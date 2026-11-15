-- Canais de notificação por grupo (Telegram e e-mail) com roteamento por fazenda, regra e severidade.
-- O token do bot do Telegram fica cifrado (AES-256-GCM, mesma cifra dos tokens de monitoramento) e
-- só a dica mascarada volta para a interface. Os destinatários legados (alert_recipients) continuam valendo.
CREATE TABLE notification_channels (
  org_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('telegram', 'email')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  enabled boolean NOT NULL DEFAULT true,
  -- Nulo significa todas as fazendas e todas as regras do grupo.
  farm_ids uuid[] CHECK (farm_ids IS NULL OR cardinality(farm_ids) BETWEEN 1 AND 500),
  rules text[] CHECK (rules IS NULL OR (cardinality(rules) >= 1
    AND rules <@ ARRAY['collector_silent', 'capture_stale', 'asset_offline', 'asset_missing']::text[])),
  min_severity text NOT NULL DEFAULT 'critical' CHECK (min_severity IN ('critical', 'warning')),
  notify_resolved boolean NOT NULL DEFAULT true,
  rate_limit_per_minute integer NOT NULL DEFAULT 20 CHECK (rate_limit_per_minute BETWEEN 1 AND 120),
  telegram_chat_id text CHECK (telegram_chat_id IS NULL OR char_length(telegram_chat_id) <= 64),
  telegram_token text,
  token_hint text CHECK (token_hint IS NULL OR char_length(token_hint) <= 32),
  recipients text[] CHECK (recipients IS NULL OR cardinality(recipients) BETWEEN 1 AND 50),
  -- Só ocorrências abertas depois deste instante são roteadas: reativar ou mudar filtros não reenvia o passado.
  active_since timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CHECK (kind <> 'telegram' OR (telegram_chat_id IS NOT NULL AND telegram_token IS NOT NULL AND recipients IS NULL)),
  CHECK (kind <> 'email' OR (recipients IS NOT NULL AND telegram_chat_id IS NULL AND telegram_token IS NULL))
);

-- Outbox de entregas: uma linha por ocorrência, canal e evento (abertura, encerramento ou teste).
-- A chave de idempotência impede envio duplicado entre réplicas do worker e reavaliações.
CREATE TABLE notification_deliveries (
  org_id uuid NOT NULL,
  id uuid NOT NULL,
  channel_id uuid NOT NULL,
  occurrence_id uuid,
  farm_id uuid,
  event text NOT NULL CHECK (event IN ('opened', 'resolved', 'test')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) <= 200),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'suppressed', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  -- Mensagens enviadas juntas (agrupadas por fazenda) compartilham o lote; o limite por canal conta lotes.
  batch_id uuid,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (org_id, channel_id) REFERENCES notification_channels(org_id, id),
  FOREIGN KEY (org_id, occurrence_id) REFERENCES occurrences(org_id, id),
  FOREIGN KEY (org_id, farm_id) REFERENCES farms(org_id, id),
  CHECK ((event = 'test') = (occurrence_id IS NULL))
);
CREATE INDEX notification_deliveries_pending ON notification_deliveries (org_id, available_at) WHERE status = 'pending';
CREATE INDEX notification_deliveries_recent ON notification_deliveries (org_id, created_at DESC);
CREATE INDEX notification_deliveries_channel_sent ON notification_deliveries (org_id, channel_id, sent_at) WHERE sent_at IS NOT NULL;
CREATE INDEX occurrence_events_recent ON occurrence_events (org_id, occurred_at) WHERE kind IN ('opened', 'resolved');

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['notification_channels', 'notification_deliveries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY org_scope ON %I USING (org_id = nullif(current_setting(''malha.org_id'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''malha.org_id'', true), '''')::uuid)', table_name);
  END LOOP;
END $$;
