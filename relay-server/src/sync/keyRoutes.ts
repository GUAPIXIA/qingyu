/**
 * S8-02：新设备密钥登记与密钥信封中转。
 *
 * 服务端只保存不透明且带签名的 key envelope；
 * 不解析 spaceKey，不替换公钥后伪造签名。
 * 批准必须由已有设备带外核对后签名——仅服务端列表点击设备名不构成批准。
 */
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { createHash } from 'node:crypto'
import { requireRelayAuth } from '../auth/middleware.js'
import type { AccessTokenService, RelayAccessClaims } from '../auth/accessToken.js'
import { withTenantTransaction } from '../db/tenantTransaction.js'
import { sendRelayError } from '../http/relayErrors.js'
import type { MetricsRegistry } from '../observability/metrics.js'
import type { DeviceKeyRegistration, KeyEnvelopeWire } from './types.js'
import { DEFAULT_QUOTA, checkQuota, quotaSnapshotFromDefaults } from './quota.js'

export interface KeyRoutesOptions {
  pool: pg.Pool
  tokens: AccessTokenService
  validate: (claims: RelayAccessClaims) => Promise<boolean>
  metrics?: MetricsRegistry
}

const B64_32 = /^[A-Za-z0-9+/]{43}=$/
const ENVELOPE_MAX = 16 * 1024

function isValidPublicKey(v: unknown): v is string {
  return typeof v === 'string' && B64_32.test(v)
}

function isValidNonce(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9+/]{8,64}={0,2}$/.test(v)
}

/** 结构校验 key envelope（签名在客户端验；服务端只挡明显非法） */
export function validateKeyEnvelopeWire(input: unknown): { ok: true; envelope: KeyEnvelopeWire } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'envelope 必须是对象' }
  const e = input as Partial<KeyEnvelopeWire>
  if (e.formatVersion !== 1) return { ok: false, reason: 'formatVersion 非法' }
  if (typeof e.spaceId !== 'string' || !e.spaceId) return { ok: false, reason: 'spaceId 非法' }
  if (typeof e.keyEpoch !== 'number' || !Number.isInteger(e.keyEpoch) || e.keyEpoch < 1) {
    return { ok: false, reason: 'keyEpoch 非法' }
  }
  if (typeof e.recipientDeviceId !== 'string' || !e.recipientDeviceId) return { ok: false, reason: 'recipientDeviceId 非法' }
  if (!isValidPublicKey(e.recipientX25519PublicKey)) return { ok: false, reason: 'recipientX25519PublicKey 非法' }
  if (typeof e.approverDeviceId !== 'string' || !e.approverDeviceId) return { ok: false, reason: 'approverDeviceId 非法' }
  if (!isValidPublicKey(e.approverX25519PublicKey)) return { ok: false, reason: 'approverX25519PublicKey 非法' }
  if (!isValidPublicKey(e.approverEd25519PublicKey)) return { ok: false, reason: 'approverEd25519PublicKey 非法' }
  if (!isValidNonce(e.nonce)) return { ok: false, reason: 'nonce 非法' }
  if (typeof e.expiresAt !== 'number' || !Number.isFinite(e.expiresAt)) return { ok: false, reason: 'expiresAt 非法' }
  if (typeof e.wrappedNonce !== 'string' || !e.wrappedNonce) return { ok: false, reason: 'wrappedNonce 非法' }
  if (typeof e.wrappedKey !== 'string' || e.wrappedKey.length < 40) return { ok: false, reason: 'wrappedKey 非法' }
  if (typeof e.transcriptHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(e.transcriptHash)) {
    return { ok: false, reason: 'transcriptHash 非法' }
  }
  if (typeof e.signature !== 'string' || e.signature.length < 64) return { ok: false, reason: 'signature 非法' }
  return { ok: true, envelope: e as KeyEnvelopeWire }
}

export function sasFingerprint(transcriptHash: string): string {
  return createHash('sha256').update(transcriptHash, 'utf8').digest('hex').slice(0, 16)
}

export async function keyRoutes(app: FastifyInstance, options: KeyRoutesOptions): Promise<void> {
  const { pool, tokens, validate, metrics } = options
  const auth = () => requireRelayAuth(tokens, undefined, validate)

  /** 新设备登记公钥（S8-02 步骤 1）；返回待批登记内容供带外核对 */
  app.post('/sync/v1/devices/keys', {
    preHandler: auth(),
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['deviceId', 'x25519PublicKey', 'ed25519PublicKey', 'nonce', 'expiresAt'],
        properties: {
          deviceId: { type: 'string', minLength: 1, maxLength: 64 },
          x25519PublicKey: { type: 'string', minLength: 40, maxLength: 64 },
          ed25519PublicKey: { type: 'string', minLength: 40, maxLength: 64 },
          nonce: { type: 'string', minLength: 16, maxLength: 64 },
          expiresAt: { type: 'integer' },
        },
      },
    },
  }, async (request, reply) => {
    const claims = request.relayAuth!
    const body = request.body as DeviceKeyRegistration & { deviceId: string }
    // deviceId 必须等于 token 主体（不能替他人登记）
    if (body.deviceId !== claims.sub) {
      return sendRelayError(reply, 403, 'DEVICE_REVOKED', 'deviceId 与令牌不一致', request.id)
    }
    if (!isValidPublicKey(body.x25519PublicKey) || !isValidPublicKey(body.ed25519PublicKey) || !isValidNonce(body.nonce)) {
      return sendRelayError(reply, 400, 'KEY_ENVELOPE_INVALID', '公钥或 nonce 格式非法', request.id)
    }
    if (body.expiresAt <= Date.now() || body.expiresAt > Date.now() + 7 * 24 * 3600_000) {
      return sendRelayError(reply, 400, 'KEY_ENVELOPE_INVALID', 'expiresAt 非法', request.id)
    }
    await withTenantTransaction(pool, claims.sid, async (client) => {
      await client.query(
        `INSERT INTO sync_device_keys(space_id,device_id,x25519_public_key,ed25519_public_key,status,nonce,expires_at)
         VALUES ($1,$2,$3,$4,'pending',$5,to_timestamp($6/1000.0))
         ON CONFLICT (space_id, device_id) DO UPDATE SET
           x25519_public_key=EXCLUDED.x25519_public_key,
           ed25519_public_key=EXCLUDED.ed25519_public_key,
           nonce=EXCLUDED.nonce,
           expires_at=EXCLUDED.expires_at,
           status='pending',
           approved_at=NULL`,
        [claims.sid, claims.sub, body.x25519PublicKey, body.ed25519PublicKey, body.nonce, body.expiresAt],
      )
    })
    metrics?.inc('sync_device_key_registrations_total', { result: 'pending' })
    return reply.code(201).send({
      deviceId: claims.sub,
      x25519PublicKey: body.x25519PublicKey,
      ed25519PublicKey: body.ed25519PublicKey,
      nonce: body.nonce,
      expiresAt: body.expiresAt,
      status: 'pending',
      // 带外核对提示：客户端本地计算 SAS，不经过服务端
      sasHint: 'compare-local-sas',
    })
  })

  /** 查询待批设备列表（仅元数据；批准仍须带外） */
  app.get('/sync/v1/devices/keys', { preHandler: auth() }, async (request) => {
    const claims = request.relayAuth!
    const result = await withTenantTransaction(pool, claims.sid, async (client) => {
      return client.query<{
        device_id: string; x25519_public_key: string; ed25519_public_key: string
        status: string; nonce: string; expires_at: Date
      }>(
        `SELECT device_id,x25519_public_key,ed25519_public_key,status,nonce,expires_at
         FROM sync_device_keys WHERE space_id=$1 AND expires_at > now() ORDER BY created_at`,
        [claims.sid],
      )
    })
    return {
      devices: result.rows.map((r) => ({
        deviceId: r.device_id,
        x25519PublicKey: r.x25519_public_key,
        ed25519PublicKey: r.ed25519_public_key,
        status: r.status,
        nonce: r.nonce,
        expiresAt: r.expires_at.getTime(),
      })),
    }
  })

  /** 批准设备提交签名 key envelope（S8-02 步骤 3–4） */
  app.post('/sync/v1/key-envelopes', {
    preHandler: auth(),
    schema: { body: { type: 'object', additionalProperties: true } },
  }, async (request, reply) => {
    const claims = request.relayAuth!
    const raw = request.body as { envelope?: unknown }
    const check = validateKeyEnvelopeWire(raw.envelope ?? raw)
    if (!check.ok) {
      metrics?.inc('sync_key_envelope_rejected_total', { reason: 'format' })
      return sendRelayError(reply, 400, 'KEY_ENVELOPE_INVALID', check.reason, request.id)
    }
    const envelope = check.envelope
    if (envelope.spaceId !== claims.sid) {
      return sendRelayError(reply, 404, 'RESOURCE_NOT_FOUND', '内容不存在', request.id)
    }
    // 批准设备必须是调用者，且已 approved
    if (envelope.approverDeviceId !== claims.sub) {
      return sendRelayError(reply, 403, 'KEY_ENVELOPE_INVALID', 'approverDeviceId 必须等于调用设备', request.id)
    }
    const json = JSON.stringify(envelope)
    if (json.length > ENVELOPE_MAX) {
      return sendRelayError(reply, 400, 'KEY_ENVELOPE_INVALID', 'envelope 过大', request.id)
    }
    const result = await withTenantTransaction(pool, claims.sid, async (client) => {
      const recipient = await client.query<{ status: string; x25519_public_key: string; nonce: string; expires_at: Date }>(
        `SELECT status,x25519_public_key,nonce,expires_at FROM sync_device_keys
         WHERE space_id=$1 AND device_id=$2 FOR UPDATE`,
        [claims.sid, envelope.recipientDeviceId],
      )
      const rec = recipient.rows[0]
      if (!rec) return { ok: false as const, reason: 'recipient_not_found' }
      if (rec.status === 'revoked') return { ok: false as const, reason: 'recipient_revoked' }
      if (rec.x25519_public_key !== envelope.recipientX25519PublicKey) {
        // 服务端不能替换目标公钥后仍通过客户端校验；此处同步挡下
        return { ok: false as const, reason: 'recipient_key_mismatch' }
      }
      if (rec.nonce !== envelope.nonce) return { ok: false as const, reason: 'nonce_mismatch' }
      if (rec.expires_at.getTime() <= Date.now()) return { ok: false as const, reason: 'registration_expired' }
      const approver = await client.query<{ status: string }>(
        `SELECT status FROM sync_device_keys WHERE space_id=$1 AND device_id=$2`,
        [claims.sid, envelope.approverDeviceId],
      )
      if (approver.rows[0]?.status !== 'approved') {
        return { ok: false as const, reason: 'approver_not_approved' }
      }
      // 确保 epoch 存在
      await client.query(
        `INSERT INTO sync_key_epochs(space_id,key_epoch) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [claims.sid, envelope.keyEpoch],
      )
      await client.query(
        `INSERT INTO sync_key_envelopes(space_id,key_epoch,recipient_device_id,envelope)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (space_id,key_epoch,recipient_device_id) DO UPDATE SET envelope=EXCLUDED.envelope`,
        [claims.sid, envelope.keyEpoch, envelope.recipientDeviceId, json],
      )
      await client.query(
        `UPDATE sync_device_keys SET status='approved', approved_at=now()
         WHERE space_id=$1 AND device_id=$2`,
        [claims.sid, envelope.recipientDeviceId],
      )
      return { ok: true as const }
    })
    if (!result.ok) {
      metrics?.inc('sync_key_envelope_rejected_total', { reason: result.reason })
      const map: Record<string, string> = {
        recipient_not_found: '目标设备未登记',
        recipient_revoked: '目标设备已吊销',
        recipient_key_mismatch: '目标公钥与登记不一致',
        nonce_mismatch: 'nonce 不一致',
        registration_expired: '登记已过期',
        approver_not_approved: '批准设备未授权',
      }
      return sendRelayError(reply, 400, 'KEY_ENVELOPE_INVALID', map[result.reason] ?? 'envelope 无效', request.id)
    }
    metrics?.inc('sync_key_envelope_accepted_total', {})
    return reply.code(201).send({ ok: true, keyEpoch: envelope.keyEpoch, recipientDeviceId: envelope.recipientDeviceId })
  })

  /** 新设备领取自己的 key envelope */
  app.get('/sync/v1/key-envelopes', { preHandler: auth() }, async (request) => {
    const claims = request.relayAuth!
    const result = await withTenantTransaction(pool, claims.sid, async (client) => {
      return client.query<{ key_epoch: number; envelope: unknown; created_at: Date }>(
        `SELECT key_epoch,envelope,created_at FROM sync_key_envelopes
         WHERE space_id=$1 AND recipient_device_id=$2 ORDER BY key_epoch DESC`,
        [claims.sid, claims.sub],
      )
    })
    return {
      envelopes: result.rows.map((r) => ({
        keyEpoch: r.key_epoch,
        envelope: r.envelope,
        createdAt: r.created_at.getTime(),
      })),
    }
  })

  /** 空间密钥 epoch 状态（无密钥材料） */
  app.get('/sync/v1/keys/status', { preHandler: auth() }, async (request) => {
    const claims = request.relayAuth!
    const result = await withTenantTransaction(pool, claims.sid, async (client) => {
      await client.query(
        `INSERT INTO sync_space_keys(space_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [claims.sid],
      )
      const keys = await client.query<{ current_key_epoch: number }>(
        `SELECT current_key_epoch FROM sync_space_keys WHERE space_id=$1`,
        [claims.sid],
      )
      const epochs = await client.query<{ key_epoch: number; retired_at: Date | null }>(
        `SELECT key_epoch,retired_at FROM sync_key_epochs WHERE space_id=$1 ORDER BY key_epoch`,
        [claims.sid],
      )
      return { current: keys.rows[0]?.current_key_epoch ?? 1, epochs: epochs.rows }
    })
    return {
      currentKeyEpoch: result.current,
      epochs: result.epochs.map((e) => ({ keyEpoch: e.key_epoch, retiredAt: e.retired_at?.getTime() ?? null })),
    }
  })

  /**
   * S8-06：创建新 key epoch（设备吊销后由持钥客户端发起）。
   * 服务端只记 epoch/状态，不能独立重加密。
   */
  app.post('/sync/v1/keys/rotate', {
    preHandler: auth(),
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['reason'],
        properties: {
          reason: { type: 'string', enum: ['device_revoked', 'suspected_leak', 'manual'] },
          revokeDeviceId: { type: 'string', maxLength: 64 },
        },
      },
    },
  }, async (request, reply) => {
    const claims = request.relayAuth!
    const body = request.body as { reason: string; revokeDeviceId?: string }
    const out = await withTenantTransaction(pool, claims.sid, async (client) => {
      if (body.revokeDeviceId) {
        await client.query(
          `UPDATE sync_device_keys SET status='revoked' WHERE space_id=$1 AND device_id=$2`,
          [claims.sid, body.revokeDeviceId],
        )
        await client.query(
          `UPDATE relay_devices SET revoked_at=now(), token_version=token_version+1
           WHERE space_id=$1 AND id=$2`,
          [claims.sid, body.revokeDeviceId],
        )
      }
      await client.query(
        `INSERT INTO sync_space_keys(space_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [claims.sid],
      )
      const cur = await client.query<{ current_key_epoch: number }>(
        `SELECT current_key_epoch FROM sync_space_keys WHERE space_id=$1 FOR UPDATE`,
        [claims.sid],
      )
      const next = (cur.rows[0]?.current_key_epoch ?? 1) + 1
      await client.query(
        `UPDATE sync_space_keys SET current_key_epoch=$2, updated_at=now() WHERE space_id=$1`,
        [claims.sid, next],
      )
      await client.query(
        `INSERT INTO sync_key_epochs(space_id,key_epoch) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [claims.sid, next],
      )
      return { nextKeyEpoch: next }
    })
    metrics?.inc('sync_key_rotations_total', { reason: body.reason })
    return reply.code(201).send({
      currentKeyEpoch: out.nextKeyEpoch,
      reencryptRequired: true,
      note: '历史数据由持钥客户端在用户显式维护时重加密；服务器不能独立完成',
    })
  })

  /** 重加密游标（S8-06 可恢复） */
  app.get('/sync/v1/keys/reencrypt-cursor', { preHandler: auth() }, async (request) => {
    const claims = request.relayAuth!
    const result = await withTenantTransaction(pool, claims.sid, async (client) => {
      return client.query<{
        from_key_epoch: number; to_key_epoch: number; last_entity_type: string | null
        last_entity_id: string | null; status: string
      }>(
        `SELECT from_key_epoch,to_key_epoch,last_entity_type,last_entity_id,status
         FROM sync_reencrypt_cursors WHERE space_id=$1 AND device_id=$2`,
        [claims.sid, claims.sub],
      )
    })
    return {
      cursors: result.rows.map((r) => ({
        fromKeyEpoch: r.from_key_epoch,
        toKeyEpoch: r.to_key_epoch,
        lastEntityType: r.last_entity_type,
        lastEntityId: r.last_entity_id,
        status: r.status,
      })),
    }
  })

  app.put('/sync/v1/keys/reencrypt-cursor', {
    preHandler: auth(),
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['fromKeyEpoch', 'toKeyEpoch', 'status'],
        properties: {
          fromKeyEpoch: { type: 'integer', minimum: 1 },
          toKeyEpoch: { type: 'integer', minimum: 1 },
          lastEntityType: { type: 'string', maxLength: 64 },
          lastEntityId: { type: 'string', maxLength: 128 },
          status: { type: 'string', enum: ['running', 'completed', 'aborted'] },
        },
      },
    },
  }, async (request) => {
    const claims = request.relayAuth!
    const body = request.body as {
      fromKeyEpoch: number; toKeyEpoch: number
      lastEntityType?: string; lastEntityId?: string; status: string
    }
    await withTenantTransaction(pool, claims.sid, async (client) => {
      await client.query(
        `INSERT INTO sync_reencrypt_cursors(space_id,device_id,from_key_epoch,to_key_epoch,last_entity_type,last_entity_id,status,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (space_id,device_id,from_key_epoch,to_key_epoch) DO UPDATE SET
           last_entity_type=EXCLUDED.last_entity_type,
           last_entity_id=EXCLUDED.last_entity_id,
           status=EXCLUDED.status,
           updated_at=now()`,
        [claims.sid, claims.sub, body.fromKeyEpoch, body.toKeyEpoch, body.lastEntityType ?? null, body.lastEntityId ?? null, body.status],
      )
    })
    return { ok: true }
  })

  /** 配额查询（S8-05） */
  app.get('/sync/v1/quota', { preHandler: auth() }, async (request) => {
    const claims = request.relayAuth!
    const result = await withTenantTransaction(pool, claims.sid, async (client) => {
      await client.query(
        `INSERT INTO sync_space_quota(space_id) VALUES ($1)
         ON CONFLICT (space_id) DO NOTHING`,
        [claims.sid],
      )
      const q = await client.query<{
        max_entities: string; max_ciphertext_bytes: string; max_blob_bytes: string; max_devices: number
        used_entities: string; used_ciphertext_bytes: string
      }>(
        `SELECT max_entities,max_ciphertext_bytes,max_blob_bytes,max_devices,used_entities,used_ciphertext_bytes
         FROM sync_space_quota WHERE space_id=$1`,
        [claims.sid],
      )
      const devices = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM sync_device_keys WHERE space_id=$1 AND status <> 'revoked'`,
        [claims.sid],
      )
      return { quota: q.rows[0], usedDevices: Number(devices.rows[0]?.n ?? 0) }
    })
    const snap = quotaSnapshotFromDefaults({
      usedEntities: Number(result.quota?.used_entities ?? 0),
      usedCiphertextBytes: Number(result.quota?.used_ciphertext_bytes ?? 0),
      usedDevices: result.usedDevices,
    })
    return {
      usedEntities: snap.usedEntities,
      maxEntities: snap.maxEntities,
      usedCiphertextBytes: snap.usedCiphertextBytes,
      maxCiphertextBytes: snap.maxCiphertextBytes,
      maxBlobBytes: snap.maxBlobBytes,
      usedDevices: snap.usedDevices,
      maxDevices: snap.maxDevices,
    }
  })
}

export { DEFAULT_QUOTA, checkQuota }
