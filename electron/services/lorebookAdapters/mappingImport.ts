import type { CanonicalLorebookDocumentV2, JsonValue } from '../../../shared/lorebook/domain/v2'
import type { LorebookMappingTemplate } from '../../../shared/lorebook/adapters/mapping'
import { resolveMappingPath } from '../../../shared/lorebook/adapters/mapping'
import { migrateNativeLorebookV1ToV2 } from '../../../shared/lorebook/migrations/v1-to-v2'
import { assertImportJsonDepth, enforceImportDocumentLimits } from '../../../shared/lorebook/limits'
import { normalizeImportedLorebook } from '../lorebookImport'

/**
 * 应用映射模板导入（阶段 6 P2）：条目数组 + 受限字段路径 → canonical v2。
 * 模板未覆盖的条目字段原样保留在 foreign 命名空间供诊断；按方案 §6.3，映射向导不提供导出。
 */

const FOREIGN_NAMESPACE = 'qingyu.mapping'
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export type LorebookMappingSeverity = 'info' | 'warning' | 'error'
export type LorebookMappingAction = 'mapped' | 'preserved' | 'dropped' | 'rejected'

export interface LorebookMappingIssue {
  severity: LorebookMappingSeverity
  action: LorebookMappingAction
  code: string
  path: string
  message: string
}

export interface LorebookMappingImportResult {
  document: CanonicalLorebookDocumentV2
  issues: LorebookMappingIssue[]
  summary: {
    mapped: number
    preserved: number
    approximated: number
    dropped: number
    rejected: number
    warnings: number
    errors: number
  }
}

function issue(severity: LorebookMappingSeverity, action: LorebookMappingAction, code: string, path: string, message: string): LorebookMappingIssue {
  return { severity, action, code, path, message }
}

function summarize(issues: LorebookMappingIssue[]): LorebookMappingImportResult['summary'] {
  const count = (action: LorebookMappingAction) => issues.filter((item) => item.action === action).length
  return {
    mapped: count('mapped'),
    preserved: count('preserved'),
    approximated: 0,
    dropped: count('dropped'),
    rejected: count('rejected'),
    warnings: issues.filter((item) => item.severity === 'warning').length,
    errors: issues.filter((item) => item.severity === 'error').length,
  }
}

function stringListValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
  }
  if (typeof value !== 'string') return []
  return value.split(/[,，\n]+/).map((item) => item.trim()).filter(Boolean)
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const result: JsonValue[] = []
    for (const item of value) {
      const converted = jsonValue(item)
      if (converted !== undefined) result.push(converted)
    }
    return result
  }
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(key)) continue
      const converted = jsonValue(item)
      if (converted !== undefined) result[key] = converted
    }
    return result
  }
  return undefined
}

export function importLorebookWithMappingTemplate(
  raw: unknown,
  template: LorebookMappingTemplate,
  context: { id?: string; fallbackName: string; now?: number; contentHash?: string },
): LorebookMappingImportResult {
  const issues: LorebookMappingIssue[] = []
  // 与 registry 导入同一条安全边界（方案 §15）
  try {
    assertImportJsonDepth(raw)
  } catch (error) {
    issues.push(issue('error', 'rejected', 'json_depth_exceeded', '$', (error as Error).message))
    return { document: rejectedDocument(context, template), issues, summary: summarize(issues) }
  }
  const entriesPath = template.entriesPath
  const entriesValue = resolveMappingPath(raw, entriesPath)
  const reject = (code: string, message: string): LorebookMappingImportResult => {
    const rejected = [issue('error', 'rejected', code, entriesPath || '$', message)]
    return { document: rejectedDocument(context, template), issues: rejected, summary: summarize(rejected) }
  }
  if (!Array.isArray(entriesValue)) return reject('mapping_entries_not_found', '条目数组路径未指向数组，无法导入')
  const rawEntries = entriesValue.filter((entry): entry is Record<string, unknown> =>
    !!entry && typeof entry === 'object' && !Array.isArray(entry))
  if (rawEntries.length < entriesValue.length) {
    issues.push(issue('error', 'rejected', 'mapping_invalid_entries', entriesPath || '$',
      `${entriesValue.length - rawEntries.length} 个条目不是对象，无法导入`))
  }
  if (rawEntries.length === 0) {
    issues.push(issue('error', 'rejected', 'mapping_empty_entries', entriesPath || '$', '没有可导入的世界书条目'))
  }

  const consumed = new Set(Object.values(template.fields).filter((value): value is string => !!value)
    .map((path) => path.split('.')[0]))
  const bookNameSource = template.namePath || 'name'
  const bookName = resolveMappingPath(raw, bookNameSource)
  const payloadEntries = rawEntries.map((entry, index) => {
    const keys = stringListValue(resolveMappingPath(entry, template.fields.keys))
    const content = resolveMappingPath(entry, template.fields.content)
    const secondary = template.fields.secondaryKeys ? stringListValue(resolveMappingPath(entry, template.fields.secondaryKeys)) : []
    for (const name of ['keys', 'content', 'secondaryKeys', 'title', 'enabled', 'order', 'probability', 'constant', 'useRegex'] as const) {
      const path = template.fields[name]
      if (!path) continue
      if (resolveMappingPath(entry, path) !== undefined) {
        issues.push(issue('info', 'mapped', 'mapping_field', `$.entries[${index}].${path}`, `字段 ${name} 已按模板映射`))
      } else {
        issues.push(issue('warning', 'dropped', 'mapping_field_missing', `$.entries[${index}].${path}`, `模板字段 ${name}（${path}）在该条目上不存在`))
      }
    }
    const probability = template.fields.probability ? numberValue(resolveMappingPath(entry, template.fields.probability)) : undefined
    const foreignSource: Record<string, JsonValue> = {}
    for (const [key, value] of Object.entries(entry)) {
      if (consumed.has(key) || DANGEROUS_KEYS.has(key)) continue
      const converted = jsonValue(value)
      if (converted !== undefined) foreignSource[key] = converted
    }
    if (Object.keys(foreignSource).length > 0) {
      issues.push(issue('info', 'preserved', 'mapping_unknown_field', `$.entries[${index}]`,
        `${Object.keys(foreignSource).length} 个未映射字段已保留在 ${FOREIGN_NAMESPACE} 命名空间`))
    }
    const titleValue = template.fields.title ? resolveMappingPath(entry, template.fields.title) : undefined
    const enabledPath = template.fields.enabled
    const constantPath = template.fields.constant
    const useRegexPath = template.fields.useRegex
    return {
      keys,
      content: typeof content === 'string' ? content : '',
      ...(secondary.length > 0 ? { secondaryKeywords: secondary } : {}),
      // 归一化器不读标题字段；迁移后在 canonical 上回填
      ...(typeof titleValue === 'string' && titleValue ? { entryTitle: titleValue } : {}),
      ...(enabledPath && booleanValue(resolveMappingPath(entry, enabledPath)) === false ? { disable: true } : {}),
      ...(numberValue(template.fields.order ? resolveMappingPath(entry, template.fields.order) : undefined) !== undefined
        ? { insertion_order: numberValue(resolveMappingPath(entry, template.fields.order!)) }
        : {}),
      ...(probability !== undefined ? { probability, useProbability: probability < 100 } : {}),
      ...(constantPath && booleanValue(resolveMappingPath(entry, constantPath)) === true ? { constant: true } : {}),
      ...(useRegexPath && booleanValue(resolveMappingPath(entry, useRegexPath)) === true ? { useRegex: true } : {}),
      ...(Object.keys(foreignSource).length > 0 ? { foreignSource } : {}),
    }
  })

  const normalized = normalizeImportedLorebook({
    ...(typeof bookName === 'string' && bookName.trim() ? { name: bookName } : {}),
    entries: payloadEntries.map(({ foreignSource: _foreign, ...entry }) => entry),
  }, {
    id: context.id,
    fallbackName: context.fallbackName,
    sourceKind: 'character_book',
  })
  const document = migrateNativeLorebookV1ToV2(normalized, {
    now: context.now ?? Date.now(),
    contentHash: context.contentHash ?? 'mapping-template',
  })
  document.entries.forEach((entry, index) => {
    const source = payloadEntries[index]
    const title = source?.entryTitle
    if (typeof title === 'string' && title) entry.title = title
    if (source?.foreignSource && Object.keys(source.foreignSource).length > 0) {
      entry.foreign = { ...(entry.foreign ?? {}), [FOREIGN_NAMESPACE]: { source: source.foreignSource } }
    }
  })
  document.source = {
    adapterId: `mapping.${template.id}`,
    formatVersion: 'template',
    originalName: document.name,
    importedAt: document.createdAt,
    contentHash: context.contentHash ?? 'mapping-template',
  }
  // 导入产物统一执行条目数/正文长度/foreign 保留区/正则上限
  const limitIssues = enforceImportDocumentLimits(document).map((item) => ({
    ...item,
    action: (item.action === 'approximated' ? 'dropped' : item.action) as LorebookMappingAction,
  }))
  issues.push(...limitIssues)
  return { document, issues, summary: summarize(issues) }
}

function rejectedDocument(
  context: { id?: string; fallbackName: string; now?: number; contentHash?: string },
  template: LorebookMappingTemplate,
): CanonicalLorebookDocumentV2 {
  const now = context.now ?? Date.now()
  return {
    schema: 'qingyu_lorebook',
    schemaVersion: 2,
    id: context.id ?? 'mapping-rejected',
    revision: 1,
    name: context.fallbackName,
    description: '',
    enabled: true,
    defaults: { scanDepth: 4, recursiveScanning: true },
    entries: [],
    source: { adapterId: `mapping.${template.id}`, formatVersion: 'template', importedAt: now, contentHash: context.contentHash ?? 'mapping-template' },
    createdAt: now,
    updatedAt: now,
  }
}
