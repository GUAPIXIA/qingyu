import type { IpcMain, Dialog } from 'electron'
import { join } from 'node:path'
import { DIRS, writeJson, readJson, listJsonFiles, removeFile } from '../services/storage'
import { createLogger } from '../services/logger'
import type { Lorebook } from '../../shared/types'
import { safeId } from '../utils/pathGuard'

const log = createLogger('lorebook')

export function registerLorebookIPC(ipcMain: IpcMain, dialog: Dialog): void {
  // 列表
  ipcMain.handle('lorebook:list', async () => {
    return listJsonFiles<Lorebook>(DIRS.lorebooks())
  })

  // 保存
  ipcMain.handle('lorebook:save', async (_e, lorebook: Lorebook) => {
    safeId(lorebook.id)
    writeJson(join(DIRS.lorebooks(), `${lorebook.id}.json`), lorebook)
    log.info('世界书已保存', { id: lorebook.id, name: lorebook.name, entries: lorebook.entries.length })
  })

  // 删除
  ipcMain.handle('lorebook:delete', async (_e, id: string) => {
    safeId(id)
    removeFile(join(DIRS.lorebooks(), `${id}.json`))
    log.info('世界书已删除', { id })
  })

  // 导入
  ipcMain.handle('lorebook:importJson', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入世界书',
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const { readFileSync } = require('node:fs')
    const raw = readFileSync(result.filePaths[0], 'utf-8')
    const parsed = JSON.parse(raw)
    // 兼容 SillyTavern 世界书格式
    const lorebook: Lorebook = {
      id: parsed.id ?? require('nanoid').nanoid(),
      name: parsed.name ?? '导入的世界书',
      description: parsed.description ?? '',
      entries: (parsed.entries ?? []).map((e: any, i: number) => ({
        id: e.uid?.toString() ?? require('nanoid').nanoid(),
        keywords: Array.isArray(e.key) ? e.key : (e.key ? e.key.split(',') : []),
        content: e.content ?? '',
        position: e.position === 'before' ? 'before_char' : e.position === 'after' ? 'after_char' : 'at_end',
        order: e.order ?? i,
        probability: e.probability ?? 100,
        enabled: e.disable ? false : (e.enabled ?? true),
      })),
      enabled: true,
      scanDepth: parsed.scan_depth ?? 4,
    }
    writeJson(join(DIRS.lorebooks(), `${lorebook.id}.json`), lorebook)
    log.info('世界书已导入', { name: lorebook.name, entries: lorebook.entries.length })
    return lorebook
  })
}
