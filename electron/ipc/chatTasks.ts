/**
 * V12-10 Desktop IPC 适配（实施方案 §12）
 *
 * 渲染层不再直接调 window.api.ai.chat，而是经 ChatOrchestrator：
 *   chatTask:start / get / listBySession / eventsAfter / cancel / retry
 * 事件：chatTask:event（TaskEventEnvelope）
 */
import type { IpcMain, BrowserWindow } from 'electron'
import { safeHandle } from '../utils/safeHandle'
import { safeId } from '../utils/pathGuard'
import { ChatOrchestrator } from '../chat/orchestrator'
import { chatMessagePort } from '../chat/messagePort'
import { contextService } from '../chat/contextService'
import { FakeModelPort } from '../chat/fakeModel'
import { getTaskSnapshot, listActiveTasks, readEvents } from '../chat/taskStore'
import type { ChatCommand } from '../../shared/chat-core/commands'

function getOrchestrator(): ChatOrchestrator {
  return new ChatOrchestrator({
    messagePort: chatMessagePort,
    contextPort: contextService,
    modelPort: new FakeModelPort({ kind: 'success', chunks: ['（desktop 占位）'] }),
  })
}

export function registerChatTaskIPC(ipcMain: IpcMain, getWindow: () => BrowserWindow | null): void {
  // start
  safeHandle(ipcMain, 'chatTask:start', async (_event, command: ChatCommand) => {
    if (!command || typeof command.requestId !== 'string') {
      throw new Error('参数无效：command 缺少 requestId')
    }
    safeId(command.requestId)
    if ((command as { sessionId?: string }).sessionId) {
      safeId((command as { sessionId: string }).sessionId)
    } else if (command.type !== 'retry_generation') {
      throw new Error('参数无效：command 缺少 sessionId')
    }
    if (command.type === 'send' && typeof (command as { content?: string }).content === 'string') {
      const c = (command as { content: string }).content
      if (c.length > 20000) throw new Error('参数无效：content 过长')
    }
    // 注入桌面端 client 标识（渲染层不可伪造 deviceId）
    const cmd: ChatCommand = {
      ...command,
      client: { ...(command.client ?? {}), kind: 'desktop', clientId: 'desktop', protocolVersion: 2 },
    } as ChatCommand
    const orch = getOrchestrator()
    const task = await orch.handle(cmd)
    // 推送首个事件（accepted）给渲染层
    const win = getWindow()
    win?.webContents.send('chatTask:event', { taskId: task.taskId, type: 'task:accepted', task })
    return { taskId: task.taskId, state: task.state, lastSequence: task.lastSequence }
  })

  // get
  safeHandle(ipcMain, 'chatTask:get', async (_event, taskId: string) => {
    safeId(taskId)
    return getTaskSnapshot(taskId)
  })

  // listBySession
  safeHandle(ipcMain, 'chatTask:listBySession', async (_event, sessionId: string) => {
    safeId(sessionId)
    return listActiveTasks().filter((t) => t.sessionId === sessionId)
  })

  // eventsAfter
  safeHandle(ipcMain, 'chatTask:eventsAfter', async (_event, taskId: string, sequence: number) => {
    safeId(taskId)
    const seq = Number(sequence) || 0
    return readEvents(taskId, seq, 200)
  })

  // cancel
  safeHandle(ipcMain, 'chatTask:cancel', async (_event, taskId: string) => {
    safeId(taskId)
    const orch = getOrchestrator()
    return orch.cancel(taskId)
  })

  // retry
  safeHandle(ipcMain, 'chatTask:retry', async (_event, taskId: string) => {
    safeId(taskId)
    const snap = getTaskSnapshot(taskId)
    if (!snap) throw new Error('任务不存在')
    const { nanoid } = await import('nanoid')
    const retryCmd = {
      type: 'send',
      requestId: nanoid(8),
      sessionId: snap.sessionId,
      characterId: snap.characterId,
      content: snap.accumulatedText || 'retry',
      client: { kind: 'desktop' as const, clientId: 'desktop', protocolVersion: 2 as const },
      retryOfTaskId: snap.taskId,
    } as unknown as ChatCommand
    const orch = getOrchestrator()
    const task = await orch.handle(retryCmd)
    return { taskId: task.taskId, state: task.state }
  })
}
