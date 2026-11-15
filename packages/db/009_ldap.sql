-- Login por diretório (Active Directory ou outro LDAP), ao lado do Microsoft Entra ID.
-- O identificador estável do usuário no diretório (objectGUID do AD, entryUUID do OpenLDAP) é um UUID
-- e ocupa a mesma coluna de associação usada pelo Entra (memberships.entra_oid).
CREATE TABLE ldap_directories (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  domain text UNIQUE NOT NULL CHECK (domain ~ '^[a-z0-9][a-z0-9.-]{1,251}[a-z0-9]$'),
  url text NOT NULL,
  start_tls boolean NOT NULL DEFAULT false,
  base_dn text NOT NULL CHECK (char_length(base_dn) BETWEEN 3 AND 500),
  bind_dn text NOT NULL CHECK (char_length(bind_dn) BETWEEN 3 AND 500),
  bind_secret text NOT NULL,
  user_attribute text NOT NULL DEFAULT 'sAMAccountName' CHECK (user_attribute ~ '^[A-Za-z][A-Za-z0-9-]{0,63}$'),
  id_attribute text NOT NULL DEFAULT 'objectGUID' CHECK (id_attribute IN ('objectGUID', 'entryUUID')),
  ca_pem text,
  enabled boolean NOT NULL DEFAULT true,
  -- Só conexões cifradas: ldaps://, ou ldap:// obrigatoriamente com StartTLS.
  CHECK (url ~ '^ldaps://' OR (url ~ '^ldap://' AND start_tls))
);

CREATE TABLE login_attempts (
  client_hash text NOT NULL,
  subject_hash text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_client ON login_attempts (client_hash, attempted_at DESC);
CREATE INDEX login_attempts_subject ON login_attempts (subject_hash, attempted_at DESC);
