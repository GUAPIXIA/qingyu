CREATE TABLE cached_sessions (
  space_id uuid NOT NULL, session_id text NOT NULL, revision bigint NOT NULL,
  payload jsonb NOT NULL, updated_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY (space_id, session_id)
);
CREATE TABLE cached_messages (
  space_id uuid NOT NULL, session_id text NOT NULL, message_id text NOT NULL, revision bigint NOT NULL,
  payload jsonb NOT NULL, updated_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY (space_id, session_id, message_id)
);
CREATE INDEX cached_messages_session_idx ON cached_messages(space_id, session_id, updated_at DESC);
CREATE TABLE cached_resources (
  space_id uuid NOT NULL, resource_type text NOT NULL, resource_id text NOT NULL,
  revision bigint NOT NULL, payload jsonb NOT NULL, updated_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY (space_id, resource_type, resource_id)
);
CREATE TABLE relay_commands (
  id uuid NOT NULL, space_id uuid NOT NULL, device_id uuid NOT NULL, session_id text,
  command_type text NOT NULL, payload jsonb NOT NULL, status text NOT NULL,
  expires_at timestamptz NOT NULL, result_status integer, result_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  PRIMARY KEY (space_id, id),
  FOREIGN KEY (space_id, device_id) REFERENCES relay_devices(space_id, id)
);
CREATE TABLE relay_events (
  space_id uuid NOT NULL, seq bigint NOT NULL, event_type text NOT NULL,
  payload jsonb NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, seq)
);
