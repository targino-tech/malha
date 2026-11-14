package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

const (
	enrollPath     = "/v1/collectors/enroll"
	heartbeatPath  = "/v1/collectors/heartbeat"
	batchesPath    = "/v1/collectors/batches"
	maxBatchBytes  = 1024 * 1024
	devicesPerPart = 200
)

var base64URL = base64.RawURLEncoding

type device struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	MAC      string `json:"mac"`
	IP       string `json:"ip"`
	Model    string `json:"model"`
	State    string `json:"state"`
	Firmware string `json:"firmware"`
}

type batch struct {
	SchemaVersion int       `json:"schemaVersion"`
	ID            string    `json:"batchId"`
	CaptureID     string    `json:"captureId"`
	Sequence      int64     `json:"sequence"`
	ObservedAt    time.Time `json:"observedAt"`
	Part          int       `json:"part"`
	Parts         int       `json:"parts"`
	Devices       []device  `json:"devices"`
}

type heartbeat struct {
	Version    string `json:"version"`
	QueueDepth int    `json:"queueDepth"`
	Healthy    bool   `json:"healthy"`
}

type publicJWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
}

type enrollment struct {
	CollectorID string `json:"collectorId"`
	KeyID       string `json:"keyId"`
	FarmID      string `json:"farmId"`
}

type signer struct {
	privateKey ed25519.PrivateKey
	keyID      string
}

func (s signer) authorization(method, path string, body []byte, now time.Time) string {
	head, _ := json.Marshal(struct {
		Alg string `json:"alg"`
		Kid string `json:"kid,omitempty"`
	}{Alg: "Ed25519", Kid: s.keyID})
	digest := sha256.Sum256(body)
	claims, _ := json.Marshal(struct {
		Audience string `json:"aud"`
		Method   string `json:"method"`
		Path     string `json:"path"`
		BodyHash string `json:"body_sha256"`
		IssuedAt int64  `json:"iat"`
		Expires  int64  `json:"exp"`
		Nonce    string `json:"jti"`
	}{"malha-collector", method, path, hex.EncodeToString(digest[:]), now.Unix(), now.Add(time.Minute).Unix(), newID()})
	input := base64URL.EncodeToString(head) + "." + base64URL.EncodeToString(claims)
	return "JWS " + input + "." + base64URL.EncodeToString(ed25519.Sign(s.privateKey, []byte(input)))
}

func newID() string {
	var raw [16]byte
	rand.Read(raw[:])
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[:4], raw[4:6], raw[6:8], raw[8:10], raw[10:])
}

type malhaClient struct {
	client *http.Client
	base   *url.URL
	signer signer
}

type serverError struct {
	code  int
	retry time.Duration
}

func (err serverError) Error() string { return fmt.Sprintf("Malha retornou HTTP %d", err.code) }

func (m malhaClient) send(ctx context.Context, path string, body []byte, result any, allowed ...int) error {
	target := *m.base
	target.Path = path
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", m.signer.authorization(request.Method, path, body, time.Now()))
	response, err := m.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	for _, expected := range allowed {
		if response.StatusCode == expected {
			if result == nil {
				_, err = readBounded(response.Body, 64*1024)
				return err
			}
			return decodeResponse(response, 64*1024, result)
		}
	}
	return serverError{code: response.StatusCode, retry: retryAfter(response.Header.Get("Retry-After"), time.Now())}
}

func (m malhaClient) enroll(ctx context.Context, code string) (enrollment, error) {
	public := m.signer.privateKey.Public().(ed25519.PublicKey)
	request, _ := json.Marshal(struct {
		Code      string    `json:"code"`
		PublicKey publicJWK `json:"publicKey"`
	}{code, publicJWK{"OKP", "Ed25519", base64URL.EncodeToString(public)}})
	var result enrollment
	err := m.send(ctx, enrollPath, request, &result, http.StatusCreated, http.StatusOK)
	if err == nil && (!validID(result.CollectorID) || result.KeyID == "" || !validID(result.FarmID)) {
		err = errors.New("resposta de ativação inválida")
	}
	return result, err
}

func (m malhaClient) heartbeat(ctx context.Context, status heartbeat) error {
	body, _ := json.Marshal(status)
	return m.send(ctx, heartbeatPath, body, nil, http.StatusOK, http.StatusNoContent)
}

func (m malhaClient) upload(ctx context.Context, id string, body []byte) error {
	var receipt struct {
		BatchID string `json:"batchId"`
	}
	if err := m.send(ctx, batchesPath, body, &receipt, http.StatusAccepted); err != nil {
		return err
	}
	if receipt.BatchID != id {
		return errors.New("recibo para um lote diferente")
	}
	return nil
}

func retryAfter(value string, now time.Time) time.Duration {
	if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
		return time.Duration(min(seconds, 86400)) * time.Second
	}
	if at, err := http.ParseTime(value); err == nil && at.After(now) {
		return min(at.Sub(now), 24*time.Hour)
	}
	return 0
}

func readBounded(reader io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("resposta acima do limite")
	}
	return data, nil
}
