/**
 * 阶段 0a：渲染层 ContextDataProvider 实现（方案「安卓伴侣端方案」§7 阶段 0a）。
 *
 * 策略：包装现有 Zustand store 的 getState()，零数据迁移——
 * 角色/预设来自函数参数调用方传入的 ID 反查 store，会话/消息/激活世界书/语义命中
 * 直读 useChatStore，设置直读 useSettingsStore，正则走 window.api.regex.list()（IPC 读盘）。
 *
 * 与主进程实现（electron/context/mainContextProvider.ts）共用同一接口，
 * 0b 的 contextBuilder 将同时接受两个实现，保证两端组装行为一致。
 */

import type {
  ContextBuildData,
  ContextChatSnapshot,
  ContextDataProvider,
} from '../../shared/contextTypes'
import type { ChatSession, Character, Lorebook, Preset, RegexRule } from '../../shared/types'
import { useChatStore } from '../store/useChatStore'
import { useSettingsStore } from '../store/useSettingsStore'
import { useCharacterStore } from '../store/useCharacterStore'
import { lorebookCache } from '../utils/lorebook'
/** 渲染层会话快照：直读 useChatStore（含 P0-2 语义检索命中） */
function buildChatSnapshot(): ContextChatSnapshot {
  const store = useChatStore.getState()
  return {
    messages: store.messages,
    sessions: store.sessions,
    currentSessionId: store.currentSessionId,
    activeLorebookIds: store.activeLorebookIds,
    semanticFactsHits: store._semanticFactsHits,
    // BudgetLoreItem -> SemanticLoreHit（shared 层不依赖 src 内部类型）
    semanticLoreHits: store._semanticLoreHits.map((hit) => ({
      content: hit.content,
      order: hit.order,
      position: hit.position,
      depth: hit.depth,
    })),
  }
}

/** 渲染层 ContextDataProvider：包装现有 store（零数据迁移） */
export const rendererContextProvider: ContextDataProvider = {
  async fetchBuildData(characterId, sessionId, opts): Promise<ContextBuildData> {
    const characterStore = useCharacterStore.getState()
    const character: Character | null =
      characterStore.characters.find((c) => c.id === characterId) ?? null

    const settingsStore = useSettingsStore.getState()
    const settings = settingsStore.settings
    const profile = settingsStore.getActiveProfile()

    const chat = buildChatSnapshot()

    // 预设：显式覆盖 > store 的 activePresetId（对齐 getActiveChatConfig 的读取路径）
    let presetId = opts?.presetId
    if (presetId === undefined) presetId = useChatStore.getState().activePresetId
    let preset: Preset | null = null
    if (presetId) {
      const presets = await window.api.preset.list()
      preset = presets.find((p) => p.id === presetId) ?? null
    }

    // 世界书：与 getActiveChatConfig 同一刷新路径（仅 enabled）
    const lorebooks: Lorebook[] = chat.activeLorebookIds.length > 0
      ? (await lorebookCache.refresh(chat.activeLorebookIds)).filter((lb) => lb.enabled)
      : []

    const regexRules: RegexRule[] = await window.api.regex.list()

    return {
      character,
      preset,
      chat,
      settings: { settings, profile },
      lorebooks,
      regexRules,
    }
  },

  async getSession(characterId, sessionId): Promise<ChatSession | null> {
    const store = useChatStore.getState()
    // 当前会话优先；否则按 characterId + sessionId 从会话列表反查
    if (store.currentSessionId === sessionId) {
      return store.sessions.find((s) => s.id === sessionId) ?? null
    }
    return store.sessions.find((s) => s.characterId === characterId && s.id === sessionId) ?? null
  },
}

/**
 * 同步构造数据快照（0b 薄封装专用）：从 store 实时取数，不触发任何 IPC/异步加载。
 * - lorebooks 用 lorebookCache.getAll（与迁移前 buildChatContext 的读取路径一致，不过滤书级 enabled）
 * - regexRules 恒空：正则管线在 sendMessage/streamAIResponse 内独立处理，contextBuilder 不消费
 */
export function syncBuildData(character: Character, preset: Preset | null): ContextBuildData {
  const settingsStore = useSettingsStore.getState()
  const chat = buildChatSnapshot()
  return {
    character,
    preset,
    chat,
    settings: {
      settings: settingsStore.settings,
      profile: settingsStore.getActiveProfile(),
    },
    lorebooks: lorebookCache.getAll(chat.activeLorebookIds),
    regexRules: [],
  }
}

export const rendererSyncContextProvider = { syncBuildData }
