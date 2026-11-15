package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

const (
	switchID = "11111111-1111-4111-8111-111111111111"
	apID     = "22222222-2222-4222-8222-222222222222"
)

func TestNetworkReadingOnlyUsesGetAndKeepsInventoryOnDetailFailure(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.Header.Get("X-API-Key") != "fixture" {
			t.Errorf("solicitação proibida: %s %s", r.Method, r.URL.Path)
			http.Error(w, "proibido", http.StatusMethodNotAllowed)
			return
		}
		prefix := "/proxy/network/integration/v1/sites/" + siteID
		switch r.URL.Path {
		case prefix + "/devices/" + switchID:
			io.WriteString(w, `{"id":"`+switchID+`","features":{"switching":{}},"uplink":{"deviceId":"`+apID+`"},
				"interfaces":{"ports":[{"idx":2,"state":"DOWN","connector":"RJ45","maxSpeedMbps":1000},
				{"idx":1,"state":"up","connector":"SFP+","speedMbps":10000,"maxSpeedMbps":10000,"poe":{"standard":"802.3at","type":2,"enabled":true,"state":"UP"}},
				{"idx":1,"state":"UP"},{"state":"UP"}],"radios":[]}}`)
		case prefix + "/devices/" + switchID + "/statistics/latest":
			io.WriteString(w, `{"uptimeSec":10,"uplink":{"txRateBps":1200.4,"rxRateBps":-5}}`)
		case prefix + "/devices/" + apID:
			http.Error(w, "falha", http.StatusInternalServerError)
		case prefix + "/networks":
			io.WriteString(w, `{"offset":0,"count":2,"totalCount":2,"data":[
				{"id":"33333333-3333-4333-8333-333333333333","name":"Produção","enabled":true,"vlanId":20,"management":"GATEWAY","ipv4Configuration":{"hostIpAddress":"10.20.0.1","prefixLength":24}},
				{"id":"44444444-4444-4444-8444-444444444444","name":"","vlanId":9999}]}`)
		default:
			t.Errorf("rota inesperada: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL + "/proxy/network/integration/v1")
	unifi := unifiReader{server.Client(), base, "fixture"}
	devices := []device{{ID: switchID, State: "ONLINE"}, {ID: apID, State: "ONLINE"}}
	if err := unifi.enrich(t.Context(), siteID, devices); err != nil {
		t.Fatal(err)
	}
	sw := devices[0]
	if sw.Ports == nil || len(*sw.Ports) != 2 || (*sw.Ports)[0].Idx != 1 || (*sw.Ports)[0].State != "UP" || (*sw.Ports)[0].PoE == nil || *(*sw.Ports)[0].SpeedMbps != 10000 {
		t.Fatalf("portas: %+v", sw.Ports)
	}
	if sw.UplinkDeviceID != apID || sw.UplinkTxBps == nil || *sw.UplinkTxBps != 1200 || sw.UplinkRxBps != nil || len(sw.Features) != 1 || sw.Features[0] != "switching" {
		t.Fatalf("uplink e recursos: %+v", sw)
	}
	if devices[1].Ports != nil || devices[1].UplinkDeviceID != "" {
		t.Fatalf("falha de detalhe inventou dados: %+v", devices[1])
	}
	networks, err := unifi.networks(t.Context(), siteID)
	if err != nil || networks == nil || len(*networks) != 2 {
		t.Fatalf("redes: %+v %v", networks, err)
	}
	if first := (*networks)[0]; first.Subnet != "10.20.0.0/24" || first.VlanID == nil || *first.VlanID != 20 {
		t.Fatalf("rede: %+v", first)
	}
	if second := (*networks)[1]; second.VlanID != nil || second.Name != "" {
		t.Fatalf("VLAN fora da faixa aceita: %+v", second)
	}
}

func TestNetworksMissingInOlderConsolesIsNotAnError(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL + "/proxy/network/integration/v1")
	networks, err := (unifiReader{server.Client(), base, "fixture"}).networks(t.Context(), siteID)
	if err != nil || networks != nil {
		t.Fatalf("console sem redes: %+v %v", networks, err)
	}
}

func TestPartitionRespectsBytesAndKeepsVersionedPayload(t *testing.T) {
	ports := make([]port, maxPortsPerDevice)
	for i := range ports {
		ports[i] = port{Idx: i + 1, Name: strings.Repeat("p", 80), State: "UP", Connector: "RJ45"}
	}
	devices := make([]device, 150)
	for i := range devices {
		devices[i] = device{ID: newID(), Name: "Switch", State: "ONLINE", Ports: &ports}
	}
	chunks, err := partition(devices, &[]network{{ID: newID(), Name: "Rede"}})
	if err != nil || len(chunks) < 2 {
		t.Fatalf("partes: %d %v", len(chunks), err)
	}
	total := 0
	for _, chunk := range chunks {
		body, _ := json.Marshal(batch{batchSchemaVersion, newID(), newID(), 1, time.Now(), 1, len(chunks), chunk, nil})
		if len(body) > maxBatchBytes {
			t.Fatalf("parte acima do limite: %d bytes", len(body))
		}
		total += len(chunk)
	}
	if total != len(devices) {
		t.Fatalf("dispositivos perdidos: %d", total)
	}
	legacy, _ := json.Marshal(device{ID: switchID, Name: "AP", State: "ONLINE"})
	if strings.Contains(string(legacy), "ports") || strings.Contains(string(legacy), "uplink") {
		t.Fatalf("campos de rede ausentes devem ser omitidos: %s", legacy)
	}
	empty, _ := json.Marshal(device{ID: switchID, Ports: &[]port{}})
	if !strings.Contains(string(empty), `"ports":[]`) {
		t.Fatalf("lista vazia de portas lida deve ser enviada: %s", empty)
	}
}
