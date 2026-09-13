/**
 * W1（主计划 §7.3/§5.3）：用量档案 renderer 侧缓存。
 *
 * 发送编排在构建上下文前 `await prefetchUsageProfile(...)` 预取；
 * 构建与后台任务调用点用 `cachedReasoningSamplesFor(...)` 同步读取。
 * 读取失败或无样本时返回 undefined —— 预算回退静态档案，生成不受影响。
 *
 * 隐私：只缓存数值聚合（IPC 已保证不含正文/完整 URL/磁盘路径），
 * 端点维度在本地也只用指纹，不保留 baseUrl 明文。
 */
import { endpointFingerprint } from '../../shared/endpointKey'
import type { GenerationUsageProfile, GenerationUsageProfileQuery } from '../../shared/ipc-api'

export interface UsageProfileCacheKeyInput {
  provider: string
  baseUrl: string
  model: string
  /** 缺省 = 主对话桶 */
  taskType?: string
  /** 缺省 = 无门控分桶（W4 起按实际档位传值） */
  gate?: string
}

/** 缓存有效期：同一分桶在短时间内复用，避免每轮都走 IPC */
const CACHE_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  profile: GenerationUsageProfile | null
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<void>>()

function cacheKeyOf(input: UsageProfileCacheKeyInput): string {
  return [
    input.provider,
    endpointFingerprint(input.baseUrl),
    input.model,
    input.taskType ?? 'main',
    input.gate ?? '(default)',
  ].join('\u0000')
}

function toQuery(input: UsageProfileCacheKeyInput): GenerationUsageProfileQuery {
  return {
    provider: input.provider,
    baseUrl: input.baseUrl,
    model: input.model,
    ...(input.taskType ? { taskType: input.taskType } : {}),
    ...(input.gate ? { gate: input.gate } : {}),
  }
}

/** 生成前异步预取（并发去重 + TTL 复用）；任何失败都静默降级为空档案 */
export async function prefetchUsageProfile(input: UsageProfileCacheKeyInput): Promise<void> {
  if (!input.provider || !input.model) return
  const key = cacheKeyOf(input)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return
  const pending = inflight.get(key)
  if (pending) return pending

  const task = (async () => {
    let profile: GenerationUsageProfile | null = null
    try {
      profile = await window.api.ai.getGenerationUsageProfile(toQuery(input))
    } catch {
      // 回读失败：静态档案兜底，不阻塞生成
      profile = null
    }
    cache.set(key, { profile: profile ?? null, fetchedAt: Date.now() })
    inflight.delete(key)
  })()
  inflight.set(key, task)
  return task
}

/**
 * 后台任务用：不阻塞当前调用，仅刷新缓存供后续轮次使用（失败静默）。
 * 记忆/压缩等后台路径不改变自身的同步时序，样本从下一次调用起生效。
 */
export function refreshUsageProfileInBackground(input: UsageProfileCacheKeyInput): void {
  void prefetchUsageProfile(input).catch(() => { /* 静默降级 */ })
}

/** 同步读取已缓存的近期推理样本（未预取/无样本/低置信度都不影响返回形状） */
export function cachedReasoningSamplesFor(input: UsageProfileCacheKeyInput): number[] | undefined {
  const entry = cache.get(cacheKeyOf(input))
  const samples = entry?.profile?.recentReasoningTokens
  return samples && samples.length > 0 ? [...samples] : undefined
}

/**
 * 便捷包装：按当前连接档案取该模型的近期样本，无样本时返回空对象，
 * 便于直接展开进预算/计划输入（`...withReasoningSamples(profile, activeModel)`）。
 */
export function withReasoningSamples(
  profile: { provider: string; baseUrl: string; model: string } | null | undefined,
  activeModel?: string,
): { reasoningSamples?: number[] } {
  const model = activeModel || profile?.model
  if (!profile || !model) return {}
  const samples = cachedReasoningSamplesFor({
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model,
  })
  return samples ? { reasoningSamples: samples } : {}
}

/** 测试与「重置模型探测」入口共用：清空缓存（不影响主进程观测文件） */
export function clearUsageProfileCache(): void {
  cache.clear()
  inflight.clear()
}
