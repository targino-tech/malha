-- Ocorrências: um episódio aberto por organização, fazenda, regra e recurso.
ALTER TABLE farms ADD COLUMN timezone text NOT NULL DEFAULT 'America/Cuiaba';

-- offline_since guarda a primeira observação offline do episódio para medir o tempo de detecção.
-- missing_captures conta capturas completas consecutivas sem um ativo antes observado.
ALTER TABLE assets ADD COLUMN offline_since timestamptz;
ALTER TABLE assets ADD COLUMN missing_captures integer NOT NULL DEFAULT 0;

CREATE TABLE occurrences (
  org_id uuid NOT NULL REFERENCES organizations(id),
  farm_id uuid NOT NULL,
  id uuid NOT NULL,
  rule text NOT NULL CHECK (rule IN ('collector_silent', 'capture_stale', 'asset_offline', 'asset_missing')),
  resource_kind text NOT NULL CHECK (resource_kind IN ('collector', 'asset')),
  resource_id uuid NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'warning')),
  title text NOT NULL,
  first_observed_at timestamptz,
  opened_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by text,
  resolved_at timestamptz,
  resolution text CHECK (resolution IN ('auto')),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, farm_id) REFERENCES farms(org_id, id),
  CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL)),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);
CREATE UNIQUE INDEX occurrences_one_open ON occurrences (org_id, farm_id, rule, resource_id) WHERE resolved_at IS NULL;
CREATE INDEX occurrences_recent ON occurrences (org_id, opened_at DESC);

CREATE TABLE occurrence_events (
  org_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('opened', 'acknowledged', 'resolved')),
  actor text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, occurrence_id) REFERENCES occurrences(org_id, id)
);
CREATE INDEX occurrence_events_by_occurrence ON occurrence_events (org_id, occurrence_id, occurred_at);

CREATE TABLE alert_recipients (
  org_id uuid NOT NULL REFERENCES organizations(id),
  email text NOT NULL CHECK (email = lower(email) AND length(email) <= 254),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (org_id, email)
);

-- A chave primária é a chave de envio por ocorrência e destinatário.
CREATE TABLE notifications (
  org_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  recipient text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'suppressed', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  PRIMARY KEY (org_id, occurrence_id, recipient),
  FOREIGN KEY (org_id, occurrence_id) REFERENCES occurrences(org_id, id)
);
CREATE INDEX notifications_pending ON notifications (org_id, available_at) WHERE status = 'pending';

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['occurrences', 'occurrence_events', 'alert_recipients', 'notifications']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY org_scope ON %I USING (org_id = nullif(current_setting(''malha.org_id'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''malha.org_id'', true), '''')::uuid)', table_name);
  END LOOP;
END $$;
