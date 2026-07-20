import type { IpcMain } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { DIRS } from '../services/storage'
import type { RegexRule } from '../../shared/types'
import { nanoid } from 'nanoid'

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

function writeRules(rules: RegexRule[]): void {
  writeFileSync(getRulesPath(), JSON.stringify(rules, null, 2), 'utf-8')
}

export function registerRegexIPC(ipcMain: IpcMain): void {
  // 列出所有规则
  ipcMain.handle('regex:list', async () => {
    return readRules()
  })

  // 保存规则（新增或更新）
  ipcMain.handle('regex:save', async (_e, rule: RegexRule) => {
    const rules = readRules()
    const idx = rules.findIndex((r) => r.id === rule.id)
    if (idx >= 0) {
      rules[idx] = rule
    } else {
      rules.push(rule)
    }
    writeRules(rules)
    return rule
  })

  // 删除规则
  ipcMain.handle('regex:delete', async (_e, id: string) => {
    const rules = readRules().filter((r) => r.id !== id)
    writeRules(rules)
  })

  // 创建新规则
  ipcMain.handle('regex:create', async (_e, name: string) => {
    const rule: RegexRule = {
      id: nanoid(),
      name: name || '新规则',
      pattern: '',
      replacement: '',
      enabled: true,
      scope: 'both',
    }
    const rules = readRules()
    rules.push(rule)
    writeRules(rules)
    return rule
  })
}
