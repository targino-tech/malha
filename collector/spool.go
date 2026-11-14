package main

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const (
	spoolRetention = 72 * time.Hour
	spoolMaxBytes  = 256 * 1024 * 1024
)

const spoolSchema = `
CREATE TABLE IF NOT EXISTS identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  seed BLOB NOT NULL CHECK (length(seed) = 32),
  server TEXT NOT NULL,
  key_id TEXT NOT NULL DEFAULT '',
  collector_id TEXT NOT NULL DEFAULT '',
  farm_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS captures (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  captured INTEGER NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pending (
  batch_id TEXT PRIMARY KEY,
  capture INTEGER NOT NULL REFERENCES captures(sequence) ON DELETE CASCADE,
  part INTEGER NOT NULL,
  body BLOB NOT NULL,
  UNIQUE (capture, part)
);`

type spool struct {
	db *sql.DB
}

func openSpool(dataDir string) (*spool, error) {
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, err
	}
	if err := privatePath(dataDir); err != nil {
		return nil, err
	}
	path := filepath.Join(dataDir, "collector.sqlite3")
	if err := privatePath(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	// Use a SQLite URI so paths containing '?', '#' or spaces work on both OSes.
	dsn, err := sqliteDSN(path)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(spoolSchema); err != nil {
		db.Close()
		return nil, err
	}
	return &spool{db}, nil
}

func privatePath(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
		return errors.New("MALHA_DATA_DIR e banco local exigem caminho direto com acesso exclusivo ao usuário do coletor")
	}
	return nil
}

func sqliteDSN(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	p := filepath.ToSlash(abs)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	uri := url.URL{Scheme: "file", Path: p, RawQuery: url.Values{"_pragma": {"foreign_keys(1)", "journal_mode(WAL)", "synchronous(FULL)", "busy_timeout(5000)"}}.Encode()}
	return uri.String(), nil
}

func (s *spool) identity(ctx context.Context, origin string, create bool) (signer, enrollment, error) {
	var seed []byte
	var existingOrigin string
	var binding enrollment
	if create {
		_, key, err := ed25519.GenerateKey(nil)
		if err != nil {
			return signer{}, binding, err
		}
		_, err = s.db.ExecContext(ctx, `INSERT INTO identity (singleton, seed, server) VALUES (1, ?, ?) ON CONFLICT(singleton) DO NOTHING`, key.Seed(), origin)
		if err != nil {
			return signer{}, binding, err
		}
	}
	err := s.db.QueryRowContext(ctx, `SELECT seed, server, key_id, collector_id, farm_id FROM identity WHERE singleton=1`).Scan(&seed, &existingOrigin, &binding.KeyID, &binding.CollectorID, &binding.FarmID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !create && binding.KeyID == "") {
		return signer{}, binding, errors.New("ative o coletor com o comando enroll")
	}
	if err != nil {
		return signer{}, binding, err
	}
	if existingOrigin != origin {
		return signer{}, binding, errors.New("o diretório de dados pertence a outro MALHA_URL")
	}
	return signer{ed25519.NewKeyFromSeed(seed), binding.KeyID}, binding, nil
}

func (s *spool) bind(ctx context.Context, value enrollment) error {
	result, err := s.db.ExecContext(ctx, `UPDATE identity SET key_id=?, collector_id=?, farm_id=? WHERE singleton=1 AND (key_id='' OR key_id=?)`, value.KeyID, value.CollectorID, value.FarmID, value.KeyID)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count != 1 {
		return errors.New("diretório de dados já vinculado")
	}
	return err
}

func (s *spool) store(ctx context.Context, when time.Time, devices []device) (int64, error) {
	if len(devices) > maxInventory {
		return 0, errors.New("inventário acima do limite")
	}
	if devices == nil {
		devices = make([]device, 0)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	created, err := tx.ExecContext(ctx, `INSERT INTO captures (captured) VALUES (?)`, when.Unix())
	if err != nil {
		return 0, err
	}
	sequence, err := created.LastInsertId()
	if err != nil {
		return 0, err
	}
	captureID := newID()
	parts := max(1, (len(devices)+devicesPerPart-1)/devicesPerPart)
	totalBytes := 0
	for part := range parts {
		id := newID()
		start := part * devicesPerPart
		value := batch{1, id, captureID, sequence, when.UTC(), part + 1, parts, devices[start:min(start+devicesPerPart, len(devices))]}
		body, err := json.Marshal(value)
		if err != nil {
			return 0, err
		}
		if len(body) > maxBatchBytes {
			return 0, errors.New("lote acima do limite")
		}
		totalBytes += len(body)
		if _, err := tx.ExecContext(ctx, `INSERT INTO pending (batch_id, capture, part, body) VALUES (?, ?, ?, ?)`, id, sequence, part+1, body); err != nil {
			return 0, err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE captures SET bytes=? WHERE sequence=?`, totalBytes, sequence); err != nil {
		return 0, err
	}
	lost, err := pruneCaptures(ctx, tx, when)
	if err != nil {
		return 0, err
	}
	return lost, tx.Commit()
}

func (s *spool) prune(ctx context.Context, now time.Time) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	lost, err := pruneCaptures(ctx, tx, now)
	if err != nil {
		return 0, err
	}
	return lost, tx.Commit()
}

func pruneCaptures(ctx context.Context, tx *sql.Tx, now time.Time) (int64, error) {
	expired, err := tx.ExecContext(ctx, `DELETE FROM captures WHERE captured < ?`, now.Add(-spoolRetention).Unix())
	if err != nil {
		return 0, err
	}
	capacity, err := tx.ExecContext(ctx, `DELETE FROM captures WHERE sequence IN (
  SELECT sequence FROM (SELECT sequence, sum(bytes) OVER (ORDER BY sequence DESC) AS accumulated FROM captures)
  WHERE accumulated > ?
)`, spoolMaxBytes)
	if err != nil {
		return 0, err
	}
	old, err := expired.RowsAffected()
	if err != nil {
		return 0, err
	}
	full, err := capacity.RowsAffected()
	return old + full, err
}

type queuedBatch struct {
	id       string
	sequence int64
	body     []byte
}

func (s *spool) next(ctx context.Context) (queuedBatch, error) {
	var item queuedBatch
	err := s.db.QueryRowContext(ctx, `SELECT batch_id, capture, body FROM pending ORDER BY capture DESC, part LIMIT 1`).Scan(&item.id, &item.sequence, &item.body)
	return item, err
}

func (s *spool) depth(ctx context.Context) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM pending`).Scan(&count)
	return count, err
}

func (s *spool) acknowledge(ctx context.Context, item queuedBatch) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `DELETE FROM pending WHERE batch_id=?`, item.id)
	if err != nil {
		return err
	}
	deleted, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if deleted == 1 {
		if _, err := tx.ExecContext(ctx, `UPDATE captures SET bytes=bytes-? WHERE sequence=?`, len(item.body), item.sequence); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM captures WHERE sequence=? AND bytes=0`, item.sequence); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *spool) discard(ctx context.Context, sequence int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM captures WHERE sequence=?`, sequence)
	if err != nil {
		return fmt.Errorf("descartar captura: %w", err)
	}
	return nil
}
