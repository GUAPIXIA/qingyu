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
