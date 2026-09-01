import pg from 'pg'
import type { RelayConfig } from '../config.js'

export function createPool(config: Pick<RelayConfig, 'databaseUrl'>): pg.Pool {
  // 登录角色只负责建连；每个业务连接在 PostgreSQL 启动参数阶段即降权到
  // NOSUPERUSER/NOBYPASSRLS 的 qingyu_relay_app，避免连接池中出现可绕过 RLS 的窗口。
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: 20,
    statement_timeout: 65_000,
    options: '-c role=qingyu_relay_app',
  })
}
