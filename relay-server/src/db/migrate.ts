import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'

const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) throw new Error('Missing DATABASE_URL')
const migrationsDir = resolve(process.env.RELAY_MIGRATIONS_DIR ?? 'relay-server/migrations')
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })

try {
  await pool.query(`CREATE TABLE IF NOT EXISTS relay_schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
  )`)
  const files = (await readdir(migrationsDir)).filter((name) => /^\d+.*\.sql$/.test(name)).sort()
  for (const name of files) {
    const exists = await pool.query('SELECT 1 FROM relay_schema_migrations WHERE name=$1', [name])
    if (exists.rowCount) continue
    const sql = await readFile(resolve(migrationsDir, name), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO relay_schema_migrations(name) VALUES ($1)', [name])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
} finally { await pool.end() }
