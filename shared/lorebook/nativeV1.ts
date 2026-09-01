import type { Lorebook, LoreEntry } from '../types'

export const NATIVE_LOREBOOK_V1_SCHEMA_ID = 'https://qingyu.app/schemas/lorebook/native-v1.schema.json'

export interface NativeV1ValidationIssue {
  path: string
  code: 'required' | 'type' | 'enum' | 'range'
  message: string
}

export type NativeV1ValidationResult =
  | { valid: true; value: Lorebook; issues: [] }
  | { valid: false; issues: NativeV1ValidationIssue[] }

type UnknownRecord = Record<string, unknown>

const POSITIONS = new Set<LoreEntry['position']>(['before_char', 'after_char', 'at_depth', 'at_end'])
const ROLES = new Set<NonNullable<LoreEntry['role']>>(['system', 'user', 'assistant'])
const SELECTIVE_LOGIC = new Set<NonNullable<LoreEntry['selectiveLogic']>>([
  'and_any', 'and_all', 'not_any', 'not_all',
])
const MATCH_MODES = new Set<NonNullable<LoreEntry['matchMode']>>(['keyword', 'semantic', 'both'])
const PRIORITIES = new Set<NonNullable<LoreEntry['priority']>>(['always', 'conditional', 'detail'])
const GENERATION_TRIGGERS = new Set<NonNullable<LoreEntry['generationTriggers']>[number]>([
  'normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet',
])

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function add(
  issues: NativeV1ValidationIssue[],
  path: string,
  code: NativeV1ValidationIssue['code'],
  message: string,
): void {
  issues.push({ path, code, message })
}

function required(record: UnknownRecord, key: string, path: string, issues: NativeV1ValidationIssue[]): boolean {
  if (record[key] !== undefined) return true
  add(issues, `${path}.${key}`, 'required', `缺少必填字段 ${key}`)
  return false
}

function stringField(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: NativeV1ValidationIssue[],
  requiredField = false,
): void {
  if (!requiredField && record[key] === undefined) return
  if (requiredField && !required(record, key, path, issues)) return
  if (typeof record[key] !== 'string') add(issues, `${path}.${key}`, 'type', `${key} 必须是字符串`)
}

function booleanField(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: NativeV1ValidationIssue[],
  requiredField = false,
): void {
  if (!requiredField && record[key] === undefined) return
  if (requiredField && !required(record, key, path, issues)) return
  if (typeof record[key] !== 'boolean') add(issues, `${path}.${key}`, 'type', `${key} 必须是布尔值`)
}

function finiteNumberField(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: NativeV1ValidationIssue[],
  options: { required?: boolean; integer?: boolean; min?: number; max?: number } = {},
): void {
  if (!options.required && record[key] === undefined) return
  if (options.required && !required(record, key, path, issues)) return
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    add(issues, `${path}.${key}`, 'type', `${key} 必须是有限数字`)
    return
  }
  if (options.integer && !Number.isInteger(value)) {
    add(issues, `${path}.${key}`, 'type', `${key} 必须是整数`)
  }
  if (options.min !== undefined && value < options.min) {
    add(issues, `${path}.${key}`, 'range', `${key} 不能小于 ${options.min}`)
  }
  if (options.max !== undefined && value > options.max) {
    add(issues, `${path}.${key}`, 'range', `${key} 不能大于 ${options.max}`)
  }
}

function stringArrayField(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: NativeV1ValidationIssue[],
  requiredField = false,
): void {
  if (!requiredField && record[key] === undefined) return
  if (requiredField && !required(record, key, path, issues)) return
  const value = record[key]
  if (!Array.isArray(value)) {
    add(issues, `${path}.${key}`, 'type', `${key} 必须是字符串数组`)
    return
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string') add(issues, `${path}.${key}[${index}]`, 'type', '数组成员必须是字符串')
  })
}

function enumField<T extends string>(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: NativeV1ValidationIssue[],
  allowed: Set<T>,
): void {
  if (record[key] === undefined) return
  if (typeof record[key] !== 'string' || !allowed.has(record[key] as T)) {
    add(issues, `${path}.${key}`, 'enum', `${key} 不是受支持的枚举值`)
  }
}

function validateEntry(value: unknown, index: number, issues: NativeV1ValidationIssue[]): void {
  const path = `$.entries[${index}]`
  if (!isRecord(value)) {
    add(issues, path, 'type', '世界书条目必须是对象')
    return
  }

  stringField(value, 'id', path, issues, true)
  stringArrayField(value, 'keywords', path, issues, true)
  stringField(value, 'content', path, issues, true)
  if (required(value, 'position', path, issues)) enumField(value, 'position', path, issues, POSITIONS)
  finiteNumberField(value, 'depth', path, issues, { integer: true, min: 0 })
  enumField(value, 'role', path, issues, ROLES)
  finiteNumberField(value, 'order', path, issues, { required: true })
  finiteNumberField(value, 'probability', path, issues, { required: true, min: 0, max: 100 })
  booleanField(value, 'enabled', path, issues, true)
  booleanField(value, 'useRegex', path, issues)
  stringField(value, 'regexFlags', path, issues)
  stringArrayField(value, 'secondaryKeywords', path, issues)
  enumField(value, 'selectiveLogic', path, issues, SELECTIVE_LOGIC)
  booleanField(value, 'caseSensitive', path, issues)
  booleanField(value, 'matchWholeWords', path, issues)
  booleanField(value, 'excludeRecursion', path, issues)
  booleanField(value, 'preventRecursion', path, issues)
  finiteNumberField(value, 'scanDepth', path, issues, { integer: true, min: 0 })

  if (value.delayUntilRecursion !== undefined) {
    if (typeof value.delayUntilRecursion !== 'boolean') {
      const n = value.delayUntilRecursion
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
        add(issues, `${path}.delayUntilRecursion`, 'type', 'delayUntilRecursion 必须是布尔值或大于等于 1 的整数')
      }
    }
  }

  stringArrayField(value, 'inclusionGroups', path, issues)
  booleanField(value, 'inclusionGroupPrioritized', path, issues)
  finiteNumberField(value, 'inclusionGroupWeight', path, issues, { min: 0 })
  booleanField(value, 'useGroupScoring', path, issues)

  if (value.characterFilter !== undefined) {
    const filterPath = `${path}.characterFilter`
    if (!isRecord(value.characterFilter)) {
      add(issues, filterPath, 'type', 'characterFilter 必须是对象')
    } else {
      booleanField(value.characterFilter, 'exclude', filterPath, issues, true)
      stringArrayField(value.characterFilter, 'names', filterPath, issues, true)
      stringArrayField(value.characterFilter, 'tags', filterPath, issues, true)
    }
  }

  if (value.generationTriggers !== undefined) {
    if (!Array.isArray(value.generationTriggers)) {
      add(issues, `${path}.generationTriggers`, 'type', 'generationTriggers 必须是数组')
    } else {
      value.generationTriggers.forEach((trigger, triggerIndex) => {
        if (
          typeof trigger !== 'string'
          || !GENERATION_TRIGGERS.has(trigger as NonNullable<LoreEntry['generationTriggers']>[number])
        ) {
          add(issues, `${path}.generationTriggers[${triggerIndex}]`, 'enum', '不支持的生成触发类型')
        }
      })
    }
  }

  finiteNumberField(value, 'sticky', path, issues, { integer: true, min: 0 })
  finiteNumberField(value, 'cooldown', path, issues, { integer: true, min: 0 })
  finiteNumberField(value, 'delay', path, issues, { integer: true, min: 0 })
  booleanField(value, 'ignoreBudget', path, issues)
  enumField(value, 'matchMode', path, issues, MATCH_MODES)
  stringField(value, 'translation', path, issues)
  enumField(value, 'priority', path, issues, PRIORITIES)
  stringField(value, 'summary', path, issues)
}

/**
 * 校验当前轻语持久化世界书（native v1）的结构，不执行外部格式归一化。
 * 未知字段允许存在，以冻结当前已知字段而不阻断前向扩展。
 */
export function validateNativeLorebookV1(value: unknown): NativeV1ValidationResult {
  const issues: NativeV1ValidationIssue[] = []
  if (!isRecord(value)) {
    return { valid: false, issues: [{ path: '$', code: 'type', message: '世界书顶层必须是对象' }] }
  }

  stringField(value, 'id', '$', issues, true)
  stringField(value, 'name', '$', issues, true)
  stringField(value, 'description', '$', issues, true)
  booleanField(value, 'enabled', '$', issues, true)
  finiteNumberField(value, 'scanDepth', '$', issues, { required: true, integer: true, min: 0 })
  booleanField(value, 'recursiveScanning', '$', issues)
  finiteNumberField(value, 'tokenBudget', '$', issues, { integer: true, min: 0 })

  if (!required(value, 'entries', '$', issues)) {
    return { valid: false, issues }
  }
  if (!Array.isArray(value.entries)) {
    add(issues, '$.entries', 'type', 'entries 必须是数组')
  } else {
    value.entries.forEach((entry, index) => validateEntry(entry, index, issues))
  }

  return issues.length === 0
    ? { valid: true, value: value as unknown as Lorebook, issues: [] }
    : { valid: false, issues }
}

export function assertNativeLorebookV1(value: unknown): asserts value is Lorebook {
  const result = validateNativeLorebookV1(value)
  if (!result.valid) {
    throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'))
  }
}
