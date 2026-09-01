import { join } from 'node:path'
import { DIRS, readJson, writeJson } from './storage'
import { createLogger } from './logger'
import { isMappingTemplate, type LorebookMappingTemplate } from '../../shared/lorebook/adapters/mapping'

/**
 * 阶段 6 P2：映射向导模板的持久化存储。
 * 模板只包含字段路径，不含可执行内容；数量与单条体积设上限防止膨胀。
 */

const log = createLogger('lorebook-mapping-templates')

const MAX_TEMPLATES = 50

function templatesFile(): string {
  return join(DIRS.config(), 'lorebook-mapping-templates.json')
}

export function listLorebookMappingTemplates(): LorebookMappingTemplate[] {
  const stored = readJson<unknown>(templatesFile())
  const list = Array.isArray(stored) ? stored : []
  const valid = list.filter(isMappingTemplate)
  if (valid.length !== list.length) {
    log.warn('映射模板文件中存在非法条目，已忽略', { total: list.length, valid: valid.length })
  }
  return valid.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function saveLorebookMappingTemplate(template: LorebookMappingTemplate): void {
  if (!isMappingTemplate(template)) throw new Error('映射模板结构不合法')
  const list = listLorebookMappingTemplates().filter((item) => item.id !== template.id)
  list.unshift({ ...template, updatedAt: Date.now() })
  writeJson(templatesFile(), list.slice(0, MAX_TEMPLATES))
}

export function deleteLorebookMappingTemplate(id: string): void {
  const list = listLorebookMappingTemplates().filter((item) => item.id !== id)
  writeJson(templatesFile(), list)
}
