-- Solicitações de contratação enviadas pelo site público.
-- Não pertencem a uma organização: o grupo só existe depois do provisionamento (pnpm db configure).
CREATE TABLE site_requests (
  id uuid PRIMARY KEY,
  plan text NOT NULL CHECK (plan IN ('piloto', 'grupo', 'corporativo')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  email text NOT NULL CHECK (char_length(email) BETWEEN 6 AND 254),
  company text NOT NULL CHECK (char_length(company) BETWEEN 2 AND 160),
  farms integer NOT NULL CHECK (farms BETWEEN 1 AND 500),
  message text CHECK (char_length(message) <= 2000),
  client_hash text NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'provisioned', 'declined')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_requests_client ON site_requests (client_hash, created_at DESC);
CREATE INDEX site_requests_recent ON site_requests (created_at DESC);
