import type { IpcMain, Dialog } from 'electron'
import { join } from 'node:path'
import { DIRS, writeJson, readJson, getDefaultSettings } from '../services/storage'
import { saveCredential, getCredential } from '../services/safeStorage'
import { createLogger } from '../services/logger'
import type { Settings } from '../../shared/types'

const log = createLogger('settings')

const SETTINGS_FILE = () => join(DIRS.config(), 'settings.json')

export function registerSettingsIPC(ipcMain: IpcMain, dialog: Dialog): void {
  // 读取设置
  ipcMain.handle('settings:get', async () => {
    return readJson<Settings>(SETTINGS_FILE()) ?? getDefaultSettings()
  })

  // 保存设置
  ipcMain.handle('settings:save', async (_e, settings: Settings) => {
    writeJson(SETTINGS_FILE(), settings)
    log.info('设置已保存', { activeProfileId: settings.activeProfileId || '(none)', theme: settings.theme })
  })

  // 保存凭据（加密）
  ipcMain.handle('settings:saveCredential', async (_e, provider: string, key: string) => {
    saveCredential(provider, key)
    log.info('凭据已保存', { provider })
  })

  // 读取凭据
  ipcMain.handle('settings:getCredential', async (_e, provider: string) => {
    return getCredential(provider)
  })

  // 导出备份
  ipcMain.handle('settings:exportBackup', async () => {
    const result = await dialog.showSaveDialog({
      title: '导出备份',
      defaultPath: `qingyu-backup-${Date.now()}.json`,
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return

    const { readFileSync, readdirSync, existsSync } = require('node:fs')
    const backup: Record<string, unknown> = { version: 1, timestamp: Date.now() }

    // 备份设置
    backup.settings = readJson(SETTINGS_FILE())

    // 备份角色
    const charDir = DIRS.characters()
    if (existsSync(charDir)) {
      backup.characters = readdirSync(charDir)
        .filter((f: string) => f.endsWith('.json'))
        .map((f: string) => readJson(join(charDir, f)))
    }

    // 备份世界书
    const loreDir = DIRS.lorebooks()
    if (existsSync(loreDir)) {
      backup.lorebooks = readdirSync(loreDir)
        .filter((f: string) => f.endsWith('.json'))
        .map((f: string) => readJson(join(loreDir, f)))
    }

    // 备份预设
    const presetDir = DIRS.presets()
    if (existsSync(presetDir)) {
      backup.presets = readdirSync(presetDir)
        .filter((f: string) => f.endsWith('.json'))
        .map((f: string) => readJson(join(presetDir, f)))
    }

    const { writeFileSync } = require('node:fs')
    writeFileSync(result.filePath, JSON.stringify(backup, null, 2), 'utf-8')
    log.info('备份已导出', { path: result.filePath, chars: (backup.characters as any[])?.length ?? 0, lorebooks: (backup.lorebooks as any[])?.length ?? 0 })
  })

  // 导入备份
  ipcMain.handle('settings:importBackup', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入备份',
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return

    const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
    const backup = JSON.parse(readFileSync(result.filePaths[0], 'utf-8'))

    if (backup.settings) {
      writeJson(SETTINGS_FILE(), backup.settings)
    }
    if (backup.characters) {
      mkdirSync(DIRS.characters(), { recursive: true })
      for (const char of backup.characters) {
        writeJson(join(DIRS.characters(), `${char.id}.json`), char)
      }
    }
    if (backup.lorebooks) {
      mkdirSync(DIRS.lorebooks(), { recursive: true })
      for (const lore of backup.lorebooks) {
        writeJson(join(DIRS.lorebooks(), `${lore.id}.json`), lore)
      }
    }
    if (backup.presets) {
      mkdirSync(DIRS.presets(), { recursive: true })
      for (const preset of backup.presets) {
        writeJson(join(DIRS.presets(), `${preset.id}.json`), preset)
      }
    }
    log.info('备份已导入', { chars: backup.characters?.length ?? 0, lorebooks: backup.lorebooks?.length ?? 0, presets: backup.presets?.length ?? 0 })
  })
}
