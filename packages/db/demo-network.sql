-- DADOS FICTÍCIOS (sintéticos) de rede para o modo demo. Nenhum nome, IP ou medição vem de cliente real.
-- Portas, VLANs, ligações e tráfego ficam marcados com synthetic = true ou source = 'synthetic'.
-- Fazendas novas em vários estados, com coordenadas plausíveis de municípios agrícolas, e 7 dias de tráfego.

INSERT INTO farms (org_id, id, name, location, latitude, longitude, timezone) VALUES
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000104', 'Fazenda Cerrado Alto', 'Rio Verde · GO', -17.792, -50.919, 'America/Sao_Paulo'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000105', 'Fazenda Rio Claro', 'Luís Eduardo Magalhães · BA', -12.096, -45.786, 'America/Bahia'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000106', 'Fazenda Campo Bom', 'Dourados · MS', -22.221, -54.806, 'America/Campo_Grande'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000107', 'Fazenda Três Pinheiros', 'Cascavel · PR', -24.956, -53.455, 'America/Sao_Paulo');

INSERT INTO collector_keys (key_id, collector_id, org_id, farm_id, public_key)
SELECT ('00000000-0000-4000-8000-00000000020' || n)::uuid, ('00000000-0000-4000-8000-00000000030' || n)::uuid,
  '00000000-0000-4000-8000-000000000001', ('00000000-0000-4000-8000-00000000010' || n)::uuid, '{}'
FROM generate_series(4, 7) AS n;

INSERT INTO collector_health (org_id, farm_id, collector_id, last_heartbeat_at, last_capture_at, healthy, version, queue_depth, last_sequence)
SELECT '00000000-0000-4000-8000-000000000001', ('00000000-0000-4000-8000-00000000010' || n)::uuid, ('00000000-0000-4000-8000-00000000030' || n)::uuid,
  now(), now() - interval '2 minutes', true, 'demo', 0, 168
FROM generate_series(4, 7) AS n;

-- Dispositivos de rede fictícios. parent/parent_port/own_port descrevem a árvore de uplink sintética.
CREATE TEMP TABLE demo_network_devices (
  farm_id uuid, asset_id uuid, name text, category text, model text, ip text, mac text, features text[], role text,
  parent uuid, parent_port int, own_port int, ports int, base_mbps numeric, status text, critical boolean, add_asset boolean
) ON COMMIT DROP;

INSERT INTO demo_network_devices VALUES
  -- Fazenda Vale Verde (ativos já existentes no demo.sql: só ganham portas, ligações e tráfego).
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000406', NULL, NULL, NULL, NULL, NULL, '{}', 'gateway', NULL, NULL, NULL, 5, 180, 'online', true, false),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000404', NULL, NULL, NULL, NULL, NULL, '{switching}', 'switch', '00000000-0000-4000-8000-000000000406', 2, 1, 16, 90, 'offline', true, false),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000405', NULL, NULL, NULL, NULL, NULL, '{accessPoint}', 'ap', '00000000-0000-4000-8000-000000000404', 5, 1, 1, 25, 'online', true, false),
  -- Fazenda Cerrado Alto · GO
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000501', 'Gateway da sede', 'Gateway', 'UniFi Cloud Gateway Max', '10.60.1.1', '02:00:00:3c:01:01', '{}', 'gateway', NULL, NULL, NULL, 5, 260, 'online', true, true),
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000502', 'Switch do escritório', 'Switch', 'UniFi USW Pro 24 PoE', '10.60.1.2', '02:00:00:3c:01:02', '{switching}', 'switch', '00000000-0000-4000-8000-000000000501', 2, 25, 26, 140, 'online', true, true),
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000503', 'AP da sede', 'Ponto de acesso', 'UniFi U7 Pro', '10.60.1.11', '02:00:00:3c:01:0b', '{accessPoint}', 'ap', '00000000-0000-4000-8000-000000000502', 3, 1, 1, 45, 'online', false, true),
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000504', 'AP do armazém', 'Ponto de acesso', 'UniFi U6 Mesh', '10.60.1.12', '02:00:00:3c:01:0c', '{accessPoint}', 'ap', '00000000-0000-4000-8000-000000000502', 4, 1, 1, 30, 'online', false, true),
  -- Fazenda Rio Claro · BA
  ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000511', 'Gateway da unidade', 'Gateway', 'UniFi Dream Machine Pro', '10.61.1.1', '02:00:00:3d:01:01', '{}', 'gateway', NULL, NULL, NULL, 11, 210, 'online', true, true),
  ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000512', 'Switch da oficina', 'Switch', 'UniFi USW Lite 16 PoE', '10.61.1.2', '02:00:00:3d:01:02', '{switching}', 'switch', '00000000-0000-4000-8000-000000000511', 3, 1, 16, 95, 'online', true, true),
  ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000513', 'AP da oficina', 'Ponto de acesso', 'UniFi U6 Pro', '10.61.1.11', '02:00:00:3d:01:0b', '{accessPoint}', 'ap', '00000000-0000-4000-8000-000000000512', 2, 1, 1, 35, 'offline', false, true),
  ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000514', 'AP do refeitório', 'Ponto de acesso', 'UniFi U6 Lite', '10.61.1.12', '02:00:00:3d:01:0c', '{accessPoint}', 'ap', '00000000-0000-4000-8000-000000000512', 5, 1, 1, 20, 'online', false, true),
  -- Fazenda Campo Bom · MS
  ('00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000521', 'Gateway da sede', 'Gateway', 'UniFi Cloud Gateway Ultra', '10.62.1.1', '02:00:00:3e:01:01', '{}', 'gateway', NULL, NULL, NULL, 5, 150, 'online', true, true),
  ('00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000522', 'Switch central', 'Switch', 'UniFi USW Pro 24', '10.62.1.2', '02:00:00:3e:01:02', '{switching}', 'switch', '00000000-0000-4000-8000-000000000521', 2, 25, 26, 110, 'online', true, true),
  ('00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000523', 'Switch do secador', 'Switch', 'UniFi USW Flex', '10.62.1.3', '02:00:00:3e:01:03', '{switching}', 'switch', '00000000-0000-4000-8000-000000000522', 10, 1, 5, 40, 'online', false, true),
  ('00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000524', 'AP do secador', 'Ponto de acesso', 'UniFi U6 Mesh', '10.62.1.11', '02:00:00:3e:01:0b', '{accessPoint}', 'ap', '00000000-0000-4000-8000-000000000523', 2, 1, 1, 18, 'online', false, true),
  ('00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000525', 'AP da portaria', 'Ponto de acesso', 'UniFi U6 Lite', '10.62.1.12', '02:00:00:3e:01:0c', '{accessPoint}', 'ap', '00000000-0000-4000-8000-000000000522', 3, 1, 1, 15, 'online', true, true),
  -- Fazenda Três Pinheiros · PR
  ('00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000531', 'Gateway da cooperativa', 'Gateway', 'UniFi Dream Machine SE', '10.63.1.1', '02:00:00:3f:01:01', '{}', 'gateway', NULL, NULL, NULL, 9, 320, 'online', true, true),
  ('00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000532', 'Switch do galpão', 'Switch', 'UniFi USW Pro 48 PoE', '10.63.1.2', '02:00:00:3f:01:02', '{switching}', 'switch', '00000000-0000-4000-8000-000000000531', 2, 49, 52, 170, 'online', true, true),
  ('00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000533', 'Switch da balança', 'Switch', 'UniFi USW Lite 8 PoE', '10.63.1.3', '02:00:00:3f:01:03', '{switching}', 'switch', '00000000-0000-4000-8000-000000000532', 12, 1, 8, 35, 'offline', true, true),
  ('00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000534', 'AP do galpão', 'Ponto de acesso', 'UniFi U7 Pro', '10.63.1.11', '02:00:00:3f:01:0b', '{accessPoint}', 'ap', '00000000-0000-4000-8000-000000000532', 3, 1, 1, 50, 'online', false, true),
  ('00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000535', 'AP do escritório', 'Ponto de acesso', 'UniFi U6 Pro', '10.63.1.12', '02:00:00:3f:01:0c', '{accessPoint}', 'ap', '00000000-0000-4000-8000-000000000532', 4, 1, 1, 30, 'online', false, true);

INSERT INTO assets (org_id, farm_id, id, name, category, ip, mac, critical, source, external_id, model, firmware, status, last_observed_at, last_collector_id, network_features)
SELECT '00000000-0000-4000-8000-000000000001', d.farm_id, d.asset_id, d.name, d.category, d.ip, d.mac, d.critical, 'unifi',
  'demo-' || right(d.asset_id::text, 3), d.model, '7.4.1', d.status, now() - interval '2 minutes',
  ('00000000-0000-4000-8000-00000000030' || right(d.farm_id::text, 1))::uuid, nullif(d.features, '{}')
FROM demo_network_devices d WHERE d.add_asset;

UPDATE assets a SET network_features = nullif(d.features, '{}')
FROM demo_network_devices d WHERE NOT d.add_asset AND a.org_id = '00000000-0000-4000-8000-000000000001' AND a.id = d.asset_id;

-- Catálogo de VLANs fictício por fazenda (a Santa Luzia fica sem VLANs para exercitar o estado vazio).
INSERT INTO network_vlans (org_id, farm_id, id, name, vlan_id, subnet, enabled, management, synthetic, observed_at)
SELECT '00000000-0000-4000-8000-000000000001', f.farm_id, 'demo-' || f.octet || '-' || v.vlan, v.name, v.vlan,
  ('10.' || f.octet || '.' || v.vlan || '.0/24')::cidr, v.vlan <> 99, 'GATEWAY', true, now() - interval '2 minutes'
FROM (VALUES ('00000000-0000-4000-8000-000000000102'::uuid, 42), ('00000000-0000-4000-8000-000000000104'::uuid, 60),
  ('00000000-0000-4000-8000-000000000105'::uuid, 61), ('00000000-0000-4000-8000-000000000106'::uuid, 62),
  ('00000000-0000-4000-8000-000000000107'::uuid, 63)) AS f(farm_id, octet)
CROSS JOIN (VALUES (10, 'Gestão'), (20, 'Produção'), (30, 'Wi-Fi visitantes'), (40, 'CFTV'), (50, 'IoT de campo'), (99, 'Reserva desativada')) AS v(vlan, name);

-- Portas fictícias: uplink em SFP+ (10 Gbps) nos switches, demais em RJ45 com PoE nas portas de acesso.
INSERT INTO device_ports (org_id, farm_id, asset_id, idx, name, state, connector, speed_mbps, max_speed_mbps, poe_standard, poe_enabled, poe_state,
  poe_power_mw, native_vlan_id, tagged_vlan_ids, rx_bytes, tx_bytes, rx_packets, tx_packets, rx_errors, tx_errors, rx_dropped, tx_dropped,
  rx_bps, tx_bps, synthetic, observed_at, collector_id)
SELECT '00000000-0000-4000-8000-000000000001', d.farm_id, d.asset_id, p.idx, 'Porta ' || p.idx,
  CASE WHEN d.status = 'offline' THEN 'DOWN' WHEN p.idx = d.own_port OR p.idx IN (SELECT c.parent_port FROM demo_network_devices c WHERE c.parent = d.asset_id)
    OR p.idx % 3 <> 0 THEN 'UP' ELSE 'DOWN' END,
  CASE WHEN d.role = 'switch' AND p.idx = d.own_port AND d.ports > 16 THEN 'SFPPLUS' ELSE 'RJ45' END,
  CASE WHEN d.status = 'offline' OR (p.idx % 3 = 0 AND p.idx <> coalesce(d.own_port, -1)) THEN NULL
    WHEN d.role = 'switch' AND p.idx = d.own_port AND d.ports > 16 THEN 10000 ELSE 1000 END,
  CASE WHEN d.role = 'switch' AND p.idx = d.own_port AND d.ports > 16 THEN 10000 WHEN d.role = 'ap' THEN 2500 ELSE 1000 END,
  CASE WHEN d.role = 'switch' AND p.idx <> d.own_port THEN '802.3at' END,
  CASE WHEN d.role = 'switch' AND p.idx <> d.own_port THEN true END,
  CASE WHEN d.role = 'switch' AND p.idx <> d.own_port THEN CASE WHEN p.idx % 3 = 0 THEN 'OFF' ELSE 'UP' END END,
  CASE WHEN d.role = 'switch' AND p.idx <> d.own_port AND p.idx % 3 <> 0 THEN 4000 + (p.idx * 731) % 9000 END,
  CASE WHEN p.idx = d.own_port OR d.role = 'gateway' AND p.idx = 1 THEN 10 ELSE (ARRAY[10, 20, 40, 50])[1 + p.idx % 4] END,
  CASE WHEN p.idx = d.own_port OR p.idx IN (SELECT c.parent_port FROM demo_network_devices c WHERE c.parent = d.asset_id) THEN ARRAY[20, 30, 40, 50] END,
  (d.base_mbps * 1e6 / 8 * 86400 * 6 * (1 + p.idx % 5))::bigint, (d.base_mbps * 1e6 / 8 * 86400 * 2 * (1 + p.idx % 3))::bigint,
  (d.base_mbps * 9e5 * (1 + p.idx))::bigint, (d.base_mbps * 4e5 * (1 + p.idx))::bigint,
  (p.idx * 7) % 13, (p.idx * 3) % 5, (p.idx * 11) % 17, (p.idx * 5) % 7,
  CASE WHEN d.status <> 'offline' AND p.idx % 3 <> 0 THEN (d.base_mbps * 1e6 / (1 + p.idx))::bigint END,
  CASE WHEN d.status <> 'offline' AND p.idx % 3 <> 0 THEN (d.base_mbps * 3e5 / (1 + p.idx))::bigint END,
  true, now() - interval '2 minutes', ('00000000-0000-4000-8000-00000000030' || right(d.farm_id::text, 1))::uuid
FROM demo_network_devices d CROSS JOIN LATERAL generate_series(1, d.ports) AS p(idx);

-- Ligações fictícias: switch ao gateway porta a porta (as duas portas conhecidas no dado sintético) e
-- APs/switches de borda só no nível de dispositivo, para exercitar os dois níveis de evidência.
INSERT INTO network_links (org_id, farm_id, from_asset_id, to_asset_id, evidence, level, from_port_idx, to_port_idx, first_seen_at, last_seen_at)
SELECT '00000000-0000-4000-8000-000000000001', d.farm_id, d.asset_id, d.parent, 'synthetic',
  CASE WHEN d.role = 'switch' THEN 'port' ELSE 'device' END,
  CASE WHEN d.role = 'switch' THEN d.own_port END, CASE WHEN d.role = 'switch' THEN d.parent_port END,
  now() - interval '30 days', now() - interval '2 minutes'
FROM demo_network_devices d WHERE d.parent IS NOT NULL;

-- 7 dias de tráfego fictício a cada 15 minutos, com ciclo diário (pico à tarde) e variação determinística.
INSERT INTO traffic_samples (org_id, farm_id, asset_id, kind, port_idx, observed_at, rx_bps, tx_bps, interval_seconds, source)
SELECT '00000000-0000-4000-8000-000000000001', d.farm_id, d.asset_id, 'uplink', 0, t.at,
  (d.base_mbps * 1e6 * t.shape)::bigint, (d.base_mbps * 1e6 * 0.32 * t.shape * (1 + 0.2 * sin(t.n / 7.0)))::bigint, 900, 'synthetic'
FROM demo_network_devices d
CROSS JOIN LATERAL (
  SELECT g.n, date_trunc('minute', now()) - make_interval(mins => 15 * g.n) AS at,
    greatest(0.04, 0.18 + 0.72 * greatest(0, sin(pi() * ((extract(hour FROM now() - make_interval(mins => 15 * g.n)) - 6) / 15.0)))
      + 0.08 * sin(g.n * 1.7 + length(d.asset_id::text) + ascii(right(d.asset_id::text, 1)))) AS shape
  FROM generate_series(1, 672) AS g(n)
) t
WHERE d.status <> 'offline' OR t.n > 96;

-- Porta de uplink de cada switch também ganha série por porta (como se a fonte expusesse contadores).
INSERT INTO traffic_samples (org_id, farm_id, asset_id, kind, port_idx, observed_at, rx_bps, tx_bps, interval_seconds, source)
SELECT s.org_id, s.farm_id, s.asset_id, 'port', d.own_port, s.observed_at, s.tx_bps, s.rx_bps, s.interval_seconds, 'synthetic'
FROM traffic_samples s JOIN demo_network_devices d ON d.asset_id = s.asset_id
WHERE s.org_id = '00000000-0000-4000-8000-000000000001' AND s.kind = 'uplink' AND d.role = 'switch';

-- Capturas fictícias de hora em hora para medir o volume enviado pelos coletores das fazendas novas.
INSERT INTO captures (org_id, farm_id, collector_id, id, seq, observed_at, parts, applied_at)
SELECT '00000000-0000-4000-8000-000000000001', ('00000000-0000-4000-8000-00000000010' || f)::uuid, ('00000000-0000-4000-8000-00000000030' || f)::uuid,
  gen_random_uuid(), 169 - h, now() - make_interval(hours => h), 1, now() - make_interval(hours => h)
FROM generate_series(4, 7) AS f CROSS JOIN generate_series(1, 168) AS h;

INSERT INTO capture_batches (org_id, farm_id, collector_id, capture_id, id, part, content_hash, devices, received_at, payload_bytes)
SELECT c.org_id, c.farm_id, c.collector_id, c.id, gen_random_uuid(), 1, 'demo-sintetico', '[]', c.observed_at,
  9000 + (extract(epoch FROM c.observed_at)::bigint % 2500)::int
FROM captures c WHERE c.org_id = '00000000-0000-4000-8000-000000000001' AND c.farm_id IN (
  '00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000107');

-- Uma ocorrência aberta fictícia no switch offline de Três Pinheiros, para o mapa e o painel.
INSERT INTO occurrences (org_id, farm_id, id, rule, resource_kind, resource_id, severity, title, first_observed_at, opened_at)
VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000107', gen_random_uuid(), 'asset_offline', 'asset',
  '00000000-0000-4000-8000-000000000533', 'critical', 'Ativo offline: Switch da balança', now() - interval '26 minutes', now() - interval '24 minutes');
