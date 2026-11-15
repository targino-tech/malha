-- Apply after the migrations as the schema owner with permission to create roles.
-- Provision the LOGIN separately, then run GRANT malha_runtime TO <app-login>.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'malha_runtime') THEN
    CREATE ROLE malha_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO malha_runtime;
GRANT SELECT ON organizations, memberships, farms, collector_keys, enrollment_codes TO malha_runtime;
GRANT SELECT, INSERT, DELETE ON sessions TO malha_runtime;
GRANT UPDATE (last_seen_at) ON sessions TO malha_runtime;
GRANT INSERT ON collector_keys TO malha_runtime;
GRANT UPDATE (used_key_id) ON enrollment_codes TO malha_runtime;
-- Row locking clauses require UPDATE privilege on at least one column of the selected table.
GRANT UPDATE (name) ON farms TO malha_runtime;
GRANT UPDATE (public_key) ON collector_keys TO malha_runtime;
GRANT SELECT, INSERT, DELETE ON collector_nonces TO malha_runtime;
GRANT SELECT, INSERT, UPDATE ON collector_request_limits, collector_health, assets, imports, captures, inventory_outbox TO malha_runtime;
GRANT SELECT, INSERT ON capture_batches TO malha_runtime;
GRANT INSERT ON audit_log TO malha_runtime;
GRANT SELECT, INSERT, UPDATE ON occurrences, notifications TO malha_runtime;
GRANT SELECT, INSERT ON occurrence_events TO malha_runtime;
GRANT SELECT ON alert_recipients TO malha_runtime;
-- Administração pela interface (Fase 2).
GRANT INSERT ON farms TO malha_runtime;
GRANT UPDATE (location, timezone, latitude, longitude) ON farms TO malha_runtime;
GRANT INSERT, UPDATE (role, active, display_name) ON memberships TO malha_runtime;
GRANT SELECT, INSERT, DELETE ON membership_farms TO malha_runtime;
GRANT SELECT, INSERT ON technical_locations TO malha_runtime;
GRANT INSERT, DELETE ON enrollment_codes TO malha_runtime;
GRANT UPDATE (revoked_at) ON collector_keys TO malha_runtime;
-- Histórico, conciliação, atendimentos e indicadores (Fase 3).
GRANT SELECT, INSERT, UPDATE ON service_records, baselines TO malha_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON asset_observations TO malha_runtime;
GRANT DELETE ON assets, capture_batches TO malha_runtime;
GRANT SELECT ON audit_log TO malha_runtime;
-- O site público grava solicitações e conta envios recentes para o limite por cliente.
GRANT SELECT, INSERT ON site_requests TO malha_runtime;
-- Login por diretório: lê a configuração do grupo e registra tentativas para o limite.
GRANT SELECT ON ldap_directories TO malha_runtime;
GRANT SELECT, INSERT, DELETE ON login_attempts TO malha_runtime;
-- Conexões de monitoramento por grupo (RLS).
GRANT SELECT, INSERT, UPDATE, DELETE ON monitoring_connections TO malha_runtime;
