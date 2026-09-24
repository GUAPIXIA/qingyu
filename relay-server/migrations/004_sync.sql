-- 阶段 8 S8-03/S8-05/S8-06：服务器同步与 E2EE 表。
-- 服务端只存密文/元数据/版本向量，无 spaceKey、无明文。
-- 所有租户表启用 RLS；应用角色 NOSUPERUSER NOBYPASSRLS。

-- 空间密钥 epoch（只记状态，无密钥材料）
CREATE TABLE IF NOT EXISTS sync_space_keys (
  space_id uuid PRIMARY KEY REFERENCES relay_spaces(id),
  current_key_epoch integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_key_epochs (
  space_id uuid NOT NULL REFERENCES relay_spaces(id),
  key_epoch integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  PRIMARY KEY (space_id, key_epoch)
);

-- 设备长期公钥（X25519 + Ed25519）；status 流转 pending/approved/revoked
CREATE TABLE IF NOT EXISTS sync_device_keys (
  space_id uuid NOT NULL,
  device_id uuid NOT NULL,
  x25519_public_key text NOT NULL,
  ed25519_public_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'revoked')) DEFAULT 'pending',
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  PRIMARY KEY (space_id, device_id),
  FOREIGN KEY (space_id, device_id) REFERENCES relay_devices(space_id, id)
);

-- 密钥信封：不透明 + 批准设备签名；服务端不可解
CREATE TABLE IF NOT EXISTS sync_key_envelopes (
  space_id uuid NOT NULL,
  key_epoch integer NOT NULL,
  recipient_device_id uuid NOT NULL,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, key_epoch, recipient_device_id)
);

-- 实体 head：同一业务版本允许多 cipher revision；并发业务 head 靠不同 version_hash 共存
CREATE TABLE IF NOT EXISTS sync_entity_heads (
  space_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  version_hash text NOT NULL,
  version jsonb NOT NULL,
  dot_device text NOT NULL,
  dot_counter_text text NOT NULL,
  schema_version integer NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  parent_id text,
  key_epoch integer NOT NULL,
  cipher_revision integer NOT NULL,
  cipher_hash text NOT NULL,
  content_tag text NOT NULL,
  ciphertext text,
  blob_manifest_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, entity_type, entity_id, version_hash, key_epoch, cipher_revision),
  CHECK (dot_counter_text ~ '^(0|[1-9][0-9]*)$'),
  CHECK (char_length(ciphertext) <= 65536 OR ciphertext IS NULL)
);

CREATE INDEX IF NOT EXISTS sync_entity_heads_pull_idx
  ON sync_entity_heads (space_id, created_at, entity_type, entity_id);

-- 变更日志：按 server_seq 拉取
CREATE TABLE IF NOT EXISTS sync_changes (
  space_id uuid NOT NULL,
  server_seq bigserial,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  version_hash text NOT NULL,
  key_epoch integer NOT NULL,
  cipher_revision integer NOT NULL,
  cipher_hash text NOT NULL,
  content_tag text NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, server_seq),
  UNIQUE (space_id, entity_type, entity_id, version_hash, key_epoch, cipher_revision, cipher_hash)
);

CREATE INDEX IF NOT EXISTS sync_changes_seq_idx ON sync_changes (space_id, server_seq);

-- 设备已知向量 / ack
CREATE TABLE IF NOT EXISTS sync_device_acks (
  space_id uuid NOT NULL,
  device_id uuid NOT NULL,
  known_vector jsonb NOT NULL DEFAULT '{}'::jsonb,
  server_seq bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, device_id)
);

-- 幂等批次缓存
CREATE TABLE IF NOT EXISTS sync_batches (
  space_id uuid NOT NULL,
  device_id uuid NOT NULL,
  batch_id text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, device_id, batch_id)
);

-- blob 元数据；对象本体在对象存储
CREATE TABLE IF NOT EXISTS sync_blobs (
  space_id uuid NOT NULL,
  blob_id text NOT NULL,
  manifest jsonb NOT NULL,
  size bigint NOT NULL,
  ref_count integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('pending', 'committed', 'orphan', 'deleted')) DEFAULT 'pending',
  object_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, blob_id)
);

-- 同步会话（prepare/commit 可恢复）
CREATE TABLE IF NOT EXISTS sync_sessions (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL,
  device_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'planned', 'pushing', 'pulling', 'prepared', 'committed', 'aborted', 'expired')),
  protocol_version integer NOT NULL DEFAULT 1,
  known_vector jsonb NOT NULL DEFAULT '{}'::jsonb,
  prepared_receipt jsonb,
  commit_receipt jsonb,
  request_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS sync_sessions_space_idx ON sync_sessions (space_id, device_id, expires_at);

-- 重加密游标（S8-06）
CREATE TABLE IF NOT EXISTS sync_reencrypt_cursors (
  space_id uuid NOT NULL,
  device_id uuid NOT NULL,
  from_key_epoch integer NOT NULL,
  to_key_epoch integer NOT NULL,
  last_entity_type text,
  last_entity_id text,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'aborted')) DEFAULT 'running',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, device_id, from_key_epoch, to_key_epoch)
);

-- 空间配额（覆盖 relay_spaces.quota_bytes 的同步细分）
CREATE TABLE IF NOT EXISTS sync_space_quota (
  space_id uuid PRIMARY KEY REFERENCES relay_spaces(id),
  max_entities bigint NOT NULL DEFAULT 100000,
  max_ciphertext_bytes bigint NOT NULL DEFAULT 524288000,
  max_blob_bytes bigint NOT NULL DEFAULT 67108864,
  max_devices integer NOT NULL DEFAULT 10,
  used_entities bigint NOT NULL DEFAULT 0,
  used_ciphertext_bytes bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS：所有含 space_id 的同步表
DO $$ DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sync_space_keys','sync_key_epochs','sync_device_keys','sync_key_envelopes',
    'sync_entity_heads','sync_changes','sync_device_acks','sync_batches',
    'sync_blobs','sync_sessions','sync_reencrypt_cursors','sync_space_quota'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (space_id = nullif(current_setting(''app.space_id'', true), '''')::uuid) WITH CHECK (space_id = nullif(current_setting(''app.space_id'', true), '''')::uuid)',
      table_name || '_space_policy', table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO qingyu_relay_app;
