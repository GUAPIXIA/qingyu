import type pg from 'pg'

export type TenantClient = Omit<pg.PoolClient, 'release'> & { readonly tenantSpaceId: string }

export async function withTenantTransaction<T>(pool: pg.Pool, spaceId: string, callback: (client: TenantClient) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(spaceId)) throw new Error('invalid tenant space id')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.space_id', $1, true)", [spaceId])
    const scoped = Object.assign(client, { tenantSpaceId: spaceId }) as TenantClient
    const result = await callback(scoped)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
