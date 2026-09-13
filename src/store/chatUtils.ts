import { useSettingsStore } from './useSettingsStore'
import { usePersonaStore } from './usePersonaStore'
import { logWarn } from '../lib/logger'
import { estimateTokens } from '../utils/tokenCounter'
import type { LorebookCompressionRequest } from '../utils/lorebook'
import type { Character, SessionPreview, LorebookCompressionCacheEntry, ProviderType } from '../../shared/types'
import { stripAllThinking } from '../../shared/thoughtMarkup'
import { resolveDefaultGroupMemoryConfig, resolveDefaultMemoryConfig } from '../../shared/defaultMemory'

/** 防止会话加载竞态的请求计数器（模块级，跨调用共享） */
export let loadRequestId = 0

export function nextLoadRequestId(): number {
  return ++loadRequestId
}

/** 读取当前请求计数（不递增） */
export function currentLoadRequestId(): number {
  return loadRequestId
}

/** 将原始 API 错误转换为用户友好的中文提示 */
export function friendlyError(error: string): string {
  if (!error) return '未知错误'
  const lower = error.toLowerCase()
  if (lower.includes('401') || lower.includes('unauthorized')) return 'API Key 无效或已过期'
  if (lower.includes('403') || lower.includes('forbidden')) return '访问被拒绝，请检查 API Key 权限'
  if (lower.includes('429') || lower.includes('rate limit')) return '请求过于频繁，请稍后再试'
  if (lower.includes('500') || lower.includes('502') || lower.includes('503')) return 'AI 服务暂时不可用，请稍后重试'
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborted')) return '请求超时，请检查网络'
  if (lower.includes('network') || lower.includes('econnrefused') || lower.includes('fetch failed')) return '网络连接失败，请检查网络或 Base URL'
  if (lower.includes('model not found')) return '模型不存在，请检查模型名'
  if (lower.includes('context length') || lower.includes('too long')) return '上下文过长，请清空部分对话'
  // 图片/视觉相关错误（含适配器附加的「请求包含图片」诊断标记）
  if (lower.includes('请求包含图片')) {
    return '模型或网关不支持图片输入：请确认识图模型支持视觉（如 gpt-4o、qwen-vl 系列），且网关支持 data URL 图片格式；或检查识图模型配置'
  }
  if (lower.includes('image') && (lower.includes('400') || lower.includes('invalid'))) {
    return '图片请求被拒绝：模型可能不支持视觉输入，请确认识图模型配置正确'
  }
  return error.length > 100 ? error.slice(0, 100) + '...' : error
}

/** 根据 personaId 同步身份到 settings（activePersonaId / userName / userDescription / userPersona）
 *  用于新会话绑定默认身份后立即生效，避免顶栏与发送消息仍使用旧身份 */
export function syncPersonaToSettings(personaId?: string | null): void {
  const persona = personaId ? usePersonaStore.getState().getPersona(personaId) : undefined
  if (persona) {
    useSettingsStore.getState().updateSettings({
      activePersonaId: persona.id,
      userName: persona.name,
      userDescription: persona.description,
      userPersona: persona.persona,
    })
  }
}

/**
 * 应用新会话的默认长记忆配置。角色卡已启用长记忆时优先使用角色参数，
 * 否则回退到全局“新建对话默认开启长记忆”设置。
 * 仅初始化一次，用户后续可手动覆盖。
 */
export async function applyDefaultMemory(character: Character | null | undefined, sessionId: string): Promise<void> {
  if (!character) return
  const cfg = resolveDefaultMemoryConfig(useSettingsStore.getState().settings, character)
  if (!cfg.memoryEnabled) return
  try {
    await window.api.chat.updateSession(character.id, sessionId, { ...cfg })
  } catch { /* 忽略 */ }
}

/** 将全局默认长记忆配置应用到新建群聊。 */
export async function applyDefaultGroupMemory(groupId: string, sessionId: string): Promise<void> {
  const cfg = resolveDefaultGroupMemoryConfig(useSettingsStore.getState().settings)
  if (!cfg.memoryEnabled) return
  try {
    await window.api.group.updateSession(groupId, sessionId, { ...cfg })
  } catch { /* 忽略 */ }
}

/** 历史变更后使上下文压缩缓存失效（编辑/删除/清空消息时调用） */
export async function invalidateCompression(
  get: () => { currentSessionId: string | null; sessions: { id: string; compressedSummary?: string | null; compressedRange?: unknown }[] },
  character: Character,
): Promise<void> {
  const sid = get().currentSessionId
  if (!sid) return
  const cur = get().sessions.find((s) => s.id === sid)
  if (cur?.compressedSummary) {
    await window.api.chat.updateSession(character.id, sid, {
      compressedSummary: null,
      compressedRange: null,
    }).catch(() => { /* 忽略 */ })
  }
}

/**
 * 消息被改写、删除或切换候选回复后，历史摘要、事实向量和压缩摘要的失效策略（阶段五检查点）。
 * - changedMessageId 为空（如 clearChat）→ 全量失效
 * - 无检查点（memoryVersion 0 / memoryLastMessageId 空）→ 全量失效
 * - 变更在游标之后 → 保留派生记忆（return null）
 * - 变更在游标之前或等于游标 / 游标/消息找不到 → 全量失效
 * 返回 patch 与 expectedVersion（乐观锁），调用方据此决定是否 patchLocalSession。
 */
export async function invalidateDerivedMemory(
  get: () => { currentSessionId: string | null; sessions: SessionPreview[]; messages?: { id: string }[] },
  character: Character,
  changedMessageId?: string | null,
): Promise<{ sessionId: string; patch: Partial<SessionPreview>; expectedVersion: number } | null> {
  const sessionId = get().currentSessionId
  if (!sessionId) return null
  const current = get().sessions.find((session) => session.id === sessionId)
  if (!current) return null
  const hasDerivedData = Boolean(
    current.memory || current.memoryCurrentState || current.memoryFacts?.length || current.memoryFactHistory?.length || current.factsVectors?.length
    || current.memoryLastMessageId || current.memoryVersion || current.memoryFactParseFailureCount || current.memoryFactRetryAfterVersion || current.compressedSummary,
  )
  if (!hasDerivedData) return null

  // 检查点逻辑：变更在游标后则保留
  if (changedMessageId) {
    const cursor = current.memoryLastMessageId
    const version = current.memoryVersion ?? 0
    // 无检查点则全量失效
    if (!cursor || version === 0) {
      // fallthrough to full invalidate
    } else {
      const messages = (get() as { messages?: { id: string }[] }).messages ?? []
      const cursorIndex = messages.findIndex((m) => m.id === cursor)
      const changedIndex = messages.findIndex((m) => m.id === changedMessageId)
      // 消息或游标找不到 → 保守全量失效
      if (cursorIndex === -1 || changedIndex === -1) {
        // fallthrough
      } else if (changedIndex > cursorIndex) {
        // 变更在已总结范围之后，保留记忆
        return null
      }
      // 变更在游标前或等于游标 → 全量失效（fallthrough）
    }
  }

  const expectedVersion = current.memoryVersion ?? 0
  const patch: Partial<SessionPreview> = {
    memory: '',
    memoryCurrentState: '',
    memoryFacts: [],
    memoryFactHistory: [],
    memoryFactParseFailureCount: 0,
    memoryFactRetryAfterVersion: 0,
    factsVectors: [],
    memoryUpdatedAt: 0,
    memoryLastMessageId: null,
    memoryVersion: 0,
    factsVectorVersion: 0,
    compressedSummary: null,
    compressedRange: null,
  }
  // 乐观锁：若版本已变则跳过（由调用方在 patchLocalSession 前二次校验）
  const latest = get().sessions.find((s) => s.id === sessionId)
  if (latest && (latest.memoryVersion ?? 0) !== expectedVersion) {
    return null
  }
  const commit = await window.api.chat.updateSessionIfMemoryVersion(character.id, sessionId, expectedVersion, patch).catch(() => null)
  if (!commit?.applied) return null
  return { sessionId, patch, expectedVersion }
}

/**
 * 群聊检查点同步：与单聊 invalidateDerivedMemory 同逻辑，作用于 GroupSession。
 * changedMessageId 为空（如 clearChat）→ 全量失效；游标后变更保留。
 */
export async function invalidateGroupDerivedMemory(
  get: () => { currentSessionId: string | null; sessions: { id: string; memory?: string | null; memoryFacts?: unknown[]; memoryFactHistory?: unknown[]; factsVectors?: unknown[]; memoryLastMessageId?: string | null; memoryVersion?: number; compressedSummary?: string | null; compressedRange?: unknown }[]; messages?: { id: string }[] },
  groupId: string,
  changedMessageId?: string | null,
): Promise<{ sessionId: string; patch: Record<string, unknown>; expectedVersion: number } | null> {
  const sessionId = get().currentSessionId
  if (!sessionId) return null
  const current = get().sessions.find((s) => s.id === sessionId) as unknown as Record<string, unknown> & { memory?: string; memoryFacts?: unknown[]; memoryFactHistory?: unknown[]; factsVectors?: unknown[]; memoryLastMessageId?: string | null; memoryVersion?: number; compressedSummary?: string | null }
  if (!current) return null
  const hasDerived = Boolean(
    current.memory || current.memoryCurrentState || (current.memoryFacts as unknown[])?.length || (current.memoryFactHistory as unknown[])?.length || (current.factsVectors as unknown[])?.length
    || current.memoryLastMessageId || current.memoryVersion || current.compressedSummary,
  )
  if (!hasDerived) return null
  if (changedMessageId) {
    const cursor = current.memoryLastMessageId as string | null | undefined
    const version = (current.memoryVersion as number | undefined) ?? 0
    if (!cursor || version === 0) {
      // fallthrough
    } else {
      const messages = get().messages ?? []
      const cursorIndex = messages.findIndex((m) => m.id === cursor)
      const changedIndex = messages.findIndex((m) => m.id === changedMessageId)
      if (cursorIndex === -1 || changedIndex === -1) {
        // fallthrough
      } else if (changedIndex > cursorIndex) {
        return null
      }
    }
  }
  const expectedVersion = (current.memoryVersion as number | undefined) ?? 0
  const patch: Record<string, unknown> = {
    memory: '',
    memoryCurrentState: '',
    memoryFacts: [],
    memoryFactHistory: [],
    memoryFactParseFailureCount: 0,
    memoryFactRetryAfterVersion: 0,
    factsVectors: [],
    memoryUpdatedAt: 0,
    memoryLastMessageId: null,
    memoryVersion: 0,
    factsVectorVersion: 0,
    compressedSummary: null,
    compressedRange: null,
  }
  const latest = get().sessions.find((s) => s.id === sessionId) as unknown as { memoryVersion?: number }
  if (latest && (latest.memoryVersion ?? 0) !== expectedVersion) return null
  const commit = await window.api.group.updateSessionIfMemoryVersion(groupId, sessionId, expectedVersion, patch).catch(() => null)
  if (!commit?.applied) return null
  return { sessionId, patch, expectedVersion }
}

// ===================== 世界书超限压缩（阶段三） =====================

/**
 * 世界书超限条目 AI 压缩：非流式调用主进程，将本轮被丢弃的低分条目压缩为一段摘要。
 * 调用方以 fire-and-forget 方式使用（不 await，不阻断发送）；任何失败返回 null，
 * 由裁剪逻辑维持阶段二的直接丢弃行为（静默降级）。
 */
const lorebookCompressionInFlight = new Map<string, Promise<{ key: string; entry: LorebookCompressionCacheEntry } | null>>()

export async function compressLorebookOverflow(
  request: LorebookCompressionRequest,
  conn: { provider: string; apiKey: string; baseUrl: string; model: string },
): Promise<{ key: string; entry: LorebookCompressionCacheEntry } | null> {
  if (!request.contents.length || request.targetTokens < 32) return null
  const inFlightKey = [conn.provider, conn.baseUrl, conn.model, request.key, request.targetTokens].join('|')
  const existing = lorebookCompressionInFlight.get(inFlightKey)
  if (existing) return existing

  const task = (async () => {
    try {
      const raw = await window.api.ai.compressLorebook({
        contents: request.contents,
        targetTokens: request.targetTokens,
        provider: conn.provider as ProviderType,
        apiKey: conn.apiKey,
        baseUrl: conn.baseUrl,
        model: conn.model,
      })
      // 去除思考标签与空白；空结果或超出目标均不写缓存，避免下一轮重复命中无效结果。
      const summary = stripAllThinking(String(raw ?? ''))
      if (!summary || estimateTokens(summary, conn.model) > request.targetTokens) return null
      const now = Date.now()
      return {
        key: request.key,
        entry: { summary, entryKeys: request.entryKeys, createdAt: now, lastUsedAt: now },
      }
    } catch (e) {
      logWarn('lorebookCompression', `世界书超限压缩失败（降级为直接裁剪）：${(e as Error)?.message ?? e}`)
      return null
    }
  })().finally(() => lorebookCompressionInFlight.delete(inFlightKey))
  lorebookCompressionInFlight.set(inFlightKey, task)
  return task
}

// ===================== 语义检索缓存 =====================

/**
 * 语义检索结果缓存：同一轮对话内扫描文本不变时复用命中结果，
 * 避免重复调用嵌入服务（网络请求是语义触发的最大耗时点）。
 */
const semanticCache = new Map<string, { hits: unknown; ts: number }>()
const SEMANTIC_CACHE_TTL_MS = 60_000
const SEMANTIC_CACHE_MAX = 50

export function semanticCacheGet<T>(key: string): T | null {
  const item = semanticCache.get(key)
  if (!item) return null
  if (Date.now() - item.ts > SEMANTIC_CACHE_TTL_MS) {
    semanticCache.delete(key)
    return null
  }
  return item.hits as T
}

export function semanticCacheSet(key: string, hits: unknown): void {
  if (semanticCache.size >= SEMANTIC_CACHE_MAX) semanticCache.clear()
  semanticCache.set(key, { hits, ts: Date.now() })
}

/**
 * 构造语义检索缓存键。检索参数必须全部入键，避免用户切换服务、阈值或 topK 后
 * 在 TTL 内误用上一套配置的结果。JSON 序列化也避免正文中的分隔符造成碰撞。
 */
export function buildSemanticCacheKey(input: {
  scope: 'lore' | 'group-lore' | 'facts' | 'group-facts'
  corpus: string
  query: string
  provider: string
  baseUrl: string
  model: string
  threshold?: number
  maxResults?: number
}): string {
  return JSON.stringify({
    ...input,
    baseUrl: input.baseUrl.trim().replace(/\/$/, ''),
    model: input.model.trim(),
    threshold: input.threshold ?? 0.3,
    maxResults: input.maxResults ?? 3,
  })
}
