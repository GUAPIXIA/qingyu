import type { SpatialNode, SpatialWorldDocumentV1 } from './model.ts'

const retiredCategories = ['regionCategory', 'placeCategory', 'categoryLabel'] as const

/** 兼容旧文档和旧创建载荷，分类字段不再参与持久化。 */
export function stripNodeCategories(node: SpatialNode): SpatialNode {
  if (!node || !retiredCategories.some(key => Object.prototype.hasOwnProperty.call(node, key))) return node
  const { regionCategory: _region, placeCategory: _place, categoryLabel: _label, ...clean } = node as SpatialNode & {
    regionCategory?: unknown; placeCategory?: unknown; categoryLabel?: unknown
  }
  return clean as SpatialNode
}

export function removeNodeCategories(world: SpatialWorldDocumentV1): { world: SpatialWorldDocumentV1; changed: boolean } {
  if (!Array.isArray(world.nodes)) return { world, changed: false }
  const nodes = world.nodes.map(stripNodeCategories)
  const changed = nodes.some((node, index) => node !== world.nodes[index])
  return { world: changed ? { ...world, nodes } : world, changed }
}
