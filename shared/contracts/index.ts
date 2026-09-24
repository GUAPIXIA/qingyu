export * from './canonical-json'
export * from './version-vector'
export * from './sync-envelope'
export * from './conflict'
export * from './migrations'
// 阶段 7 Sync Core 纯逻辑（可从 contracts 再导出，也可直接 import shared/sync-core）
export * as syncCore from '../sync-core'
