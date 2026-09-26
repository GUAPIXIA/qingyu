/**
 * S8-03：`/sync/v1` 会话协议路由（服务器模式）。
 *
 * - 只验证 envelope 元数据、版本向量、密文 hash/大小与授权，不解密业务 payload；
 * - 并发 heads 同时保存，禁止 last-write-wins；
 * - 同 batchId 重试幂等；
 * - commit 前 preparedReceipt 可查询；commit 响应丢失可查 commitReceipt；
 * - 不使用业务 WebSocket。
 */
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { requireRelayAuth } from '../auth/middleware.js'
import type { AccessTokenService, RelayAccessClaims } from '../auth/accessToken.js'
import { withTenantTransaction } from '../db/tenantTransaction.js'
import { sendRelayError } from '../http/relayErrors.js'
import type { MetricsRegistry } from '../observability/metrics.js'
import type { ObjectStore } from './objectStore.js'
import { DEFAULT_QUOTA, checkQuota, type QuotaSnapshot } from './quota.js'
import {
  canTransition,
  computeRequestHash,
  isExpired,
  isTerminal,
  mergeKnownVector,
  sessionTtlMs,
  batchTtlMs,
  type SessionRecord,
} from './session.js'
import {
  isValidBatchId,
  isValidCursor,
  validatePushBatch,
  validateVersionVector,
  type ValidationError,
} from './validation.js'
import {
  SYNC_PULL_MAX_ITEMS,
  SYNC_PROTOCOL_VERSION,
  type CommitReceipt,
  type PlanResponse,
  type PreparedReceipt,
  type PushRequestBody,
  type PullRequestBody,
  type SessionResponse,
  type SyncSessionState,
} from './types.js'

export interface SyncRoutesOptions {
  pool: pg.Pool
  tokens: AccessTokenService
  validate: (claims: RelayAccessClaims) => Promise<boolean>
  objects: ObjectStore
  metrics?: MetricsRegistry
}

function toSessionResponse(rec: SessionRecord): SessionResponse {
  return {
    sessionId: rec.sessionId,
    state: rec.state,
    protocolVersion: rec.protocolVersion,
    expiresAt: rec.expiresAt,
    ...(rec.preparedReceipt ? { preparedReceipt: rec.preparedReceipt } : {}),
    ...(rec.commitReceipt ? { commitReceipt: rec.commitReceipt } : {}),
  }
}

function validationToHttp(e: ValidationError): { status: number; code: string; message: string; retryable: boolean } {
  const status =
    e.code === 'QUOTA_EXCEEDED' ? 409 :
    e.code === 'SESSION_EXPIRED' ? 410 :
    e.code === 'DEVICE_REVOKED' ? 403 :
    e.code === 'BATCH_TOO_LARGE' ? 413 :
    e.code === 'BATCH_REPLAY_MISMATCH' ? 409 :
    400
  return { status, code: e.code, message: e.message, retryable: e.retryable }
}

export async function syncRoutes(app: FastifyInstance, options: SyncRoutesOptions): Promise<void> {
  const { pool, tokens, validate, objects, metrics } = options
  const auth = () => requireRelayAuth(tokens, undefined, validate)

  async function loadSession(
    claims: RelayAccessClaims,
    sessionId: string,
  ): Promise<{ ok: true; session: SessionRecord } | { ok: false; status: number; error: ValidationError }> {
    const result = await withTenantTransaction(pool, claims.sid, async (client) => {
      const row = await client.query<{
        id: string; space_id: string; device_id: string; state: SyncSessionState
        protocol_version: number; known_vector: Record<string, string>
        prepared_receipt: PreparedReceipt | null; commit_receipt: CommitReceipt | null
        request_fingerprint: string | null
        created_at: Date; updated_at: Date; expires_at: Date
      }>(
        `SELECT id,space_id,device_id,state,protocol_version,known_vector,prepared_receipt,commit_receipt,
                request_fingerprint,created_at,updated_at,expires_at
         FROM sync_sessions WHERE id=$1 AND space_id=$2 FOR UPDATE`,
        [sessionId, claims.sid],
      )
      return row.rows[0] ?? null
    })
    if (!result) {
      return {
        ok: false,
        status: 404,
        error: { code: 'SESSION_EXPIRED', message: '会话不存在', retryable: false },
      }
    }
    const session: SessionRecord = {
      sessionId: result.id,
      spaceId: result.space_id,
      deviceId: result.device_id,
      state: result.state,
      protocolVersion: result.protocol_version,
      knownVector: result.known_vector ?? {},
      preparedReceipt: result.prepared_receipt,
      commitReceipt: result.commit_receipt,
      requestFingerprint: result.request_fingerprint,
      createdAt: result.created_at.getTime(),
      updatedAt: result.updated_at.getTime(),
      expiresAt: result.expires_at.getTime(),
    }
    if (session.deviceId !== claims.sub) {
      return {
        ok: false,
        status: 404,
        error: { code: 'SESSION_EXPIRED', message: '会话不存在', retryable: false },
      }
    }
    if (isExpired(session, Date.now()) && !isTerminal(session.state)) {
      return {
        ok: false,
        status: 410,
        error: { code: 'SESSION_EXPIRED', message: '会话已过期', retryable: true },
      }
    }
    return { ok: true, session }
  }

  // ---- create session ----
  app.post('/sync/v1/sessions', {
    preHandler: auth(),
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['protocolVersion', 'deviceId'],
        properties: {
          protocolVersion: { type: 'integer', const: SYNC_PROTOCOL_VERSION },
          deviceId: { type: 'string', minLength: 1, maxLength: 64 },
          capabilities: { type: 'array', items: { type: 'string' }, maxItems: 32 },
          knownVersions: {
            type: 'object',
            additionalProperties: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const started = process.hrtime.bigint()
    const claims = request.relayAuth!
    const body = request.body as { protocolVersion: number; deviceId: string; knownVersions?: Record<string, string> }
    if (body.deviceId !== claims.sub) {
      return sendRelayError(reply, 403, 'DEVICE_REVOKED', 'deviceId 与令牌不一致', request.id)
    }
    const vv = validateVersionVector(body.knownVersions ?? {})
    if (!vv.ok) {
      const h = validationToHttp(vv.error)
      return sendRelayError(reply, h.status, h.code, h.message, request.id, h.retryable)
    }
    // 设备必须已批准且未吊销（密钥登记状态；无密钥登记时允许仅元数据同步？——阶段 8 要求 E2EE，必须 approved）
    const deviceCheck = await withTenantTransaction(pool, claims.sid, async (client) => {
      const keys = await client.query<{ status: string }>(
        `SELECT status FROM sync_device_keys WHERE space_id=$1 AND device_id=$2`,
        [claims.sid, claims.sub],
      )
      const devices = await client.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM relay_devices WHERE space_id=$1 AND id=$2`,
        [claims.sid, claims.sub],
      )
      return { keyStatus: keys.rows[0]?.status ?? null, revoked: devices.rows[0]?.revoked_at != null }
    })
    if (deviceCheck.revoked || deviceCheck.keyStatus === 'revoked') {
      metrics?.inc('sync_sessions_total', { result: 'device_revoked' })
      return sendRelayError(reply, 403, 'DEVICE_REVOKED', '设备已吊销', request.id)
    }
    if (deviceCheck.keyStatus !== 'approved') {
      metrics?.inc('sync_sessions_total', { result: 'device_pending' })
      return sendRelayError(reply, 403, 'DEVICE_REVOKED', '设备密钥未批准（需带外核对）', request.id)
    }

    const sessionId = randomUUID()
    const now = Date.now()
    const expiresAt = now + sessionTtlMs()
    await withTenantTransaction(pool, claims.sid, async (client) => {
      await client.query(
        `INSERT INTO sync_sessions(id,space_id,device_id,state,protocol_version,known_vector,expires_at)
         VALUES ($1,$2,$3,'open',$4,$5,to_timestamp($6/1000.0))`,
        [sessionId, claims.sid, claims.sub, body.protocolVersion, JSON.stringify(body.knownVersions ?? {}), expiresAt],
      )
      await client.query(
        `INSERT INTO sync_space_keys(space_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [claims.sid],
      )
    })
    metrics?.inc('sync_sessions_total', { result: 'open' })
    metrics?.observe('sync_request_duration_seconds', Number(process.hrtime.bigint() - started) / 1e9, { op: 'create_session', status: '200' })
    return reply.code(201).send({
      sessionId,
      state: 'open' as SyncSessionState,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      expiresAt,
    })
  })

  // ---- get session (commit 响应丢失恢复) ----
  app.get('/sync/v1/sessions/:sessionId', { preHandler: auth() }, async (request, reply) => {
    const claims = request.relayAuth!
    const { sessionId } = request.params as { sessionId: string }
    const loaded = await loadSession(claims, sessionId)
    if (!loaded.ok) {
      return sendRelayError(reply, loaded.status, loaded.error.code, loaded.error.message, request.id, loaded.error.retryable)
    }
    return toSessionResponse(loaded.session)
  })

  // ---- plan ----
  app.post('/sync/v1/sessions/:sessionId/plan', {
    preHandler: auth(),
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          knownVersions: {
            type: 'object',
            additionalProperties: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
          },
          summaryRoot: { type: 'string', maxLength: 128 },
        },
      },
    },
  }, async (request, reply) => {
    const started = process.hrtime.bigint()
    const claims = request.relayAuth!
    const { sessionId } = request.params as { sessionId: string }
    const loaded = await loadSession(claims, sessionId)
    if (!loaded.ok) {
      return sendRelayError(reply, loaded.status, loaded.error.code, loaded.error.message, request.id, loaded.error.retryable)
    }
    const body = (request.body ?? {}) as { knownVersions?: Record<string, string> }
    const vv = validateVersionVector(body.knownVersions ?? {})
    if (!vv.ok) {
      const h = validationToHttp(vv.error)
      return sendRelayError(reply, h.status, h.code, h.message, request.id, h.retryable)
    }
    const known = mergeKnownVector(loaded.session.knownVector, body.knownVersions ?? {})
    const plan = await withTenantTransaction(pool, claims.sid, async (client): Promise<PlanResponse> => {
      // 下载：server 上 version 不被 known 支配的 heads（按 server_seq 后续 pull）
      // 这里用简化口径：返回 server 侧 head 总数与字节估算；具体 pull 按 cursor
      const heads = await client.query<{
        entity_type: string; entity_id: string; version_hash: string
        version: Record<string, string>; cipher_hash: string; ciphertext: string | null
      }>(
        `SELECT entity_type,entity_id,version_hash,version,cipher_hash,ciphertext FROM sync_entity_heads WHERE space_id=$1`,
        [claims.sid],
      )
      let download = 0
      let estimatedBytes = 0
      const items: PlanResponse['items'] = []
      for (const h of heads.rows) {
        // 服务端不比对业务支配以外的内容；download 计数用 known 向量粗分
        const dominated = Object.entries(h.version).every(([d, c]) => BigInt(known[d] ?? '0') >= BigInt(c))
        if (!dominated) {
          download++
          estimatedBytes += h.ciphertext ? Buffer.from(h.ciphertext, 'base64').length : 0
          if (items.length < 50) {
            items.push({ entityType: h.entity_type, entityId: h.entity_id, direction: 'download' })
          }
        }
      }
      const quotaRow = await client.query<{ used_entities: string; used_ciphertext_bytes: string; max_entities: string; max_ciphertext_bytes: string }>(
        `INSERT INTO sync_space_quota(space_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING max_entities,max_ciphertext_bytes,used_entities,used_ciphertext_bytes`,
        [claims.sid],
      )
      const q = quotaRow.rows[0] ?? {
        used_entities: '0', used_ciphertext_bytes: '0',
        max_entities: String(DEFAULT_QUOTA.maxEntities),
        max_ciphertext_bytes: String(DEFAULT_QUOTA.maxCiphertextBytes),
      }
      return {
        upload: 0,
        download,
        conflicts: 0,
        estimatedBytes,
        items,
        quota: {
          usedEntities: Number(q.used_entities),
          maxEntities: Number(q.max_entities),
          usedCiphertextBytes: Number(q.used_ciphertext_bytes),
          maxCiphertextBytes: Number(q.max_ciphertext_bytes),
        },
      }
    })
    if (!canTransition(loaded.session.state, 'planned')) {
      // planned 幂等
      if (loaded.session.state !== 'planned') {
        return sendRelayError(reply, 409, 'CONFLICT', `状态非法: ${loaded.session.state}`, request.id)
      }
    }
    await withTenantTransaction(pool, claims.sid, async (client) => {
      await client.query(
        `UPDATE sync_sessions SET state='planned', known_vector=$3, updated_at=now() WHERE id=$1 AND space_id=$2`,
        [sessionId, claims.sid, JSON.stringify(known)],
      )
    })
    metrics?.observe('sync_request_duration_seconds', Number(process.hrtime.bigint() - started) / 1e9, { op: 'plan', status: '200' })
    return plan
  })

  // ---- push ----
  app.post('/sync/v1/sessions/:sessionId/push', {
    preHandler: auth(),
    schema: { body: { type: 'object', additionalProperties: true } },
  }, async (request, reply) => {
    const started = process.hrtime.bigint()
    const claims = request.relayAuth!
    const { sessionId } = request.params as { sessionId: string }
    const loaded = await loadSession(claims, sessionId)
    if (!loaded.ok) {
      return sendRelayError(reply, loaded.status, loaded.error.code, loaded.error.message, request.id, loaded.error.retryable)
    }
    const body = request.body as PushRequestBody
    if (!isValidBatchId(body.batchId)) {
      return sendRelayError(reply, 400, 'BAD_ENVELOPE', 'batchId 非法', request.id)
    }
    const reencrypt = body.reencrypt
      ? { fromKeyEpoch: body.reencrypt.fromKeyEpoch, toKeyEpoch: body.reencrypt.toKeyEpoch }
      : undefined
    const check = validatePushBatch(body.envelopes, claims.sub, {
      maxBlobBytes: DEFAULT_QUOTA.maxBlobBytes,
      ...(reencrypt ? { reencrypt } : {}),
    })
    if (!check.ok) {
      const h = validationToHttp(check.error)
      metrics?.inc('sync_push_batches_total', { result: 'rejected' })
      return sendRelayError(reply, h.status, h.code, h.message, request.id, h.retryable)
    }
    const envelopes = body.envelopes
    const requestHash = computeRequestHash(body.batchId, envelopes)

    // 幂等：同 batchId 同 hash → 同结果；不同 hash → 拒绝
    const idem = await withTenantTransaction(pool, claims.sid, async (client) => {
      const prior = await client.query<{ request_hash: string; response: unknown }>(
        `SELECT request_hash,response FROM sync_batches
         WHERE space_id=$1 AND device_id=$2 AND batch_id=$3 AND expires_at > now()`,
        [claims.sid, claims.sub, body.batchId],
      )
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) {
          return { kind: 'mismatch' as const }
        }
        return { kind: 'replay' as const, response: prior.rows[0].response }
      }
      return { kind: 'fresh' as const }
    })
    if (idem.kind === 'mismatch') {
      return sendRelayError(reply, 409, 'BATCH_REPLAY_MISMATCH', '同 batchId 内容不一致', request.id)
    }
    if (idem.kind === 'replay') {
      metrics?.inc('sync_push_batches_total', { result: 'replay' })
      return idem.response
    }

    // 配额：原子拒绝
    let newCiphertextBytes = 0
    for (const e of envelopes) {
      if (e.ciphertext) newCiphertextBytes += Buffer.from(e.ciphertext, 'base64').length
    }
    const quotaResult = await withTenantTransaction(pool, claims.sid, async (client) => {
      await client.query(`INSERT INTO sync_space_quota(space_id) VALUES ($1) ON CONFLICT DO NOTHING`, [claims.sid])
      const q = await client.query<{ used_entities: string; used_ciphertext_bytes: string; max_entities: string; max_ciphertext_bytes: string; max_blob_bytes: string; max_devices: string }>(
        `SELECT used_entities,used_ciphertext_bytes,max_entities,max_ciphertext_bytes,max_blob_bytes,max_devices
         FROM sync_space_quota WHERE space_id=$1 FOR UPDATE`,
        [claims.sid],
      )
      const row = q.rows[0]
      const snap: QuotaSnapshot = {
        usedEntities: Number(row?.used_entities ?? 0),
        maxEntities: Number(row?.max_entities ?? DEFAULT_QUOTA.maxEntities),
        usedCiphertextBytes: Number(row?.used_ciphertext_bytes ?? 0),
        maxCiphertextBytes: Number(row?.max_ciphertext_bytes ?? DEFAULT_QUOTA.maxCiphertextBytes),
        maxBlobBytes: Number(row?.max_blob_bytes ?? DEFAULT_QUOTA.maxBlobBytes),
        maxDevices: Number(row?.max_devices ?? DEFAULT_QUOTA.maxDevices),
        usedDevices: 0,
      }
      // 粗算新增实体：按唯一 (type,id) 且当前不存在
      const newIds = new Set(envelopes.map((e) => `${e.entityType}|${e.entityId}`))
      let actuallyNew = 0
      for (const key of newIds) {
        const [t, i] = key.split('|')
        const exists = await client.query(
          `SELECT 1 FROM sync_entity_heads WHERE space_id=$1 AND entity_type=$2 AND entity_id=$3 LIMIT 1`,
          [claims.sid, t, i],
        )
        if (!exists.rowCount) actuallyNew++
      }
      return checkQuota(snap, { newEntities: actuallyNew, newCiphertextBytes })
    })
    if (!quotaResult.ok) {
      metrics?.inc('sync_push_batches_total', { result: 'quota' })
      return sendRelayError(reply, 409, 'QUOTA_EXCEEDED', `配额不足: ${quotaResult.reason}`, request.id, false)
    }

    // 写入 heads + changes + 批次缓存（原子）
    const writeResult = await withTenantTransaction(pool, claims.sid, async (client) => {
      let accepted = 0
      const rejected = 0
      let maxSeq = '0'
      let newEntityDelta = 0
      let newBytesDelta = 0
      for (const e of envelopes) {
        const hasPrior = await client.query(
          `SELECT 1 FROM sync_entity_heads WHERE space_id=$1 AND entity_type=$2 AND entity_id=$3 LIMIT 1`,
          [claims.sid, e.entityType, e.entityId],
        )
        // 并发 heads：同 (type,id,versionHash,keyEpoch,cipherRevision) 冲突则保留既有（同版本）
        const inserted = await client.query<{ created_at: Date }>(
          `INSERT INTO sync_entity_heads(
             space_id,entity_type,entity_id,version_hash,version,dot_device,dot_counter_text,
             schema_version,deleted,parent_id,key_epoch,cipher_revision,cipher_hash,content_tag,ciphertext,blob_manifest_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (space_id,entity_type,entity_id,version_hash,key_epoch,cipher_revision) DO NOTHING
           RETURNING created_at`,
          [
            claims.sid, e.entityType, e.entityId, e.versionHash, JSON.stringify(e.version),
            e.dot.deviceId, e.dot.counter, e.schemaVersion, e.deleted, e.parentId ?? null,
            e.keyEpoch, e.cipherRevision, e.cipherHash, e.contentTag,
            e.ciphertext ?? null, e.blobManifestId ?? null,
          ],
        )
        if (!inserted.rowCount) {
          // 同版本已存在：幂等接受
          accepted++
          continue
        }
        accepted++
        if (!hasPrior.rowCount) {
          newEntityDelta++
          if (e.ciphertext) newBytesDelta += Buffer.from(e.ciphertext, 'base64').length
        }
        const ch = await client.query<{ server_seq: string }>(
          `INSERT INTO sync_changes(space_id,entity_type,entity_id,version_hash,key_epoch,cipher_revision,cipher_hash,content_tag,deleted)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT DO NOTHING
           RETURNING server_seq`,
          [claims.sid, e.entityType, e.entityId, e.versionHash, e.keyEpoch, e.cipherRevision, e.cipherHash, e.contentTag, e.deleted],
        )
        if (ch.rows[0]) maxSeq = ch.rows[0].server_seq
      }
      await client.query(
        `UPDATE sync_space_quota SET
           used_entities = used_entities + $2,
           used_ciphertext_bytes = used_ciphertext_bytes + $3,
           updated_at = now()
         WHERE space_id=$1`,
        [claims.sid, newEntityDelta, newBytesDelta],
      )
      const response = {
        batchId: body.batchId,
        accepted,
        rejected,
        cursor: maxSeq,
      }
      await client.query(
        `INSERT INTO sync_batches(space_id,device_id,batch_id,request_hash,response,expires_at)
         VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0))
         ON CONFLICT (space_id,device_id,batch_id) DO NOTHING`,
        [claims.sid, claims.sub, body.batchId, requestHash, JSON.stringify(response), Date.now() + batchTtlMs()],
      )
      if (loaded.session.state === 'open' || loaded.session.state === 'planned' || loaded.session.state === 'pushing') {
        await client.query(
          `UPDATE sync_sessions SET state='pushing', updated_at=now() WHERE id=$1 AND space_id=$2`,
          [sessionId, claims.sid],
        )
      }
      return response
    })
    metrics?.inc('sync_push_batches_total', { result: 'ok' })
    metrics?.inc('sync_push_items_total', {}, writeResult.accepted)
    metrics?.observe('sync_request_duration_seconds', Number(process.hrtime.bigint() - started) / 1e9, { op: 'push', status: '200' })
    return writeResult
  })

  // ---- pull ----
  app.post('/sync/v1/sessions/:sessionId/pull', {
    preHandler: auth(),
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cursor: { type: 'string', pattern: '^[0-9]+$' },
          limit: { type: 'integer', minimum: 1, maximum: SYNC_PULL_MAX_ITEMS },
        },
      },
    },
  }, async (request, reply) => {
    const started = process.hrtime.bigint()
    const claims = request.relayAuth!
    const { sessionId } = request.params as { sessionId: string }
    const loaded = await loadSession(claims, sessionId)
    if (!loaded.ok) {
      return sendRelayError(reply, loaded.status, loaded.error.code, loaded.error.message, request.id, loaded.error.retryable)
    }
    const body = (request.body ?? {}) as PullRequestBody
    if (body.cursor !== undefined && !isValidCursor(body.cursor)) {
      return sendRelayError(reply, 400, 'BAD_ENVELOPE', 'cursor 非法', request.id)
    }
    const limit = Math.min(body.limit ?? SYNC_PULL_MAX_ITEMS, SYNC_PULL_MAX_ITEMS)
    const cursor = body.cursor ?? '0'
    const result = await withTenantTransaction(pool, claims.sid, async (client) => {
      const changes = await client.query<{
        server_seq: string; entity_type: string; entity_id: string; version_hash: string
        key_epoch: number; cipher_revision: number; cipher_hash: string; content_tag: string; deleted: boolean
      }>(
        `SELECT server_seq,entity_type,entity_id,version_hash,key_epoch,cipher_revision,cipher_hash,content_tag,deleted
         FROM sync_changes
         WHERE space_id=$1 AND server_seq > $2
         ORDER BY server_seq
         LIMIT $3`,
        [claims.sid, cursor, limit],
      )
      const envelopes = []
      for (const c of changes.rows) {
        const head = await client.query<{
          version: Record<string, string>; dot_device: string; dot_counter_text: string
          schema_version: number; deleted: boolean; parent_id: string | null
          updated_at: Date; ciphertext: string | null; blob_manifest_id: string | null
          key_epoch: number; cipher_revision: number; cipher_hash: string; content_tag: string
        }>(
          `SELECT version,dot_device,dot_counter_text,schema_version,deleted,parent_id,updated_at,
                  ciphertext,blob_manifest_id,key_epoch,cipher_revision,cipher_hash,content_tag
           FROM sync_entity_heads
           WHERE space_id=$1 AND entity_type=$2 AND entity_id=$3 AND version_hash=$4
             AND key_epoch=$5 AND cipher_revision=$6`,
          [claims.sid, c.entity_type, c.entity_id, c.version_hash, c.key_epoch, c.cipher_revision],
        )
        const h = head.rows[0]
        if (!h) continue
        envelopes.push({
          entityType: c.entity_type,
          entityId: c.entity_id,
          parentId: h.parent_id,
          schemaVersion: h.schema_version,
          version: h.version,
          versionHash: c.version_hash,
          dot: { deviceId: h.dot_device, counter: h.dot_counter_text },
          deleted: h.deleted,
          updatedAt: h.updated_at.getTime(),
          keyEpoch: h.key_epoch,
          cipherRevision: h.cipher_revision,
          cipherHash: h.cipher_hash,
          contentTag: h.content_tag,
          ...(h.ciphertext ? { ciphertext: h.ciphertext } : {}),
          ...(h.blob_manifest_id ? { blobManifestId: h.blob_manifest_id } : {}),
          serverSeq: c.server_seq,
        })
      }
      const last = changes.rows[changes.rows.length - 1]
      const nextCursor = last ? last.server_seq : cursor
      const hasMore = changes.rows.length === limit
      if (loaded.session.state === 'open' || loaded.session.state === 'planned' || loaded.session.state === 'pulling') {
        await client.query(
          `UPDATE sync_sessions SET state='pulling', updated_at=now() WHERE id=$1 AND space_id=$2`,
          [sessionId, claims.sid],
        )
      }
      return {
        batchId: randomUUID(),
        envelopes,
        nextCursor: String(nextCursor),
        hasMore,
      }
    })
    metrics?.observe('sync_request_duration_seconds', Number(process.hrtime.bigint() - started) / 1e9, { op: 'pull', status: '200' })
    return result
  })

  // ---- blobs ----
  app.post('/sync/v1/sessions/:sessionId/blobs', {
    preHandler: auth(),
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['blobId', 'mode'],
        properties: {
          blobId: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
          mode: { type: 'string', enum: ['upload', 'download'] },
          chunkSize: { type: 'integer', minimum: 1, maximum: 1024 * 1024 },
          size: { type: 'integer', minimum: 0, maximum: 67108864 },
          cipherHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
          chunkIndex: { type: 'integer', minimum: 0 },
          chunkCiphertext: { type: 'string', maxLength: 2_000_000 },
          manifest: { type: 'object' },
          complete: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const claims = request.relayAuth!
    const { sessionId } = request.params as { sessionId: string }
    const loaded = await loadSession(claims, sessionId)
    if (!loaded.ok) {
      return sendRelayError(reply, loaded.status, loaded.error.code, loaded.error.message, request.id, loaded.error.retryable)
    }
    const body = request.body as {
      blobId: string; mode: 'upload' | 'download'
      chunkSize?: number; size?: number; cipherHash?: string
      chunkIndex?: number; chunkCiphertext?: string
      manifest?: object; complete?: boolean
    }
    if (body.mode === 'upload') {
      if (body.chunkCiphertext !== undefined) {
        // 分块写入对象存储（key 随机，不含 blobId）
        const data = Buffer.from(body.chunkCiphertext, 'base64')
        if (data.length > 1024 * 1024 + 32) {
          return sendRelayError(reply, 413, 'BATCH_TOO_LARGE', 'chunk 过大', request.id)
        }
        const put = await objects.put(data)
        // 临时以 blobId+chunk 索引；完整 manifest 在 complete 时写入
        await withTenantTransaction(pool, claims.sid, async (client) => {
          await client.query(
            `INSERT INTO sync_blobs(space_id,blob_id,manifest,size,ref_count,status,object_key)
             VALUES ($1,$2,$3,$4,0,'pending',$5)
             ON CONFLICT (space_id,blob_id) DO UPDATE SET manifest=EXCLUDED.manifest, object_key=EXCLUDED.object_key`,
            [claims.sid, body.blobId, JSON.stringify({ chunkIndex: body.chunkIndex ?? 0, objectKey: put.objectKey }), put.size, put.objectKey],
          )
        })
        return { blobId: body.blobId, mode: 'upload' as const, chunkIndex: body.chunkIndex ?? 0, accepted: true }
      }
      if (body.complete) {
        await withTenantTransaction(pool, claims.sid, async (client) => {
          await client.query(
            `UPDATE sync_blobs SET status='committed', manifest=$3, size=$4, ref_count=1
             WHERE space_id=$1 AND blob_id=$2`,
            [claims.sid, body.blobId, JSON.stringify(body.manifest ?? {}), body.size ?? 0],
          )
        })
        return { blobId: body.blobId, mode: 'upload' as const, complete: true }
      }
      return {
        blobId: body.blobId,
        mode: 'upload' as const,
        chunkSize: body.chunkSize ?? 1024 * 1024,
      }
    }
    // download
    const row = await withTenantTransaction(pool, claims.sid, async (client) => {
      const r = await client.query<{ status: string; object_key: string; size: string; manifest: unknown }>(
        `SELECT status,object_key,size,manifest FROM sync_blobs WHERE space_id=$1 AND blob_id=$2`,
        [claims.sid, body.blobId],
      )
      return r.rows[0] ?? null
    })
    if (!row || row.status !== 'committed') {
      return sendRelayError(reply, 404, 'RESOURCE_NOT_FOUND', '内容不存在', request.id)
    }
    return {
      blobId: body.blobId,
      mode: 'download' as const,
      size: Number(row.size),
      manifest: row.manifest,
    }
  })

  /** blob 分块下载（流式代理；绑定 space/device/session） */
  app.post('/sync/v1/sessions/:sessionId/blobs/:blobId/chunk', {
    preHandler: auth(),
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['chunkIndex'],
        properties: { chunkIndex: { type: 'integer', minimum: 0 } },
      },
    },
  }, async (request, reply) => {
    const claims = request.relayAuth!
    const { sessionId, blobId } = request.params as { sessionId: string; blobId: string }
    const loaded = await loadSession(claims, sessionId)
    if (!loaded.ok) {
      return sendRelayError(reply, loaded.status, loaded.error.code, loaded.error.message, request.id, loaded.error.retryable)
    }
    const { chunkIndex } = request.body as { chunkIndex: number }
    const row = await withTenantTransaction(pool, claims.sid, async (client) => {
      const r = await client.query<{ manifest: { objectKey?: string; chunks?: Array<{ objectKey?: string }> }; status: string }>(
        `SELECT manifest,status FROM sync_blobs WHERE space_id=$1 AND blob_id=$2`,
        [claims.sid, blobId],
      )
      return r.rows[0] ?? null
    })
    if (!row || row.status !== 'committed') {
      return sendRelayError(reply, 404, 'RESOURCE_NOT_FOUND', '内容不存在', request.id)
    }
    // 单 chunk 模式：object_key 即整块；多 chunk 时 manifest.chunks[i]
    let objectKey: string | undefined
    const m = row.manifest as { objectKey?: string; chunks?: Array<{ objectKey?: string }> }
    if (m.chunks && m.chunks[chunkIndex]) objectKey = m.chunks[chunkIndex]?.objectKey
    else if (chunkIndex === 0) objectKey = m.objectKey
    if (!objectKey) {
      return sendRelayError(reply, 404, 'RESOURCE_NOT_FOUND', '内容不存在', request.id)
    }
    try {
      const data = await objects.get(objectKey)
      return { blobId, chunkIndex, ciphertext: data.toString('base64') }
    } catch {
      return sendRelayError(reply, 404, 'RESOURCE_NOT_FOUND', '内容不存在', request.id)
    }
  })

  // ---- commit ----
  app.post('/sync/v1/sessions/:sessionId/commit', {
    preHandler: auth(),
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          vector: {
            type: 'object',
            additionalProperties: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const started = process.hrtime.bigint()
    const claims = request.relayAuth!
    const { sessionId } = request.params as { sessionId: string }
    const loaded = await loadSession(claims, sessionId)
    if (!loaded.ok) {
      return sendRelayError(reply, loaded.status, loaded.error.code, loaded.error.message, request.id, loaded.error.retryable)
    }
    // commit 响应丢失恢复：已 committed 直接返回同一 receipt
    if (loaded.session.state === 'committed' && loaded.session.commitReceipt) {
      metrics?.inc('sync_commits_total', { result: 'replay' })
      return {
        sessionId,
        committedAt: loaded.session.commitReceipt.committedAt,
        vector: loaded.session.commitReceipt.vector,
        serverSeq: loaded.session.commitReceipt.serverSeq,
      }
    }
    const body = (request.body ?? {}) as { vector?: Record<string, string> }
    const vv = validateVersionVector(body.vector ?? {})
    if (!vv.ok) {
      const h = validationToHttp(vv.error)
      return sendRelayError(reply, h.status, h.code, h.message, request.id, h.retryable)
    }
    const receipt = await withTenantTransaction(pool, claims.sid, async (client): Promise<CommitReceipt> => {
      const seqRow = await client.query<{ max: string | null }>(
        `SELECT max(server_seq)::text AS max FROM sync_changes WHERE space_id=$1`,
        [claims.sid],
      )
      const serverSeq = seqRow.rows[0]?.max ?? '0'
      const vector = mergeKnownVector(loaded.session.knownVector, body.vector ?? {})
      const committedAt = Date.now()
      // 更新设备 ack
      await client.query(
        `INSERT INTO sync_device_acks(space_id,device_id,known_vector,server_seq,updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (space_id,device_id) DO UPDATE SET
           known_vector=EXCLUDED.known_vector,
           server_seq=EXCLUDED.server_seq,
           updated_at=now()`,
        [claims.sid, claims.sub, JSON.stringify(vector), serverSeq],
      )
      await client.query(
        `UPDATE sync_sessions SET state='committed', commit_receipt=$3, known_vector=$4, updated_at=now()
         WHERE id=$1 AND space_id=$2`,
        [sessionId, claims.sid, JSON.stringify({ sessionId, committedAt, vector, serverSeq }), JSON.stringify(vector)],
      )
      return { sessionId, committedAt, vector, serverSeq }
    })
    metrics?.inc('sync_commits_total', { result: 'ok' })
    metrics?.observe('sync_request_duration_seconds', Number(process.hrtime.bigint() - started) / 1e9, { op: 'commit', status: '200' })
    return receipt
  })

  // ---- abort ----
  app.delete('/sync/v1/sessions/:sessionId', { preHandler: auth() }, async (request, reply) => {
    const claims = request.relayAuth!
    const { sessionId } = request.params as { sessionId: string }
    const loaded = await loadSession(claims, sessionId)
    if (!loaded.ok) {
      // abort 幂等：已消失视为成功
      if (loaded.status === 404) return reply.code(204).send()
      return sendRelayError(reply, loaded.status, loaded.error.code, loaded.error.message, request.id, loaded.error.retryable)
    }
    if (loaded.session.state === 'committed') {
      return sendRelayError(reply, 409, 'CONFLICT', '已提交会话不能放弃', request.id)
    }
    await withTenantTransaction(pool, claims.sid, async (client) => {
      await client.query(
        `UPDATE sync_sessions SET state='aborted', updated_at=now() WHERE id=$1 AND space_id=$2`,
        [sessionId, claims.sid],
      )
    })
    metrics?.inc('sync_sessions_total', { result: 'aborted' })
    return reply.code(204).send()
  })
}
