import type { SessionMachineResult, SyncSessionEvent, SyncSessionState } from './types'

/** 非法事件：保持原状态 */
const TRANSITIONS: Record<SyncSessionState, Partial<Record<SyncSessionEvent, SyncSessionState>>> = {
  idle: {
    start_scan: 'scanning',
    fail_non_retryable: 'failed',
  },
  scanning: {
    plan_ready: 'plan_ready',
    cancel: 'cancelling',
    fail_retryable: 'failed',
    fail_non_retryable: 'failed',
  },
  plan_ready: {
    await_confirmation: 'awaiting_confirmation',
    cancel: 'cancelling',
    fail_retryable: 'failed',
    fail_non_retryable: 'failed',
  },
  awaiting_confirmation: {
    user_confirm: 'transferring',
    cancel: 'cancelling',
    fail_retryable: 'failed',
    fail_non_retryable: 'failed',
  },
  transferring: {
    validate: 'validating',
    cancel: 'cancelling',
    fail_retryable: 'failed',
    fail_non_retryable: 'failed',
  },
  validating: {
    prepare: 'prepared',
    cancel: 'cancelling',
    fail_retryable: 'failed',
    fail_non_retryable: 'failed',
  },
  prepared: {
    commit: 'committing',
    cancel: 'cancelling',
    fail_retryable: 'failed',
    fail_non_retryable: 'failed',
  },
  committing: {
    apply_local: 'applying_local',
    fail_retryable: 'failed',
    fail_non_retryable: 'failed',
  },
  applying_local: {
    mark_completed: 'completed',
    fail_retryable: 'failed',
    fail_non_retryable: 'failed',
  },
  committed: {
    apply_local: 'applying_local',
    mark_completed: 'completed',
    fail_retryable: 'failed',
    fail_non_retryable: 'failed',
  },
  completed: {},
  cancelling: {
    cancel_done: 'cancelled',
    fail_non_retryable: 'failed',
  },
  cancelled: {},
  failed: {
    // 失败后允许从 scanning 重试（retryable）；由 start_scan 进入
    start_scan: 'scanning',
  },
}

/**
 * 同步会话状态机（方案 §1）。
 * scanning/plan 只读；终态 completed/cancelled 锁定。
 */
export function transitionSession(
  current: SyncSessionState,
  event: SyncSessionEvent,
): SessionMachineResult {
  const next = TRANSITIONS[current]?.[event]
  if (!next) {
    const terminal = current === 'completed' || current === 'cancelled'
    return {
      next: current,
      ok: false,
      reason: terminal ? 'TERMINAL_LOCKED' : 'INVALID_TRANSITION',
    }
  }
  return { next, ok: true }
}

export function isTerminalSession(state: SyncSessionState): boolean {
  return state === 'completed' || state === 'cancelled'
}

export function isReadOnlyPhase(state: SyncSessionState): boolean {
  return state === 'scanning' || state === 'plan_ready'
}
