import { useSettingsStore } from './useSettingsStore'
import { usePersonaStore } from './usePersonaStore'
import type { Character } from '../../shared/types'

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
  if (lower.includes('timeout') || lower.includes('aborted')) return '请求超时，请检查网络'
  if (lower.includes('network') || lower.includes('econnrefused') || lower.includes('fetch failed')) return '网络连接失败，请检查网络或 Base URL'
  if (lower.includes('model not found')) return '模型不存在，请检查模型名'
  if (lower.includes('context length') || lower.includes('too long')) return '上下文过长，请清空部分对话'
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
 * 应用角色的默认长记忆配置到新会话（角色卡配置 defaultMemoryEnabled 时生效）。
 * 仅初始化一次，用户后续可手动覆盖。
 */
export async function applyDefaultMemory(character: Character | null | undefined, sessionId: string): Promise<void> {
  if (!character?.defaultMemoryEnabled) return
  try {
    await window.api.chat.updateSession(character.id, sessionId, {
      memoryEnabled: true,
      memoryMode: character.defaultMemoryMode ?? 'auto',
      autoMemoryInterval: character.defaultMemoryInterval ?? 10,
    })
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
