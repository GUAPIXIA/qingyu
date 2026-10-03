/**
 * 导入防护：文件大小、数量上限、深度、悬空引用、循环、恶意 JSON。
 * 对齐方案 §13.3 与 §15。
 */
import type {
  SpatialRuntimeStateV1,
  SpatialWorldDocumentV1,
} from './model.ts'
import { IMPORT_LIMITS } from './model.ts'
import { collectDescendants, getBoard, getNode } from './hierarchy.ts'
import { validateAll, hasErrors } from './validation.ts'

export interface ImportLimitIssue {
  code: string
  message: string
}

export interface ImportGuardOptions {
  maxFileBytes?: number
  maxBoards?: number
  maxNodes?: number
  maxDistances?: number
  maxHierarchyDepth?: number
  maxActors?: number
}

const DEFAULTS: Required<ImportGuardOptions> = {
  maxFileBytes: IMPORT_LIMITS.maxFileBytes,
  maxBoards: IMPORT_LIMITS.maxBoards,
  maxNodes: IMPORT_LIMITS.maxNodes,
  maxDistances: IMPORT_LIMITS.maxDistances,
  maxHierarchyDepth: IMPORT_LIMITS.maxHierarchyDepth,
  maxActors: IMPORT_LIMITS.maxActors,
}

/** 解析并防护导入的 JSON 文本 */
export function parseImportJson(
  text: string,
  options: ImportGuardOptions = {}
): { ok: true; value: unknown } | { ok: false; issues: ImportLimitIssue[] } {
  const opts = { ...DEFAULTS, ...options }
  const issues: ImportLimitIssue[] = []

  const byteLength = new TextEncoder().encode(text).length
  if (byteLength > opts.maxFileBytes) {
    issues.push({
      code: 'file_too_large',
      message: `文件 ${byteLength} 字节超过上限 ${opts.maxFileBytes}`,
    })
    return { ok: false, issues }
  }

  // 防御超深嵌套导致解析栈溢出：粗略深度扫描
  const depth = estimateJsonDepth(text)
  if (depth > 64) {
    issues.push({
      code: 'json_too_deep',
      message: `JSON 嵌套深度约 ${depth}，超过安全上限 64`,
    })
    return { ok: false, issues }
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (e) {
    issues.push({
      code: 'json_invalid',
      message: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`,
    })
    return { ok: false, issues }
  }

  // 原型污染防护
  if (value && typeof value === 'object' && hasProtoKey(value as object)) {
    issues.push({
      code: 'proto_pollution',
      message: '检测到 __proto__ / constructor 污染键，已拒绝',
    })
    return { ok: false, issues }
  }

  return { ok: true, value }
}

function estimateJsonDepth(text: string): number {
  let depth = 0
  let max = 0
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') {
      depth += 1
      if (depth > max) max = depth
    } else if (ch === '}' || ch === ']') {
      depth = Math.max(0, depth - 1)
    }
  }
  return max
}

function hasProtoKey(obj: object): boolean {
  const stack: unknown[] = [obj]
  const seen = new Set<object>()
  while (stack.length > 0) {
    const cur = stack.pop()
    if (!cur || typeof cur !== 'object') continue
    if (seen.has(cur as object)) continue
    seen.add(cur as object)
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item)
      continue
    }
    for (const key of Object.keys(cur as object)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return true
      }
      stack.push((cur as Record<string, unknown>)[key])
    }
  }
  return false
}

/** 世界定义结构上限与引用完整性 */
export function guardWorldImport(
  world: SpatialWorldDocumentV1,
  options: ImportGuardOptions = {}
): ImportLimitIssue[] {
  const opts = { ...DEFAULTS, ...options }
  const issues: ImportLimitIssue[] = []

  if (world.boards.length > opts.maxBoards) {
    issues.push({
      code: 'too_many_boards',
      message: `画板数 ${world.boards.length} > ${opts.maxBoards}`,
    })
  }
  if (world.nodes.length > opts.maxNodes) {
    issues.push({
      code: 'too_many_nodes',
      message: `节点数 ${world.nodes.length} > ${opts.maxNodes}`,
    })
  }
  if (world.distances.length > opts.maxDistances) {
    issues.push({
      code: 'too_many_distances',
      message: `距离数 ${world.distances.length} > ${opts.maxDistances}`,
    })
  }
  if (world.actors.length > opts.maxActors) {
    issues.push({
      code: 'too_many_actors',
      message: `角色数 ${world.actors.length} > ${opts.maxActors}`,
    })
  }

  // 深度：任一节点包含路径
  for (const n of world.nodes) {
    const depth = measureNodeDepth(world, n.id)
    if (depth > opts.maxHierarchyDepth) {
      issues.push({
        code: 'hierarchy_too_deep',
        message: `节点 ${n.id} 深度 ${depth} > ${opts.maxHierarchyDepth}`,
      })
      break
    }
  }

  // 恶意深度：collectDescendants 若成环会靠 seen 截断，这里显式检环
  for (const n of world.nodes) {
    if (isCycle(world, n.id)) {
      issues.push({
        code: 'cycle_detected',
        message: `节点 ${n.id} 父子链成环`,
      })
      break
    }
  }

  const domainIssues = validateAll(world, {
    schemaVersion: 1,
    worldId: world.id,
    runtimeId: 'import_guard',
    revision: 0,
    placements: [],
    events: [],
    updatedAt: 0,
  })
  if (hasErrors(domainIssues)) {
    for (const i of domainIssues.filter((x) => x.severity === 'error')) {
      issues.push({ code: i.code, message: i.message })
    }
  }

  // 限制 issue 数量，避免放大
  return issues.slice(0, 50)
}

function measureNodeDepth(
  world: SpatialWorldDocumentV1,
  nodeId: string
): number {
  // 跨画板包含路径长度
  let depth = 0
  const seen = new Set<string>()
  let current: string | null = nodeId
  while (current && !seen.has(current)) {
    seen.add(current)
    depth += 1
    const node = getNode(world, current)
    if (!node) break
    if (node.parentNodeId) {
      current = node.parentNodeId
      continue
    }
    // 经子画板入口上溯
    const board = getBoard(world, node.boardId)
    const entry = board?.parentEntryNodeId ?? null
    current = entry
  }
  return depth
}

function isCycle(world: SpatialWorldDocumentV1, nodeId: string): boolean {
  const seen = new Set<string>()
  let current: string | null = nodeId
  while (current) {
    if (seen.has(current)) return true
    seen.add(current)
    current = getNode(world, current)?.parentNodeId ?? null
  }
  return false
}

/** 运行时导入防护 */
export function guardRuntimeImport(
  runtime: SpatialRuntimeStateV1,
  world: SpatialWorldDocumentV1
): ImportLimitIssue[] {
  const issues: ImportLimitIssue[] = []
  if (runtime.worldId !== world.id) {
    issues.push({
      code: 'runtime_world_mismatch',
      message: `运行状态属于世界 ${runtime.worldId}，当前世界为 ${world.id}`,
    })
  }
  if (runtime.placements.length > IMPORT_LIMITS.maxActors) {
    issues.push({
      code: 'too_many_placements',
      message: `位置数 ${runtime.placements.length} 超限`,
    })
  }
  for (const p of runtime.placements) {
    if (!world.actors.some((a) => a.id === p.actorId)) {
      issues.push({
        code: 'dangling_actor',
        message: `位置引用了不存在的角色 ${p.actorId}`,
      })
    }
    if (!getBoard(world, p.boardId)) {
      issues.push({
        code: 'dangling_board_ref',
        message: `位置 boardId=${p.boardId} 不存在`,
      })
    }
    if (p.anchor.kind === 'node' && p.anchor.nodeId) {
      const node = getNode(world, p.anchor.nodeId)
      if (!node) {
        issues.push({
          code: 'dangling_anchor',
          message: `锚点 ${p.anchor.nodeId} 不存在`,
        })
      } else if (node.boardId !== p.boardId) {
        issues.push({
          code: 'anchor_board_mismatch',
          message: `锚点 ${p.anchor.nodeId} 不属于 ${p.boardId}`,
        })
      }
    }
  }
  return issues.slice(0, 50)
}

export function formatImportIssues(issues: ImportLimitIssue[]): string {
  return issues.map((i) => `${i.code}: ${i.message}`).join('\n')
}

// 供性能测试使用
export { measureNodeDepth, collectDescendants }
