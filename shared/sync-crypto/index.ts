/**
 * 阶段 8 S8-01/S8-02：同步 E2EE 原语与密钥格式。
 *
 * 跨端契约：TS 生成 golden（`shared/fixtures/cross-platform/sync-crypto/`），Kotlin 逐字节复算。
 * 生产随机数由边缘注入；fixture 使用固定测试密钥。
 */
export * from './types'
export * from './kdf'
export * from './entity'
export * from './blob'
export * from './keyEnvelope'
export * from './recovery'
