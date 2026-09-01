/**
 * 阶段 6 P2：未知 Tavern fork / 通用 JSON 的受限映射向导。
 * 用户在导入预览中选择条目数组与关键字段的路径，保存为可复用模板；
 * 模板只做字段搬运，不执行表达式或脚本。
 * 本文件保持纯类型与纯函数（渲染进程也可用）；应用模板的导入逻辑在
 * electron/services/lorebookAdapters/mappingImport.ts。
 */

export interface LorebookMappingFieldPaths {
  /** 每条目的关键词字段：数组或逗号分隔字符串。 */
  keys: string
  content: string
  title?: string
  secondaryKeys?: string
  enabled?: string
  order?: string
  probability?: string
  constant?: string
  useRegex?: string
}

export interface LorebookMappingTemplate {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  /** 条目数组的 JSON 路径（如 'entries'、'data.book.entries'）；留空表示顶层就是数组。 */
  entriesPath: string
  /** 书名字段路径；留空时读取顶层 name，仍没有则用导入文件名兜底。 */
  namePath?: string
  fields: LorebookMappingFieldPaths
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function isMappingTemplate(value: unknown): value is LorebookMappingTemplate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const template = value as LorebookMappingTemplate
  return typeof template.id === 'string' && template.id.length > 0
    && typeof template.name === 'string' && template.name.trim().length > 0
    && typeof template.entriesPath === 'string'
    && !!template.fields
    && typeof template.fields.keys === 'string' && template.fields.keys.trim().length > 0
    && typeof template.fields.content === 'string' && template.fields.content.trim().length > 0
}

/** 按点分路径读取值；拒绝危险键。 */
export function resolveMappingPath(root: unknown, path: string): unknown {
  if (!path.trim()) return root
  let current: unknown = root
  for (const segment of path.split('.')) {
    if (!segment || DANGEROUS_KEYS.has(segment)) return undefined
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

const COMMON_ENTRY_CONTAINERS = ['entries', 'data.entries', 'data.book.entries', 'book.entries']
const COMMON_KEY_FIELDS = ['keys', 'key', 'keywords', 'keyPrimary', 'keys_primary']
const COMMON_CONTENT_FIELDS = ['content', 'text', 'entry', 'value']
const COMMON_TITLE_FIELDS = ['comment', 'name', 'displayName', 'displayname', 'title']

/** 从导入样本猜测受限映射模板（仅猜测常见形状；用户可在向导中修改后保存）。 */
export function guessMappingTemplate(sample: unknown, name = '猜测模板'): LorebookMappingTemplate | null {
  if (Array.isArray(sample)) return guessFromArray(sample, '', name)
  if (!sample || typeof sample !== 'object') return null
  for (const container of COMMON_ENTRY_CONTAINERS) {
    const value = resolveMappingPath(sample, container)
    if (Array.isArray(value) && value.length > 0) {
      const guessed = guessFromArray(value, container, name)
      if (guessed) return guessed
    }
  }
  return null
}

function guessFromArray(entries: unknown[], container: string, name: string): LorebookMappingTemplate | null {
  const candidate = entries.find((entry): entry is Record<string, unknown> =>
    !!entry && typeof entry === 'object' && !Array.isArray(entry))
  if (!candidate) return null
  const pick = (options: string[]): string | undefined => options.find((option) => option in candidate)
  const keys = pick(COMMON_KEY_FIELDS)
  const content = pick(COMMON_CONTENT_FIELDS)
  if (!keys || !content) return null
  const title = pick(COMMON_TITLE_FIELDS)
  const now = Date.now()
  return {
    id: `guess-${now}`,
    name,
    createdAt: now,
    updatedAt: now,
    entriesPath: container,
    fields: { keys, content, ...(title ? { title } : {}) },
  }
}
