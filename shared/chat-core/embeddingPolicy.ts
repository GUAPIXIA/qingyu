/**
 * 嵌入 / 语义检索的判定层（跨端共享，纯函数）。
 *
 * 为什么放在 `shared/`：这批函数是「PC 与 Android 是否做出同一个语义检索决定」的判定依据，
 * 两端都必须一致，因此按仓库既有规则提取为共享模块——跨语言 fixture 的 oracle
 * 就是**生产代码本身**，而不是测试里另抄一份。
 *
 * 不含任何 Electron / Node 运行时依赖，可被渲染进程、主进程与测试直接引用。
 */

/** 自动模式下的保守通用阈值 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.3

/** 远端嵌入服务的索引切片字符数 */
export const REMOTE_INDEX_CHUNK_CHARS = 4000

/** 本地模型 id 形态：`name@1.2.3`（可带预发布后缀） */
const LOCAL_MODEL_ID = /^[a-z0-9][a-z0-9._-]{1,63}@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export interface EmbeddingPolicyConfig {
  provider: 'local' | 'openai' | 'ollama' | string
  model: string
  baseUrl?: string
  apiKey?: string
}

export interface EmbeddingVectorSpace {
  provider: string
  model: string
  modelId?: string
  modelVersion?: string
}

/**
 * 检索命中 → 事实文本。
 *
 * 命中 id 是**字符串形式的下标**（对齐索引存储格式）；越界与非数字 id 一律丢弃，
 * 而不是抛出——旧索引在事实被裁剪后必然出现越界命中。
 */
export function mapFactSearchHits(
  hits: Array<{ id: string; score: number }>,
  facts: string[],
): Array<{ text: string; index: number; score: number }> {
  return hits
    .map((hit) => ({ text: facts[Number(hit.id)], index: Number(hit.id), score: hit.score }))
    .filter((hit) => Boolean(hit.text))
}

/**
 * 条目是否参与**语义匹配**（索引侧判定）。
 *
 * 注意与 `shared/lorebookEmbedding.isLoreEntrySemanticEligible` 的差别，两者不是一回事：
 * 这条只看 `priority` 与 `matchMode`，另一条还要求条目启用且正文非空。
 * 混用会让「该索引的没索引」或「不该索引的进了索引」，因此两者都保留。
 */
export function isSemanticEligible(entry: { priority?: string | null; matchMode?: string | null }): boolean {
  if (entry.priority === 'always') return false
  const mode = entry.matchMode ?? 'both'
  return mode === 'semantic' || mode === 'both'
}

/**
 * 由配置推导向量空间。查询向量与索引必须来自同一模型，
 * 否则维度即便碰巧一致，相似度也没有意义。
 *
 * 注意 `provider = local` 且模型串没有 `@` 时是 JS 切片的产物：
 * `lastIndexOf('@')` 返回 -1，于是 `slice(0, -1)` 丢掉最后一个字符、`slice(0)` 取整串。
 * 看起来怪，但是可观测行为，两端必须一致（已由跨语言 fixture 锁定）。
 */
export function vectorSpaceFromConfig(config: EmbeddingPolicyConfig): EmbeddingVectorSpace {
  if (config.provider === 'local') {
    const splitAt = config.model.lastIndexOf('@')
    return {
      provider: 'local',
      model: config.model,
      modelId: config.model.slice(0, splitAt),
      modelVersion: config.model.slice(splitAt + 1),
    }
  }
  return { provider: config.provider, model: config.model }
}

/** 索引是否仍可用于当前配置（模型名必比；双方都有 provider 时也比；local 还比 modelId/version）。 */
export function isVectorIndexCompatible(
  index: { model: string; provider?: string; modelId?: string; modelVersion?: string },
  config: Pick<EmbeddingPolicyConfig, 'model'> & Partial<Pick<EmbeddingPolicyConfig, 'provider'>>,
): boolean {
  if (index.model.trim() !== config.model.trim()) return false
  if (index.provider && config.provider && index.provider !== config.provider) return false
  if (config.provider === 'local') {
    const space = vectorSpaceFromConfig(config as EmbeddingPolicyConfig)
    return index.modelId === space.modelId && index.modelVersion === space.modelVersion
  }
  return true
}

/**
 * 语义检索阈值：显式请求优先；本地模型按已评测的校准值，未知模型用保守通用值。
 *
 * @param localProfiles 本地模型的评测表（`model → similarityThreshold`）。
 *   由调用方注入而不是在此处 import：该表位于 Electron 侧目录，注入后本模块保持纯函数、可跨端复用。
 */
export function resolveSemanticThreshold(
  config: EmbeddingPolicyConfig,
  requested?: number,
  localProfiles: Readonly<Record<string, { similarityThreshold: number }>> = {},
): number {
  if (typeof requested === 'number' && Number.isFinite(requested)) return requested
  if (config.provider === 'local') {
    return localProfiles[config.model]?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD
  }
  return DEFAULT_SIMILARITY_THRESHOLD
}

/** 嵌入服务是否已配置到可用（远端必须有 baseUrl；OpenAI 兼容还必须有 apiKey，Ollama 不需要）。 */
export function isEmbeddingConfigured(config: EmbeddingPolicyConfig): boolean {
  if (!config.model?.trim()) return false
  if (config.provider === 'local') return LOCAL_MODEL_ID.test(config.model)
  if (!config?.baseUrl?.trim()) return false
  if (config.provider === 'openai' && !config.apiKey?.trim()) return false
  return true
}
