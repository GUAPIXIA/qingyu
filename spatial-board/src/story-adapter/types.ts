/**
 * 剧情适配层类型：核心只认 SpatialCommand[]，本层负责安全应用策略。
 */
import type {
  PlacementGuard,
  SpatialCommand,
  SpatialCommandBatch,
  ActorPlacementInput,
} from '@qingyu/spatial-core'

export type AutoMovePolicy = 'off' | 'suggest' | 'auto'

/** 模型/剧情侧提交的命令信封 */
export interface StoryCommandEnvelope {
  schemaVersion: 1
  expectedRevision: number
  worldId?: string
  runtimeId?: string
  commands: SpatialCommand[]
  /** 来源消息 id，便于回溯 */
  messageId?: string
  /** 摘要，用于「是否移动到…」提示 */
  summary?: string
  /** 来源是否为已完成动作（非计划/假设/回忆） */
  completed?: boolean
  /** 0..1；auto 模式要求高置信 */
  confidence?: number
}

export type SuggestionStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'failed'

export interface PendingSuggestion {
  id: string
  envelope: StoryCommandEnvelope
  status: SuggestionStatus
  /** 给用户看的提示文案 */
  label: string
  /** 拒绝/失败原因 */
  reason?: string
  createdAt: number
}

export type StoryDecisionCode =
  | 'applied'
  | 'queued'
  | 'policy_off'
  | 'schema_invalid'
  | 'revision_conflict'
  | 'incomplete_action'
  | 'low_confidence'
  | 'creates_map_entities'
  | 'conflicting_moves'
  | 'ambiguous_or_missing_target'
  | 'world_mismatch'
  | 'batch_failed'

export interface StoryDecision {
  ok: boolean
  code: StoryDecisionCode
  message: string
  /** 提示进入待确认队列 */
  suggestion?: PendingSuggestion
}

export interface StoryContext {
  policy: AutoMovePolicy
  now: number
  idGen: () => string
  currentRevision: number
  worldId: string
  runtimeId: string
  /** auto 模式最低置信度，默认 0.9 */
  minConfidence?: number
}

export interface StoryAdapter {
  /** 解析任意输入为信封；失败返回错误 */
  parse(input: unknown): StoryCommandEnvelope | { error: string }
  /** 按策略校验并应用；不直接改 store */
  evaluate(
    envelope: StoryCommandEnvelope,
    ctx: StoryContext
  ): { decision: StoryDecision; batch?: SpatialCommandBatch }
}

export type { SpatialCommand, SpatialCommandBatch, ActorPlacementInput, PlacementGuard }
