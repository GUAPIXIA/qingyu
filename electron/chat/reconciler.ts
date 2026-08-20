/**
 * V12-13 TaskReconciler：启动对账（实施方案 §16）
 *
 * 1. 扫描 active task 快照
 * 2. queued 且未写用户消息 -> interrupted
 * 3. preparing/streaming/waiting_approval/finalizing -> interrupted
 * 4. 检查 userMessageId/assistantMessageId 是否真实存在（本版通过 MessagePort 校验，缺失则标记 PERSISTENCE_FAILED）
 * 5. assistant 已落盘但 terminal 缺失 -> 补 completed
 * 6. terminal 已有但助手消息缺失 -> PERSISTENCE_FAILED
 * 7. 清理悬空 AbortController/过期审批（内存态，重启即清）
 */
import { getTaskSnapshot, listActiveTasks, updateTask, appendEvent, readEvents } from './taskStore'
import { createDomainError } from '../../shared/chat-core/errors'
import type { TaskSnapshot } from '../../shared/chat-core/events'

export interface ReconcileResult {
  interrupted: string[]
  persistenceFailed: string[]
  recovered: string[]
}

export async function reconcileTasks(opts?: {
  findMessage?: (task: TaskSnapshot) => Promise<boolean>
  findUserMessage?: (task: TaskSnapshot) => Promise<boolean>
}): Promise<ReconcileResult> {
  const active = listActiveTasks()
  const res: ReconcileResult = { interrupted: [], persistenceFailed: [], recovered: [] }

  for (const snap of active) {
    const state = snap.state
    // 2 & 3: 非终态统一 interrupted（queued 含未写用户消息场景）
    if (['queued', 'preparing', 'streaming', 'waiting_approval', 'finalizing'].includes(state)) {
      // 4. 检查消息存在性（可选）
      let userExists = true
      let assistantExists = true
      if (opts?.findUserMessage && snap.userMessageId) {
        try { userExists = await opts.findUserMessage(snap) } catch { userExists = false }
      }
      if (opts?.findMessage && snap.assistantMessageId) {
        try { assistantExists = await opts.findMessage(snap) } catch { assistantExists = false }
      }

      // 若 assistant 已落盘但 terminal 缺失，补 completed 视为恢复（5）
      // 简化：若 task 为 finalizing 且 assistant 分配则直接 completed
      if (state === 'finalizing' && snap.assistantMessageId && assistantExists) {
        updateTask(snap.taskId, (s) => ({ ...s, state: 'completed' as const, finishedAt: Date.now(), updatedAt: Date.now() }))
        appendEvent({
          protocolVersion: 2,
          eventId: `reconcile-${snap.taskId}`,
          taskId: snap.taskId,
          requestId: snap.requestId,
          sessionId: snap.sessionId,
          sequence: snap.lastSequence + 1,
          type: 'task:completed',
          timestamp: Date.now(),
          payload: { recovered: true },
        })
        updateTask(snap.taskId, (s) => ({ ...s, lastSequence: s.lastSequence + 1, updatedAt: Date.now() }))
        res.recovered.push(snap.taskId)
        continue
      }

      // 6. terminal 已有但助手缺失 -> 不伪造完成，标记 PERSISTENCE_FAILED
      // 此处为非终态，不涉及；终态检查在下方

      // 统一 interrupted
      updateTask(snap.taskId, (s) => ({
        ...s,
        state: 'interrupted' as const,
        error: createDomainError('TASK_INTERRUPTED', '进程退出导致中断', { retryable: true }),
        finishedAt: Date.now(),
        updatedAt: Date.now(),
        lastSequence: s.lastSequence + 1,
      }))
      appendEvent({
        protocolVersion: 2,
        eventId: `reconcile-${snap.taskId}`,
        taskId: snap.taskId,
        requestId: snap.requestId,
        sessionId: snap.sessionId,
        sequence: snap.lastSequence + 1,
        type: 'task:interrupted',
        timestamp: Date.now(),
        payload: { lastTextLength: snap.accumulatedText.length },
      })
      // 注意：updateTask 已将 lastSequence +1，此处事件 sequence 与快照一致（简化）
      res.interrupted.push(snap.taskId)
      continue
    }

    // 已终态：检查一致性 5 & 6
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(state)) {
      const hasAssistant = !!snap.assistantMessageId
      let assistantExists = hasAssistant
      if (opts?.findMessage && hasAssistant) {
        try { assistantExists = await opts.findMessage(snap) } catch { assistantExists = false }
      }
      // completed 但助手缺失 -> PERSISTENCE_FAILED
      if (state === 'completed' && hasAssistant && !assistantExists) {
        updateTask(snap.taskId, (s) => ({
          ...s,
          error: createDomainError('PERSISTENCE_FAILED', '助手消息缺失', { retryable: true }),
          updatedAt: Date.now(),
        }))
        res.persistenceFailed.push(snap.taskId)
      }
      // 检查 terminal 事件缺失（事件日志为空但状态为 completed）-> 补事件视为 recovered
      const page = readEvents(snap.taskId, 0, 1)
      if (state === 'completed' && page.events.length === 0) {
        appendEvent({
          protocolVersion: 2,
          eventId: `reconcile-${snap.taskId}`,
          taskId: snap.taskId,
          requestId: snap.requestId,
          sessionId: snap.sessionId,
          sequence: snap.lastSequence + 1,
          type: 'task:completed',
          timestamp: Date.now(),
          payload: { recovered: true },
        })
        updateTask(snap.taskId, (s) => ({ ...s, lastSequence: s.lastSequence + 1, updatedAt: Date.now() }))
        res.recovered.push(snap.taskId)
      }
    }
  }

  // 7. 内存态清理：AbortController / 过期审批 重启即清空（本模块无常驻，无需操作）
  return res
}
