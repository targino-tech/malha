# Dados de rede

Base de dados de rede do Malha: portas por dispositivo, VLANs por fazenda, série de tráfego, ligações entre
dispositivos com evidência e indicadores por fazenda para o mapa. Este documento é o contrato para as telas de
topologia, mapa e gráficos. Os tipos TypeScript ficam em
[`apps/web/src/server/network/types.ts`](../apps/web/src/server/network/types.ts).

## O que o coletor lê do UniFi

O coletor continua **somente com GET** na API local de Integrações (`/proxy/network/integration/v1`). Por captura:

| Endpoint | Campos usados | Observação |
| --- | --- | --- |
| `GET /sites/{site}/devices` (paginado) | `id`, `name`, `macAddress`, `ipAddress`, `model`, `state`, `firmwareVersion`, `features` | Inventário, como antes. |
| `GET /sites/{site}/devices/{id}` | `features`, `uplink.deviceId`, `interfaces.ports[]` (`idx`, `state`, `connector`, `speedMbps`, `maxSpeedMbps`, `poe.standard`, `poe.type`, `poe.enabled`, `poe.state`) | Uma leitura por dispositivo, com orçamento de 75 s por captura e até 2.000 dispositivos. Falha num dispositivo não derruba a captura: ele segue sem os campos de rede. |
| `GET /sites/{site}/devices/{id}/statistics/latest` | `uplink.txRateBps`, `uplink.rxRateBps` | Só para dispositivos `ONLINE`. Taxas negativas, NaN ou acima de 400 Gbps são descartadas. |
| `GET /sites/{site}/networks` (paginado) | `id`, `name`, `enabled`, `vlanId`, `management`, `ipv4Configuration.hostIpAddress` + `prefixLength` (vira a sub-rede) | Consoles antigos respondem 404: a captura segue sem VLANs (`networks` ausente) e o catálogo anterior é mantido. |

### Lacunas conhecidas da API (não inventamos esses campos)

- **Contadores por porta** (bytes, pacotes, erros, descartes): a API de Integrações não expõe. O tráfego real vem
  da taxa de uplink por dispositivo (`statistics/latest`).
- **VLAN por porta** (nativa e marcadas, perfil de porta): não exposta por porta.
- **Potência PoE por porta** (mW): não exposta; só padrão, tipo, habilitado e estado.
- **Vizinhos LLDP e porta do uplink**: a API informa só o dispositivo a montante (`uplink.deviceId`), sem as portas.
  Por isso toda ligação vinda do UniFi é de nível **dispositivo**; o Malha nunca desenha porta a porta sem as duas pontas.

A ingestão já aceita esses campos como **opcionais e reservados** (`nativeVlanId`, `taggedVlanIds`, `rxBytes`…
`txDropped`, `poe.powerMw`) para fontes que os tenham. Quando chegam contadores, o Malha calcula a taxa por diferença
(abaixo). O coletor UniFi atual não os envia.

## Lote do coletor, versão 2

`POST /v1/collectors/batches` aceita `schemaVersion` **1** (como antes) e **2**. A versão 2 só acrescenta campos
opcionais; ausência sempre significa "não lido nesta captura", nunca "zero". Um lote versão 1 com campos de rede é
recusado (400). Assinatura, nonce, idempotência (mesmo `batchId` devolve o recibo; conteúdo divergente recebe 409),
limite de 1 MiB, 200 dispositivos e 100 partes continuam iguais. O coletor divide as partes também por tamanho
(até ~900 KiB de JSON por parte) e envia `networks` só na primeira parte.

```jsonc
{
  "schemaVersion": 2, "batchId": "uuid", "captureId": "uuid", "sequence": 42,
  "observedAt": "2026-11-15T12:00:00Z", "part": 1, "parts": 1,
  "devices": [{
    "id": "uuid-unifi", "name": "Switch", "mac": "aa:bb:cc:dd:ee:ff", "ip": "10.0.0.2", "model": "USW 24", "state": "ONLINE", "firmware": "7.1",
    "features": ["switching"],                 // opcional, até 16
    "uplinkDeviceId": "uuid-do-gateway",       // opcional: dispositivo a montante
    "uplinkTxBps": 1200000, "uplinkRxBps": 8000000, // opcionais, bits/s
    "ports": [{                                 // opcional; [] = lido e sem portas; até 128, idx único
      "idx": 1, "name": "Porta 1", "state": "UP", "connector": "SFPPLUS", "speedMbps": 10000, "maxSpeedMbps": 10000,
      "poe": { "standard": "802.3at", "type": 2, "enabled": true, "state": "UP", "powerMw": null },
      "nativeVlanId": null, "taggedVlanIds": null,              // reservados
      "rxBytes": null, "txBytes": null, "rxPackets": null, "txPackets": null,
      "rxErrors": null, "txErrors": null, "rxDropped": null, "txDropped": null  // reservados
    }]
  }],
  "networks": [{ "id": "uuid", "name": "Produção", "vlanId": 20, "enabled": true, "management": "GATEWAY", "subnet": "10.20.0.0/24" }]
}
```

### Aplicação pelo worker

A aplicação roda na mesma outbox (`inventory_outbox`) e na mesma transação da projeção de inventário
([`server/network/apply.ts`](../apps/web/src/server/network/apply.ts)):

- **Captura mais nova que a aplicada** (`sequence` maior): substitui as portas de cada dispositivo cujas portas
  foram lidas, o catálogo de VLANs (quando `networks` veio) e as ligações `unifi_uplink` dos dispositivos com
  detalhe lido. Também grava `assets.network_features` e `assets.ports_observed_at`.
- **Captura atrasada** (reenvio fora de ordem): não mexe no estado atual, mas entra na série de tráfego, porque cada
  amostra tem o próprio instante.
- **Idempotência**: chaves primárias por instante (`traffic_samples`, `port_counter_readings`) e `ON CONFLICT DO NOTHING`.

### Taxa a partir de contadores

[`server/network/rates.ts`](../apps/web/src/server/network/rates.ts):

- taxa = Δbytes × 8 / Δs, registrada no instante final do intervalo;
- contador menor que o anterior: estouro de 32 bits se o anterior cabia em 32 bits e a volta é plausível para o
  intervalo; estouro de 64 bits perto do teto; senão é **reinício** e a amostra é descartada;
- intervalo ≤ 0 (fora de ordem ou repetido), acima de 1 h (lacuna) ou taxa acima de 400 Gbps: descartada;
- leitura atrasada: as leituras brutas ficam em `port_counter_readings` e a série é recalculada numa janela de ±2 h,
  então a leitura do meio divide o intervalo entre as vizinhas.

## Banco (migração `012_dados_rede.sql`)

Todas com `org_id`, chave composta por fazenda, RLS habilitada e forçada (`org_scope`) e grants em
`runtime-grants.sql`. **O integrador pode renumerar a migração** se outra frente usar o 012.

| Tabela | Conteúdo |
| --- | --- |
| `device_ports` | Estado mais recente por porta (`org_id, farm_id, asset_id, idx`), PoE, VLANs, contadores e última taxa. |
| `network_vlans` | Catálogo de redes por fazenda (`id` do UniFi, nome, VLAN, sub-rede `cidr`). |
| `port_counter_readings` | Leituras brutas de contador, para o recálculo fora de ordem. Retenção: 2 dias. |
| `traffic_samples` | Série temporal. `kind` `uplink` (porta 0, taxa do UniFi) ou `port`; `source` `unifi_rate`, `counter_delta` ou `synthetic`; `interval_seconds` para estimar volume. Retenção: 30 dias. |
| `network_links` | Ligação do dispositivo a jusante (`from`) ao a montante (`to`). `level = 'port'` só com as duas portas preenchidas (CHECK). `evidence`: `unifi_uplink`, `lldp`, `synthetic`. |

Colunas novas: `capture_batches.networks` (jsonb), `capture_batches.payload_bytes` (tamanho do corpo assinado),
`assets.network_features`, `assets.ports_observed_at`. A retenção roda no `applyRetention` do worker, de hora em hora.

## API GET `/api/network/*`

Todas exigem sessão (no demo, o usuário demo). Rodam com o grupo fixado (RLS) e filtram pelas fazendas do usuário.
**Fazenda ou ativo fora do escopo, de outro grupo ou com id inválido responde 404**, igual a inexistente. Parâmetros
inválidos respondem 400 com `{ "error": "Parâmetros inválidos." }`. Respostas com `Cache-Control: no-store`. Datas em
ISO 8601 UTC; taxas em bits/s; volumes em bytes.

### `GET /api/network/topology?farmId=<uuid>`

Grafo da fazenda. Nós: ativos não arquivados com origem UniFi, com portas ou com ligação (até 2.000; `truncated`
indica corte). Arestas: só entre nós devolvidos.

```jsonc
{
  "farmId": "uuid", "generatedAt": "…", "truncated": false,
  "nodes": [{ "assetId": "uuid", "name": "Switch do escritório", "role": "switch", // gateway | switch | ap | radio | other
    "vendor": "Ubiquiti", "model": "UniFi USW Pro 24 PoE", "ip": "10.60.1.2", "mac": "02:00:…", "status": "online", // online | offline | unknown
    "critical": true, "lastObservedAt": "…", "ports": { "total": 26, "up": 18 }, // null = portas nunca lidas
    "uplink": { "rxBps": 120000000, "txBps": 38000000, "observedAt": "…" } }],    // null = sem amostra
  "edges": [{ "from": "uuid-jusante", "to": "uuid-montante", "level": "device", // device | port
    "evidence": "unifi_uplink", "fromPortIdx": null, "toPortIdx": null,         // portas só quando level = port
    "firstSeenAt": "…", "lastSeenAt": "…", "synthetic": false }]
}
```

`status` usa a mesma regra do inventário (observação recente do coletor ativo em contato; senão `unknown`). `role`
vem dos recursos UniFi (`accessPoint`, `switching`), do modelo (UDM/UCG/USG… = gateway) e do catálogo.

### `GET /api/network/devices/<assetId>/ports`

```jsonc
{ "assetId": "uuid", "farmId": "uuid", "name": "Switch", "role": "switch",
  "ports": [{ // null = nunca lidas; [] = lidas e sem portas
    "idx": 1, "name": "Porta 1", "state": "UP", "connector": "SFPPLUS", "speedMbps": 10000, "maxSpeedMbps": 10000,
    "poe": { "standard": "802.3at", "enabled": true, "state": "UP", "powerMw": null }, // null sem PoE
    "nativeVlan": { "vlanId": 20, "name": "Produção" }, "taggedVlans": [{ "vlanId": 30, "name": "Visitantes" }],
    "rxBps": null, "txBps": null, // só com contadores
    "counters": null,             // { rxBytes, txBytes, rxPackets, txPackets, rxErrors, txErrors, rxDropped, txDropped }
    "observedAt": "…", "synthetic": false }] }
```

### `GET /api/network/vlans?farmId=<uuid>&limit=100&cursor=<n>`

`farmId` opcional (sem ele, todas as fazendas do escopo). `limit` 1–200 (padrão 100). `cursor` é o `nextCursor`
anterior (opaco).

```jsonc
{ "items": [{ "farmId": "uuid", "farmName": "Fazenda Cerrado Alto", "id": "…", "name": "Produção", "vlanId": 20,
    "subnet": "10.60.20.0/24", "enabled": true, "management": "GATEWAY", "nativePorts": 5, "taggedPorts": 3,
    "observedAt": "…", "synthetic": true }],
  "total": 30, "nextCursor": "100" }
```

### `GET /api/network/traffic?farmId=<uuid>[&assetId=<uuid>[&portIdx=<n>]][&period=24h|7d|30d | &from=…&to=…]`

- sem `assetId`: tráfego da **fazenda** = soma dos uplinks dos dispositivos raiz (sem ligação a montante);
- com `assetId`: uplink do dispositivo; com `portIdx` (exige `assetId`): série da porta;
- `period` padrão `24h`; ou `from`/`to` ISO com fuso, até **31 dias**, sem futuro; `period` junto de `from/to` é 400;
- agrupamento automático (≤ 500 pontos): 24 h → 300 s, 7 d → 3.600 s, 30 d → 21.600 s.

```jsonc
{ "scope": { "farmId": "uuid", "assetId": null, "portIdx": null, "kind": "farm" }, // farm | uplink | port
  "from": "…", "to": "…", "bucketSeconds": 3600, "sources": ["unifi_rate"],          // ou counter_delta, synthetic
  "points": [{ "t": "início do intervalo", "rxBps": 123, "txBps": 45, "rxMaxBps": 300, "txMaxBps": 90,
    "rxBytes": 55000000, "txBytes": 20000000, "samples": 4 }] }
```

Intervalos sem amostra não aparecem em `points` (a tela deve mostrar lacuna, não zero). O volume é estimado por
amostra como taxa × `interval_seconds` / 8 (300 s para a taxa do UniFi, o intervalo real para contadores).

### `GET /api/network/geo?period=24h|7d|30d`

Fazendas do escopo com coordenadas (migração 008; `null` quando não cadastradas) e indicadores do período.

```jsonc
{ "period": "7d", "from": "…", "to": "…",
  "farms": [{ "farmId": "uuid", "name": "Fazenda Cerrado Alto", "location": "Rio Verde · GO", "latitude": -17.792, "longitude": -50.919,
    "metrics": { "trafficRxBytes": 0, "trafficTxBytes": 0, "offlineAssets": 0, "assets": 4, "openOccurrences": 0,
      "collector": { "captures": 168, "batches": 168, "payloadBytes": 1800000, "lastCaptureAt": "…" } }, // null sem coletor ativo
    "synthetic": true }] }
```

`payloadBytes` soma o corpo assinado dos lotes recebidos no período (lotes anteriores à migração contam 0).

## Demo (`MALHA_MODE=demo`)

[`packages/db/demo-network.sql`](../packages/db/demo-network.sql) roda depois do `demo.sql`. Tudo é **fictício**:
quatro fazendas novas (Rio Verde · GO, Luís Eduardo Magalhães · BA, Dourados · MS, Cascavel · PR) além das três de
MT, com gateway, switches e APs, portas com PoE e VLANs, ligações porta a porta e entre dispositivos, 7 dias de
tráfego a cada 15 minutos com ciclo diário, capturas de hora em hora e uma ocorrência aberta. As linhas levam
`synthetic = true` (portas, VLANs), `evidence = 'synthetic'` (ligações) ou `source = 'synthetic'` (tráfego), e a API
devolve `synthetic: true` para a tela rotular os dados como fictícios. A Fazenda Santa Luzia fica sem VLANs nem
portas para exercitar os estados vazios.

## Para as telas

- Toda visualização precisa de alternativa em tabela; os campos acima já vêm prontos para isso.
- Mostre o nível da ligação: "porta a porta" só com `level = 'port'`; caso contrário "ligação entre dispositivos".
- Rotule `synthetic: true` como dado fictício. `null` é "não lido", não zero.
