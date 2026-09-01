import type pg from 'pg'
import { withTenantTransaction, type TenantClient } from '../db/tenantTransaction.js'

type Notify = (spaceId: string, event: string, data: unknown, targetDeviceId?: string) => void

/** 小批次清理器：逐空间进入 RLS 事务，绝不使用跨租户裸查询删除资源。 */
export class RetentionWorker {
  private timer: NodeJS.Timeout | null = null
  constructor(private readonly pool: pg.Pool, private readonly notify: Notify = () => {}) {}

  start(intervalMs = 15 * 60_000): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.runOnce() }, intervalMs)
    this.timer.unref()
    void this.runOnce()
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  async runOnce(): Promise<void> {
    const spaces = await this.pool.query<{ id: string }>("SELECT id FROM relay_spaces WHERE status<>'deleted' ORDER BY id")
    for (const { id: spaceId } of spaces.rows) {
      await withTenantTransaction(this.pool, spaceId, async (client) => {
        await this.deleteExpired(client, 'cached_resources')
        await this.deleteExpired(client, 'relay_events')
        await this.deleteExpired(client, 'cached_sessions')
        await this.deleteExpired(client, 'cached_messages')
        const expired = await client.query<{ id: string; device_id: string }>(
          `UPDATE relay_commands SET status='expired'
           WHERE ctid IN (SELECT ctid FROM relay_commands WHERE status='queued' AND expires_at<=now() LIMIT 500)
           RETURNING id,device_id`,
        )
        for (const row of expired.rows) this.notify(spaceId, 'command:expired', { commandId: row.id }, row.device_id)
        await client.query(
          `WITH ranked AS (
             SELECT ctid,row_number() OVER (PARTITION BY session_id ORDER BY updated_at DESC) AS rn
             FROM cached_messages
           )
           DELETE FROM cached_messages m USING ranked r WHERE m.ctid=r.ctid AND r.rn>200`,
        )
      })
    }
  }

  private async deleteExpired(client: TenantClient, table: 'cached_resources' | 'relay_events' | 'cached_sessions' | 'cached_messages'): Promise<void> {
    await client.query(`DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE expires_at<=now() LIMIT 500)`)
  }
}
