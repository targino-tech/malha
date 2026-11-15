-- Login por provedores OpenID Connect além do Entra ID (Google Workspace, Okta, Keycloak...).
-- O membro é convidado por e-mail; no primeiro login com e-mail verificado, a identidade (emissor + sub)
-- fica ligada à associação e passa a valer mesmo que o e-mail mude depois.
ALTER TABLE memberships ADD COLUMN invite_email text CHECK (invite_email = lower(invite_email) AND char_length(invite_email) <= 254);
CREATE UNIQUE INDEX memberships_invite_email ON memberships (org_id, invite_email) WHERE invite_email IS NOT NULL;

CREATE TABLE oidc_identities (
  issuer text NOT NULL,
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  org_id uuid NOT NULL,
  entra_oid uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject),
  FOREIGN KEY (org_id, entra_oid) REFERENCES memberships(org_id, entra_oid)
);
