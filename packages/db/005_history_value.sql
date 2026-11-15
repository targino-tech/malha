-- Histórico de observações por ativo. Uma linha por ativo e captura completa, inclusive reenvios atrasados.
CREATE TABLE asset_observations (
  org_id uuid NOT NULL,
  farm_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  capture_id uuid NOT NULL,
  collector_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('online', 'offline', 'unknown')),
  ip text,
  firmware text,
  PRIMARY KEY (org_id, asset_id, capture_id),
  FOREIGN KEY (org_id, farm_id, asset_id) REFERENCES assets(org_id, farm_id, id) ON DELETE CASCADE
);
CREATE INDEX asset_observations_timeline ON asset_observations (org_id, asset_id, observed_at DESC);
CREATE INDEX asset_observations_retention ON asset_observations (org_id, observed_at);
CREATE INDEX capture_batches_retention ON capture_batches (org_id, received_at);

-- Conciliação: quem conferiu o ativo e quais vínculos automáticos foram rejeitados pelo técnico.
ALTER TABLE assets ADD COLUMN reviewed_at timestamptz;
ALTER TABLE assets ADD COLUMN reviewed_by text;
ALTER TABLE assets ADD COLUMN rejected_external_ids text[] NOT NULL DEFAULT '{}';

-- Atendimentos registrados pela TI e linha de base definida antes do piloto.
CREATE TABLE service_records (
  org_id uuid NOT NULL,
  farm_id uuid NOT NULL,
  id uuid NOT NULL,
  occurrence_id uuid,
  asset_id uuid,
  actor text NOT NULL,
  attended_at timestamptz NOT NULL,
  diagnosis_minutes integer NOT NULL CHECK (diagnosis_minutes BETWEEN 0 AND 10080),
  trip_avoided boolean NOT NULL,
  notes text CHECK (length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, farm_id) REFERENCES farms(org_id, id),
  FOREIGN KEY (org_id, occurrence_id) REFERENCES occurrences(org_id, id),
  FOREIGN KEY (org_id, farm_id, asset_id) REFERENCES assets(org_id, farm_id, id)
);
CREATE INDEX service_records_period ON service_records (org_id, attended_at DESC);

CREATE TABLE baselines (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  diagnosis_minutes integer NOT NULL CHECK (diagnosis_minutes BETWEEN 0 AND 10080),
  travel_hours numeric(6, 2) NOT NULL CHECK (travel_hours >= 0),
  cost_per_hour numeric(10, 2) NOT NULL CHECK (cost_per_hour >= 0),
  cost_per_trip numeric(10, 2) NOT NULL CHECK (cost_per_trip >= 0),
  defined_at timestamptz NOT NULL DEFAULT now(),
  defined_by text NOT NULL
);

CREATE INDEX audit_log_recent ON audit_log (org_id, occurred_at DESC, id DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['asset_observations', 'service_records', 'baselines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY org_scope ON %I USING (org_id = nullif(current_setting(''malha.org_id'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''malha.org_id'', true), '''')::uuid)', table_name);
  END LOOP;
END $$;
