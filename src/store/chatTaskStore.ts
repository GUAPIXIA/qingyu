/**
 * V12-11 ChatTask Store（feature flag 隔离，实施方案 §17.5）
 *
 * 旧链路：useChatStore 直接调 streamController -> window.api.ai.chat
 * 新链路（flag=true）：提交 ChatCommand -> 消费 chatTask:event -> eventsAfter 补拉
 *
 * 本文件为新链路的薄封装，旧 store 保持不动，回滚时关闭 flag 即可。
 */
import { create } from 'zustand'
import type { TaskSnapshot, TaskEventEnvelope } from '../../shared/chat-core/events'

export interface ChatTaskState {
  activeTask: TaskSnapshot | null
  events: TaskEventEnvelope[]
  isTaskStreaming: boolean
  error: string | null
  // feature flag
  chatEngineV2: boolean
}

export const useChatTaskStore = create<ChatTaskState>(() => ({
  activeTask: null,
  events: [],
  isTaskStreaming: false,
  error: null,
  chatEngineV2: true,
}))

/** 提交 send 命令（渲染层仅负责输入，执行在主进程） */
export async function submitChatTask(sessionId: string, content: string, characterId?: string): Promise<TaskSnapshot> {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const command = {
    type: 'send' as const,
    requestId,
    sessionId,
    characterId,
    content,
    client: { kind: 'desktop' as const, clientId: 'desktop', protocolVersion: 2 as const },
  }
  const res = await (window as unknown as { api: { chatTask: { start: (c: unknown) => Promise<{ taskId: string }> } } }).api.chatTask.start(command)
  const snap = await (window as unknown as { api: { chatTask: { get: (id: string) => Promise<TaskSnapshot> } } }).api.chatTask.get(res.taskId)
  useChatTaskStore.setState({ activeTask: snap, isTaskStreaming: snap?.state === 'streaming' })
  return snap!
}

/** 订阅任务事件（挂载时调用，卸载时取消） */
export function subscribeTaskEvents(taskId: string, onChunk: (delta: string) => void): () => void {
  const api = (window as unknown as { api: { chatTask: { onEvent: (cb: (e: { taskId: string; type: string; payload?: unknown }) => void) => () => void } } }).api.chatTask
  if (!api?.onEvent) return () => {}
  return api.onEvent((event) => {
    if (event.taskId !== taskId) return
    if (event.type === 'task:chunk' && (event as unknown as { payload: { delta: string } }).payload?.delta) {
      onChunk((event as unknown as { payload: { delta: string } }).payload.delta)
    }
    if (event.type === 'task:completed' || event.type === 'task:failed' || event.type === 'task:cancelled') {
      useChatTaskStore.setState({ isTaskStreaming: false })
    }
  })
}

/** 切页恢复：查询会话 active 任务并补拉 */
export async function resumeActiveTask(sessionId: string): Promise<TaskSnapshot | null> {
  const api = (window as unknown as { api: { chatTask: { listBySession: (id: string) => Promise<TaskSnapshot[]>; eventsAfter: (id: string, seq: number) => Promise<{ events: TaskEventEnvelope[]; snapshot?: TaskSnapshot }> } } }).api.chatTask
  if (!api?.listBySession) return null
  const tasks = await api.listBySession(sessionId)
  const active = tasks.find((t) => ['queued', 'preparing', 'streaming', 'waiting_approval', 'finalizing'].includes(t.state))
  if (!active) return null
  useChatTaskStore.setState({ activeTask: active, isTaskStreaming: true })
  // 补拉遗漏事件（at-least-once 去重由调用方按 sequence 处理，此处仅演示拉取）
  await api.eventsAfter(active.taskId, active.lastSequence)
  return active
}
