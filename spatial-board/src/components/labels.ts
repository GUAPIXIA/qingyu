/**
 * 领域枚举的中文展示标签。值仍存英文枚举，仅 UI 显示中文化。
 */
export const DIRECTION_LABELS: Record<string, string> = {
  inside: '内部',
  nearby: '附近',
  center: '中心',
  north: '北',
  'north-east': '东北',
  east: '东',
  'south-east': '东南',
  south: '南',
  'south-west': '西南',
  west: '西',
  'north-west': '西北',
}

export const PRECISION_LABELS: Record<string, string> = {
  exact: '精确',
  approximate: '大致',
  'inside-only': '仅知在内',
  unknown: '未知',
}

export const DISTANCE_UNIT_LABELS: Record<string, string> = {
  m: '米 (m)',
  km: '公里 (km)',
  au: '天文单位 (au)',
  ly: '光年 (ly)',
  custom: '自定义单位',
}

export const CERTAINTY_LABELS: Record<string, string> = {
  exact: '精确',
  estimated: '估算',
  unknown: '未知',
}

export const POLICY_LABELS: Record<string, string> = {
  off: '关闭 — 不解析、不移动',
  suggest: '建议 — 待确认（默认）',
  auto: '自动 — 高置信直接应用',
}

export const ANCHOR_KIND_LABELS: Record<string, string> = {
  board: '画板',
  node: '节点',
}

export const SOURCE_LABELS: Record<string, string> = {
  user: '用户',
  story: '剧情',
  import: '导入',
  system: '系统',
}

export const ACTOR_KIND_LABELS: Record<string, string> = {
  persona: '用户身份',
  character: '角色',
}

export const COMMAND_TYPE_LABELS: Record<string, string> = {
  create_node: '创建节点',
  update_node: '更新节点',
  delete_node: '删除节点',
  create_distance: '创建距离',
  update_distance: '更新距离',
  delete_distance: '删除距离',
  create_actor: '添加角色',
  update_actor: '更新角色',
  delete_actor: '删除角色',
  place_actor: '放置角色',
  move_actor: '移动角色',
  remove_actor_from_board: '移出画板',
}

export function labelOf(
  map: Record<string, string>,
  key: string | undefined | null,
  fallback?: string
): string {
  if (!key) return fallback ?? '—'
  return map[key] ?? fallback ?? key
}
