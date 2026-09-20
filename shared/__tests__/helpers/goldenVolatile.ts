/**
 * 跨语言 golden 的「易变值归一」唯一出处。
 *
 * fixture 要能被另一种语言复现，就必须先确认哪些值是**这台机器、这一次运行**才有意义的：
 * 时间戳、内容哈希、以及随机生成的实体 id。留着它们，Kotlin 侧会在下一台机器上无故变红；
 * 全抹掉又会把「外部格式本来就带的确定 id」一起抹掉，让 Android 的正确答案反倒像偏差。
 * 所以这里只有两条规矩，且**所有** content-io / lorebook golden 都必须走这两个函数：
 *
 * - [stripVolatile]：时间戳与 sha256 → 哨兵；
 * - [normalizeCanonicalEntryIds]：只把「导入器自己造的」条目 id 换成哨兵。
 */

export const VOLATILE_TIMESTAMP = '<volatile:timestamp>'
export const VOLATILE_HASH = '<volatile:sha256>'
export const ENTRY_ID_SENTINEL = '<volatile:entry-id>'

/** 世界书导入会盖 `importedAt` 与 `contentHash`；Kotlin 不可能复现同一时间戳。 */
export function stripVolatile(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, raw) => {
      if (key === 'importedAt' && typeof raw === 'number') return VOLATILE_TIMESTAMP
      if (key === 'createdAt' || key === 'updatedAt') {
        return typeof raw === 'number' ? VOLATILE_TIMESTAMP : raw
      }
      if (key === 'contentHash' && typeof raw === 'string' && raw.length > 0) return VOLATILE_HASH
      return raw
    }),
  )
}

/**
 * canonical v2 文档里「由调用顺序决定」的条目 id → 哨兵。
 *
 * 判据是 `id !== sourceId`：`shared/lorebook/migrations/v1-to-v2.ts` 对原生 v1 会
 * 同时写 `id: entry.id` 与 `sourceId: entry.id`（样本里的 `v1e` 因此是确定值，
 * 而且 `shared/lorebook/runtime/compile.ts` 的原生 v1 导出**直接写 `entry.id`**），
 * 而 nanoid 新生成的 id 必然与 sourceId 不同。
 * 一律归成哨兵会把 `v1e` 这种必须原样导出的值也抹掉——第一版就是这么写的，
 * 结果 Android 导出 `id:"v1e"` 反而被判成偏差。
 *
 * `src/test/setup.ts` 把 nanoid 全局 mock 成自增的 `mock-id-N`，所以这个函数
 * 同时保证了「同一份 fixture 换执行顺序也逐字节一致」。
 */
export function normalizeCanonicalEntryIds(document: unknown): unknown {
  if (!document || typeof document !== 'object') return document
  const entries = (document as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return document
  return {
    ...document,
    entries: entries.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry
      const record = entry as { id?: unknown; sourceId?: unknown }
      return typeof record.id === 'string' && record.id !== record.sourceId
        ? { ...record, id: ENTRY_ID_SENTINEL }
        : record
    }),
  }
}

/** 一条 world book canonical 文档的完整归一结果，供两端共用。 */
export function normalizeLorebookDocument(document: unknown): unknown {
  return normalizeCanonicalEntryIds(stripVolatile(document))
}
