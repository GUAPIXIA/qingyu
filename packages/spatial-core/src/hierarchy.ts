/**
 * 层级：父子包含、子画板双向引用、循环检测、包含路径。
 * 纯函数，不依赖 React / DOM / 文件系统。
 */
import type {
  SpatialBoard,
  SpatialNode,
  SpatialWorldDocumentV1,
} from './model.ts'
import { IMPORT_LIMITS } from './model.ts'
import { validateSubstructures } from './substructures.ts'

export interface ValidationIssue {
  code: string
  message: string
  /** 关联实体 id，便于 UI 定位 */
  subjectId?: string
  /** warning 不阻断导入；error 阻断 */
  severity: 'error' | 'warning'
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export function getBoard(
  world: SpatialWorldDocumentV1,
  boardId: string
): SpatialBoard | undefined {
  return world.boards.find((b) => b.id === boardId)
}

export function getNode(
  world: SpatialWorldDocumentV1,
  nodeId: string
): SpatialNode | undefined {
  return world.nodes.find((n) => n.id === nodeId)
}

export function getNodesOnBoard(
  world: SpatialWorldDocumentV1,
  boardId: string
): SpatialNode[] {
  return world.nodes.filter((n) => n.boardId === boardId)
}

/** 祖先链（含自身），从根到当前。含循环时截断并由校验器报告。 */
export function getAncestorChain(
  world: SpatialWorldDocumentV1,
  nodeId: string
): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  let current: string | null = nodeId
  while (current) {
    if (seen.has(current)) break
    seen.add(current)
    chain.push(current)
    const node: SpatialNode | undefined = getNode(world, current)
    current = node?.parentNodeId ?? null
  }
  chain.reverse()
  return chain
}

/**
 * 完整包含路径（跨画板）。
 * board 内从节点上溯 parentNodeId；再经 board.parentEntryNodeId 递归到根画板。
 * 返回 nodeId 数组，从最外层到当前。
 */
export function getContainmentPath(
  world: SpatialWorldDocumentV1,
  boardId: string,
  nodeId: string | null
): string[] {
  /** 从内到外收集的段，最后反转拼接 */
  const segments: string[][] = []
  const visited = new Set<string>()
  let currentBoardId: string | null = boardId
  let currentNodeId: string | null = nodeId

  while (currentBoardId) {
    const key = `${currentBoardId}::${currentNodeId ?? ''}`
    if (visited.has(key)) break
    visited.add(key)

    if (currentNodeId) {
      // getAncestorChain 返回根→当前（同画板内）
      segments.push(getAncestorChain(world, currentNodeId))
    }

    const board = getBoard(world, currentBoardId)
    const entryId = board?.parentEntryNodeId ?? null
    if (!entryId) break

    const entryNode = getNode(world, entryId)
    if (!entryNode) break

    currentBoardId = entryNode.boardId
    currentNodeId = entryId
  }

  // segments[0] 是最内层画板；需要从外到内
  const path: string[] = []
  for (const seg of segments.reverse()) {
    for (const id of seg) {
      if (path[path.length - 1] !== id) path.push(id)
    }
  }
  return path
}

/** 是否为祖先（严格：不含自身） */
export function isAncestor(
  world: SpatialWorldDocumentV1,
  ancestorId: string,
  nodeId: string
): boolean {
  const seen = new Set<string>()
  let current: string | null = getNode(world, nodeId)?.parentNodeId ?? null
  while (current) {
    if (current === ancestorId) return true
    if (seen.has(current)) return false
    seen.add(current)
    current = getNode(world, current)?.parentNodeId ?? null
  }
  return false
}

/** 节点的所有后代（含间接），同一画板内 + 通过子画板递归 */
export function collectDescendants(
  world: SpatialWorldDocumentV1,
  nodeId: string
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (id: string) => {
    for (const n of world.nodes) {
      if (n.parentNodeId === id && !seen.has(n.id)) {
        seen.add(n.id)
        out.push(n.id)
        walk(n.id)
      }
    }
    const node = getNode(world, id)
    if (node?.childBoardId) {
      const board = getBoard(world, node.childBoardId)
      if (board) {
        for (const n of world.nodes) {
          if (n.boardId === board.id && n.parentNodeId === null && !seen.has(n.id)) {
            seen.add(n.id)
            out.push(n.id)
            walk(n.id)
          }
        }
      }
    }
  }
  walk(nodeId)
  return out
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export function validateHierarchy(world: SpatialWorldDocumentV1): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  // 根画板存在且唯一（parentEntryNodeId === null 的为根）
  const rootBoards = world.boards.filter((b) => b.parentEntryNodeId === null)
  if (rootBoards.length === 0) {
    issues.push({
      code: 'missing_root_board',
      message: '缺少根画板（parentEntryNodeId 为 null）',
      severity: 'error',
    })
  } else if (rootBoards.length > 1) {
    issues.push({
      code: 'multiple_root_boards',
      message: `根画板数量为 ${rootBoards.length}，必须唯一`,
      severity: 'error',
    })
  }
  if (world.rootBoardId) {
    const root = getBoard(world, world.rootBoardId)
    if (!root) {
      issues.push({
        code: 'root_board_missing',
        message: `rootBoardId=${world.rootBoardId} 不存在`,
        subjectId: world.rootBoardId,
        severity: 'error',
      })
    } else if (root.parentEntryNodeId !== null) {
      issues.push({
        code: 'root_board_not_root',
        message: `rootBoardId=${world.rootBoardId} 的 parentEntryNodeId 必须为 null`,
        subjectId: root.id,
        severity: 'error',
      })
    }
  }

  // ID 唯一
  const idCounts = new Map<string, number>()
  const bump = (id: string) => idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
  world.boards.forEach((b) => bump(b.id))
  world.nodes.forEach((n) => bump(n.id))
  world.distances.forEach((d) => bump(d.id))
  world.actors.forEach((a) => bump(a.id))
  for (const [id, count] of idCounts) {
    if (count > 1) {
      issues.push({
        code: 'duplicate_id',
        message: `ID 重复：${id}（${count} 次）`,
        subjectId: id,
        severity: 'error',
      })
    }
  }

  // 数量上限
  if (world.boards.length > IMPORT_LIMITS.maxBoards) {
    issues.push({
      code: 'too_many_boards',
      message: `画板数 ${world.boards.length} 超过上限 ${IMPORT_LIMITS.maxBoards}`,
      severity: 'error',
    })
  }
  if (world.nodes.length > IMPORT_LIMITS.maxNodes) {
    issues.push({
      code: 'too_many_nodes',
      message: `节点数 ${world.nodes.length} 超过上限 ${IMPORT_LIMITS.maxNodes}`,
      severity: 'error',
    })
  }

  // 画板 parentEntryNodeId ↔ 节点 childBoardId 双向一致
  for (const board of world.boards) {
    if (board.parentEntryNodeId === null) continue
    const entry = getNode(world, board.parentEntryNodeId)
    if (!entry) {
      issues.push({
        code: 'dangling_parent_entry',
        message: `画板 ${board.id} 的 parentEntryNodeId=${board.parentEntryNodeId} 不存在`,
        subjectId: board.id,
        severity: 'error',
      })
      continue
    }
    if (entry.childBoardId !== board.id) {
      issues.push({
        code: 'child_board_mismatch',
        message: `画板 ${board.id} 入口节点 ${entry.id} 的 childBoardId=${entry.childBoardId ?? 'null'} 不一致`,
        subjectId: board.id,
        severity: 'error',
      })
    }
  }
  for (const node of world.nodes) {
    if (node.childBoardId === null) continue
    const board = getBoard(world, node.childBoardId)
    if (!board) {
      issues.push({
        code: 'dangling_child_board',
        message: `节点 ${node.id} 的 childBoardId=${node.childBoardId} 不存在`,
        subjectId: node.id,
        severity: 'error',
      })
      continue
    }
    if (board.parentEntryNodeId !== node.id) {
      issues.push({
        code: 'child_board_mismatch',
        message: `节点 ${node.id} 的子画板 ${board.id} 入口为 ${board.parentEntryNodeId ?? 'null'}，不一致`,
        subjectId: node.id,
        severity: 'error',
      })
    }
  }

  // 节点：名称、父节点、几何
  for (const node of world.nodes) {
    if (node.name.trim().length === 0) {
      issues.push({
        code: 'empty_name',
        message: `节点 ${node.id} 名称为空`,
        subjectId: node.id,
        severity: 'error',
      })
    }

    const board = getBoard(world, node.boardId)
    if (!board) {
      issues.push({
        code: 'dangling_board_ref',
        message: `节点 ${node.id} 的 boardId=${node.boardId} 不存在`,
        subjectId: node.id,
        severity: 'error',
      })
    }

    if (node.parentNodeId !== null) {
      const parent = getNode(world, node.parentNodeId)
      if (!parent) {
        issues.push({
          code: 'dangling_parent',
          message: `节点 ${node.id} 的 parentNodeId=${node.parentNodeId} 不存在`,
          subjectId: node.id,
          severity: 'error',
        })
      } else {
        if (parent.kind === 'place' && node.kind === 'region') {
          issues.push({
            code: 'invalid_parent',
            message: `区域 ${node.id} 的父节点 ${parent.id} 不能是地点`,
            subjectId: node.id,
            severity: 'error',
          })
        }
        if (parent.boardId !== node.boardId) {
          issues.push({
            code: 'cross_board_parent',
            message: `节点 ${node.id} 与父节点 ${parent.id} 不在同一画板`,
            subjectId: node.id,
            severity: 'error',
          })
        }
      }
    }

    // 无限画布几何：坐标可正可负，但所有数值必须有限，区域宽高必须为正。
    if (node.kind === 'region') {
      const { x, y, width, height } = node.geometry
      for (const [key, v] of Object.entries({ x, y })) {
        if (!Number.isFinite(v)) {
          issues.push({
            code: 'invalid_geometry',
            message: `区域 ${node.id} 的 ${key}=${v} 不是有限数值`,
            subjectId: node.id,
            severity: 'error',
          })
        }
      }
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        issues.push({
          code: 'invalid_geometry',
          message: `区域 ${node.id} 的宽高必须是大于 0 的有限数值`,
          subjectId: node.id,
          severity: 'error',
        })
      }
    } else {
      const { x, y } = node.geometry
      for (const [key, v] of Object.entries({ x, y })) {
        if (!Number.isFinite(v)) {
          issues.push({
            code: 'invalid_geometry',
            message: `地点 ${node.id} 的 ${key}=${v} 不是有限数值`,
            subjectId: node.id,
            severity: 'error',
          })
        }
      }
    }

    // 子几何位于父 region 内
    if (node.parentNodeId) {
      const parent = getNode(world, node.parentNodeId)
      if (parent && parent.kind === 'region') {
        const pg = parent.geometry
        const inside =
          node.kind === 'region'
            ? node.geometry.x >= pg.x &&
              node.geometry.y >= pg.y &&
              node.geometry.x + node.geometry.width <= pg.x + pg.width + 1e-9 &&
              node.geometry.y + node.geometry.height <= pg.y + pg.height + 1e-9
            : node.geometry.x >= pg.x &&
              node.geometry.y >= pg.y &&
              node.geometry.x <= pg.x + pg.width + 1e-9 &&
              node.geometry.y <= pg.y + pg.height + 1e-9
        if (!inside) {
          issues.push({
            code: 'geometry_outside_parent',
            message: `节点 ${node.id} 几何超出父区域 ${parent.id} 范围`,
            subjectId: node.id,
            severity: 'warning',
          })
        }
      }
    }
  }

  // 父子循环
  for (const node of world.nodes) {
    const seen = new Set<string>([node.id])
    let current: string | null = node.parentNodeId
    while (current) {
      if (current === node.id || seen.has(current)) {
        issues.push({
          code: 'cycle_detected',
          message: `节点 ${node.id} 所在父子链存在循环`,
          subjectId: node.id,
          severity: 'error',
        })
        break
      }
      seen.add(current)
      current = getNode(world, current)?.parentNodeId ?? null
    }
  }

  // 深度
  for (const node of world.nodes) {
    const depth = getContainmentPath(world, node.boardId, node.id).length
    if (depth > IMPORT_LIMITS.maxHierarchyDepth) {
      issues.push({
        code: 'hierarchy_too_deep',
        message: `节点 ${node.id} 包含路径深度 ${depth} 超过 ${IMPORT_LIMITS.maxHierarchyDepth}`,
        subjectId: node.id,
        severity: 'error',
      })
    }
  }

  return [...issues, ...validateSubstructures(world)]
}
