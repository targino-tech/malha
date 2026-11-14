CREATE TABLE collector_request_limits (
  scope uuid PRIMARY KEY,
  bucket bigint NOT NULL,
  requests integer NOT NULL CHECK (requests > 0)
);
