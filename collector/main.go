package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

var version = "0.1.0"

func main() {
	command := "run"
	if len(os.Args) == 2 {
		command = os.Args[1]
	}
	if len(os.Args) > 2 || (command != "run" && command != "enroll" && command != "sites" && command != "version") {
		fmt.Fprintln(os.Stderr, "uso: malha-collector [run|enroll|sites|version]")
		os.Exit(2)
	}
	if command == "version" {
		fmt.Println(version)
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := execute(ctx, command); err != nil && !errors.Is(err, context.Canceled) {
		slog.Error("coletor encerrado", "erro", err)
		os.Exit(1)
	}
}

func execute(ctx context.Context, command string) error {
	cfg, err := loadConfig(command)
	if err != nil {
		return err
	}
	var unifi unifiReader
	if command != "enroll" {
		client, err := clientWithTLS(cfg.caFile)
		if err != nil {
			return err
		}
		unifi = unifiReader{client, cfg.unifi, cfg.apiKey}
	}
	if command == "sites" {
		sites, err := unifi.sites(ctx)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(sites)
	}
	queue, err := openSpool(cfg.dataDir)
	if err != nil {
		return fmt.Errorf("abrir armazenamento local: %w", err)
	}
	defer queue.db.Close()
	signing, binding, err := queue.identity(ctx, cfg.server.String(), command == "enroll")
	if err != nil {
		return err
	}
	client, err := clientWithTLS("")
	if err != nil {
		return err
	}
	malha := malhaClient{client, cfg.server, signing}
	if command == "enroll" {
		if signing.keyID != "" {
			return errors.New("coletor já ativado neste diretório")
		}
		binding, err := malha.enroll(ctx, cfg.enrollCode)
		if err != nil {
			return err
		}
		if err := queue.bind(ctx, binding); err != nil {
			return err
		}
		fmt.Printf("Coletor %s vinculado à fazenda %s.\n", binding.CollectorID, binding.FarmID)
		return nil
	}
	slog.Info("coletor ativo", "versão", version, "coletor", binding.CollectorID, "fazenda", binding.FarmID)
	return run(ctx, cfg.site, unifi, malha, queue)
}

func run(ctx context.Context, site string, unifi unifiReader, malha malhaClient, queue *spool) error {
	lost, err := queue.prune(ctx, time.Now())
	if err != nil {
		return err
	}
	var healthy atomic.Bool
	var coverageLoss atomic.Bool
	markLoss(lost, &coverageLoss)
	wake := make(chan struct{}, 1)
	var loops sync.WaitGroup
	loops.Go(func() {
		for ctx.Err() == nil {
			refreshCapture(ctx, site, unifi, queue, &healthy, &coverageLoss, wake)
			if !pause(ctx, 5*time.Minute+time.Duration(rand.IntN(31)-15)*time.Second) {
				return
			}
		}
	})
	loops.Go(func() {
		for ctx.Err() == nil {
			interval := time.Minute
			depth, err := queue.depth(ctx)
			if err == nil {
				lost := coverageLoss.Swap(false)
				err = malha.heartbeat(ctx, heartbeat{version, depth, healthy.Load() && !lost})
				if err != nil {
					if lost {
						coverageLoss.Store(true)
					}
					interval = retryDelay(err, interval)
				}
			}
			if err != nil && ctx.Err() == nil {
				slog.Warn("heartbeat falhou", "erro", err)
			}
			if !pause(ctx, interval) {
				return
			}
		}
	})
	loops.Go(func() { drain(ctx, malha, queue, wake, &coverageLoss) })
	loops.Wait()
	return ctx.Err()
}

func refreshCapture(ctx context.Context, site string, unifi unifiReader, queue *spool, healthy, coverageLoss *atomic.Bool, wake chan<- struct{}) {
	captureCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	observedAt := time.Now()
	devices, err := unifi.inventory(captureCtx, site)
	var networks *[]network
	if err == nil {
		// Portas, uplink e VLANs são complementares: falham sem descartar o inventário.
		err = unifi.enrich(captureCtx, site, devices)
	}
	if err == nil {
		var networkErr error
		networks, networkErr = unifi.networks(captureCtx, site)
		if networkErr != nil && ctx.Err() == nil {
			slog.Warn("leitura de redes UniFi falhou", "erro", networkErr)
		}
	}
	if err != nil {
		healthy.Store(false)
		if ctx.Err() == nil {
			slog.Warn("coleta UniFi falhou", "erro", err)
		}
		lost, err := queue.prune(ctx, observedAt)
		if err == nil {
			markLoss(lost, coverageLoss)
		} else if ctx.Err() == nil {
			slog.Warn("limpeza da fila local falhou", "erro", err)
		}
		return
	}
	lost, err := queue.store(ctx, observedAt, devices, networks)
	healthy.Store(err == nil)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("persistência da coleta falhou", "erro", err)
		}
		return
	}
	markLoss(lost, coverageLoss)
	select {
	case wake <- struct{}{}:
	default:
	}
	slog.Info("coleta persistida", "dispositivos", len(devices))
}

func markLoss(lost int64, coverageLoss *atomic.Bool) {
	if lost > 0 {
		coverageLoss.Store(true)
		slog.Warn("capturas expiraram na fila local", "capturas", lost)
	}
}

func drain(ctx context.Context, malha malhaClient, queue *spool, wake <-chan struct{}, coverageLoss *atomic.Bool) {
	const pacing = 2300 * time.Millisecond
	backoff := pacing
	for ctx.Err() == nil {
		item, err := queue.next(ctx)
		if errors.Is(err, sql.ErrNoRows) {
			select {
			case <-ctx.Done():
				return
			case <-wake:
				continue
			}
		}
		if err == nil {
			err = malha.upload(ctx, item.id, item.body)
			if err == nil {
				err = queue.acknowledge(ctx, item)
			}
		}
		if err == nil {
			backoff = pacing
			pause(ctx, pacing)
			continue
		}
		if ctx.Err() != nil {
			return
		}
		var status serverError
		if errors.As(err, &status) && (status.code == 409 || status.code == 413 || status.code == 422) {
			if discardErr := queue.discard(ctx, item.sequence); discardErr == nil {
				coverageLoss.Store(true)
				slog.Warn("captura rejeitada na ingestão", "sequência", item.sequence, "erro", err)
				continue
			}
		}
		slog.Warn("envio falhou e lote permanece na fila", "erro", err)
		if !pause(ctx, retryDelay(err, backoff+time.Duration(rand.IntN(1000))*time.Millisecond)) {
			return
		}
		backoff = min(backoff*2, 2*time.Minute)
	}
}

func retryDelay(err error, minimum time.Duration) time.Duration {
	var status serverError
	if errors.As(err, &status) && status.retry > minimum {
		return status.retry
	}
	return minimum
}

func pause(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
