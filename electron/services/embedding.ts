/**
 * 嵌入（Embedding）适配器
 *
 * 支持两种嵌入服务，协议均为标准 HTTP JSON，无原生依赖：
 * - openai：OpenAI 兼容 `/embeddings` 接口（OpenAI / DeepSeek / 硅基流动 / OneAPI 等）
 * - ollama：Ollama `/api/embed` 接口（本地免费，如 nomic-embed-text / bge-m3）
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { createLogger } from './logger'

const log = createLogger('embedding')

export type EmbeddingProvider = 'openai' | 'ollama'

export interface EmbeddingConfig {
  provider: EmbeddingProvider
  baseUrl: string
  model: string
  apiKey: string
}

/** 单条输入的最大字符数（避免超长条目超出模型输入限制） */
const MAX_INPUT_CHARS = 8000
/** 单批嵌入条数 */
const BATCH_SIZE = 32
/** 请求超时（毫秒） */
const TIMEOUT_MS = 60_000

/** 截断过长的文本 */
function truncate(text: string, max = MAX_INPUT_CHARS): string {
  if (text.length <= max) return text
  return text.slice(0, max)
}

/** OpenAI 兼容 /embeddings 接口 */
async function embedOpenAI(config: EmbeddingConfig, inputs: string[]): Promise<number[][]> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/embeddings`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: config.model, input: inputs }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`嵌入服务错误 ${response.status}: ${errText.slice(0, 300)}`)
  }
  const data: any = await response.json()
  const embeddings = Array.isArray(data?.data) ? data.data : []
  // 按输入顺序排列（部分兼容端点可能乱序，按 index 重排）
  const sorted = embeddings
    .filter((e: any) => Array.isArray(e.embedding))
    .sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
  if (sorted.length !== inputs.length) {
    log.warn('嵌入结果数量与输入不匹配', { expected: inputs.length, got: sorted.length })
  }
  return sorted.map((e: any) => e.embedding as number[])
}

/** Ollama /api/embed 接口 */
async function embedOllama(config: EmbeddingConfig, inputs: string[]): Promise<number[][]> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/api/embed`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, input: inputs }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Ollama 嵌入错误 ${response.status}: ${errText.slice(0, 300)}`)
  }
  const data: any = await response.json()
  const embeddings: number[][] = Array.isArray(data?.embeddings) ? data.embeddings : []
  if (embeddings.length !== inputs.length) {
    // Ollama 单个字符串输入时返回一维数组，兼容处理
    if (embeddings.length === 1 && inputs.length === 1) return embeddings
    log.warn('Ollama 嵌入结果数量与输入不匹配', { expected: inputs.length, got: embeddings.length })
  }
  return embeddings
}

/** 批量嵌入文本（自动分批 + 截断，任一批失败即抛错） */
export async function embedTexts(config: EmbeddingConfig, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const clean = texts.map((t) => truncate(t ?? ''))
  const results: number[][] = []
  const embed = config.provider === 'ollama' ? embedOllama : embedOpenAI
  for (let i = 0; i < clean.length; i += BATCH_SIZE) {
    const batch = clean.slice(i, i + BATCH_SIZE)
    const vectors = await embed(config, batch)
    results.push(...vectors)
  }
  // 兜底：结果缺失时补零向量（沿用批次已知维度，避免维度不一致导致下游点积错乱）
  let knownDim = 0
  for (const v of results) {
    if (v.length > 0) { knownDim = v.length; break }
  }
  while (results.length < clean.length) {
    results.push(knownDim > 0 ? new Array(knownDim).fill(0) : [])
  }
  return results
}

/** 测试嵌入服务连接：嵌入固定文本并返回向量维度 */
export async function testEmbedding(config: EmbeddingConfig): Promise<{ ok: boolean; dim?: number; error?: string }> {
  try {
    const vectors = await embedTexts(config, ['测试'])
    const dim = vectors[0]?.length
    if (!dim) return { ok: false, error: '嵌入服务未返回有效向量' }
    return { ok: true, dim }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 检查配置是否可发起嵌入请求 */
export function isEmbeddingConfigured(config: EmbeddingConfig): boolean {
  if (!config?.baseUrl?.trim()) return false
  if (!config.model?.trim()) return false
  // OpenAI 兼容服务需要 apiKey；Ollama 不需要
  if (config.provider === 'openai' && !config.apiKey?.trim()) return false
  return true
}
