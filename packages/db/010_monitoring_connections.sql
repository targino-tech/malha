-- Conexões do grupo com Zabbix e Grafana para aplicar o monitoramento pela API.
-- O token fica cifrado (AES-256-GCM) e nunca é devolvido à interface.
CREATE TABLE monitoring_connections (
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('zabbix', 'grafana')),
  url text NOT NULL CHECK (url ~ '^https://' AND char_length(url) <= 300),
  token text NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_result jsonb,
  PRIMARY KEY (org_id, kind)
);
ALTER TABLE monitoring_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY org_scope ON monitoring_connections
  USING (org_id = nullif(current_setting('malha.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('malha.org_id', true), '')::uuid);
