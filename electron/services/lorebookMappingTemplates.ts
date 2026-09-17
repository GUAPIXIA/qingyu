import { join } from 'node:path'
import { DIRS, readJson, serializeJson } from './storage'
import { createLogger } from './logger'
import { commitThroughDomain } from '../domain/syncDomainService'
import { isMappingTemplate, type LorebookMappingTemplate } from '../../shared/lorebook/adapters/mapping'

/**
 * 阶段 6 P2：映射向导模板的持久化存储。
 * 模板只包含字段路径，不含可执行内容；数量与单条体积设上限防止膨胀。
 * 阶段 2 S2-04：模板数组文件与其 journal 在同一文件事务内提交（commitThroughDomain），
 * 不再有绕过事务的原始 JSON 写。
 */

const log = createLogger('lorebook-mapping-templates')

const MAX_TEMPLATES = 50

function templatesFile(): string {
  return join(DIRS.config(), 'lorebook-mapping-templates.json')
}

/** 读取磁盘上的合法模板（保持文件顺序，非法条目忽略并告警）。 */
function readStoredTemplates(): LorebookMappingTemplate[] {
  const stored = readJson<unknown>(templatesFile())
  const list = Array.isArray(stored) ? stored : []
  const valid = list.filter(isMappingTemplate)
  if (valid.length !== list.length) {
    log.warn('映射模板文件中存在非法条目，已忽略', { total: list.length, valid: valid.length })
  }
  return valid
}

export function listLorebookMappingTemplates(): LorebookMappingTemplate[] {
  return readStoredTemplates().sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 阶段 2 S2-04 canonical payload：与 bootstrap 扫描器（bootstrapScanners.scanLorebooks）
 * 保持一致 —— 模板实体去掉 id（id 即 entityId）。
 */
export function lorebookMappingTemplatePayload(template: LorebookMappingTemplate): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(template)) {
    if (key !== 'id') payload[key] = value
  }
  return payload
}

/**
 * 阶段 2 S2-04：模板文件一次写可能涉及多个实体变化（新增/更新、超出上限被截断、删除），
 * 因此以磁盘旧状态 diff 出 puts / deletes，与文件字节一起用 commitThroughDomain 提交；
 * domain flag 关闭时入口内部退化为旧行为（原子直写、不写 journal）。
 */
function commitMappingTemplates(
  previous: LorebookMappingTemplate[],
  next: LorebookMappingTemplate[],
): void {
  const previousById = new Map(previous.map((template) => [template.id, JSON.stringify(template)]))
  const nextIds = new Set(next.map((template) => template.id))

  const puts = next
    .filter((template) => previousById.get(template.id) !== JSON.stringify(template))
    .map((template) => ({
      entityId: template.id,
      payload: lorebookMappingTemplatePayload(template),
      schemaVersion: 1,
    }))
  const deletes = previous
    .filter((template) => !nextIds.has(template.id))
    .map((template) => ({ entityId: template.id }))

  commitThroughDomain({
    domain: 'lorebook',
    entityType: 'lorebook_mapping_template',
    puts,
    deletes,
    files: [{ path: templatesFile(), content: serializeJson(next) }],
  })
}

/** 阶段 2 S2-04 收口入口：新增/更新模板（超出上限被截断的模板按删除记账）。 */
export function upsertLorebookMappingTemplate(template: LorebookMappingTemplate): void {
  if (!isMappingTemplate(template)) throw new Error('映射模板结构不合法')
  const previous = listLorebookMappingTemplates()
  const next = [
    { ...template, updatedAt: Date.now() },
    ...previous.filter((item) => item.id !== template.id),
  ].slice(0, MAX_TEMPLATES)
  commitMappingTemplates(previous, next)
}

/** 阶段 2 S2-04 收口入口：删除模板（tombstone 与文件写同一事务提交）。 */
export function removeLorebookMappingTemplate(id: string): void {
  const previous = listLorebookMappingTemplates()
  commitMappingTemplates(previous, previous.filter((item) => item.id !== id))
}
