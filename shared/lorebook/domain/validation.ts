import {
  CANONICAL_LOREBOOK_SCHEMA,
  CANONICAL_LOREBOOK_VERSION,
  type CanonicalLorebookDocumentV2,
} from './v2'

export interface CanonicalValidationIssue {
  path: string
  message: string
}

export type CanonicalValidationResult =
  | { valid: true; value: CanonicalLorebookDocumentV2; issues: [] }
  | { valid: false; issues: CanonicalValidationIssue[] }

type UnknownRecord = Record<string, unknown>

const PROMPT_ANCHORS = [
  'before_character', 'after_character', 'before_examples', 'after_examples',
  'authors_note_top', 'authors_note_bottom', 'prompt_end',
]
const ROLES = ['system', 'user', 'assistant']
const SECONDARY_LOGIC = ['and_any', 'and_all', 'not_any', 'not_all']
const GENERATION_TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet']

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function issue(issues: CanonicalValidationIssue[], path: string, message: string): void {
  issues.push({ path, message })
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function finiteNumber(value: unknown, min?: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && (min === undefined || value >= min)
}

function nonNegativeInteger(value: unknown): boolean {
  return finiteNumber(value, 0) && Number.isInteger(value)
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isRecord(value)) return false
  for (const [key, item] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) return false
    if (!isJsonValue(item)) return false
  }
  return true
}

function validateForeign(value: unknown, path: string, issues: CanonicalValidationIssue[]): void {
  if (value !== undefined && (!isRecord(value) || !isJsonValue(value))) {
    issue(issues, path, 'foreign 必须是 JSON 对象')
  }
}

function validateEntry(value: unknown, index: number, issues: CanonicalValidationIssue[]): void {
  const path = `$.entries[${index}]`
  if (!isRecord(value)) {
    issue(issues, path, '条目必须是对象')
    return
  }
  if (typeof value.id !== 'string') issue(issues, `${path}.id`, 'id 必须是字符串')
  if (value.sourceId !== undefined && typeof value.sourceId !== 'string' && typeof value.sourceId !== 'number') {
    issue(issues, `${path}.sourceId`, 'sourceId 必须是字符串或数字')
  }
  if (typeof value.enabled !== 'boolean') issue(issues, `${path}.enabled`, 'enabled 必须是布尔值')
  if (typeof value.content !== 'string') issue(issues, `${path}.content`, 'content 必须是字符串')
  for (const key of ['title', 'summary', 'translation'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      issue(issues, `${path}.${key}`, `${key} 必须是字符串`)
    }
  }
  validateForeign(value.foreign, `${path}.foreign`, issues)

  if (!isRecord(value.activation)) {
    issue(issues, `${path}.activation`, 'activation 必须是对象')
  } else {
    const activation = value.activation
    if (!['constant', 'conditional'].includes(String(activation.mode))) {
      issue(issues, `${path}.activation.mode`, '不支持的 activation mode')
    }
    if (!['protected', 'standard', 'supplemental'].includes(String(activation.budgetTier))) {
      issue(issues, `${path}.activation.budgetTier`, '不支持的 budget tier')
    }
    for (const key of ['primaryKeys', 'secondaryKeys', 'aliases'] as const) {
      if (!stringArray(activation[key])) issue(issues, `${path}.activation.${key}`, `${key} 必须是字符串数组`)
    }
    if (!['any', 'all'].includes(String(activation.keyLogic))) {
      issue(issues, `${path}.activation.keyLogic`, '不支持的 key logic')
    }
    if (activation.secondaryLogic !== undefined && !SECONDARY_LOGIC.includes(String(activation.secondaryLogic))) {
      issue(issues, `${path}.activation.secondaryLogic`, '不支持的 secondary logic')
    }
    if (typeof activation.caseSensitive !== 'boolean') {
      issue(issues, `${path}.activation.caseSensitive`, 'caseSensitive 必须是布尔值')
    }
    if (typeof activation.wholeWords !== 'boolean') {
      issue(issues, `${path}.activation.wholeWords`, 'wholeWords 必须是布尔值')
    }
    if (!isRecord(activation.regex)
      || typeof activation.regex.enabled !== 'boolean'
      || typeof activation.regex.flags !== 'string') {
      issue(issues, `${path}.activation.regex`, 'regex 结构无效')
    }
    if (!['keyword', 'semanticPreferred', 'semanticRequired', 'hybrid'].includes(String(activation.retrieval))) {
      issue(issues, `${path}.activation.retrieval`, '不支持的 retrieval mode')
    }
  }

  if (!isRecord(value.insertion) || typeof value.insertion.kind !== 'string') {
    issue(issues, `${path}.insertion`, 'insertion 结构无效')
  } else if (value.insertion.kind === 'prompt') {
    if (!PROMPT_ANCHORS.includes(String(value.insertion.anchor))) {
      issue(issues, `${path}.insertion.anchor`, '不支持的 prompt anchor')
    }
  } else if (value.insertion.kind === 'chat') {
    if (!nonNegativeInteger(value.insertion.depth)) issue(issues, `${path}.insertion.depth`, 'depth 必须是非负整数')
    if (value.insertion.role !== undefined && !ROLES.includes(String(value.insertion.role))) {
      issue(issues, `${path}.insertion.role`, '不支持的 chat role')
    }
  } else if (value.insertion.kind === 'outlet') {
    if (typeof value.insertion.name !== 'string') issue(issues, `${path}.insertion.name`, 'outlet name 必须是字符串')
  } else if (value.insertion.kind === 'custom') {
    if (typeof value.insertion.source !== 'string') issue(issues, `${path}.insertion.source`, 'custom source 必须是字符串')
    if (!isJsonValue(value.insertion.value)) issue(issues, `${path}.insertion.value`, 'custom value 必须是 JSON 值')
  } else {
    issue(issues, `${path}.insertion.kind`, '不支持的 insertion kind')
  }

  if (!isRecord(value.scheduling)) {
    issue(issues, `${path}.scheduling`, 'scheduling 必须是对象')
  } else {
    const scheduling = value.scheduling
    if (!finiteNumber(scheduling.order)) issue(issues, `${path}.scheduling.order`, 'order 必须是有限数字')
    if (!finiteNumber(scheduling.probability, 0) || Number(scheduling.probability) > 100) {
      issue(issues, `${path}.scheduling.probability`, 'probability 必须在 0-100')
    }
    if (scheduling.scanDepth !== undefined && !nonNegativeInteger(scheduling.scanDepth)) {
      issue(issues, `${path}.scheduling.scanDepth`, 'scanDepth 必须是非负整数')
    }
    if (!isRecord(scheduling.recursion)) {
      issue(issues, `${path}.scheduling.recursion`, 'recursion 结构无效')
    } else {
      if (typeof scheduling.recursion.exclude !== 'boolean') {
        issue(issues, `${path}.scheduling.recursion.exclude`, 'exclude 必须是布尔值')
      }
      if (typeof scheduling.recursion.prevent !== 'boolean') {
        issue(issues, `${path}.scheduling.recursion.prevent`, 'prevent 必须是布尔值')
      }
      if (!nonNegativeInteger(scheduling.recursion.minDepth)) {
        issue(issues, `${path}.scheduling.recursion.minDepth`, 'minDepth 必须是非负整数')
      }
    }
    if (!Array.isArray(scheduling.groups)) {
      issue(issues, `${path}.scheduling.groups`, 'groups 必须是数组')
    } else {
      scheduling.groups.forEach((group, groupIndex) => {
        const groupPath = `${path}.scheduling.groups[${groupIndex}]`
        if (!isRecord(group)) {
          issue(issues, groupPath, 'group 必须是对象')
          return
        }
        if (typeof group.name !== 'string') issue(issues, `${groupPath}.name`, 'name 必须是字符串')
        if (!finiteNumber(group.weight, 0)) issue(issues, `${groupPath}.weight`, 'weight 必须是非负数')
        if (typeof group.prioritized !== 'boolean') issue(issues, `${groupPath}.prioritized`, 'prioritized 必须是布尔值')
      })
    }
    if (typeof scheduling.groupScoring !== 'boolean') issue(issues, `${path}.scheduling.groupScoring`, 'groupScoring 必须是布尔值')
    if (typeof scheduling.ignoreBudget !== 'boolean') issue(issues, `${path}.scheduling.ignoreBudget`, 'ignoreBudget 必须是布尔值')
    for (const key of ['sticky', 'cooldown', 'delay'] as const) {
      if (scheduling[key] !== undefined && !nonNegativeInteger(scheduling[key])) {
        issue(issues, `${path}.scheduling.${key}`, `${key} 必须是非负整数`)
      }
    }
    if (scheduling.characterFilter !== undefined) {
      const filterPath = `${path}.scheduling.characterFilter`
      if (!isRecord(scheduling.characterFilter)) {
        issue(issues, filterPath, 'characterFilter 必须是对象')
      } else {
        if (typeof scheduling.characterFilter.exclude !== 'boolean') issue(issues, `${filterPath}.exclude`, 'exclude 必须是布尔值')
        if (!stringArray(scheduling.characterFilter.names)) issue(issues, `${filterPath}.names`, 'names 必须是字符串数组')
        if (!stringArray(scheduling.characterFilter.tags)) issue(issues, `${filterPath}.tags`, 'tags 必须是字符串数组')
      }
    }
    if (scheduling.generationTriggers !== undefined
      && (!Array.isArray(scheduling.generationTriggers)
        || !scheduling.generationTriggers.every((trigger) => GENERATION_TRIGGERS.includes(String(trigger))))) {
      issue(issues, `${path}.scheduling.generationTriggers`, '包含不支持的 generation trigger')
    }
  }
}

export function validateCanonicalLorebookV2(value: unknown): CanonicalValidationResult {
  const issues: CanonicalValidationIssue[] = []
  if (!isRecord(value)) return { valid: false, issues: [{ path: '$', message: '文档必须是对象' }] }
  if (value.schema !== CANONICAL_LOREBOOK_SCHEMA) issue(issues, '$.schema', 'schema 不匹配')
  if (value.schemaVersion !== CANONICAL_LOREBOOK_VERSION) issue(issues, '$.schemaVersion', 'schemaVersion 不匹配')
  if (typeof value.id !== 'string') issue(issues, '$.id', 'id 必须是字符串')
  if (!Number.isInteger(value.revision) || Number(value.revision) < 1) issue(issues, '$.revision', 'revision 必须是正整数')
  if (typeof value.name !== 'string') issue(issues, '$.name', 'name 必须是字符串')
  if (typeof value.description !== 'string') issue(issues, '$.description', 'description 必须是字符串')
  if (typeof value.enabled !== 'boolean') issue(issues, '$.enabled', 'enabled 必须是布尔值')
  if (!finiteNumber(value.createdAt, 0)) issue(issues, '$.createdAt', 'createdAt 必须是非负时间戳')
  if (!finiteNumber(value.updatedAt, 0)) issue(issues, '$.updatedAt', 'updatedAt 必须是非负时间戳')
  if (value.source !== undefined) {
    if (!isRecord(value.source)) {
      issue(issues, '$.source', 'source 必须是对象')
    } else {
      if (typeof value.source.adapterId !== 'string') issue(issues, '$.source.adapterId', 'adapterId 必须是字符串')
      if (value.source.formatVersion !== undefined && typeof value.source.formatVersion !== 'string') issue(issues, '$.source.formatVersion', 'formatVersion 必须是字符串')
      if (value.source.originalName !== undefined && typeof value.source.originalName !== 'string') issue(issues, '$.source.originalName', 'originalName 必须是字符串')
      if (!finiteNumber(value.source.importedAt, 0)) issue(issues, '$.source.importedAt', 'importedAt 必须是非负时间戳')
      if (typeof value.source.contentHash !== 'string') issue(issues, '$.source.contentHash', 'contentHash 必须是字符串')
    }
  }
  validateForeign(value.foreign, '$.foreign', issues)
  if (!isRecord(value.defaults)) {
    issue(issues, '$.defaults', 'defaults 必须是对象')
  } else {
    if (!finiteNumber(value.defaults.scanDepth, 0)) issue(issues, '$.defaults.scanDepth', 'scanDepth 必须是非负数')
    if (typeof value.defaults.recursiveScanning !== 'boolean') issue(issues, '$.defaults.recursiveScanning', 'recursiveScanning 必须是布尔值')
    if (value.defaults.tokenBudget !== undefined && !nonNegativeInteger(value.defaults.tokenBudget)) {
      issue(issues, '$.defaults.tokenBudget', 'tokenBudget 必须是非负整数')
    }
  }
  if (!Array.isArray(value.entries)) {
    issue(issues, '$.entries', 'entries 必须是数组')
  } else {
    value.entries.forEach((entry, index) => validateEntry(entry, index, issues))
  }
  return issues.length === 0
    ? { valid: true, value: value as unknown as CanonicalLorebookDocumentV2, issues: [] }
    : { valid: false, issues }
}

export function isCanonicalLorebookV2(value: unknown): value is CanonicalLorebookDocumentV2 {
  return validateCanonicalLorebookV2(value).valid
}
