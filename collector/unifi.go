package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

const (
	unifiPageSize = 100
	maxInventory  = 20_000
	maxUnifiPage  = 2 * 1024 * 1024
)

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func validID(s string) bool { return uuidPattern.MatchString(s) }

type unifiReader struct {
	client *http.Client
	base   *url.URL
	key    string
}

type unifiPage[T any] struct {
	Offset *int `json:"offset"`
	Count  *int `json:"count"`
	Total  *int `json:"totalCount"`
	Data   []T  `json:"data"`
}

type remoteSite struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type remoteDevice struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	MAC      string `json:"macAddress"`
	IP       string `json:"ipAddress"`
	Model    string `json:"model"`
	State    string `json:"state"`
	Firmware string `json:"firmwareVersion"`
}

func readPages[T any](ctx context.Context, unifi unifiReader, endpoint string, getID func(T) string) ([]T, error) {
	initialTotal := -1
	items := make([]T, 0)
	seen := make(map[string]struct{})
	for offset := 0; ; offset = len(items) {
		target := *unifi.base
		target.Path += endpoint
		target.RawQuery = url.Values{"offset": {strconv.Itoa(offset)}, "limit": {strconv.Itoa(unifiPageSize)}}.Encode()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if err != nil {
			return nil, err
		}
		request.Header.Set("Accept", "application/json")
		request.Header.Set("X-API-Key", unifi.key)
		response, err := unifi.client.Do(request)
		if err != nil {
			return nil, err
		}
		if response.StatusCode != http.StatusOK {
			response.Body.Close()
			return nil, fmt.Errorf("UniFi retornou HTTP %d", response.StatusCode)
		}
		var page unifiPage[T]
		err = decodeResponse(response, maxUnifiPage, &page)
		response.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("resposta UniFi: %w", err)
		}
		if page.Offset == nil || page.Count == nil || page.Total == nil || page.Data == nil || *page.Offset != offset ||
			*page.Count != len(page.Data) || *page.Total > maxInventory || *page.Total < offset+len(page.Data) {
			return nil, errors.New("paginação UniFi incompleta ou acima do limite")
		}
		if initialTotal == -1 {
			initialTotal = *page.Total
		}
		if *page.Total != initialTotal || (len(page.Data) == 0 && offset < initialTotal) {
			return nil, errors.New("inventário UniFi mudou durante a paginação")
		}
		for _, item := range page.Data {
			id := strings.ToLower(getID(item))
			if _, duplicate := seen[id]; !validID(id) || duplicate {
				return nil, errors.New("inventário UniFi contém ID inválido ou duplicado")
			}
			seen[id] = struct{}{}
			items = append(items, item)
		}
		if len(items) == initialTotal {
			return items, nil
		}
	}
}

func (unifi unifiReader) sites(ctx context.Context) ([]remoteSite, error) {
	return readPages(ctx, unifi, "/sites", func(site remoteSite) string { return site.ID })
}

func (unifi unifiReader) inventory(ctx context.Context, site string) ([]device, error) {
	if !validID(site) {
		return nil, errors.New("site UniFi inválido")
	}
	items, err := readPages(ctx, unifi, "/sites/"+site+"/devices", func(item remoteDevice) string { return item.ID })
	if err != nil {
		return nil, err
	}
	devices := make([]device, 0, len(items))
	for _, item := range items {
		result := device{ID: strings.ToLower(item.ID), Name: trimField(item.Name, 160), Model: trimField(item.Model, 120), Firmware: trimField(item.Firmware, 120), State: strings.ToUpper(trimField(item.State, 40))}
		if mac, err := net.ParseMAC(item.MAC); err == nil && len(mac) == 6 {
			result.MAC = mac.String()
		}
		if ip, err := netip.ParseAddr(item.IP); err == nil && ip.Zone() == "" {
			result.IP = ip.Unmap().String()
		}
		if result.Name == "" {
			result.Name = result.ID
		}
		if result.State == "" {
			result.State = "UNKNOWN"
		}
		devices = append(devices, result)
	}
	return devices, nil
}

func trimField(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) <= max {
		return value
	}
	// The ingest schema counts JavaScript UTF-16 code units.
	for index, char := range value {
		max -= utf16.RuneLen(char)
		if max < 0 {
			return value[:index]
		}
	}
	return value
}

func decodeResponse(response *http.Response, max int64, destination any) error {
	data, err := readBounded(response.Body, max)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, destination)
}
