/**
 * 自动移动策略：决定 apply / suggest / reject。
 * 默认 suggest；auto 仅对高置信且完成事实的放置命令生效。
 */
import type {
  SpatialCommand,
  SpatialCoreState,
} from '@qingyu/spatial-core'
import { getNode } from '@qingyu/spatial-core'
import type {
  AutoMovePolicy,
  PendingSuggestion,
  StoryCommandEnvelope,
  StoryContext,
  StoryDecision,
} from './types.ts'

const INCOMPLETE_PATTERNS = [
  /可能/i,
  /准备/i,
  /想要/i,
  /如果/i,
  /也许/i,
  /大概/i,
  /似乎/i,
  /好像/i,
  /打算/i,
  /将会/i,
  /将要/i,
  /might/i,
  /maybe/i,
  /plan to/i,
  /want to/i,
  /if /i,
  /would/i,
  /thinking of/i,
]

/** 是否只含角色放置类命令（禁止剧情创建地图实体） */
export function isPlacementOnly(commands: SpatialCommand[]): boolean {
  return commands.every(
    (c) =>
      c.type === 'place_actor' ||
      c.type === 'move_actor' ||
      c.type === 'remove_actor_from_board'
  )
}

export function hasCreates(commands: SpatialCommand[]): boolean {
  return commands.some(
    (c) =>
      c.type === 'create_node' ||
      c.type === 'create_distance' ||
      c.type === 'create_actor' ||
      c.type === 'delete_node' ||
      c.type === 'delete_distance' ||
      c.type === 'delete_actor' ||
      c.type === 'update_node' ||
      c.type === 'update_distance' ||
      c.type === 'update_actor'
  )
}

/** 同一回复中对同一角色的冲突目标 */
export function hasConflictingMoves(commands: SpatialCommand[]): boolean {
  const lastByActor = new Map<string, string>()
  for (const c of commands) {
    if (c.type !== 'move_actor' && c.type !== 'place_actor') continue
    const to =
      c.type === 'move_actor'
        ? `${c.to.boardId}::${c.to.anchor.kind}::${c.to.anchor.nodeId ?? ''}`
        : `${c.placement.boardId}::${c.placement.anchor.kind}::${
            c.placement.anchor.nodeId ?? ''
          }`
    const prev = lastByActor.get(c.actorId)
    if (prev && prev !== to) return true
    lastByActor.set(c.actorId, to)
  }
  return false
}

/** 目标 ID 是否存在且属于目标画板 */
export function targetsResolvable(
  core: SpatialCoreState,
  commands: SpatialCommand[]
): { ok: boolean; message?: string } {
  for (const c of commands) {
    if (
      c.type !== 'place_actor' &&
      c.type !== 'move_actor' &&
      c.type !== 'remove_actor_from_board'
    ) {
      continue
    }
    if (!core.world.actors.some((a) => a.id === c.actorId)) {
      return { ok: false, message: `角色 ${c.actorId} 不存在` }
    }
    if (c.type === 'remove_actor_from_board') continue
    const place = c.type === 'move_actor' ? c.to : c.placement
    const board = core.world.boards.find((b) => b.id === place.boardId)
    if (!board) {
      return { ok: false, message: `画板 ${place.boardId} 不存在` }
    }
    if (place.anchor.kind === 'node') {
      const nodeId = place.anchor.nodeId
      if (!nodeId) {
        return { ok: false, message: 'node 锚点缺少 nodeId' }
      }
      const node = getNode(core.world, nodeId)
      if (!node) {
        return { ok: false, message: `目标节点 ${nodeId} 不存在` }
      }
      if (node.boardId !== place.boardId) {
        return {
          ok: false,
          message: `目标节点 ${nodeId} 不属于画板 ${place.boardId}`,
        }
      }
    }
  }
  return { ok: true }
}

export function looksIncomplete(text: string | undefined): boolean {
  if (!text) return false
  return INCOMPLETE_PATTERNS.some((re) => re.test(text))
}

export function describeEnvelope(
  envelope: StoryCommandEnvelope,
  core: SpatialCoreState
): string {
  if (envelope.summary) return envelope.summary
  const parts: string[] = []
  for (const c of envelope.commands) {
    if (c.type === 'move_actor' || c.type === 'place_actor') {
      const actor =
        core.world.actors.find((a) => a.id === c.actorId)?.displayName ?? c.actorId
      const to = c.type === 'move_actor' ? c.to : c.placement
      const target =
        to.anchor.kind === 'node'
          ? (getNode(core.world, to.anchor.nodeId ?? '')?.name ?? to.anchor.nodeId)
          : '画板'
      parts.push(`${actor} → ${target}`)
    } else if (c.type === 'remove_actor_from_board') {
      const actor =
        core.world.actors.find((a) => a.id === c.actorId)?.displayName ?? c.actorId
      parts.push(`${actor} 移出画板`)
    }
  }
  return parts.join('；') || '剧情命令'
}

/**
 * 评估信封是否可自动应用 / 进入建议 / 直接拒绝。
 * 不修改 core；返回可选 batch 供上层提交。
 */
export function evaluateStoryEnvelope(
  envelope: StoryCommandEnvelope,
  ctx: StoryContext,
  core: SpatialCoreState
): { decision: StoryDecision; suggestion?: PendingSuggestion } {
  const label = describeEnvelope(envelope, core)

  if (ctx.policy === 'off') {
    return {
      decision: {
        ok: false,
        code: 'policy_off',
        message: '自动移动已关闭，忽略剧情命令',
      },
    }
  }

  if (!envelope.commands?.length) {
    return {
      decision: {
        ok: false,
        code: 'schema_invalid',
        message: '命令批次为空',
      },
    }
  }

  if (hasCreates(envelope.commands)) {
    return {
      decision: {
        ok: false,
        code: 'creates_map_entities',
        message: '剧情不得创建或修改地图实体，已拒绝',
      },
    }
  }

  if (!isPlacementOnly(envelope.commands)) {
    return {
      decision: {
        ok: false,
        code: 'creates_map_entities',
        message: '仅允许 place/move/remove 角色命令',
      },
    }
  }

  if (hasConflictingMoves(envelope.commands)) {
    return {
      decision: {
        ok: false,
        code: 'conflicting_moves',
        message: '同一回复包含互相冲突的移动，不自动执行',
      },
    }
  }

  const resolvable = targetsResolvable(core, envelope.commands)
  if (!resolvable.ok) {
    return {
      decision: {
        ok: false,
        code: 'ambiguous_or_missing_target',
        message: resolvable.message ?? '目标无法唯一解析',
      },
    }
  }

  if (
    envelope.worldId !== undefined &&
    envelope.worldId !== ctx.worldId
  ) {
    return {
      decision: {
        ok: false,
        code: 'world_mismatch',
        message: `worldId 不匹配：${envelope.worldId}`,
      },
    }
  }
  if (
    envelope.runtimeId !== undefined &&
    envelope.runtimeId !== ctx.runtimeId
  ) {
    return {
      decision: {
        ok: false,
        code: 'world_mismatch',
        message: `runtimeId 不匹配：${envelope.runtimeId}`,
      },
    }
  }

  const completed = envelope.completed !== false
  const confidence = envelope.confidence ?? 1
  const minConfidence = ctx.minConfidence ?? 0.9

  // revision 冲突：一律进建议，不覆盖用户最新拖动
  if (envelope.expectedRevision !== ctx.currentRevision) {
    const suggestion: PendingSuggestion = {
      id: ctx.idGen(),
      envelope,
      status: 'pending',
      label: `${label}（revision 过期：${envelope.expectedRevision} → ${ctx.currentRevision}）`,
      reason: 'revision_conflict',
      createdAt: ctx.now,
    }
    return {
      decision: {
        ok: false,
        code: 'revision_conflict',
        message: `expectedRevision=${envelope.expectedRevision} 与当前 ${ctx.currentRevision} 不一致，已进入待确认`,
        suggestion,
      },
    }
  }

  // 未完成语气
  const incomplete =
    !completed || looksIncomplete(envelope.summary) || looksIncomplete(envelope.commands.map((c) => (c as { reason?: string }).reason).join(' '))
  if (incomplete) {
    const suggestion: PendingSuggestion = {
      id: ctx.idGen(),
      envelope,
      status: 'pending',
      label: `${label}（来源可能不是完成动作）`,
      reason: 'incomplete_action',
      createdAt: ctx.now,
    }
    return {
      decision: {
        ok: false,
        code: 'incomplete_action',
        message: '来源不是明确完成的移动，仅作建议',
        suggestion,
      },
    }
  }

  if (ctx.policy === 'suggest') {
    const suggestion: PendingSuggestion = {
      id: ctx.idGen(),
      envelope,
      status: 'pending',
      label: `是否${label}`,
      createdAt: ctx.now,
    }
    return {
      decision: {
        ok: true,
        code: 'queued',
        message: '已加入待确认建议',
        suggestion,
      },
    }
  }

  // auto
  if (confidence < minConfidence) {
    const suggestion: PendingSuggestion = {
      id: ctx.idGen(),
      envelope,
      status: 'pending',
      label: `${label}（置信度 ${confidence.toFixed(2)} 偏低）`,
      reason: 'low_confidence',
      createdAt: ctx.now,
    }
    return {
      decision: {
        ok: false,
        code: 'low_confidence',
        message: `置信度 ${confidence} 低于 ${minConfidence}，进入待确认`,
        suggestion,
      },
    }
  }

  return {
    decision: {
      ok: true,
      code: 'applied',
      message: `自动应用：${label}`,
    },
  }
}

export type { AutoMovePolicy }
