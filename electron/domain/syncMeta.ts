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
