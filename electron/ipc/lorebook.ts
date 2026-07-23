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

    // 格式校验
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('文件格式错误：不是有效的 JSON 文件')
    }

    // 校验基本结构
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('文件格式错误：JSON 顶层必须是对象')
    }

    // 兼容 SillyTavern 世界书格式
    const lorebook: Lorebook = {
      id: parsed.id ?? require('nanoid').nanoid(),
      name: parsed.name ?? '导入的世界书',
      description: parsed.description ?? '',
      entries: (Array.isArray(parsed.entries)
        ? parsed.entries
        : (typeof parsed.entries === 'object' && parsed.entries !== null ? Object.values(parsed.entries) : [])
      ).map((e: any, i: number) => {
        // 校验每个条目
        if (typeof e !== 'object' || e === null) return null
        return {
          id: e.uid?.toString() ?? require('nanoid').nanoid(),
          keywords: Array.isArray(e.key) ? e.key.filter((k: any) => typeof k === 'string') : (typeof e.key === 'string' ? e.key.split(',').map((s: string) => s.trim()).filter(Boolean) : []),
          content: typeof e.content === 'string' ? e.content : '',
          position: e.position === 0 || e.position === 'before' ? 'before_char' : e.position === 1 || e.position === 'after' ? 'after_char' : 'at_end',
          order: typeof e.order === 'number' ? e.order : i,
          probability: typeof e.probability === 'number' ? Math.max(0, Math.min(100, e.probability)) : 100,
          enabled: e.disable ? false : (typeof e.enabled === 'boolean' ? e.enabled : true),
        }
      }).filter(Boolean) as Lorebook['entries'],
      enabled: true,
      scanDepth: typeof parsed.scan_depth === 'number' ? Math.max(1, parsed.scan_depth) : 4,
    }

    if (lorebook.entries.length === 0) {
      throw new Error('世界书没有有效的条目')
    }

    writeJson(join(DIRS.lorebooks(), `${lorebook.id}.json`), lorebook)
    log.info('世界书已导入', { name: lorebook.name, entries: lorebook.entries.length })
    return lorebook
  })
}
