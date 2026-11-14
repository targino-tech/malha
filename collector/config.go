package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type config struct {
	server     *url.URL
	unifi      *url.URL
	site       string
	apiKey     string
	caFile     string
	dataDir    string
	enrollCode string
}

func loadConfig(command string) (config, error) {
	var cfg config
	var err error
	if command != "sites" {
		cfg.server, err = endpoint("MALHA_URL", false, false)
		if err != nil {
			return cfg, err
		}
		cfg.dataDir = os.Getenv("MALHA_DATA_DIR")
		if cfg.dataDir == "" {
			base, err := os.UserConfigDir()
			if err != nil {
				return cfg, fmt.Errorf("defina MALHA_DATA_DIR: %w", err)
			}
			cfg.dataDir = filepath.Join(base, "malha-collector")
		}
	}
	if command == "enroll" {
		cfg.enrollCode, err = envSecret("MALHA_ENROLL_CODE")
		return cfg, err
	}
	cfg.unifi, err = endpoint("UNIFI_BASE_URL", true, true)
	if err != nil {
		return cfg, err
	}
	cfg.apiKey, err = envSecret("UNIFI_API_KEY")
	if err != nil {
		return cfg, err
	}
	cfg.caFile = os.Getenv("UNIFI_CA_FILE")
	cfg.site = os.Getenv("UNIFI_SITE_ID")
	if command != "sites" && !validID(cfg.site) {
		return cfg, errors.New("UNIFI_SITE_ID deve conter um identificador UUID de site")
	}
	return cfg, nil
}

func envSecret(name string) (string, error) {
	if file := os.Getenv(name + "_FILE"); file != "" {
		if os.Getenv(name) != "" {
			return "", fmt.Errorf("configure somente %s ou %s_FILE", name, name)
		}
		value, err := os.ReadFile(file)
		if err != nil {
			return "", fmt.Errorf("ler %s_FILE: %w", name, err)
		}
		if secret := strings.TrimSpace(string(value)); secret != "" {
			return secret, nil
		}
	}
	if secret := strings.TrimSpace(os.Getenv(name)); secret != "" {
		return secret, nil
	}
	return "", fmt.Errorf("defina %s ou %s_FILE", name, name)
}

func endpoint(name string, allowPath, requireTLS bool) (*url.URL, error) {
	base, err := url.Parse(os.Getenv(name))
	if err != nil || base.Hostname() == "" || base.User != nil || base.RawQuery != "" || base.ForceQuery || base.Fragment != "" {
		return nil, fmt.Errorf("%s deve ser uma URL HTTP absoluta, sem usuário, consulta ou fragmento", name)
	}
	loopback := base.Hostname() == "localhost" || base.Hostname() == "127.0.0.1" || base.Hostname() == "::1"
	if base.Scheme != "https" && !(base.Scheme == "http" && loopback && !requireTLS) {
		return nil, fmt.Errorf("%s exige HTTPS. HTTP é aceito somente para MALHA_URL em loopback", name)
	}
	base.Path = strings.TrimRight(base.Path, "/")
	if base.RawPath != "" || (!allowPath && base.Path != "") || (allowPath && !strings.HasSuffix(base.Path, "/integration/v1")) {
		return nil, fmt.Errorf("%s deve usar o prefixo local /integration/v1 (UniFi) ou apenas a origem (Malha)", name)
	}
	return base, nil
}

func clientWithTLS(caFile string) (*http.Client, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	if caFile != "" {
		roots, err := x509.SystemCertPool()
		if err != nil {
			return nil, fmt.Errorf("carregar autoridades TLS: %w", err)
		}
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, fmt.Errorf("ler UNIFI_CA_FILE: %w", err)
		}
		if !roots.AppendCertsFromPEM(pem) {
			return nil, errors.New("UNIFI_CA_FILE não contém certificado PEM válido")
		}
		transport.TLSClientConfig.RootCAs = roots
	}
	return &http.Client{
		Transport: transport,
		Timeout:   12 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}, nil
}
