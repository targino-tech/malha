-- Dados de rede (feat/dados-rede): portas por dispositivo, VLANs por fazenda, série de tráfego e ligações com evidência.
-- Todas as tabelas têm org_id, chave composta por fazenda e RLS forçada com a política org_scope.

-- Redes do site recebidas na primeira parte de cada captura (schemaVersion 2). Nulo significa "não lidas".
ALTER TABLE capture_batches ADD COLUMN networks jsonb;
-- Tamanho do corpo assinado recebido, para medir o volume enviado por coletor e período. Nulo em lotes antigos.
ALTER TABLE capture_batches ADD COLUMN payload_bytes integer CHECK (payload_bytes >= 0);
CREATE INDEX capture_batches_received ON capture_batches (org_id, farm_id, received_at);

-- Recursos UniFi do dispositivo (ex.: switching, accessPoint), usados para inferir o papel na topologia.
ALTER TABLE assets ADD COLUMN network_features text[];
-- Instante da última leitura de portas: distingue "sem portas" (lista vazia lida) de "portas nunca lidas".
ALTER TABLE assets ADD COLUMN ports_observed_at timestamptz;

-- Estado mais recente de cada porta física. Substituído só por captura mais nova que a aplicada.
CREATE TABLE device_ports (
  org_id uuid NOT NULL,
  farm_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  idx integer NOT NULL CHECK (idx BETWEEN 0 AND 10000),
  name text,
  state text NOT NULL DEFAULT 'UNKNOWN',
  connector text,
  speed_mbps bigint CHECK (speed_mbps >= 0),
  max_speed_mbps bigint CHECK (max_speed_mbps >= 0),
  poe_standard text,
  poe_enabled boolean,
  poe_state text,
  poe_power_mw integer CHECK (poe_power_mw >= 0),
  native_vlan_id integer CHECK (native_vlan_id BETWEEN 1 AND 4094),
  tagged_vlan_ids integer[],
  -- Contadores acumulados e taxas derivadas: só existem quando a fonte expõe contadores por porta.
  rx_bytes bigint, tx_bytes bigint, rx_packets bigint, tx_packets bigint,
  rx_errors bigint, tx_errors bigint, rx_dropped bigint, tx_dropped bigint,
  rx_bps bigint, tx_bps bigint,
  synthetic boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL,
  collector_id uuid,
  PRIMARY KEY (org_id, farm_id, asset_id, idx),
  FOREIGN KEY (org_id, farm_id, asset_id) REFERENCES assets(org_id, farm_id, id) ON DELETE CASCADE
);

-- Catálogo de redes/VLANs por fazenda, como o console UniFi as declara.
CREATE TABLE network_vlans (
  org_id uuid NOT NULL,
  farm_id uuid NOT NULL,
  id text NOT NULL,
  name text NOT NULL,
  vlan_id integer CHECK (vlan_id BETWEEN 1 AND 4094),
  subnet cidr,
  enabled boolean,
  management text,
  synthetic boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, farm_id, id),
  FOREIGN KEY (org_id, farm_id) REFERENCES farms(org_id, id)
);

-- Leituras brutas de contadores por porta, para calcular taxa por diferença tolerando reenvio fora de ordem.
CREATE TABLE port_counter_readings (
  org_id uuid NOT NULL,
  farm_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  port_idx integer NOT NULL,
  observed_at timestamptz NOT NULL,
  rx_bytes bigint, tx_bytes bigint,
  PRIMARY KEY (org_id, farm_id, asset_id, port_idx, observed_at),
  FOREIGN KEY (org_id, farm_id, asset_id) REFERENCES assets(org_id, farm_id, id) ON DELETE CASCADE
);

-- Série temporal de tráfego. kind 'uplink' usa port_idx 0 e vem da taxa informada pelo UniFi;
-- kind 'port' vem da diferença de contadores (port_idx da porta física). source 'synthetic' marca dados fictícios do demo.
CREATE TABLE traffic_samples (
  org_id uuid NOT NULL,
  farm_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('uplink', 'port')),
  port_idx integer NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL,
  rx_bps bigint NOT NULL CHECK (rx_bps >= 0),
  tx_bps bigint NOT NULL CHECK (tx_bps >= 0),
  interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 1 AND 3600),
  source text NOT NULL CHECK (source IN ('unifi_rate', 'counter_delta', 'synthetic')),
  PRIMARY KEY (org_id, farm_id, asset_id, kind, port_idx, observed_at),
  CHECK (kind = 'port' OR port_idx = 0),
  FOREIGN KEY (org_id, farm_id, asset_id) REFERENCES assets(org_id, farm_id, id) ON DELETE CASCADE
);
CREATE INDEX traffic_samples_by_farm ON traffic_samples (org_id, farm_id, observed_at);

-- Ligações entre ativos. level 'port' exige as duas portas identificadas pela evidência; sem isso a
-- ligação é só entre dispositivos ('device'). evidence diz de onde veio a relação.
CREATE TABLE network_links (
  org_id uuid NOT NULL,
  farm_id uuid NOT NULL,
  from_asset_id uuid NOT NULL,
  to_asset_id uuid NOT NULL,
  evidence text NOT NULL CHECK (evidence IN ('unifi_uplink', 'lldp', 'synthetic')),
  level text NOT NULL CHECK (level IN ('device', 'port')),
  from_port_idx integer,
  to_port_idx integer,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, farm_id, from_asset_id, evidence),
  CHECK (from_asset_id <> to_asset_id),
  CHECK ((level = 'port') = (from_port_idx IS NOT NULL AND to_port_idx IS NOT NULL)),
  FOREIGN KEY (org_id, farm_id, from_asset_id) REFERENCES assets(org_id, farm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, farm_id, to_asset_id) REFERENCES assets(org_id, farm_id, id) ON DELETE CASCADE
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['device_ports', 'network_vlans', 'port_counter_readings', 'traffic_samples', 'network_links']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY org_scope ON %I USING (org_id = nullif(current_setting(''malha.org_id'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''malha.org_id'', true), '''')::uuid)', table_name);
  END LOOP;
END $$;
