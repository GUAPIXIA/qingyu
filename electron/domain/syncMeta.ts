import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type ChangeOrigin = 'local' | 'remote' | 'bootstrap'

export interface EntityHeadRow {
  entityType: string
  entityId: string
  versionJson: string
  hash: string
  deleted: number
  payloadRef: string | null
}

export interface ChangeLogRow {
  seq: number
  dotDevice: string
  dotCounter: string
  entityType: string
  entityId: string
  envelope: string
  origin: ChangeOrigin
  recordedAt: number
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS device_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  device_id TEXT NOT NULL,
  next_counter_text TEXT NOT NULL,
  migration_genesis_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_heads (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  version_json TEXT NOT NULL,
  hash TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  payload_ref TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  dot_device TEXT NOT NULL,
  dot_counter TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  envelope TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('local','remote','bootstrap')),
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_change_log_entity ON change_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_change_log_origin ON change_log(origin);

CREATE TABLE IF NOT EXISTS sync_receipts (
  peer_id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL,
  known_vector TEXT NOT NULL,
  committed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  local_envelope TEXT NOT NULL,
  remote_envelope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  discovered_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  path TEXT,
  hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS file_transactions (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('PREPARED','FILES_APPLIED','JOURNAL_COMMITTED','ABORTED')),
  operations_json TEXT NOT NULL,
  old_hashes_json TEXT NOT NULL,
  new_hashes_json TEXT NOT NULL,
  prepared_at INTEGER NOT NULL,
  committed_at INTEGER
);

CREATE TABLE IF NOT EXISTS bootstrap_receipts (
  id TEXT PRIMARY KEY,
  genesis_id TEXT NOT NULL,
  entity_count INTEGER NOT NULL,
  dataset_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`

/**
 * 同步元数据库（业务正文仍在文件系统）。
 */
function mapHead(row: Record<string, unknown>): EntityHeadRow {
  return {
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    versionJson: String(row.version_json),
    hash: String(row.hash),
    deleted: Number(row.deleted),
    payloadRef: row.payload_ref == null ? null : String(row.payload_ref),
  }
}

export class SyncMetaDb {
  private readonly db: DatabaseSync

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true })
    this.db = new DatabaseSync(filePath)
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  get raw(): DatabaseSync {
    return this.db
  }

  getDeviceState(): { deviceId: string; nextCounter: string; genesisId: string | null } | null {
    const row = this.db
      .prepare('SELECT device_id, next_counter_text, migration_genesis_id FROM device_state WHERE id = 1')
      .get() as Record<string, unknown> | undefined
    if (!row) return null
    return {
      deviceId: String(row.device_id),
      nextCounter: String(row.next_counter_text),
      genesisId: row.migration_genesis_id == null ? null : String(row.migration_genesis_id),
    }
  }

  setDeviceState(deviceId: string, nextCounter: string, genesisId?: string | null): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO device_state(id, device_id, next_counter_text, migration_genesis_id, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           device_id = excluded.device_id,
           next_counter_text = excluded.next_counter_text,
           migration_genesis_id = COALESCE(excluded.migration_genesis_id, device_state.migration_genesis_id),
           updated_at = excluded.updated_at`,
      )
      .run(deviceId, nextCounter, genesisId ?? null, now)
  }

  setGenesisId(genesisId: string): void {
    this.db
      .prepare('UPDATE device_state SET migration_genesis_id = ?, updated_at = ? WHERE id = 1')
      .run(genesisId, Date.now())
  }

  upsertHead(row: EntityHeadRow): void {
    this.db
      .prepare(
        `INSERT INTO entity_heads(entity_type, entity_id, version_json, hash, deleted, payload_ref, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET
           version_json = excluded.version_json,
           hash = excluded.hash,
           deleted = excluded.deleted,
           payload_ref = excluded.payload_ref,
           updated_at = excluded.updated_at`,
      )
      .run(row.entityType, row.entityId, row.versionJson, row.hash, row.deleted, row.payloadRef, Date.now())
  }

  getHead(entityType: string, entityId: string): EntityHeadRow | null {
    const row = this.db
      .prepare(
        'SELECT entity_type, entity_id, version_json, hash, deleted, payload_ref FROM entity_heads WHERE entity_type = ? AND entity_id = ?',
      )
      .get(entityType, entityId) as Record<string, unknown> | undefined
    if (!row) return null
    return mapHead(row)
  }

  listHeads(limit = 1000, offset = 0): EntityHeadRow[] {
    const rows = this.db
      .prepare(
        'SELECT entity_type, entity_id, version_json, hash, deleted, payload_ref FROM entity_heads ORDER BY entity_type, entity_id LIMIT ? OFFSET ?',
      )
      .all(limit, offset) as Array<Record<string, unknown>>
    return rows.map(mapHead)
  }

  /** 已删除（tombstone）的 head，用于构建 delete fence */
  listDeletedHeads(limit = 5000): EntityHeadRow[] {
    const rows = this.db
      .prepare(
        `SELECT entity_type, entity_id, version_json, hash, deleted, payload_ref
         FROM entity_heads WHERE deleted = 1 ORDER BY entity_type, entity_id LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>
    return rows.map(mapHead)
  }

  /** 同步 receipt：记录某对端已提交的游标与已知版本向量（S2-06 提交证据） */
  saveReceipt(input: { peerId: string; cursor: number; knownVector: unknown }): void {
    this.db
      .prepare(
        `INSERT INTO sync_receipts(peer_id, cursor, known_vector, committed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(peer_id) DO UPDATE SET
           cursor = excluded.cursor,
           known_vector = excluded.known_vector,
           committed_at = excluded.committed_at`,
      )
      .run(input.peerId, input.cursor, JSON.stringify(input.knownVector), Date.now())
  }

  getReceipt(peerId: string): { peerId: string; cursor: number; knownVector: string; committedAt: number } | null {
    const row = this.db
      .prepare('SELECT peer_id, cursor, known_vector, committed_at FROM sync_receipts WHERE peer_id = ?')
      .get(peerId) as
      | { peer_id: string; cursor: number; known_vector: string; committed_at: number }
      | undefined
    if (!row) return null
    return {
      peerId: row.peer_id,
      cursor: Number(row.cursor),
      knownVector: row.known_vector,
      committedAt: Number(row.committed_at),
    }
  }

  listConflicts(status?: string): Array<{
    id: string
    entityType: string
    entityId: string
    localEnvelope: string
    remoteEnvelope: string
    status: string
  }> {
    const rows = (
      status
        ? this.db
            .prepare(
              'SELECT id, entity_type, entity_id, local_envelope, remote_envelope, status FROM conflicts WHERE status = ? ORDER BY discovered_at',
            )
            .all(status)
        : this.db
            .prepare(
              'SELECT id, entity_type, entity_id, local_envelope, remote_envelope, status FROM conflicts ORDER BY discovered_at',
            )
            .all()
    ) as Array<{
      id: string
      entity_type: string
      entity_id: string
      local_envelope: string
      remote_envelope: string
      status: string
    }>
    return rows.map((r) => ({
      id: r.id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      localEnvelope: r.local_envelope,
      remoteEnvelope: r.remote_envelope,
      status: r.status,
    }))
  }

  appendChange(input: {
    dotDevice: string
    dotCounter: string
    entityType: string
    entityId: string
    envelope: unknown
    origin: ChangeOrigin
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO change_log(dot_device, dot_counter, entity_type, entity_id, envelope, origin, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.dotDevice,
        input.dotCounter,
        input.entityType,
        input.entityId,
        JSON.stringify(input.envelope),
        input.origin,
        Date.now(),
      )
    return Number(info.lastInsertRowid)
  }

  changesAfter(cursor: number, limit: number): { rows: ChangeLogRow[]; nextCursor: number } {
    const rows = this.db
      .prepare(
        `SELECT seq, dot_device, dot_counter, entity_type, entity_id, envelope, origin, recorded_at
         FROM change_log WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(cursor, limit) as Array<Record<string, unknown>>
    const mapped: ChangeLogRow[] = rows.map((r) => ({
      seq: Number(r.seq),
      dotDevice: String(r.dot_device),
      dotCounter: String(r.dot_counter),
      entityType: String(r.entity_type),
      entityId: String(r.entity_id),
      envelope: String(r.envelope),
      origin: r.origin as ChangeOrigin,
      recordedAt: Number(r.recorded_at),
    }))
    const nextCursor = mapped.length ? mapped[mapped.length - 1].seq : cursor
    return { rows: mapped, nextCursor }
  }

  countChanges(origin?: ChangeOrigin): number {
    if (origin) {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM change_log WHERE origin = ?').get(origin) as {
        c: number
      }
      return Number(row.c)
    }
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM change_log').get() as { c: number }
    return Number(row.c)
  }

  prepareFileTransaction(input: {
    id: string
    operationsJson: string
    oldHashesJson: string
    newHashesJson: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO file_transactions(id, state, operations_json, old_hashes_json, new_hashes_json, prepared_at)
         VALUES (?, 'PREPARED', ?, ?, ?, ?)`,
      )
      .run(input.id, input.operationsJson, input.oldHashesJson, input.newHashesJson, Date.now())
  }

  markFileTransaction(id: string, state: 'FILES_APPLIED' | 'JOURNAL_COMMITTED' | 'ABORTED'): void {
    this.db
      .prepare(
        `UPDATE file_transactions SET state = ?, committed_at = CASE WHEN ? = 'JOURNAL_COMMITTED' THEN ? ELSE committed_at END WHERE id = ?`,
      )
      .run(state, state, Date.now(), id)
  }

  getFileTransaction(id: string): {
    id: string
    state: string
    operationsJson: string
    oldHashesJson: string
    newHashesJson: string
  } | null {
    const row = this.db
      .prepare(
        'SELECT id, state, operations_json, old_hashes_json, new_hashes_json FROM file_transactions WHERE id = ?',
      )
      .get(id) as
      | {
          id: string
          state: string
          operations_json: string
          old_hashes_json: string
          new_hashes_json: string
        }
      | undefined
    if (!row) return null
    return {
      id: row.id,
      state: row.state,
      operationsJson: row.operations_json,
      oldHashesJson: row.old_hashes_json,
      newHashesJson: row.new_hashes_json,
    }
  }

  listIncompleteFileTransactions(): Array<{ id: string; state: string; operationsJson: string }> {
    const rows = this.db
      .prepare(
        `SELECT id, state, operations_json FROM file_transactions WHERE state IN ('PREPARED','FILES_APPLIED') ORDER BY prepared_at`,
      )
      .all() as Array<{ id: string; state: string; operations_json: string }>
    return rows.map((r) => ({ id: r.id, state: r.state, operationsJson: r.operations_json }))
  }

  /** 启动恢复需要完整 intent（含 hash 清单），不能只有 operations_json */
  listIncompleteFileTransactionsDetailed(): Array<{
    id: string
    state: string
    operationsJson: string
    oldHashesJson: string
    newHashesJson: string
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, state, operations_json, old_hashes_json, new_hashes_json
         FROM file_transactions WHERE state IN ('PREPARED','FILES_APPLIED') ORDER BY prepared_at`,
      )
      .all() as Array<{
      id: string
      state: string
      operations_json: string
      old_hashes_json: string
      new_hashes_json: string
    }>
    return rows.map((r) => ({
      id: r.id,
      state: r.state,
      operationsJson: r.operations_json,
      oldHashesJson: r.old_hashes_json,
      newHashesJson: r.new_hashes_json,
    }))
  }

  deleteFileTransaction(id: string): void {
    this.db.prepare('DELETE FROM file_transactions WHERE id = ?').run(id)
  }

  /** 前滚幂等：同一 dot 已写入 change_log 时不得重复追加 */
  findChangeByDot(dotDevice: string, dotCounter: string): { seq: number } | null {
    const row = this.db
      .prepare('SELECT seq FROM change_log WHERE dot_device = ? AND dot_counter = ? LIMIT 1')
      .get(dotDevice, dotCounter) as { seq: number } | undefined
    return row ? { seq: Number(row.seq) } : null
  }

  saveCheckpoint(input: { id: string; reason: string; path?: string | null; hash?: string | null }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints(id, reason, path, hash, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.reason, input.path ?? null, input.hash ?? null, Date.now())
  }

  listCheckpoints(): Array<{ id: string; reason: string; path: string | null; hash: string | null; createdAt: number }> {
    const rows = this.db
      .prepare('SELECT id, reason, path, hash, created_at FROM checkpoints ORDER BY created_at DESC')
      .all() as Array<{ id: string; reason: string; path: string | null; hash: string | null; created_at: number }>
    return rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      path: r.path,
      hash: r.hash,
      createdAt: Number(r.created_at),
    }))
  }

  getLatestCheckpoint(reason?: string): {
    id: string
    reason: string
    path: string | null
    hash: string | null
    createdAt: number
  } | null {
    const row = (
      reason
        ? this.db
            .prepare(
              'SELECT id, reason, path, hash, created_at FROM checkpoints WHERE reason = ? ORDER BY created_at DESC LIMIT 1',
            )
            .get(reason)
        : this.db
            .prepare('SELECT id, reason, path, hash, created_at FROM checkpoints ORDER BY created_at DESC LIMIT 1')
            .get()
    ) as { id: string; reason: string; path: string | null; hash: string | null; created_at: number } | undefined
    if (!row) return null
    return {
      id: row.id,
      reason: row.reason,
      path: row.path,
      hash: row.hash,
      createdAt: Number(row.created_at),
    }
  }

  /**
   * 备份恢复/迁移后同步元数据不再可信：清空 heads/journal/conflicts/receipts，保留 checkpoints 审计。
   * 方案 §6.4：恢复备份产生新设备身份，不复用备份中的设备计数器。
   */
  clearSyncState(): void {
    this.db.exec(`
      DELETE FROM entity_heads;
      DELETE FROM change_log;
      DELETE FROM conflicts;
      DELETE FROM sync_receipts;
      DELETE FROM bootstrap_receipts;
      DELETE FROM device_state;
      DELETE FROM file_transactions WHERE state != 'JOURNAL_COMMITTED';
    `)
  }

  saveBootstrapReceipt(input: {
    id: string
    genesisId: string
    entityCount: number
    datasetHash: string
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO bootstrap_receipts(id, genesis_id, entity_count, dataset_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.genesisId, input.entityCount, input.datasetHash, Date.now())
  }

  getBootstrapReceipt(): { id: string; genesisId: string; entityCount: number; datasetHash: string } | null {
    const row = this.db
      .prepare(
        'SELECT id, genesis_id, entity_count, dataset_hash FROM bootstrap_receipts ORDER BY created_at DESC LIMIT 1',
      )
      .get() as
      | { id: string; genesis_id: string; entity_count: number; dataset_hash: string }
      | undefined
    if (!row) return null
    return {
      id: row.id,
      genesisId: row.genesis_id,
      entityCount: Number(row.entity_count),
      datasetHash: row.dataset_hash,
    }
  }

  insertConflict(input: {
    id: string
    entityType: string
    entityId: string
    localEnvelope: unknown
    remoteEnvelope: unknown
  }): void {
    this.db
      .prepare(
        `INSERT INTO conflicts(id, entity_type, entity_id, local_envelope, remote_envelope, status, discovered_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        input.id,
        input.entityType,
        input.entityId,
        JSON.stringify(input.localEnvelope),
        JSON.stringify(input.remoteEnvelope),
        Date.now(),
      )
  }

  metrics(): {
    journalBacklog: number
    openConflicts: number
    heads: number
    incompleteTx: number
  } {
    const journalBacklog = this.countChanges()
    const openConflicts = Number(
      (this.db.prepare("SELECT COUNT(*) AS c FROM conflicts WHERE status = 'open'").get() as { c: number }).c,
    )
    const heads = Number(
      (this.db.prepare('SELECT COUNT(*) AS c FROM entity_heads').get() as { c: number }).c,
    )
    const incompleteTx = this.listIncompleteFileTransactions().length
    return { journalBacklog, openConflicts, heads, incompleteTx }
  }
}
