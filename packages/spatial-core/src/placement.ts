/**
 * 角色位置校验与包含路径重算。
 * containmentPath 一律由核心重算，不信任外部输入。
 */
import type {
  ActorPlacement,
  CanvasPoint,
  PlacementSource,
  SpatialRuntimeStateV1,
  SpatialWorldDocumentV1,
} from './model.ts'
import { OFFSTAGE_REGION_TAG } from './model.ts'
import type { ActorPlacementInput } from './commands.ts'
import {
  getBoard,
  getContainmentPath,
  getNode,
  type ValidationIssue,
} from './hierarchy.ts'

export function isPlacementOffstage(
  world: Pick<SpatialWorldDocumentV1, 'nodes'>,
  placement: ActorPlacement
): boolean {
  return placement.semanticPosition.containmentPath.some((nodeId) =>
    world.nodes
      .find((node) => node.id === nodeId)
      ?.tags.includes(OFFSTAGE_REGION_TAG)
  )
}

export function validatePlacements(
  world: SpatialWorldDocumentV1,
  runtime: SpatialRuntimeStateV1
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const seenActors = new Set<string>()

  for (const p of runtime.placements) {
    if (seenActors.has(p.actorId)) {
      issues.push({
        code: 'duplicate_placement',
        message: `角色 ${p.actorId} 存在多个当前位置`,
        subjectId: p.actorId,
        severity: 'error',
      })
    }
    seenActors.add(p.actorId)

    if (!Number.isFinite(p.position.x) || !Number.isFinite(p.position.y)) {
      issues.push({
        code: 'invalid_geometry',
        message: `角色 ${p.actorId} 的位置必须是有限画布坐标`,
        subjectId: p.actorId,
        severity: 'error',
      })
    }

    const actor = world.actors.find((a) => a.id === p.actorId)
    if (!actor) {
      issues.push({
        code: 'dangling_actor',
        message: `位置引用了不存在的角色 ${p.actorId}`,
        subjectId: p.actorId,
        severity: 'error',
      })
    }

    const board = getBoard(world, p.boardId)
    if (!board) {
      issues.push({
        code: 'dangling_board_ref',
        message: `角色 ${p.actorId} 的 boardId=${p.boardId} 不存在`,
        subjectId: p.actorId,
        severity: 'error',
      })
    }

    if (p.anchor.kind === 'node') {
      const nodeId = p.anchor.nodeId
      if (!nodeId) {
        issues.push({
          code: 'invalid_anchor',
          message: `角色 ${p.actorId} 的 node 锚点缺少 nodeId`,
          subjectId: p.actorId,
          severity: 'error',
        })
      } else {
        const node = getNode(world, nodeId)
        if (!node) {
          issues.push({
            code: 'dangling_anchor',
            message: `角色 ${p.actorId} 锚点节点 ${nodeId} 不存在`,
            subjectId: p.actorId,
            severity: 'error',
          })
        } else if (node.boardId !== p.boardId) {
          issues.push({
            code: 'anchor_board_mismatch',
            message: `角色 ${p.actorId} 锚点 ${nodeId} 不属于画板 ${p.boardId}`,
            subjectId: p.actorId,
            severity: 'error',
          })
        }
      }
    }

    // containmentPath 必须与核心重算结果一致
    const expected = getContainmentPath(
      world,
      p.boardId,
      p.anchor.kind === 'node' ? (p.anchor.nodeId ?? null) : null
    )
    const actual = p.semanticPosition.containmentPath
    if (expected.join('>') !== actual.join('>')) {
      issues.push({
        code: 'containment_path_mismatch',
        message: `角色 ${p.actorId} 的 containmentPath 与世界定义重算结果不一致`,
        subjectId: p.actorId,
        severity: 'error',
      })
    }
  }

  return issues
}

/**
 * 由输入构建完整 ActorPlacement。
 * containmentPath / revision / updatedAt / updatedBy 由核心写入。
 */
export function buildPlacement(
  world: SpatialWorldDocumentV1,
  actorId: string,
  input: ActorPlacementInput,
  options: {
    revision: number
    updatedAt: number
    updatedBy: PlacementSource
  }
): ActorPlacement {
  const anchor =
    input.anchor.kind === 'node'
      ? ({ kind: 'node', nodeId: input.anchor.nodeId } as const)
      : ({ kind: 'board' } as const)

  const anchorNodeId = anchor.kind === 'node' ? (anchor.nodeId ?? null) : null
  const containmentPath = getContainmentPath(world, input.boardId, anchorNodeId)

  let position: CanvasPoint
  if (input.position) {
    position = { x: input.position.x, y: input.position.y }
  } else if (anchorNodeId) {
    const node = getNode(world, anchorNodeId)
    position = node
      ? { x: node.geometry.x, y: node.geometry.y }
      : { x: 0.5, y: 0.5 }
  } else {
    position = { x: 0.5, y: 0.5 }
  }

  return {
    actorId,
    boardId: input.boardId,
    anchor,
    position,
    semanticPosition: {
      containmentPath,
      ...(input.semanticPosition?.relativeToNodeId
        ? { relativeToNodeId: input.semanticPosition.relativeToNodeId }
        : {}),
      ...(input.semanticPosition?.relativeDirection
        ? { relativeDirection: input.semanticPosition.relativeDirection }
        : {}),
      precision: input.semanticPosition?.precision ?? 'approximate',
      ...(input.semanticPosition?.note
        ? { note: input.semanticPosition.note }
        : {}),
    },
    revision: options.revision,
    updatedAt: options.updatedAt,
    updatedBy: options.updatedBy,
  }
}

/** 校验 placement 输入（提交前） */
export function validatePlacementInput(
  world: SpatialWorldDocumentV1,
  input: ActorPlacementInput
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (
    input.position &&
    (!Number.isFinite(input.position.x) || !Number.isFinite(input.position.y))
  ) {
    issues.push({
      code: 'invalid_geometry',
      message: '角色位置必须是有限画布坐标',
      severity: 'error',
    })
  }
  const board = getBoard(world, input.boardId)
  if (!board) {
    issues.push({
      code: 'board_not_found',
      message: `目标画板 ${input.boardId} 不存在`,
      subjectId: input.boardId,
      severity: 'error',
    })
    return issues
  }

  if (input.anchor.kind === 'node') {
    const nodeId = input.anchor.nodeId
    if (!nodeId) {
      issues.push({
        code: 'invalid_anchor',
        message: 'node 锚点必须提供 nodeId',
        severity: 'error',
      })
      return issues
    }
    const node = getNode(world, nodeId)
    if (!node) {
      issues.push({
        code: 'node_not_found',
        message: `锚点节点 ${nodeId} 不存在`,
        subjectId: nodeId,
        severity: 'error',
      })
    } else if (node.boardId !== input.boardId) {
      issues.push({
        code: 'anchor_board_mismatch',
        message: `锚点节点 ${nodeId} 不属于画板 ${input.boardId}`,
        subjectId: nodeId,
        severity: 'error',
      })
    }
  }

  return issues
}
