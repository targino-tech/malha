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
