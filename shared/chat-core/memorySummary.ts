import type { MemoryFactRecord } from '../types'

export type MemorySummarySkipReason =
  | 'memory_disabled'
  | 'manual_mode'
  | 'interval_not_reached'
  | 'insufficient_messages'
  | 'stale_version'

export type MemorySummaryResult =
  | {
      status: 'summarized'
      summary: string
      currentState: string
      facts: MemoryFactRecord[]
      memoryVersion: number
    }
  | {
      status: 'skipped'
      reason: MemorySummarySkipReason
    }

export interface MemorySummaryRequest {
  characterId: string
  sessionId: string
  automatic?: boolean
}
