/**
 * 阶段 0a：数据访问层（方案文档「安卓伴侣端方案」§7 阶段 0a）。
 *
 * 背景：buildChatContext（src/store/chatContext.ts）的依赖数据源全部在渲染层
 * Zustand store（角色/预设为函数参数，会话/消息/设置直读 store，正则走 IPC 读盘），
 * 主进程此前不持有这些数据副本，桥接层（阶段一）无法凭空组装上下文。
 *
 * 本文件定义统一的数据访问接口：
 * - ContextDataProvider（读）：渲染层实现包装现有 store（零数据迁移）；
 *   主进程实现按需读磁盘（复用 electron/ipc/chat.ts 与 electron/services/storage.ts），
 *   无需维护内存镜像（配置数据变更频率低，每次请求读磁盘开销可接受）。
 * - ContextDataWriter（写）：定义消息/会话落盘方法，两个实现共用同一底层存储函数，
 *   保证 JSONL 格式与版本号字段一致（安卓端发消息的落盘路径归属）。
 *
 * 0b 的 contextBuilder 与阶段一的桥接层都消费本接口。
 */

import type {
  ChatSession,
  Character,
  Lorebook,
  Message,
  Preset,
  RegexRule,
  Settings,
  SessionPreview,
} from './types'

/** 活跃连接配置（对齐 useSettingsStore.getActiveProfile() 返回值） */
export interface ActiveProfile {
  name: string
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  maxContext: number
  useInstructTemplate?: boolean
}

/** 语义检索命中的世界书条目（P0-2；主进程暂无语义检索，恒为空数组） */
export interface SemanticLoreHit {
  content: string
  order: number
  position: 'before_char' | 'after_char' | 'at_depth' | 'at_end'
  /** at_depth 注入深度（默认 0 = 对话末尾） */
  depth?: number
}

/** 上下文组装所需的会话域数据快照（对齐 buildChatContext 的 get() 依赖） */
export interface ContextChatSnapshot {
  messages: Message[]
  sessions: SessionPreview[]
  currentSessionId: string | null
  activeLorebookIds: string[]
  /** P0-2 语义检索命中（长记忆事实） */
  semanticFactsHits: string[]
  /** P0-2 语义检索命中（世界书条目） */
  semanticLoreHits: SemanticLoreHit[]
}

/** 上下文组装所需的设置域数据 */
export interface ContextSettingsSnapshot {
  settings: Settings
  profile: ActiveProfile | null
}

/** 组装一次上下文所需的全部数据（0b 的 contextBuilder 输入） */
export interface ContextBuildData {
  character: Character | null
  preset: Preset | null
  chat: ContextChatSnapshot
  settings: ContextSettingsSnapshot
  /** 已按 activeLorebookIds 展开且启用的世界书 */
  lorebooks: Lorebook[]
  /** 输入/输出正则规则（桥接层组装时同样适用） */
  regexRules: RegexRule[]
}

/** 拉取组装数据时的可选项 */
export interface FetchBuildDataOptions {
  /** 预设 ID 覆盖（渲染层传 store 的 activePresetId；主进程缺省时回退角色绑定/设置默认） */
  presetId?: string | null
}

/**
 * 读接口：为 contextBuilder / 桥接层提供组装上下文所需的全部数据。
 * 渲染层实现包装现有 Zustand store；主进程实现按需读磁盘。
 */
export interface ContextDataProvider {
  /**
   * 拉取组装一次上下文所需的全部数据。
   * @param characterId 角色 ID（会话所属角色）
   * @param sessionId 当前会话 ID
   * @param opts 可选覆盖（presetId）
   */
  fetchBuildData(
    characterId: string,
    sessionId: string,
    opts?: FetchBuildDataOptions,
  ): Promise<ContextBuildData>

  /** 获取会话完整对象（memory / compressedSummary 等字段，按需读取） */
  getSession(characterId: string, sessionId: string): Promise<ChatSession | null>
}

/**
 * 写接口：消息/会话落盘方法。
 * 渲染层实现继续走现有 window.api.chat.* IPC；
 * 主进程实现直接调用与 IPC handler 相同的底层存储函数（appendMessage 等），
 * 保证 JSONL 格式与版本号字段一致（安卓端发消息的落盘路径归属，方案 §7 阶段 0a）。
 */
export interface ContextDataWriter {
  saveMessage(characterId: string, message: Message): Promise<void>

  deleteMessage(characterId: string, messageId: string, sessionId?: string): Promise<void>

  renameSession(characterId: string, sessionId: string, title: string): Promise<void>

  createSession(characterId: string, title?: string): Promise<ChatSession>

  listSessions(characterId: string): Promise<SessionPreview[]>

  updateMemory(characterId: string, sessionId: string, memory: string): Promise<void>

  toggleMemory(characterId: string, sessionId: string, enabled: boolean): Promise<void>

  setMemoryMode(
    characterId: string,
    sessionId: string,
    mode: 'manual' | 'auto',
    interval?: number,
  ): Promise<void>
}
