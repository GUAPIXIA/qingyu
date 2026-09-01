CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE relay_spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK (status IN ('active', 'disabled', 'deleted')) DEFAULT 'active',
  owner_pc_id uuid,
  quota_bytes bigint NOT NULL DEFAULT 524288000,
  retention_days integer NOT NULL DEFAULT 7,
  event_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE relay_devices (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES relay_spaces(id),
  role text NOT NULL CHECK (role IN ('pc', 'android')),
  name text NOT NULL,
  fingerprint_hash bytea NOT NULL,
  token_version integer NOT NULL DEFAULT 1,
  approved_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (space_id, id)
);
ALTER TABLE relay_spaces ADD CONSTRAINT relay_spaces_owner_fk
  FOREIGN KEY (id, owner_pc_id) REFERENCES relay_devices(space_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE relay_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL,
  device_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  replaced_by uuid REFERENCES relay_refresh_tokens(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (space_id, device_id) REFERENCES relay_devices(space_id, id)
);

CREATE TABLE relay_pair_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES relay_spaces(id),
  code_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  claimed_device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
