/**
 * 角色卡 schema 校验（导入时拦截非法/损坏的角色卡）
 *
 * 支持：
 * - V2：顶层 spec 字段（spec_version / name / description）
 * - V3：顶层 data 字段（含 spec 元数据）
 * - 裸卡：直接顶层字段
 * 校验必填字段与类型，返回可读的错误信息。
 */

export interface CardValidationResult {
  ok: boolean
  /** 已识别到的卡格式：'v2' | 'v3' | 'bare' | 'unknown' */
  format: 'v2' | 'v3' | 'bare' | 'unknown'
  errors: string[]
  warnings: string[]
}

interface RawCard {
  spec?: unknown
  data?: unknown
  [key: string]: unknown
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 从任意字段取值（支持嵌套 data 回退） */
function pick(card: RawCard, key: string): unknown {
  if (key in card) return card[key]
  if (isRecord(card.data) && key in card.data) return (card.data as Record<string, unknown>)[key]
  if (isRecord(card.spec) && key in card.spec) return (card.spec as Record<string, unknown>)[key]
  return undefined
}

/** 校验角色卡基本结构 */
export function validateCharacterCard(parsed: unknown): CardValidationResult {
  const result: CardValidationResult = { ok: true, format: 'unknown', errors: [], warnings: [] }
  if (!isRecord(parsed)) {
    result.ok = false
    result.errors.push('角色卡 JSON 顶层必须是对象')
    return result
  }
  const card = parsed as RawCard

  // 识别格式：以 spec_version 为准（V2=2.x，V3=3.x），data 包裹的 V3 也识别
  const specVersion = isRecord(card.spec) ? String(card.spec.spec_version ?? '') : ''
  const dataSpecVersion = isRecord(card.data) && isRecord(card.data.spec)
    ? String(card.data.spec.spec_version ?? '')
    : ''
  if (specVersion.startsWith('3') || dataSpecVersion.startsWith('3') || (isRecord(card.data) && 'name' in card.data)) {
    result.format = 'v3'
  } else if (isRecord(card.spec)) {
    result.format = 'v2'
  } else if ('name' in card || 'description' in card || 'first_mes' in card || 'firstMessage' in card) {
    result.format = 'bare'
  }

  // 必填字段校验
  const name = pick(card, 'name')
  if (name === undefined || name === null || String(name).trim() === '') {
    result.errors.push('缺少角色名（name 字段为空）')
  } else if (typeof name !== 'string') {
    result.errors.push('角色名（name）必须是字符串')
  }

  // 描述 / 首条消息建议有内容（缺失只警告，不拦截）
  const description = pick(card, 'description')
  if (description !== undefined && typeof description !== 'string') {
    result.errors.push('角色描述（description）必须是字符串')
  } else if (description === undefined || String(description).trim() === '') {
    result.warnings.push('角色描述为空，导入后 AI 对角色认知可能不完整')
  }

  // 首条消息：V2 为 first_mes，V3/bare 为 first_mes 或 firstMessage
  const firstMes = pick(card, 'first_mes')
  const firstMessage = pick(card, 'firstMessage')
  if (firstMes !== undefined && typeof firstMes !== 'string') {
    result.errors.push('首条消息（first_mes）必须是字符串')
  }
  if (firstMessage !== undefined && typeof firstMessage !== 'string') {
    result.errors.push('首条消息（firstMessage）必须是字符串')
  }

  // 结构完整性：V2 必须有 spec，V3 必须有 data
  if (result.format === 'v2' && !isRecord(card.spec)) {
    result.errors.push('V2 角色卡缺少 spec 字段')
  }
  if (result.format === 'v3' && !isRecord(card.data)) {
    result.errors.push('V3 角色卡缺少 data 字段')
  }

  result.ok = result.errors.length === 0
  return result
}

/** 生成给用户看的校验错误信息（多行） */
export function formatValidationErrors(result: CardValidationResult): string {
  const lines: string[] = []
  if (result.format === 'unknown') lines.push('未能识别角色卡格式（非标准 V2/V3）')
  lines.push(...result.errors)
  return lines.join('\n')
}
