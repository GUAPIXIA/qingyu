/**
 * 距离关系校验：同类、同画板、无向去重、测量字段。
 */
import type {
  DistanceRelation,
  SpatialNode,
  SpatialWorldDocumentV1,
} from './model.ts'
import { getNode } from './hierarchy.ts'
import type { ValidationIssue } from './hierarchy.ts'

/** 无向节点对规范化键 */
export function undirectedPairKey(a: string, b: string): string {
  return a <= b ? `${a}::${b}` : `${b}::${a}`
}

export function validateDistanceRelation(
  world: SpatialWorldDocumentV1,
  relation: DistanceRelation
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const source: SpatialNode | undefined = getNode(world, relation.sourceNodeId)
  const target: SpatialNode | undefined = getNode(world, relation.targetNodeId)

  if (!source) {
    issues.push({
      code: 'distance_dangling_source',
      message: `距离 ${relation.id} 的 sourceNodeId=${relation.sourceNodeId} 不存在`,
      subjectId: relation.id,
      severity: 'error',
    })
  }
  if (!target) {
    issues.push({
      code: 'distance_dangling_target',
      message: `距离 ${relation.id} 的 targetNodeId=${relation.targetNodeId} 不存在`,
      subjectId: relation.id,
      severity: 'error',
    })
  }
  if (!source || !target) return issues

  if (relation.sourceNodeId === relation.targetNodeId) {
    issues.push({
      code: 'self_distance',
      message: `距离 ${relation.id} 连接了自身`,
      subjectId: relation.id,
      severity: 'error',
    })
  }

  if (source.kind !== target.kind) {
    issues.push({
      code: 'cross_kind_distance',
      message: `距离 ${relation.id} 连接了不同类型节点（${source.kind} ↔ ${target.kind}）`,
      subjectId: relation.id,
      severity: 'error',
    })
  }

  if (source.boardId !== target.boardId) {
    issues.push({
      code: 'cross_board_distance',
      message: `距离 ${relation.id} 两端不在同一画板（${source.boardId} / ${target.boardId}）`,
      subjectId: relation.id,
      severity: 'error',
    })
  }

  if (relation.boardId !== source.boardId) {
    issues.push({
      code: 'distance_board_mismatch',
      message: `距离 ${relation.id} 的 boardId=${relation.boardId} 与端点画板不一致`,
      subjectId: relation.id,
      severity: 'error',
    })
  }

  // 测量字段
  const m = relation.measurement
  if (m.value !== null) {
    if (!Number.isFinite(m.value) || m.value < 0) {
      issues.push({
        code: 'invalid_distance_value',
        message: `距离 ${relation.id} 的数值非法：${m.value}`,
        subjectId: relation.id,
        severity: 'error',
      })
    }
  } else if (m.displayText.trim().length === 0) {
    issues.push({
      code: 'distance_display_required',
      message: `距离 ${relation.id} 无数值时 displayText 必填`,
      subjectId: relation.id,
      severity: 'error',
    })
  }

  if (m.unit === 'custom') {
    if (!m.customUnit || m.customUnit.trim().length === 0) {
      issues.push({
        code: 'distance_custom_unit_required',
        message: `距离 ${relation.id} 使用 custom 单位时必须提供 customUnit`,
        subjectId: relation.id,
        severity: 'error',
      })
    }
  }

  return issues
}

export function validateDistances(
  world: SpatialWorldDocumentV1
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const pairSeen = new Map<string, string>()

  if (world.distances.length > 10_000) {
    issues.push({
      code: 'too_many_distances',
      message: `距离关系数 ${world.distances.length} 超过上限 10000`,
      severity: 'error',
    })
  }

  for (const rel of world.distances) {
    issues.push(...validateDistanceRelation(world, rel))
    const key = undirectedPairKey(rel.sourceNodeId, rel.targetNodeId)
    const prev = pairSeen.get(key)
    if (prev) {
      issues.push({
        code: 'duplicate_distance',
        message: `距离 ${rel.id} 与 ${prev} 重复（无向对 ${key}）`,
        subjectId: rel.id,
        severity: 'error',
      })
    } else {
      pairSeen.set(key, rel.id)
    }
  }

  return issues
}
