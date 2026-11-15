package main

import (
	"strings"
	"testing"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// Testes de fuzzing (go test -fuzz=FuzzX) para o que vem de fora: campos do UniFi, cabeçalhos
// do Malha e URLs da configuração. Sem -fuzz, os casos-semente rodam junto com go test ./...

func FuzzTrimField(f *testing.F) {
	for _, seed := range []string{"", "AP do escritório", "  espaços  ", "🌾🌾🌾", strings.Repeat("ç", 300), "\xff\xfe"} {
		f.Add(seed, 64)
	}
	f.Fuzz(func(t *testing.T, value string, max int) {
		if max < 0 || max > 4096 {
			t.Skip()
		}
		out := trimField(value, max)
		if !strings.HasPrefix(strings.TrimSpace(value), out) {
			t.Fatalf("resultado não é prefixo do valor: %q -> %q", value, out)
		}
		if utf8.ValidString(value) {
			if !utf8.ValidString(out) {
				t.Fatalf("cortou no meio de um caractere: %q", out)
			}
			if units := len(utf16.Encode([]rune(out))); units > max {
				t.Fatalf("passou do limite: %d unidades UTF-16 para max %d", units, max)
			}
		}
	})
}

func FuzzRetryAfter(f *testing.F) {
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	for _, seed := range []string{"", "0", "30", "-5", "999999999", "Sun, 15 Nov 2026 12:01:00 GMT", "lixo"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, value string) {
		delay := retryAfter(value, now)
		if delay < 0 || delay > 24*time.Hour {
			t.Fatalf("espera fora do intervalo para %q: %v", value, delay)
		}
	})
}

func FuzzEndpoint(f *testing.F) {
	for _, seed := range []string{
		"https://malha.exemplo", "http://127.0.0.1:3000", "http://malha.exemplo", "https://user:senha@malha.exemplo",
		"https://console.exemplo/proxy/network/integration/v1", "https://malha.exemplo/?a=1", "https://malha.exemplo/#x", "::", "",
	} {
		f.Add(seed, false, false)
		f.Add(seed, true, true)
	}
	f.Fuzz(func(t *testing.T, raw string, allowPath, requireTLS bool) {
		if strings.ContainsRune(raw, 0) {
			t.Skip() // o sistema operacional não aceita NUL em variáveis de ambiente
		}
		t.Setenv("MALHA_FUZZ_URL", raw)
		u, err := endpoint("MALHA_FUZZ_URL", allowPath, requireTLS)
		if err != nil {
			return
		}
		if u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Hostname() == "" {
			t.Fatalf("aceitou URL com usuário, consulta, fragmento ou sem host: %q", raw)
		}
		loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
		if u.Scheme != "https" && !(u.Scheme == "http" && loopback && !requireTLS) {
			t.Fatalf("aceitou esquema inseguro: %q", raw)
		}
		if !allowPath && u.Path != "" {
			t.Fatalf("aceitou caminho onde só a origem vale: %q", raw)
		}
	})
}
