import type pg from 'pg'
import { withTenantTransaction } from '../db/tenantTransaction.js'

interface CacheRecord { kind: 'character' | 'session' | 'message' | 'settings'; id: string; sessionId?: string; revision: number; payload: Record<string, unknown>; updatedAt: number }
interface CacheSnapshot { resources?: CacheRecord[] }

export class SnapshotService {
  constructor(private readonly pool: pg.Pool, private readonly retentionDays: number) {}

  async accept(spaceId: string, input: unknown): Promise<void> {
    const resources = (input as CacheSnapshot | null)?.resources
    if (!Array.isArray(resources) || resources.length > 25_000) throw new Error('invalid cache snapshot')
    await withTenantTransaction(this.pool, spaceId, async (client) => {
      const usage = await client.query<{ quota_bytes: string; cache_bytes: string }>(
        `SELECT s.quota_bytes::text,
          ((SELECT coalesce(sum(pg_column_size(payload)),0) FROM cached_sessions) +
           (SELECT coalesce(sum(pg_column_size(payload)),0) FROM cached_messages) +
           (SELECT coalesce(sum(pg_column_size(payload)),0) FROM cached_resources))::text AS cache_bytes
         FROM relay_spaces s WHERE s.id=$1`, [spaceId],
      )
      const quota = Number(usage.rows[0]?.quota_bytes ?? 0)
      const currentBytes = Number(usage.rows[0]?.cache_bytes ?? 0)
      const incomingBytes = resources.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record?.payload ?? null)), 0)
      // 达到配额时优先停止消息/媒体投影写入；在线 RPC 永不因缓存配额被拒绝。
      const acceptMessages = quota <= 0 || currentBytes + incomingBytes <= quota
      if (!acceptMessages) {
        await client.query(
          `DELETE FROM cached_messages WHERE ctid IN (
             SELECT ctid FROM cached_messages ORDER BY updated_at ASC LIMIT 500
           )`,
        )
      }
      for (const record of resources) {
        if (!record || !['character', 'session', 'message', 'settings'].includes(record.kind) || typeof record.id !== 'string' || !Number.isSafeInteger(record.revision) || typeof record.payload !== 'object') continue
        const expiresAt = new Date(Date.now() + this.retentionDays * 86_400_000)
        if (record.kind === 'message' && record.sessionId) {
          if (!acceptMessages) continue
          await client.query(
            `INSERT INTO cached_messages(space_id,session_id,message_id,revision,payload,updated_at,expires_at)
             VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0),$7)
             ON CONFLICT(space_id,session_id,message_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at,expires_at=excluded.expires_at
             WHERE excluded.revision>cached_messages.revision`,
            [spaceId, record.sessionId, record.id, record.revision, record.payload, record.updatedAt, expiresAt],
          )
        } else if (record.kind === 'session') {
          await client.query(
            `INSERT INTO cached_sessions(space_id,session_id,revision,payload,updated_at,expires_at)
             VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0),$6)
             ON CONFLICT(space_id,session_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at,expires_at=excluded.expires_at
             WHERE excluded.revision>cached_sessions.revision`,
            [spaceId, record.id, record.revision, record.payload, record.updatedAt, expiresAt],
          )
        } else {
          await client.query(
            `INSERT INTO cached_resources(space_id,resource_type,resource_id,revision,payload,updated_at,expires_at)
             VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0),$7)
             ON CONFLICT(space_id,resource_type,resource_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at,expires_at=excluded.expires_at
             WHERE excluded.revision>cached_resources.revision`,
            [spaceId, record.kind, record.id, record.revision, record.payload, record.updatedAt, expiresAt],
          )
        }
      }
      await client.query(
        `WITH ranked AS (
           SELECT ctid,row_number() OVER (PARTITION BY session_id ORDER BY updated_at DESC) AS rn
           FROM cached_messages
         )
         DELETE FROM cached_messages m USING ranked r WHERE m.ctid=r.ctid AND r.rn>200`,
      )
    })
  }

  async readRoute(spaceId: string, path: string): Promise<{ body: unknown; ageSeconds: number } | null> {
    return withTenantTransaction(this.pool, spaceId, async (client) => {
      let result: pg.QueryResult<{ payload: unknown; updated_at: Date }>
      if (path === '/api/v1/sessions') result = await client.query("SELECT payload,updated_at FROM cached_sessions WHERE expires_at>now() ORDER BY updated_at DESC")
      else if (path === '/api/v1/characters') result = await client.query("SELECT payload,updated_at FROM cached_resources WHERE resource_type='character' AND expires_at>now() ORDER BY updated_at DESC")
      else if (path === '/api/v1/settings/snapshot') result = await client.query("SELECT payload,updated_at FROM cached_resources WHERE resource_type='settings' AND expires_at>now() ORDER BY updated_at DESC LIMIT 1")
      else {
        const match = path.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/)
        if (!match) return null
        result = await client.query('SELECT payload,updated_at FROM cached_messages WHERE session_id=$1 AND expires_at>now() ORDER BY updated_at DESC LIMIT 200', [match[1]])
      }
      if (!result.rows.length) return null
      const newest = Math.max(...result.rows.map((row) => row.updated_at.getTime()))
      const values = result.rows.map((row) => row.payload)
      const body = path.endsWith('/messages') ? { messages: values, nextCursor: null } : path.endsWith('/snapshot') ? values[0] : values
      return { body, ageSeconds: Math.max(0, Math.round((Date.now() - newest) / 1000)) }
    })
  }
}
