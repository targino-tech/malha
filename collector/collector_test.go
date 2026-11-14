package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

const siteID = "00000000-0000-4000-8000-000000000001"

func TestUniFiInventoryOnlyReadsAndRejectsPartialPagination(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(strconv.FormatBool(changed), func(t *testing.T) {
			ctx := t.Context()
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.Header.Get("X-API-Key") != "fixture" || r.URL.Path != "/proxy/network/integration/v1/sites/"+siteID+"/devices" {
					t.Errorf("solicitação inesperada na integração: %s %s", r.Method, r.URL.Path)
					http.Error(w, "rota inesperada", http.StatusBadRequest)
					return
				}
				if r.URL.Query().Get("offset") == "0" {
					io.WriteString(w, `{"offset":0,"count":1,"totalCount":2,"data":[{"id":"11111111-1111-4111-8111-111111111111","name":"Link","ipAddress":"10.0.0.1","macAddress":"78-8A-20-3B-65-01","state":"ONLINE"}]}`)
					return
				}
				if changed {
					io.WriteString(w, `{"offset":1,"count":0,"totalCount":2,"data":[]}`)
					return
				}
				io.WriteString(w, `{"offset":1,"count":1,"totalCount":2,"data":[{"id":"22222222-2222-4222-8222-222222222222","name":"Switch","state":"OFFLINE"}]}`)
			}))
			defer server.Close()
			base, _ := url.Parse(server.URL + "/proxy/network/integration/v1")
			items, err := (unifiReader{server.Client(), base, "fixture"}).inventory(ctx, siteID)
			if changed {
				if err == nil || items != nil {
					t.Fatalf("captura parcial aceita: %+v, %v", items, err)
				}
				return
			}
			if err != nil || len(items) != 2 || items[0].MAC != "78:8a:20:3b:65:01" || items[1].State != "OFFLINE" {
				t.Fatalf("inventário: %+v, %v", items, err)
			}
		})
	}
}

func TestSpoolPersistsPartsAndReplaysSameBytes(t *testing.T) {
	ctx := t.Context()
	dir := filepath.Join(t.TempDir(), "test #1")
	queue, err := openSpool(dir)
	if err != nil {
		t.Fatal(err)
	}
	fixture := make([]device, devicesPerPart+1)
	for i := range fixture {
		fixture[i] = device{ID: newID(), Name: "Dispositivo", State: "ONLINE"}
	}
	if _, err := queue.store(ctx, time.Now(), fixture); err != nil {
		t.Fatal(err)
	}
	original, err := queue.next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := queue.db.Close(); err != nil {
		t.Fatal(err)
	}
	queue, err = openSpool(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer queue.db.Close()
	replayed, err := queue.next(ctx)
	if err != nil || original.id != replayed.id || !bytes.Equal(original.body, replayed.body) {
		t.Fatalf("replay divergiu do lote recebido: %v", err)
	}
	var first, last batch
	if err := json.Unmarshal(original.body, &first); err != nil || first.Part != 1 || first.Parts != 2 || len(first.Devices) != devicesPerPart {
		t.Fatalf("primeiro lote inválido: %v", err)
	}
	if err := queue.acknowledge(ctx, replayed); err != nil {
		t.Fatal(err)
	}
	second, err := queue.next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(second.body, &last); err != nil || last.CaptureID != first.CaptureID || last.Sequence != first.Sequence || last.Part != 2 || len(last.Devices) != 1 {
		t.Fatalf("segundo lote inválido: %v", err)
	}
	if err := queue.acknowledge(ctx, second); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.next(ctx); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("lotes confirmados ainda pendentes: %v", err)
	}
}

func TestSpoolPreservesIdentityAndDropsExpiredCapture(t *testing.T) {
	ctx := t.Context()
	queue, err := openSpool(filepath.Join(t.TempDir(), "coletor"))
	if err != nil {
		t.Fatal(err)
	}
	defer queue.db.Close()
	origin := "https://ingest.example.test"
	first, _, err := queue.identity(ctx, origin, true)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := queue.identity(ctx, origin, true)
	if err != nil || !bytes.Equal(first.privateKey, second.privateKey) {
		t.Fatalf("a chave mudou após reativação: %v", err)
	}
	if _, _, err := queue.identity(ctx, "https://other.example.test", true); err == nil {
		t.Fatal("mesma identidade aceita em outra origem")
	}
	if _, err := queue.store(ctx, time.Now().Add(-spoolRetention-time.Hour), nil); err != nil {
		t.Fatal(err)
	}
	if lost, err := queue.prune(ctx, time.Now()); err != nil || lost != 1 {
		t.Fatalf("limpeza de captura: %d %v", lost, err)
	}
	if _, err := queue.next(ctx); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("lote expirado ainda presente: %v", err)
	}
}

func TestSignatureChecksBodyAndPathAndGeneratesFreshNonce(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(nil)
	signing := signer{private, "key-a"}
	body := []byte(`{"batchId":"sample"}`)
	now := time.Now().Truncate(time.Second)
	first := signing.authorization(http.MethodPost, batchesPath, body, now)
	second := signing.authorization(http.MethodPost, batchesPath, body, now)
	if first == second {
		t.Fatal("reenvio reutilizou nonce")
	}
	parts := strings.Split(strings.TrimPrefix(first, "JWS "), ".")
	signature, _ := base64URL.DecodeString(parts[2])
	if !ed25519.Verify(public, []byte(strings.Join(parts[:2], ".")), signature) {
		t.Fatal("assinatura inválida")
	}
	var claims map[string]any
	claimJSON, _ := base64URL.DecodeString(parts[1])
	if err := json.Unmarshal(claimJSON, &claims); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	if claims["aud"] != "malha-collector" || claims["method"] != "POST" || claims["path"] != batchesPath || claims["body_sha256"] != hex.EncodeToString(digest[:]) || claims["exp"] != float64(now.Add(time.Minute).Unix()) {
		t.Fatalf("contexto da assinatura: %+v", claims)
	}
}

func TestUploadRequiresMatchingReceipt(t *testing.T) {
	ctx := context.Background()
	_, key, _ := ed25519.GenerateKey(nil)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != batchesPath || !strings.HasPrefix(r.Header.Get("Authorization"), "JWS ") {
			t.Errorf("requisição de lote inesperada: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusAccepted)
		io.WriteString(w, `{"batchId":"other"}`)
	}))
	defer server.Close()
	origin, _ := url.Parse(server.URL)
	malha := malhaClient{server.Client(), origin, signer{key, "key"}}
	if err := malha.upload(ctx, "sample", []byte(`{"batchId":"sample"}`)); err == nil {
		t.Fatal("aceitou recibo de outro lote")
	}
}
