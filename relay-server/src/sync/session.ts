/**
 * S8-03：会话状态与幂等批次（纯逻辑 + 存储接口）。
 */
import { createHash } from 'node:crypto'
import {
  SYNC_BATCH_TTL_MS,
  SYNC_SESSION_TTL_MS,
  type PreparedReceipt,
  type CommitReceipt,
  type SyncSessionState,
  type WireEntity,
} from './types.js'

export interface SessionRecord {
  sessionId: string
  spaceId: string
  deviceId: string
  state: SyncSessionState
  protocolVersion: number
  knownVector: Record<string, string>
  preparedReceipt: PreparedReceipt | null
  commitReceipt: CommitReceipt | null
  requestFingerprint: string | null
  createdAt: number
  updatedAt: number
  expiresAt: number
}

const ALLOWED: Record<SyncSessionState, readonly SyncSessionState[]> = {
  open: ['planned', 'pushing', 'pulling', 'prepared', 'committed', 'aborted', 'expired'],
  planned: ['pushing', 'pulling', 'prepared', 'committed', 'aborted', 'expired'],
  pushing: ['pushing', 'prepared', 'pulling', 'committed', 'aborted', 'expired'],
  pulling: ['pulling', 'prepared', 'pushing', 'committed', 'aborted', 'expired'],
  prepared: ['prepared', 'committed', 'aborted', 'expired'],
  committed: [],
  aborted: [],
  expired: [],
}

export function canTransition(from: SyncSessionState, to: SyncSessionState): boolean {
  return ALLOWED[from]?.includes(to) ?? false
}

export function isTerminal(state: SyncSessionState): boolean {
  return state === 'committed' || state === 'aborted' || state === 'expired'
}

export function isExpired(session: { expiresAt: number }, now: number): boolean {
  return session.expiresAt <= now
}

export function sessionTtlMs(): number {
  return SYNC_SESSION_TTL_MS
}

export function batchTtlMs(): number {
  return SYNC_BATCH_TTL_MS
}

/** 同 batchId 重试：request hash 必须一致才返回同一结果 */
export function computeRequestHash(batchId: string, envelopes: readonly WireEntity[]): string {
  const canonical = JSON.stringify({
    batchId,
    items: envelopes.map((e) => ({
      t: e.entityType,
      i: e.entityId,
      v: e.versionHash,
      k: e.keyEpoch,
      c: e.cipherRevision,
      h: e.cipherHash,
      g: e.contentTag,
      d: e.deleted,
    })),
  })
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

export function preparedReceiptInput(sessionId: string, envelopes: readonly WireEntity[]): { batchHash: string; stagedCount: number } {
  const hash = computeRequestHash(sessionId, envelopes)
  return { batchHash: hash, stagedCount: envelopes.length }
}

export function mergeKnownVector(
  current: Record<string, string>,
  incoming: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...current }
  for (const [device, counter] of Object.entries(incoming)) {
    const a = BigInt(out[device] ?? '0')
    const b = BigInt(counter)
    const max = a > b ? a : b
    if (max > 0n) out[device] = max.toString(10)
    else delete out[device]
  }
  return out
}
