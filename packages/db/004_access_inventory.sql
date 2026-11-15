-- Papéis do piloto: admin, TI, técnico de fazenda, diretoria e auditor.
ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check
  CHECK (role IN ('admin', 'ti', 'tecnico', 'diretoria', 'auditor'));
ALTER TABLE memberships ADD COLUMN display_name text CHECK (length(display_name) <= 120);

-- Sem linhas, o membro (exceto técnico) enxerga todas as fazendas do grupo. Com linhas, só as listadas.
-- Como memberships, a tabela é lida antes de o escopo da organização existir e por isso fica sem RLS.
CREATE TABLE membership_farms (
  org_id uuid NOT NULL,
  entra_oid uuid NOT NULL,
  farm_id uuid NOT NULL,
  PRIMARY KEY (org_id, entra_oid, farm_id),
  FOREIGN KEY (org_id, entra_oid) REFERENCES memberships(org_id, entra_oid) ON DELETE CASCADE,
  FOREIGN KEY (org_id, farm_id) REFERENCES farms(org_id, id)
);

CREATE TABLE technical_locations (
  org_id uuid NOT NULL,
  farm_id uuid NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  PRIMARY KEY (org_id, farm_id, id),
  UNIQUE (org_id, farm_id, name),
  FOREIGN KEY (org_id, farm_id) REFERENCES farms(org_id, id)
);

ALTER TABLE assets DROP CONSTRAINT assets_source_check;
ALTER TABLE assets ADD CONSTRAINT assets_source_check CHECK (source IN ('csv', 'unifi', 'manual'));
ALTER TABLE assets ADD COLUMN location_id uuid;
ALTER TABLE assets ADD COLUMN owner text CHECK (length(owner) <= 120);
ALTER TABLE assets ADD COLUMN maintenance_until timestamptz;
ALTER TABLE assets ADD COLUMN archived_at timestamptz;
ALTER TABLE assets ADD CONSTRAINT assets_location_fk
  FOREIGN KEY (org_id, farm_id, location_id) REFERENCES technical_locations(org_id, farm_id, id);
CREATE INDEX assets_listing ON assets (org_id, farm_id, name, id);

ALTER TABLE technical_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE technical_locations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_scope ON technical_locations
  USING (org_id = nullif(current_setting('malha.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('malha.org_id', true), '')::uuid);
