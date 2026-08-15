/**
 * 阶段 0a：主进程 ContextDataProvider 实现（方案「安卓伴侣端方案」§7 阶段 0a）。
 *
 * 设计决策：按需读磁盘，不维护内存镜像（配置数据变更频率低，每次请求读磁盘
 * 开销可接受；会话/消息复用 electron/ipc/chat.ts 的 chatData 门面）。
 *
 * 依赖说明：
 * - 角色：electron/services/charCard.ts 的 getCharacter（与渲染层同一数据源）
 * - 预设：DIRS.presets() 磁盘 JSON + getBuiltinPresets 内置预设
 * - 会话/消息：electron/ipc/chat.ts 的 chatData（与 IPC handler 共用底层存储函数）
 * - 设置：DIRS.config()/settings.json（主进程本就持有完整设置）
 * - 世界书：DIRS.lorebooks() 磁盘 JSON
 * - 正则：electron/ipc/regex.ts 的 readRules（同一 rules.json）
 *
 * 语义检索命中（_semanticFactsHits/_semanticLoreHits）为主进程暂缺能力，返回空数组
 * （P0-2 语义检索仍由渲染层 memoryManager/vectorStore 完成，桥接层按需接入）。
 */

import { join } from 'node:path'
import { DIRS, readJson, listJsonFilesAsync } from '../services/storage'
import { getCharacter } from '../services/charCard'
import { chatData } from '../ipc/chat'
import { getBuiltinPresets } from '../ipc/preset'
import { readRules } from '../ipc/regex'
import type {
  ActiveProfile,
  ContextBuildData,
  ContextChatSnapshot,
  ContextDataProvider,
  ContextSettingsSnapshot,
} from '../../shared/contextTypes'
import type {
  ChatSession,
  Character,
  Lorebook,
  Preset,
  RegexRule,
  Settings,
} from '../../shared/types'
import { getDefaultSettings } from '../../shared/defaults'
import { restoreSecrets } from '../ipc/settings'

/** 读取设置（含默认值兜底；H1：settings.json 不落 apiKey，需从 safeStorage 回填） */
function readSettings(): Settings {
  const settingsPath = join(DIRS.config(), 'settings.json')
  const saved = readJson<Settings>(settingsPath, 'settings')
  if (!saved) return getDefaultSettings()
  // H1 修复：profile/tts/生图/识图的 apiKey 存在 safeStorage，settings.json 无明文，
  // 主进程作为密钥唯一持有者需回填后再使用（对齐渲染层 settings:get 的 restoreSecrets）
  restoreSecrets(saved)
  // 与渲染层 loadSettings 的合并语义保持一致：缺省字段用默认值补全
  return { ...getDefaultSettings(), ...saved }
}

/** 解析活跃 Profile（对齐渲染层 useSettingsStore.getActiveProfile） */
function resolveActiveProfile(settings: Settings): ActiveProfile | null {
  if (!settings.activeProfileId) return null
  const profile = settings.connectionProfiles.find((p) => p.id === settings.activeProfileId)
  if (!profile) return null
  return {
    name: profile.name,
    provider: profile.provider,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: profile.model,
    maxContext: profile.maxContext || 0,
    useInstructTemplate: profile.useInstructTemplate,
  }
}

/** 读取全部预设（内置 + 自定义，对齐 preset:list 语义） */
async function listAllPresets(): Promise<Preset[]> {
  const custom = await listJsonFilesAsync<Preset>(DIRS.presets())
  return [...getBuiltinPresets(), ...custom]
}

/** 读取全部世界书（对齐 lorebook:list 语义） */
async function listAllLorebooks(): Promise<Lorebook[]> {
  return listJsonFilesAsync<Lorebook>(DIRS.lorebooks())
}

/** 会话快照：消息 + 会话列表 + 激活世界书（会话级优先，回退角色绑定） */
async function buildChatSnapshot(
  character: Character | null,
  sessionId: string,
): Promise<ContextChatSnapshot> {
  const sessions = await chatData.listSessions(character?.id ?? '')
  const currentSession = sessions.find((s) => s.id === sessionId) ?? sessions[0] ?? null
  const messages = currentSession
    ? chatData.readMessages(character?.id ?? '', currentSession.id)
    : []
  // 会话级世界书选择优先，回退角色绑定；主进程无渲染层内存态 activeLorebookIds，
  // 以会话/角色持久化为准（渲染层 fetchBuildData 仍用 store 的 activeLorebookIds）
  const activeLorebookIds =
    currentSession?.lorebookIds ??
    character?.boundLorebookIds ??
    []
  return {
    messages,
    sessions,
    currentSessionId: currentSession?.id ?? null,
    activeLorebookIds,
    // 语义检索命中：主进程暂缺，恒为空（桥接层按需接入 vectorStore）
    semanticFactsHits: [],
    semanticLoreHits: [],
  }
}

/** 主进程 ContextDataProvider（阶段 0a，供桥接层组装上下文） */
export const mainContextProvider: ContextDataProvider = {
  async fetchBuildData(characterId, sessionId, opts): Promise<ContextBuildData> {
    const character = getCharacter(characterId)
    const settings = readSettings()
    const profile = resolveActiveProfile(settings)
    const chat = await buildChatSnapshot(character, sessionId)

    // 预设优先级：显式覆盖 > 角色绑定 > 设置默认（会话无 presetId 字段，对齐渲染层 activePresetId 语义）
    let presetId = opts?.presetId ?? undefined
    if (presetId === undefined) {
      if (character?.boundPresetId) presetId = character.boundPresetId
      else presetId = settings.activePresetId ?? undefined
    }
    let preset: Preset | null = null
    if (presetId) {
      const all = await listAllPresets()
      preset = all.find((p) => p.id === presetId) ?? null
    }

    // 世界书：按激活 ID 展开 + 仅保留 enabled（对齐 getActiveChatConfig）
    const lorebooks = chat.activeLorebookIds.length > 0
      ? (await listAllLorebooks()).filter((lb) => chat.activeLorebookIds.includes(lb.id) && lb.enabled)
      : []

    const regexRules: RegexRule[] = readRules()

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
    const sessions = await chatData.listSessions(characterId)
    return sessions.find((s) => s.id === sessionId) ?? null
  },
}

/** 主进程 ContextDataWriter 实现：直接复用 chatData（与 IPC handler 同一底层存储） */
export const mainContextWriter = {
  saveMessage: (characterId: string, message: Parameters<typeof chatData.saveMessage>[1]) =>
    chatData.saveMessage(characterId, message),
  deleteMessage: chatData.deleteMessage,
  renameSession: chatData.renameSession,
  createSession: chatData.createSession,
  listSessions: chatData.listSessions,
  updateMemory: chatData.updateMemory,
  toggleMemory: chatData.toggleMemory,
  setMemoryMode: chatData.setMemoryMode,
}
