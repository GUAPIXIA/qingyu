import type { IpcMain, Dialog } from 'electron'
import { join } from 'node:path'
import { createLogger } from '../services/logger'
import { safeSend } from '../utils/safeSend'
import {
  importCharacterFromPng,
  importCharacterFromJson,
  importCardFrontendExtensions,
  exportCharacterToPng,
  exportCharacterToJson,
  saveCharacter,
  listCharacters,
  getCharacter,
  deleteCharacter,
  reloadAvatarFromUrl,
} from '../services/charCard'
import type { Character, Settings } from '../../shared/types'
import { safeId } from '../utils/pathGuard'
import { DIRS, readJson } from '../services/storage'

const log = createLogger('character')

/** 并发池大小 */
const CONCURRENCY_LIMIT = 3

/** 读取当前设置中的封面代理 URL */
function getCoverProxyUrl(): string | undefined {
  try {
    const settings = readJson<Settings>(join(DIRS.config(), 'settings.json'))
    return settings?.coverProxyUrl || undefined
  } catch {
    return undefined
  }
}

export function registerCharacterIPC(ipcMain: IpcMain, dialog: Dialog): void {
  // 列表
  ipcMain.handle('character:list', async () => {
    return await listCharacters()
  })

  // 读取
  ipcMain.handle('character:get', async (_e, id: string) => {
    safeId(id)
    return getCharacter(id)
  })

  // 保存
  ipcMain.handle('character:save', async (_e, character: Character) => {
    safeId(character.id)
    character.updatedAt = Date.now()
    // NEW-M4：持锁保存
    await withCharacterLock(character.id, () => {
      saveCharacter(character)
    })
    log.info('角色已保存', { id: character.id, name: character.name })
  })

  // 删除
  ipcMain.handle('character:delete', async (_e, id: string) => {
    safeId(id)
    // NEW-M4：持锁删除
    await withCharacterLock(id, () => {
      deleteCharacter(id)
    })
    log.info('角色已删除', { id })
  })

  // 导入 PNG
  ipcMain.handle('character:importPng', async (event) => {
    try {
      const result = await dialog.showOpenDialog({
        title: '导入角色卡 (PNG)',
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
        properties: ['openFile'],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }
      const filePath = result.filePaths[0]
      const fileName = filePath.split(/[\\/]/).pop() || filePath

      safeSend(event.sender,'character:importProgress', {
        current: 1, total: 1, fileName, status: 'processing' as const,
      })

      const proxyUrl = getCoverProxyUrl()
      const character = await importCharacterFromPng(filePath, proxyUrl)
      await withCharacterLock(character.id, () => {
        saveCharacter(character)
      })
      // 角色卡前端扩展落地（正则脚本 / 快捷回复）
      const cardExtras = importCardFrontendExtensions(character)

      safeSend(event.sender,'character:importProgress', {
        current: 1, total: 1, fileName: character.name, status: 'done' as const,
      })

      log.info('角色已导入 (PNG)', { id: character.id, name: character.name })
      return { success: true, character, cardExtras }
    } catch (e) {
      log.error('导入角色 PNG 失败', { error: (e as Error).message })
      return { success: false, error: (e as Error).message }
    }
  })

  // 导入 JSON
  ipcMain.handle('character:importJson', async (event) => {
    try {
      const result = await dialog.showOpenDialog({
        title: '导入角色卡 (JSON)',
        filters: [{ name: 'JSON 文件', extensions: ['json'] }],
        properties: ['openFile'],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }
      const filePath = result.filePaths[0]
      const fileName = filePath.split(/[\\/]/).pop() || filePath

      safeSend(event.sender,'character:importProgress', {
        current: 1, total: 1, fileName, status: 'processing' as const,
      })

      const proxyUrl = getCoverProxyUrl()
      const character = await importCharacterFromJson(filePath, proxyUrl)
      await withCharacterLock(character.id, () => {
        saveCharacter(character)
      })
      // 角色卡前端扩展落地（正则脚本 / 快捷回复）
      const cardExtras = importCardFrontendExtensions(character)
      const needAvatar = !character.avatar

      safeSend(event.sender,'character:importProgress', {
        current: 1, total: 1, fileName: character.name, status: 'done' as const,
      })

      log.info('角色已导入 (JSON)', { id: character.id, name: character.name })
      return { success: true, character, needAvatar, cardExtras }
    } catch (e) {
      log.error('导入角色 JSON 失败', { error: (e as Error).message })
      return { success: false, error: (e as Error).message }
    }
  })

  // 导出 PNG
  ipcMain.handle('character:exportPng', async (_e, id: string) => {
    safeId(id)
    const character = getCharacter(id)
    if (!character) throw new Error('角色不存在')
    const result = await dialog.showSaveDialog({
      title: '导出角色卡',
      defaultPath: `${character.name}.png`,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    })
    if (result.canceled || !result.filePath) return
    exportCharacterToPng(character, result.filePath)
    log.info('角色已导出 (PNG)', { id, name: character.name, path: result.filePath })
  })

  // 导出 JSON
  ipcMain.handle('character:exportJson', async (_e, id: string) => {
    safeId(id)
    const character = getCharacter(id)
    if (!character) throw new Error('角色不存在')
    const result = await dialog.showSaveDialog({
      title: '导出角色卡',
      defaultPath: `${character.name}.json`,
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return
    exportCharacterToJson(character, result.filePath)
    log.info('角色已导出 (JSON)', { id, name: character.name, path: result.filePath })
  })

  // 批量导入
  ipcMain.handle('character:importBatch', async (event) => {
    try {
      const result = await dialog.showOpenDialog({
        title: '批量导入角色卡',
        filters: [
          { name: '角色卡文件', extensions: ['png', 'json'] },
        ],
        properties: ['openFile', 'multiSelections'],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }

      const total = result.filePaths.length
      const batchResults: { name: string; success: boolean; error?: string; needAvatar?: boolean }[] = []
      let successCount = 0
      let failCount = 0

      const proxyUrl = getCoverProxyUrl()
      const filePaths = result.filePaths

      // ===== 阶段1: 并行解析所有文件 =====
      interface ParsedFile {
        filePath: string
        fileName: string
        character: Character
      }
      const parseResults: (ParsedFile | { filePath: string; fileName: string; error: string })[] = await Promise.all(
        filePaths.map(async (filePath) => {
          const fileName = filePath.split(/[\\/]/).pop() || filePath
          try {
            const ext = filePath.split('.').pop()?.toLowerCase()
            let character: Character
            if (ext === 'png') {
              character = await importCharacterFromPng(filePath, proxyUrl)
            } else if (ext === 'json') {
              character = await importCharacterFromJson(filePath, proxyUrl)
            } else {
              return { filePath, fileName, error: '不支持的文件格式' }
            }
            return { filePath, fileName, character }
          } catch (e) {
            return { filePath, fileName, error: (e as Error).message }
          }
        }),
      )

      // 分离成功/失败
      const toImport: ParsedFile[] = []
      const failedParses: { name: string; success: boolean; error: string }[] = []

      for (const r of parseResults) {
        if ('error' in r) {
          safeSend(event.sender, 'character:importProgress', {
            current: batchResults.length + failedParses.length + 1, total, fileName: r.fileName, status: 'error' as const,
          })
          failedParses.push({ name: r.fileName, success: false, error: r.error })
          failCount++
        } else {
          toImport.push(r)
        }
      }

      // ===== 阶段2: 并发保存（有网卡下载的已在上一步完成） =====
      let completedCount = batchResults.length + failedParses.length

      // 并发池
      async function runWithPool(items: ParsedFile[], limit: number, fn: (item: ParsedFile) => Promise<{ name: string; success: boolean; needAvatar?: boolean }>) {
        const results: { name: string; success: boolean; needAvatar?: boolean }[] = []
        let cursor = 0

        async function worker() {
          while (cursor < items.length) {
            const idx = cursor++
            const item = items[idx]
            const r = await fn(item)
            completedCount++
            const status = r.success ? 'done' as const : 'error' as const
            try {
              safeSend(event.sender, 'character:importProgress', {
                current: completedCount, total, fileName: r.name, status,
              })
            } catch {
              // renderer 可能已销毁
            }
            results.push(r)
          }
        }

        const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
        await Promise.all(workers)
        return results
      }

      const saveResults = await runWithPool(toImport, CONCURRENCY_LIMIT, async ({ character, fileName }) => {
        try {
          await withCharacterLock(character.id, () => {
            saveCharacter(character)
          })
          // 角色卡前端扩展落地（正则脚本 / 快捷回复）
          importCardFrontendExtensions(character)
          const needAvatar = !character.avatar
          return { name: character.name, success: true, needAvatar }
        } catch (e) {
          log.error('批量导入保存失败', { fileName, error: (e as Error).message })
          return { name: fileName, success: false, error: (e as Error).message }
        }
      })

      for (const r of saveResults) {
        if (r.success) successCount++
        else failCount++
      }
      batchResults.push(...failedParses, ...saveResults)

      log.info('批量导入完成', { total, successCount, failCount })
      return {
        success: true,
        results: batchResults,
        total,
        successCount,
        failCount,
      }
    } catch (e) {
      log.error('批量导入失败', { error: (e as Error).message })
      return { success: false, error: (e as Error).message }
    }
  })

  // 重新加载封面
  ipcMain.handle('character:reloadAvatar', async (_event, characterId: string, url: string) => {
    safeId(characterId)
    log.info('重新加载封面', { characterId, url })
    const proxyUrl = getCoverProxyUrl()
    const result = await reloadAvatarFromUrl(characterId, url, proxyUrl)
    if (!result.success) {
      log.warn('封面加载失败', { characterId, error: result.error, code: result.code })
    }
    return result
  })
}
