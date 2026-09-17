import type { IpcMain } from 'electron'
import { join } from 'node:path'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { DIRS, withFileLock, serializeJson } from '../services/storage'
import { createLogger } from '../services/logger'
import type { RegexRule } from '../../shared/types'
import { nanoid } from 'nanoid'
import { commitThroughDomain } from '../domain/syncDomainService'

const log = createLogger('regex')

function getRegexDir(): string {
  const dir = join(DIRS.config(), 'regex')
  mkdirSync(dir, { recursive: true })
  return dir
}

function getRulesPath(): string {
  return join(getRegexDir(), 'rules.json')
}

function readRules(): RegexRule[] {
  const path = getRulesPath()
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as RegexRule[]
  } catch {
    return []
  }
}

export { readRules }

/** 规则实体的规范 payload：与 S2-05 扫描器一致（全部业务字段，不含 id） */
function ruleEntityPayload(rule: RegexRule): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...rule }
  delete payload.id
  return payload
}

/**
 * 阶段 2 S2-04：rules.json 与其 journal 在同一文件事务内提交。
 * 以磁盘旧状态为基准 diff 出新增/内容变化的规则实体与被移除的实体，
 * flag 关闭时入口内部退化为与旧实现一致的原子落盘（同目录 tmp + rename）。
 */
function writeRules(rules: RegexRule[]): void {
  const path = getRulesPath()
  const previous = readRules()
  const previousPayloadById = new Map(
    previous.map((r) => [r.id, JSON.stringify(ruleEntityPayload(r))]),
  )
  const nextIds = new Set(rules.map((r) => r.id))

  const puts = rules
    .filter((r) => previousPayloadById.get(r.id) !== JSON.stringify(ruleEntityPayload(r)))
    .map((r) => ({ entityId: r.id, payload: ruleEntityPayload(r), schemaVersion: 1 }))
  const deletes = previous
    .filter((r) => !nextIds.has(r.id))
    .map((r) => ({ entityId: r.id }))

  commitThroughDomain({
    domain: 'regex_rule',
    entityType: 'regex_rule',
    puts,
    deletes,
    files: [{ path, content: serializeJson(rules) }],
  })
}

export function registerRegexIPC(ipcMain: IpcMain): void {
  // 列出所有规则
  ipcMain.handle('regex:list', async () => {
    return readRules()
  })

  // 保存规则（新增或更新）
  ipcMain.handle('regex:save', async (_e, rule: RegexRule) => {
    // M-14 修复：读-改-写加文件锁，并发 save 不再静默丢更新
    return withFileLock(getRulesPath(), () => {
      const rules = readRules()
      const idx = rules.findIndex((r) => r.id === rule.id)
      if (idx >= 0) {
        rules[idx] = rule
      } else {
        rules.push(rule)
      }
      writeRules(rules)
      log.info('规则已保存', { id: rule.id, name: rule.name })
      return rule
    })
  })

  // 删除规则
  ipcMain.handle('regex:delete', async (_e, id: string) => {
    await withFileLock(getRulesPath(), () => {
      const rules = readRules().filter((r) => r.id !== id)
      writeRules(rules)
    })
    log.info('规则已删除', { id })
  })

  // 创建新规则
  ipcMain.handle('regex:create', async (_e, name: string) => {
    const rule: RegexRule = {
      id: nanoid(),
      name: name || '新规则',
      pattern: '',
      replacement: '',
      flags: 'g',
      enabled: true,
      scope: 'both',
      group: '',
      stage: 'text',
    }
    const rules = readRules()
    rules.push(rule)
    writeRules(rules)
    log.info('规则已创建', { id: rule.id, name: rule.name })
    return rule
  })
}
