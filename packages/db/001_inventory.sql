CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  entra_tenant_id uuid UNIQUE
);

CREATE TABLE memberships (
  org_id uuid NOT NULL REFERENCES organizations(id),
  entra_oid uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'ti', 'diretoria')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (org_id, entra_oid)
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  org_id uuid NOT NULL,
  entra_oid uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, entra_oid) REFERENCES memberships(org_id, entra_oid)
);

CREATE TABLE farms (
  org_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL,
  name text NOT NULL,
  location text NOT NULL,
  PRIMARY KEY (org_id, id)
);

CREATE TABLE collector_keys (
  key_id uuid PRIMARY KEY,
  collector_id uuid UNIQUE NOT NULL,
  org_id uuid NOT NULL,
  farm_id uuid NOT NULL,
  public_key jsonb NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (org_id, farm_id) REFERENCES farms(org_id, id),
  UNIQUE (org_id, farm_id, collector_id)
);
CREATE UNIQUE INDEX collector_keys_one_active_per_farm ON collector_keys (org_id, farm_id) WHERE revoked_at IS NULL;

CREATE TABLE enrollment_codes (
  code_hash text PRIMARY KEY,
  org_id uuid NOT NULL,
  farm_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_key_id uuid REFERENCES collector_keys(key_id),
  FOREIGN KEY (org_id, farm_id) REFERENCES farms(org_id, id)
);

CREATE TABLE collector_nonces (
  key_id uuid NOT NULL,
  nonce uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (key_id, nonce)
);
CREATE INDEX collector_nonces_expiration ON collector_nonces(expires_at);

CREATE TABLE collector_health (
  org_id uuid NOT NULL,
  farm_id uuid NOT NULL,
  collector_id uuid NOT NULL,
  last_heartbeat_at timestamptz,
  version text,
  queue_depth integer,
  healthy boolean,
  last_capture_at timestamptz,
  last_sequence bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, farm_id, collector_id),
  FOREIGN KEY (org_id, farm_id, collector_id) REFERENCES collector_keys(org_id, farm_id, collector_id)
);

CREATE TABLE assets (
  org_id uuid NOT NULL,
  farm_id uuid NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  tag text,
  ip text,
  mac text,
  critical boolean NOT NULL DEFAULT false,
  source text NOT NULL CHECK (source IN ('csv', 'unifi')),
  external_id text,
  model text,
  firmware text,
  last_observed_at timestamptz,
  last_collector_id uuid,
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('online', 'offline', 'unknown')),
  offline_observations integer NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, farm_id, id),
  UNIQUE (org_id, farm_id, tag),
  UNIQUE (org_id, farm_id, external_id),
  FOREIGN KEY (org_id, farm_id) REFERENCES farms(org_id, id)
);
CREATE INDEX assets_mac_lookup ON assets(org_id, farm_id, mac) WHERE mac IS NOT NULL;

CREATE TABLE imports (
  org_id uuid NOT NULL,
  farm_id uuid NOT NULL,
  id uuid NOT NULL,
  actor text NOT NULL,
  rows jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  imported_count integer,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, farm_id) REFERENCES farms(org_id, id)
);

CREATE TABLE captures (
  org_id uuid NOT NULL,
  farm_id uuid NOT NULL,
  collector_id uuid NOT NULL,
  id uuid NOT NULL,
  seq bigint NOT NULL,
  observed_at timestamptz NOT NULL,
  parts integer NOT NULL,
  applied_at timestamptz,
  PRIMARY KEY (org_id, farm_id, collector_id, id),
  UNIQUE (org_id, farm_id, collector_id, seq),
  FOREIGN KEY (org_id, farm_id, collector_id) REFERENCES collector_health(org_id, farm_id, collector_id)
);

CREATE TABLE capture_batches (
  org_id uuid NOT NULL,
  farm_id uuid NOT NULL,
  collector_id uuid NOT NULL,
  capture_id uuid NOT NULL,
  id uuid NOT NULL,
  part integer NOT NULL,
  content_hash text NOT NULL,
  devices jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, farm_id, collector_id, id),
  UNIQUE (org_id, farm_id, collector_id, capture_id, part),
  FOREIGN KEY (org_id, farm_id, collector_id, capture_id) REFERENCES captures(org_id, farm_id, collector_id, id)
);

-- Only routing IDs live in the cross-tenant queue. Payload reads use RLS after the worker sets scope.
CREATE TABLE inventory_outbox (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  farm_id uuid NOT NULL,
  collector_id uuid NOT NULL,
  capture_id uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  failed_at timestamptz,
  UNIQUE (org_id, farm_id, collector_id, capture_id),
  FOREIGN KEY (org_id, farm_id, collector_id, capture_id) REFERENCES captures(org_id, farm_id, collector_id, id)
);
CREATE INDEX inventory_outbox_ready ON inventory_outbox (available_at) WHERE finished_at IS NULL AND failed_at IS NULL;

CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  actor text NOT NULL,
  action text NOT NULL,
  scope jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['farms', 'collector_health', 'assets', 'imports', 'captures', 'capture_batches', 'audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY org_scope ON %I USING (org_id = nullif(current_setting(''malha.org_id'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''malha.org_id'', true), '''')::uuid)', table_name);
  END LOOP;
END $$;
