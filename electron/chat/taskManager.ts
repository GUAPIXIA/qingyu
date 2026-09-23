/* eslint-disable no-empty */
/**
 * V12-05 TaskManager：状态转换集中校验 + 取消幂等（实施方案 §7）
 */
import { isAllowedTransition, isTerminalState, type TaskState, type TaskSnapshot, type TaskEventEnvelope } from '../../shared/chat-core/events'
import { createDomainError, type DomainError } from '../../shared/chat-core/errors'
import { getTaskSnapshot, updateTask, appendEvent } from './taskStore'
import { sessionLock } from './sessionLock'
import { nanoid } from 'nanoid'

function nowSec(): number {
  return Date.now()
}

function nextSequence(snap: TaskSnapshot): number {
  return (snap.lastSequence ?? 0) + 1
}

function makeEventId(): string {
  return nanoid(8)
}

/**
 * cancel-abort：运行中任务的模型流中断登记（模块级共享——chatTasks 每次 IPC
 * 都会新建 ChatOrchestrator 实例，登记表挂在实例上会导致 cancel 找不到 controller）。
 */
export interface TaskAbortHandle {
  /** 流式请求的中断控制器；cancelTask 取消时 abort 之，真中断后台模型流 */
  controller: AbortController
  /** handle() 完全收口（含部分正文 commit）后 resolve；cancel 等它拿到补齐 assistantMessageId 的终态快照 */
  settled: Promise<void>
  /** 可选：冲刷未 flush 的 chunk（保留已见正文进事件流/快照），在 abort 之前调用 */
  flush?: () => void
}

const taskAborts = new Map<string, TaskAbortHandle>()

/** cancel-abort：模型流启动时登记（同 taskId 覆盖旧登记，taskId 单任务唯一） */
export function registerTaskAbort(taskId: string, handle: TaskAbortHandle): void {
  taskAborts.set(taskId, handle)
}

/** cancel-abort：handle() 收口后清理登记，防止 Map 泄漏 */
export function clearTaskAbort(taskId: string): void {
  taskAborts.delete(taskId)
}

export function getTaskAbort(taskId: string): TaskAbortHandle | undefined {
  return taskAborts.get(taskId)
}

/** 合法状态转换，失败抛 DomainError */
export function transitionTask(taskId: string, to: TaskState, opts?: { error?: DomainError }): TaskSnapshot {
  const snap = getTaskSnapshot(taskId)
  if (!snap) throw createDomainError('TASK_NOT_FOUND', `任务不存在: ${taskId}`, { safeDetails: { taskId } })

  if (snap.state === to) return snap
  if (!isAllowedTransition(snap.state, to)) {
    throw createDomainError('TASK_CONFLICT', `非法状态转换: ${snap.state} -> ${to}`, { safeDetails: { from: snap.state, to } })
  }

  // terminal 唯一性：已终态不可再转换（isAllowedTransition 已拦，但二次校验）
  if (isTerminalState(snap.state)) {
    throw createDomainError('TASK_CONFLICT', `终态不可转换: ${snap.state}`, { safeDetails: { state: snap.state } })
  }

  const seq = nextSequence(snap)
  const updated: TaskSnapshot = {
    ...snap,
    state: to,
    lastSequence: seq,
    updatedAt: nowSec(),
    ...(to === 'preparing' || to === 'streaming' ? { startedAt: snap.startedAt ?? nowSec() } : {}),
    ...(isTerminalState(to) ? { finishedAt: nowSec() } : {}),
    ...(opts?.error ? { error: opts.error } : {}),
  }

  const saved = updateTask(taskId, updated)
  if (!saved) throw createDomainError('PERSISTENCE_FAILED', '持久化失败')

  // 追加 terminal 对应的唯一事件（at-least-once，调用方去重）
  if (isTerminalState(to)) {
    const typeMap: Record<TaskState, TaskEventEnvelope['type']> = {
      queued: 'task:failed',
      preparing: 'task:failed',
      streaming: 'task:failed',
      waiting_approval: 'task:failed',
      finalizing: 'task:failed',
      completed: 'task:completed',
      failed: 'task:failed',
      cancelled: 'task:cancelled',
      interrupted: 'task:interrupted',
    }
    const event: TaskEventEnvelope = {
      protocolVersion: 2,
      eventId: makeEventId(),
      taskId,
      requestId: snap.requestId,
      sessionId: snap.sessionId,
      sequence: seq,
      type: typeMap[to] ?? 'task:failed',
      timestamp: nowSec(),
      payload: to === 'failed' || to === 'interrupted' ? { error: updated.error } : to === 'cancelled' ? { partial: updated.accumulatedText } : {},
    }
    try {
      appendEvent(event)
    } catch {}
  }

  return saved
}

/** 取消：幂等，重复取消返回快照；空内容场景由调用方决定是否落盘消息 */
export function cancelTask(taskId: string): TaskSnapshot {
  const snap = getTaskSnapshot(taskId)
  if (!snap) throw createDomainError('TASK_NOT_FOUND', `任务不存在: ${taskId}`)
  if (isTerminalState(snap.state)) return snap
  // cancel-abort：真 abort 后台模型流。先冲刷已积累未 flush 的 chunk（保留已见正文），
  // 再中断底层请求——用户停止后模型流不再跑完浪费配额/算力；重复 abort 幂等无副作用。
  const inflight = taskAborts.get(taskId)
  inflight?.flush?.()
  inflight?.controller.abort()
  // 释放会话锁（若持有）
  sessionLock.release(snap.sessionId, taskId)
  return transitionTask(taskId, 'cancelled')
}

/** 会话锁封装：获取失败抛 TASK_CONFLICT */
export function acquireSessionOrThrow(sessionId: string, taskId: string): void {
  if (!sessionLock.tryAcquire(sessionId, taskId)) {
    const holder = sessionLock.holderOf(sessionId)
    throw createDomainError('TASK_CONFLICT', '该会话已有生成任务', {
      retryable: true,
      safeDetails: { activeTaskId: holder ?? 'unknown' },
    })
  }
}

export function releaseSession(sessionId: string, taskId: string): void {
  sessionLock.release(sessionId, taskId)
}
