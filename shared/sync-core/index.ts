/**
 * 阶段 7 S7-01：Sync Core 纯逻辑——**跨端共享、无副作用**。
 *
 * 禁止访问网络、磁盘、时钟和随机数；这些均通过输入传入。
 * 两端读取同一 golden（`shared/fixtures/cross-platform/sync-core/`），
 * 输出规范 JSON 必须逐字节一致。
 *
 * 依赖：`shared/contracts` 的版本向量 / 信封 / 冲突分类 / canonical JSON。
 */
export * from './types'
export * from './plan'
export * from './batch'
export * from './conflictSuggest'
export * from './tombstone'
export * from './capability'
export * from './sessionMachine'
export * from './dependency'
export * from './summary'
export * from './lanAuth'
