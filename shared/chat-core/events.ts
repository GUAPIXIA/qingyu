/**
 * V12-02 共享契约：TaskEvent / TaskSnapshot（实施方案 §7-9）
 */

import type { DomainError } from './errors'
import type { ClientRef, ChatCommandType } from './commands'

// ===== 状态机（§7.1） =====

export type TaskState =
  | 'queued'
  | 'preparing'
  | 'streaming'
  | 'waiting_approval'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

export function isTerminalState(s: TaskState): boolean {
  return TERMINAL_STATES.has(s)
}

// ===== 快照（§8.2） =====

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface TaskSnapshot {
  schemaVersion: 1
  taskId: string
  requestId: string
  type: ChatCommandType
  state: TaskState
  sessionId: string
  characterId: string
  client: ClientRef
  userMessageId?: string
  assistantMessageId?: string
  retryOfTaskId?: string
  accumulatedText: string
  lastSequence: number
  usage?: TokenUsage
  model?: {
    provider: string
    model: string
    profileId?: string
  }
  contextFingerprint?: string
  error?: DomainError
  createdAt: number
  startedAt?: number
  finishedAt?: number
  updatedAt: number
}

// ===== 事件（§9.1-9.2） =====

export type TaskEventType =
  | 'task:accepted'
  | 'task:started'
  | 'task:chunk'
  | 'task:usage'
  | 'task:approval_required'
  | 'task:approval_resolved'
  | 'task:completed'
  | 'task:failed'
  | 'task:cancelled'
  | 'task:interrupted'

export interface TaskEventEnvelope<T = unknown> {
  protocolVersion: 2
  eventId: string
  taskId: string
  requestId: string
  sessionId: string
  sequence: number
  type: TaskEventType
  timestamp: number
  payload: T
}

export interface EventPage {
  events: TaskEventEnvelope[]
  nextAfterSequence: number | null
  resyncRequired?: boolean
  snapshot?: TaskSnapshot
}

// ===== 合法转换（§7.2） =====

const ALLOWED: Record<TaskState, TaskState[]> = {
  queued: ['preparing', 'cancelled', 'interrupted', 'failed'],
  preparing: ['streaming', 'failed', 'cancelled', 'interrupted'],
  streaming: ['waiting_approval', 'finalizing', 'failed', 'cancelled', 'interrupted'],
  waiting_approval: ['streaming', 'failed', 'cancelled', 'interrupted'],
  finalizing: ['completed', 'failed', 'cancelled', 'interrupted'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
}

export function isAllowedTransition(from: TaskState, to: TaskState): boolean {
  return ALLOWED[from]?.includes(to) ?? false
}
