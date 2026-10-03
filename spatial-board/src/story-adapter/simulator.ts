/**
 * 模拟剧情适配器：接收 JSON 命令信封，不连接真实 LLM。
 */
import type { SpatialCommand } from '@qingyu/spatial-core'
import { evaluateStoryEnvelope } from './policy.ts'
import type {
  StoryAdapter,
  StoryCommandEnvelope,
  StoryContext,
  StoryDecision,
} from './types.ts'

const PLACEMENT_TYPES = new Set([
  'place_actor',
  'move_actor',
  'remove_actor_from_board',
])

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function validatePlacement(raw: unknown, path: string): string | null {
  if (!isObject(raw)) return `${path} 必须是对象`
  if (!isNonEmptyString(raw.boardId)) return `${path}.boardId 必须是非空字符串`
  if (!isObject(raw.anchor)) return `${path}.anchor 必须是对象`
  if (raw.anchor.kind !== 'board' && raw.anchor.kind !== 'node') {
    return `${path}.anchor.kind 必须是 board 或 node`
  }
  if (raw.anchor.kind === 'node' && !isNonEmptyString(raw.anchor.nodeId)) {
    return `${path}.anchor.nodeId 必须是非空字符串`
  }
  if (raw.position !== undefined) {
    if (!isObject(raw.position)) return `${path}.position 必须是对象`
    for (const key of ['x', 'y'] as const) {
      const value = raw.position[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${path}.position.${key} 必须是有限数值`
      }
    }
  }
  if (raw.semanticPosition !== undefined) {
    if (!isObject(raw.semanticPosition)) {
      return `${path}.semanticPosition 必须是对象`
    }
    const precisions = new Set(['exact', 'approximate', 'inside-only', 'unknown'])
    if (!precisions.has(String(raw.semanticPosition.precision))) {
      return `${path}.semanticPosition.precision 非法`
    }
  }
  return null
}

type CoerceResult =
  | { ok: true; command: SpatialCommand }
  | { ok: false; error: string }

function coerceCommand(raw: unknown): CoerceResult {
  if (!isObject(raw)) return { ok: false, error: '命令必须是对象' }
  const type = raw.type
  if (typeof type !== 'string') return { ok: false, error: 'type 必须是字符串' }
  if (
    (type === 'place_actor' || type === 'move_actor' || type === 'remove_actor_from_board') &&
    !isNonEmptyString(raw.actorId)
  ) {
    return { ok: false, error: `${type}.actorId 必须是非空字符串` }
  }
  if (type === 'place_actor') {
    const error = validatePlacement(raw.placement, 'place_actor.placement')
    if (error) return { ok: false, error }
  }
  if (type === 'move_actor') {
    const error = validatePlacement(raw.to, 'move_actor.to')
    if (error) return { ok: false, error }
  }
  // 非放置类命令仍交由 policy 明确拒绝为 creates_map_entities。
  return { ok: true, command: raw as unknown as SpatialCommand }
}

export function parseStoryEnvelope(input: unknown): StoryCommandEnvelope | { error: string } {
  if (typeof input === 'string') {
    try {
      return parseStoryEnvelope(JSON.parse(input) as unknown)
    } catch (e) {
      return { error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }
  if (!isObject(input)) return { error: '信封必须是对象' }
  if (input.schemaVersion !== 1) return { error: 'schemaVersion 必须为 1' }
  if (
    typeof input.expectedRevision !== 'number' ||
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    return { error: 'expectedRevision 必须是非负整数' }
  }
  if (!Array.isArray(input.commands) || input.commands.length === 0) {
    return { error: 'commands 必须是非空数组' }
  }
  if (input.commands.length > 100) {
    return { error: 'commands 数量超过 100' }
  }

  const commands: SpatialCommand[] = []
  for (let i = 0; i < input.commands.length; i += 1) {
    const result = coerceCommand(input.commands[i])
    if (!result.ok) return { error: `commands[${i}] 非法：${result.error}` }
    if (!PLACEMENT_TYPES.has(result.command.type)) {
      // 仍返回信封，由 policy 拒绝 creates_map_entities
    }
    commands.push(result.command)
  }

  const envelope: StoryCommandEnvelope = {
    schemaVersion: 1,
    expectedRevision: input.expectedRevision,
    commands,
  }
  if (typeof input.worldId === 'string') envelope.worldId = input.worldId
  if (typeof input.runtimeId === 'string') envelope.runtimeId = input.runtimeId
  if (typeof input.messageId === 'string') envelope.messageId = input.messageId
  if (typeof input.summary === 'string') envelope.summary = input.summary
  if (typeof input.completed === 'boolean') envelope.completed = input.completed
  if (typeof input.confidence === 'number' && Number.isFinite(input.confidence)) {
    envelope.confidence = Math.min(1, Math.max(0, input.confidence))
  }
  return envelope
}

export function createSimulatedStoryAdapter(deps: {
  getCore: () => {
    world: Parameters<typeof evaluateStoryEnvelope>[2]['world']
    runtime: Parameters<typeof evaluateStoryEnvelope>[2]['runtime']
  }
  makeBatch: (envelope: StoryCommandEnvelope) => {
    schemaVersion: 1
    expectedRevision: number
    commands: SpatialCommand[]
  }
}): StoryAdapter {
  return {
    parse: parseStoryEnvelope,
    evaluate(envelope, ctx: StoryContext): {
      decision: StoryDecision
      batch?: ReturnType<typeof deps.makeBatch>
    } {
      const core = deps.getCore()
      const result = evaluateStoryEnvelope(envelope, ctx, core as never)
      const decision: StoryDecision = {
        ...result.decision,
        suggestion: result.suggestion ?? result.decision.suggestion,
      }
      if (decision.ok && decision.code === 'applied') {
        return {
          decision,
          batch: deps.makeBatch(envelope),
        }
      }
      return { decision }
    },
  }
}

export type { StoryAdapter, StoryCommandEnvelope, StoryContext, StoryDecision }
