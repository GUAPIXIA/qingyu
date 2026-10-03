/**
 * 聊天 IPC 传输层（阶段 3A-2）：只保留参数边界（safeId / 形状校验）、
 * channel 注册与错误映射（safeHandle）；业务实现位于 electron/features/chat/：
 * - 会话用例 sessionUseCases.ts；消息用例 messageUseCases.ts；
 * - 仓储与锁 chatRepository.ts；数据门面 chatData.ts（Bridge/编排器复用）。
 *
 * 具体算法与调用时序沿用迁出前的 handler 实现，本层不再承载仓储实现。
 */
import type { IpcMain } from 'electron'
import type { Message, ChatSession } from '../../shared/types'
import type { FeatureCommit, FeatureSource } from '../../shared/featureSource'
import { safeId } from '../utils/pathGuard'
import { safeHandle } from '../utils/safeHandle'
import {
  clearChat,
  createSession,
  deleteSession,
  getMemoryHistory,
  listSessions,
  renameSession,
  setMemoryMode,
  toggleMemory,
  updateMemory,
  updateSession,
} from '../features/chat/sessionUseCases'
import {
  commitFeatureResult,
  deleteMessage,
  exportChat,
  getStats,
  listMessages,
  saveMessage,
} from '../features/chat/messageUseCases'
import { updateSessionIfMemoryVersion } from '../features/chat/chatRepository'

export function registerChatIPC(ipcMain: IpcMain): void {
  safeHandle(ipcMain, 'chat:commitFeatureResult', async (_e, characterId: string, sessionId: string, input: FeatureCommit) => commitFeatureResult(characterId, sessionId, input))
  // ===== 会话管理 =====

  safeHandle(ipcMain, 'chat:listSessions', async (_e, characterId: string) => {
    safeId(characterId)
    return listSessions(characterId, { sortByUpdatedAt: true })
  })

  safeHandle(ipcMain, 'chat:createSession', async (_e, characterId: string, title?: string, personaId?: string | null, lorebookIds?: string[]) => {
    safeId(characterId)
    return createSession(characterId, title, personaId, lorebookIds)
  })

  safeHandle(ipcMain, 'chat:deleteSession', async (_e, characterId: string, sessionId: string) => {
    safeId(characterId)
    safeId(sessionId)
    return deleteSession(characterId, sessionId)
  })

  safeHandle(ipcMain, 'chat:renameSession', async (_e, characterId: string, sessionId: string, title: string) => {
    safeId(characterId)
    safeId(sessionId)
    return renameSession(characterId, sessionId, title)
  })

  safeHandle(ipcMain, 'chat:updateSession', async (_e, characterId: string, sessionId: string, updates: Partial<ChatSession>) => {
    safeId(characterId)
    safeId(sessionId)
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new Error('参数无效：updates 必须为对象')
    }
    return updateSession(characterId, sessionId, updates)
  })

  safeHandle(ipcMain, 'chat:updateSessionIfMemoryVersion', async (_e, characterId: string, sessionId: string, expectedVersion: number, updates: Partial<ChatSession>, source?: FeatureSource) =>
    updateSessionIfMemoryVersion(characterId, sessionId, expectedVersion, updates, source))

  // ===== 消息管理 =====

  safeHandle(ipcMain, 'chat:listMessages', async (_e, characterId: string, sessionId?: string) => {
    safeId(characterId)
    if (sessionId) safeId(sessionId)
    return listMessages(characterId, sessionId)
  })

  /** 保存消息（新增或更新；session.updatedAt 增量维护见 messageUseCases.saveMessage） */
  safeHandle(ipcMain, 'chat:saveMessage', async (_e, message: Message) => {
    safeId(message.characterId)
    safeId(message.sessionId || 'default')
    return saveMessage(message)
  })

  safeHandle(ipcMain, 'chat:deleteMessage', async (_e, { id, characterId, sessionId }: { id: string; characterId: string; sessionId?: string }) => {
    safeId(characterId)
    const sid = sessionId || 'default'
    safeId(sid)
    safeId(id)
    return deleteMessage(characterId, id, sid)
  })

  /** 清空对话（指定会话或整个角色） */
  safeHandle(ipcMain, 'chat:clearChat', async (_e, characterId: string, sessionId?: string) => {
    safeId(characterId)
    if (sessionId) safeId(sessionId)
    return clearChat(characterId, sessionId)
  })

  // 导出对话
  safeHandle(ipcMain, 'chat:exportChat', async (_e, characterId: string, sessionId: string, format: 'md' | 'json') => {
    safeId(characterId)
    safeId(sessionId)
    return exportChat(characterId, sessionId, format)
  })

  // ===== 长记忆 =====

  safeHandle(ipcMain, 'chat:updateMemory', async (_e, characterId: string, sessionId: string, memory: string) => {
    safeId(characterId)
    safeId(sessionId)
    return updateMemory(characterId, sessionId, memory)
  })

  safeHandle(ipcMain, 'chat:toggleMemory', async (_e, characterId: string, sessionId: string, enabled: boolean) => {
    safeId(characterId)
    safeId(sessionId)
    return toggleMemory(characterId, sessionId, enabled)
  })

  safeHandle(ipcMain, 'chat:setMemoryMode', async (_e, characterId: string, sessionId: string, mode: 'manual' | 'auto', interval?: number) => {
    safeId(characterId)
    safeId(sessionId)
    return setMemoryMode(characterId, sessionId, mode, interval)
  })

  safeHandle(ipcMain, 'chat:getStats', async (_e, characterId: string, sessionId: string) => {
    safeId(characterId)
    safeId(sessionId)
    return getStats(characterId, sessionId)
  })

  // ===== 长记忆历史归档（只读，不参与上下文注入） =====
  safeHandle(ipcMain, 'chat:getMemoryHistory', async (_e, characterId: string, sessionId: string, opts?: { limit?: number; offset?: number; status?: string }) => {
    safeId(characterId)
    safeId(sessionId)
    return getMemoryHistory(characterId, sessionId, opts)
  })
}