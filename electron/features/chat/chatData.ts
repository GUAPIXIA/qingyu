/**
 * 主进程聊天数据门面（阶段 3A-2：从 electron/ipc/chat.ts 原样迁出）。
 *
 * 定位：主进程侧读写会话/消息的稳定入口（不含任何 IPC 依赖），供 Bridge、
 * 编排器端口实现（messagePort/sessionLookup）、mainContextProvider 与脚本/测试复用。
 * 与 IPC handler 共用同一套底层仓储与用例；IPC 注册模块（electron/ipc/chat.ts）
 * 不再被本门面或其它模块反向导入。
 *
 * 行为保留说明（不在结构迁移中改写）：
 * - `saveMessage` / `saveMessageLocked`：无锁/持锁的单条追加路径，不更新 session.updatedAt
 *   （与 `messageUseCases.saveMessage` 的 IPC 路径不同；后者含 updatedAt 维护）。
 * - `clearChat` / `deleteSession`：沿用迁移前的 unlink 直删路径（不写消息 tombstone），
 *   与 IPC 路径 `sessionUseCases.clearChat/deleteSession`（S2-04 tombstone + journal）不同。
 *   二者当前仅被测试调用（无生产消费者）；统一到 journal 路径属行为变更，留待独立修复批次。
 */
import { existsSync, unlinkSync } from 'node:fs'
import { prepareChatSessionDeletion } from '../../services/chatLifecycle'
import { safeId } from '../../utils/pathGuard'
import { withMessageIdentity } from '../../../shared/messageIdentity'
import type { ChatSession, Message, SessionPreview } from '../../../shared/types'
import {
  appendMessage,
  getSessionFile,
  loadSessions,
  messagesCacheInvalidate,
  readMessages,
  saveSessions,
  updateSessionIfMemoryVersion,
  withChatMessageLock,
  withSessionFileLock,
  withSessionsLock,
} from './chatRepository'
import {
  attachSpatialAiSession,
  createSession,
  listSessions,
  renameSession,
  setMemoryMode,
  toggleMemory,
  updateMemory,
  updateSession,
  updateSpatialBindingIfMatches,
} from './sessionUseCases'
import { commitFeatureResult, deleteMessage } from './messageUseCases'

/** 消息删除结果（供上层判断会话是否存在） */
export interface ChatDataResult {
  ok: boolean
}

/** 数据层门面：主进程侧读写会话/消息的统一入口（不含任何 IPC 依赖） */
export const chatData = {
  commitFeatureResult,
  readMessages,

  /** 会话列表（含消息数与最后消息摘要；无会话时自动创建默认会话） */
  listSessions: async (characterId: string): Promise<SessionPreview[]> => {
    safeId(characterId)
    return listSessions(characterId)
  },

  /** 追加/覆盖单条消息（与渲染层 saveMessage 同一落盘路径） */
  saveMessage: (characterId: string, message: Message): void => {
    appendMessage(characterId, message.sessionId, withMessageIdentity(message))
  },
  saveMessageLocked: (characterId: string, message: Message): Promise<void> =>
    withChatMessageLock({ characterId, sessionId: message.sessionId }, () => appendMessage(characterId, message.sessionId, withMessageIdentity(message))),

  /** 删除单条消息（与 IPC handler 相同的读-改-写锁路径） */
  deleteMessage: async (
    characterId: string,
    messageId: string,
    sessionId?: string,
  ): Promise<void> => {
    safeId(characterId)
    const sid = sessionId || 'default'
    safeId(sid)
    safeId(messageId)
    return deleteMessage(characterId, messageId, sid)
  },

  /** 重命名会话（与 IPC handler 同一路径） */
  renameSession: async (characterId: string, sessionId: string, title: string): Promise<void> => {
    safeId(characterId)
    safeId(sessionId)
    return renameSession(characterId, sessionId, title)
  },

  /** 创建会话（与 IPC handler 同一路径，含默认身份继承） */
  createSession: async (
    characterId: string,
    title?: string,
    personaId?: string | null,
    lorebookIds?: string[],
  ): Promise<ChatSession> => {
    safeId(characterId)
    return createSession(characterId, title, personaId, lorebookIds)
  },

  /** 更新记忆摘要（与 IPC handler 同一路径） */
  updateMemory: async (characterId: string, sessionId: string, memory: string): Promise<void> => {
    safeId(characterId)
    safeId(sessionId)
    return updateMemory(characterId, sessionId, memory)
  },

  /** 开关长记忆（与 IPC handler 同一路径） */
  toggleMemory: async (characterId: string, sessionId: string, enabled: boolean): Promise<void> => {
    safeId(characterId)
    safeId(sessionId)
    return toggleMemory(characterId, sessionId, enabled)
  },

  /** 设置记忆模式（与 IPC handler 同一路径） */
  setMemoryMode: async (
    characterId: string,
    sessionId: string,
    mode: 'manual' | 'auto',
    interval?: number,
  ): Promise<void> => {
    safeId(characterId)
    safeId(sessionId)
    return setMemoryMode(characterId, sessionId, mode, interval)
  },

  /** 更新会话字段（白名单过滤，与 IPC handler chat:updateSession 同一路径） */
  updateSession: async (
    characterId: string,
    sessionId: string,
    updates: Partial<ChatSession>,
  ): Promise<ChatSession> => {
    safeId(characterId)
    safeId(sessionId)
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new Error('参数无效：updates 必须为对象')
    }
    return updateSession(characterId, sessionId, updates)
  },

  /** 空间事务恢复只修改绑定，保留其他会话更新。 */
  updateSpatialBindingIfMatches: async (
    characterId: string, sessionId: string,
    before: { worldId: string | null; runtimeId: string | null },
    after: { worldId: string | null; runtimeId: string | null },
  ): Promise<void> => {
    safeId(characterId)
    safeId(sessionId)
    if (after.worldId) safeId(after.worldId)
    if (after.runtimeId) safeId(after.runtimeId)
    return updateSpatialBindingIfMatches(characterId, sessionId, before, after)
  },

  /** 仅当磁盘中的 memoryVersion 仍等于 expectedVersion 时应用更新。 */
  attachSpatialAiSession: async (characterId: string, sessionId: string,
    expected: { worldId: string | null; runtimeId: string | null; aiSessionId: string | null }, aiSessionId: string): Promise<void> => {
    safeId(aiSessionId)
    safeId(characterId)
    safeId(sessionId)
    return attachSpatialAiSession(characterId, sessionId, expected, aiSessionId)
  },

  updateSessionIfMemoryVersion,

  /** 清空指定会话消息（沿用迁移前门面路径：unlink 直删 + 重置记忆字段） */
  clearChat: async (characterId: string, sessionId: string): Promise<void> => {
    safeId(characterId)
    safeId(sessionId)
    await withSessionFileLock(characterId, sessionId, () => {
      const filePath = getSessionFile(characterId, sessionId)
      if (existsSync(filePath)) unlinkSync(filePath)
      messagesCacheInvalidate(characterId, sessionId)
    })
    await withSessionsLock(characterId, () => {
      const sessions = loadSessions(characterId)
      const session = sessions.find((s) => s.id === sessionId)
      if (session) {
        session.updatedAt = Date.now()
        session.memory = ''
        session.memoryCurrentState = ''
        session.memoryUpdatedAt = 0
        session.memoryFacts = []
        session.memoryFactHistory = []
        session.memoryFactParseFailureCount = 0
        session.memoryFactRetryAfterVersion = 0
        session.factsVectors = []
        session.memoryLastMessageId = null
        session.memoryVersion = 0
        session.factsVectorVersion = 0
        session.compressedSummary = null
        session.compressedRange = null
        saveSessions(characterId, sessions)
      }
    })
  },

  /** 删除会话（沿用迁移前门面路径：unlink 直删 + 从 sessions.json 移除） */
  deleteSession: async (characterId: string, sessionId: string): Promise<void> => {
    safeId(characterId)
    safeId(sessionId)
    await prepareChatSessionDeletion({ characterId, sessionId })
    await withSessionFileLock(characterId, sessionId, () => {
      const filePath = getSessionFile(characterId, sessionId)
      if (existsSync(filePath)) {
        unlinkSync(filePath)
      }
      messagesCacheInvalidate(characterId, sessionId)
    })
    await withSessionsLock(characterId, () => {
      const sessions = loadSessions(characterId).filter((s) => s.id !== sessionId)
      saveSessions(characterId, sessions)
    })
  },
}

export type ChatData = typeof chatData