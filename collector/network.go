package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Leitura de rede da API local de Integrações do UniFi, sempre com GET. A API expõe, por dispositivo,
// as portas físicas (índice, estado do enlace, conector, velocidade e PoE), o dispositivo de uplink e,
// nas estatísticas mais recentes, a taxa de TX/RX do uplink. Por site, expõe as redes (VLANs).
// Não expõe contadores por porta, VLAN por porta nem vizinhos LLDP: o coletor não inventa esses campos.

const (
	maxPortsPerDevice  = 128
	maxNetworks        = 1000
	maxDetailedDevices = 2000
	detailBudget       = 75 * time.Second
	maxRateBps         = 400e9
)

type port struct {
	Idx          int      `json:"idx"`
	Name         string   `json:"name,omitempty"`
	State        string   `json:"state"`
	Connector    string   `json:"connector,omitempty"`
	SpeedMbps    *int64   `json:"speedMbps,omitempty"`
	MaxSpeedMbps *int64   `json:"maxSpeedMbps,omitempty"`
	PoE          *portPoE `json:"poe,omitempty"`
}

type portPoE struct {
	Standard string `json:"standard,omitempty"`
	Type     *int   `json:"type,omitempty"`
	Enabled  *bool  `json:"enabled,omitempty"`
	State    string `json:"state,omitempty"`
}

type network struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	VlanID     *int   `json:"vlanId,omitempty"`
	Enabled    *bool  `json:"enabled,omitempty"`
	Management string `json:"management,omitempty"`
	Subnet     string `json:"subnet,omitempty"`
}

type remotePort struct {
	Idx          *int   `json:"idx"`
	Name         string `json:"name"`
	State        string `json:"state"`
	Connector    string `json:"connector"`
	SpeedMbps    *int64 `json:"speedMbps"`
	MaxSpeedMbps *int64 `json:"maxSpeedMbps"`
	PoE          *struct {
		Standard string `json:"standard"`
		Type     *int   `json:"type"`
		Enabled  *bool  `json:"enabled"`
		State    string `json:"state"`
	} `json:"poe"`
}

type remoteDeviceDetail struct {
	ID         string          `json:"id"`
	Features   json.RawMessage `json:"features"`
	Interfaces json.RawMessage `json:"interfaces"`
	Uplink     *struct {
		DeviceID string `json:"deviceId"`
	} `json:"uplink"`
}

type remoteStatistics struct {
	Uplink *struct {
		TxRateBps *float64 `json:"txRateBps"`
		RxRateBps *float64 `json:"rxRateBps"`
	} `json:"uplink"`
}

type remoteNetwork struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Enabled    *bool  `json:"enabled"`
	VlanID     *int   `json:"vlanId"`
	Management string `json:"management"`
	IPv4       *struct {
		HostIPAddress string `json:"hostIpAddress"`
		PrefixLength  *int   `json:"prefixLength"`
	} `json:"ipv4Configuration"`
}

var errNotFound = errors.New("recurso UniFi inexistente nesta versão")

func (unifi unifiReader) getJSON(ctx context.Context, endpoint string, destination any) error {
	target := *unifi.base
	target.Path += endpoint
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("X-API-Key", unifi.key)
	response, err := unifi.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return errNotFound
	}
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("UniFi retornou HTTP %d", response.StatusCode)
	}
	return decodeResponse(response, maxUnifiPage, destination)
}

// featureNames aceita a lista de recursos como array de textos (visão geral) ou objeto (detalhes).
func featureNames(raw json.RawMessage) []string {
	var names []string
	if json.Unmarshal(raw, &names) != nil {
		var object map[string]json.RawMessage
		if json.Unmarshal(raw, &object) != nil {
			return nil
		}
		for name := range object {
			names = append(names, name)
		}
	}
	result := make([]string, 0, len(names))
	for _, name := range names {
		if name = trimField(name, 40); name != "" && len(result) < 16 {
			result = append(result, name)
		}
	}
	sort.Strings(result)
	return result
}

func convertPorts(raw json.RawMessage) *[]port {
	var interfaces struct {
		Ports []remotePort `json:"ports"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &interfaces) != nil || interfaces.Ports == nil {
		return nil
	}
	ports := make([]port, 0, min(len(interfaces.Ports), maxPortsPerDevice))
	seen := make(map[int]struct{})
	for _, item := range interfaces.Ports {
		if item.Idx == nil || *item.Idx < 0 || *item.Idx > 10_000 || len(ports) == maxPortsPerDevice {
			continue
		}
		if _, duplicate := seen[*item.Idx]; duplicate {
			continue
		}
		seen[*item.Idx] = struct{}{}
		value := port{Idx: *item.Idx, Name: trimField(item.Name, 80), State: strings.ToUpper(trimField(item.State, 40)), Connector: strings.ToUpper(trimField(item.Connector, 40))}
		if value.State == "" {
			value.State = "UNKNOWN"
		}
		if item.SpeedMbps != nil && *item.SpeedMbps >= 0 && *item.SpeedMbps <= 1_000_000 {
			value.SpeedMbps = item.SpeedMbps
		}
		if item.MaxSpeedMbps != nil && *item.MaxSpeedMbps >= 0 && *item.MaxSpeedMbps <= 1_000_000 {
			value.MaxSpeedMbps = item.MaxSpeedMbps
		}
		if item.PoE != nil {
			value.PoE = &portPoE{Standard: trimField(item.PoE.Standard, 40), Type: item.PoE.Type, Enabled: item.PoE.Enabled, State: strings.ToUpper(trimField(item.PoE.State, 40))}
		}
		ports = append(ports, value)
	}
	sort.Slice(ports, func(i, j int) bool { return ports[i].Idx < ports[j].Idx })
	return &ports
}

func validRate(value *float64) *int64 {
	if value == nil || math.IsNaN(*value) || *value < 0 || *value > maxRateBps {
		return nil
	}
	rate := int64(math.Round(*value))
	return &rate
}

// enrich completa cada dispositivo com portas, uplink e taxas. Falhas por dispositivo não derrubam a
// captura de inventário: o dispositivo segue sem os campos de rede, que o Malha trata como "não lidos".
func (unifi unifiReader) enrich(ctx context.Context, site string, devices []device) error {
	if !validID(site) {
		return errors.New("UNIFI_SITE_ID inválido")
	}
	budget, cancel := context.WithTimeout(ctx, detailBudget)
	defer cancel()
	failures := 0
	for index := range devices {
		if index >= maxDetailedDevices || budget.Err() != nil {
			break
		}
		item := &devices[index]
		// O ID entra no caminho do GET de detalhe: só UUID, para que um valor como "../" vindo
		// do console nunca leve o coletor a ler outro caminho do host UniFi com a mesma chave.
		if !validID(item.ID) {
			failures++
			continue
		}
		var detail remoteDeviceDetail
		if err := unifi.getJSON(budget, "/sites/"+site+"/devices/"+item.ID, &detail); err != nil {
			failures++
			continue
		}
		if !strings.EqualFold(detail.ID, item.ID) {
			failures++
			continue
		}
		if features := featureNames(detail.Features); len(features) > 0 {
			item.Features = features
		}
		item.Ports = convertPorts(detail.Interfaces)
		if detail.Uplink != nil && validID(detail.Uplink.DeviceID) && !strings.EqualFold(detail.Uplink.DeviceID, item.ID) {
			item.UplinkDeviceID = strings.ToLower(detail.Uplink.DeviceID)
		}
		if item.State != "ONLINE" {
			continue
		}
		var statistics remoteStatistics
		if err := unifi.getJSON(budget, "/sites/"+site+"/devices/"+item.ID+"/statistics/latest", &statistics); err == nil && statistics.Uplink != nil {
			item.UplinkTxBps = validRate(statistics.Uplink.TxRateBps)
			item.UplinkRxBps = validRate(statistics.Uplink.RxRateBps)
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if failures > 0 {
		slog.Warn("detalhes de rede incompletos", "dispositivos", failures)
	}
	return nil
}

// networks lê as redes do site. Versões sem o recurso respondem 404 e a captura segue sem VLANs (nil).
func (unifi unifiReader) networks(ctx context.Context, site string) (*[]network, error) {
	if !validID(site) {
		return nil, errors.New("site UniFi inválido")
	}
	items, err := readPages(ctx, unifi, "/sites/"+site+"/networks", func(item remoteNetwork) string { return item.ID })
	if errors.Is(err, errNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	result := make([]network, 0, min(len(items), maxNetworks))
	for _, item := range items {
		if len(result) == maxNetworks {
			break
		}
		value := network{ID: strings.ToLower(item.ID), Name: trimField(item.Name, 120), Enabled: item.Enabled, Management: strings.ToUpper(trimField(item.Management, 40))}
		if item.VlanID != nil && *item.VlanID >= 1 && *item.VlanID <= 4094 {
			value.VlanID = item.VlanID
		}
		if item.IPv4 != nil && item.IPv4.PrefixLength != nil {
			if address, err := netip.ParseAddr(item.IPv4.HostIPAddress); err == nil && address.Is4() {
				if prefix, err := address.Prefix(*item.IPv4.PrefixLength); err == nil {
					value.Subnet = prefix.String()
				}
			}
		}
		if value.Name == "" && value.VlanID != nil {
			value.Name = "VLAN " + strconv.Itoa(*value.VlanID)
		}
		result = append(result, value)
	}
	return &result, nil
}
