import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { WebSocket } from 'ws'
import { withTenantTransaction } from '../db/tenantTransaction.js'
import type { RelayRpcRequestPayload } from '../../../shared/relayProtocol.js'
import type { RpcBroker } from '../routing/rpcBroker.js'

export class CommandQueue {
  constructor(
    private readonly pool: pg.Pool,
    private readonly broker: RpcBroker,
    private readonly notify: (spaceId: string, event: string, data: unknown, targetDeviceId?: string) => void = () => {},
  ) {}
  async enqueue(spaceId: string, deviceId: string, payload: RelayRpcRequestPayload): Promise<string> {
    const id = /^[0-9a-f-]{36}$/i.test(payload.commandId) ? payload.commandId : randomUUID()
    await withTenantTransaction(this.pool, spaceId, (client) => client.query(
      `INSERT INTO relay_commands(id,space_id,device_id,session_id,command_type,payload,status,expires_at)
       VALUES ($1,$2,$3,$4,'send_message',$5,'queued',now()+interval '15 minutes')
       ON CONFLICT(space_id,id) DO NOTHING`,
      [id, spaceId, deviceId, payload.path.match(/sessions\/([^/]+)/)?.[1] ?? null, payload],
    ).then(() => undefined))
    return id
  }
  async drain(spaceId: string, pc: WebSocket): Promise<void> {
    const drained = await withTenantTransaction(this.pool, spaceId, async (client) => {
      const expired = await client.query<{ id: string; device_id: string }>(
        "UPDATE relay_commands SET status='expired' WHERE status='queued' AND expires_at<=now() RETURNING id,device_id",
      )
      const result = await client.query<{ id: string; payload: RelayRpcRequestPayload }>(
        "SELECT id,payload FROM relay_commands WHERE status='queued' AND expires_at>now() ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED",
      )
      if (result.rows.length) await client.query("UPDATE relay_commands SET status='processing' WHERE id=ANY($1::uuid[])", [result.rows.map((row) => row.id)])
      return { rows: result.rows, expired: expired.rows }
    })
    for (const row of drained.expired) {
      this.notify(spaceId, 'command:expired', { commandId: row.id }, row.device_id)
    }
    for (const row of drained.rows) {
      try {
        const response = await this.broker.request(spaceId, pc, { ...row.payload, commandId: row.id })
        await withTenantTransaction(this.pool, spaceId, (client) => client.query(
          "UPDATE relay_commands SET status='completed',result_status=$2,result_body=$3,completed_at=now() WHERE id=$1",
          [row.id, response.status, response.body ?? null],
        ).then(() => undefined))
        this.notify(spaceId, 'command:completed', {
          commandId: row.id, resultStatus: response.status, resultBody: response.body ?? null,
        }, row.payload.sourceDeviceId)
      } catch {
        await withTenantTransaction(this.pool, spaceId, (client) => client.query("UPDATE relay_commands SET status='queued' WHERE id=$1 AND expires_at>now()", [row.id]).then(() => undefined))
        break
      }
    }
  }
}
