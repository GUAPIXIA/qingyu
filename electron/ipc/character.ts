import type { IpcMain, Dialog } from 'electron'
import { join } from 'node:path'
import { DIRS, writeJson, readJson, removeFile, listJsonFiles } from '../services/storage'
import { createLogger } from '../services/logger'
import { safeSend } from '../utils/safeSend'
import {
  importCharacterFromPng,
  importCharacterFromJson,
  exportCharacterToPng,
  exportCharacterToJson,
  saveCharacter,
  listCharacters,
  getCharacter,
  deleteCharacter,
  reloadAvatarFromUrl,
} from '../services/charCard'
import type { Character } from '../../shared/types'
import { safeId } from '../utils/pathGuard'

const log = createLogger('character')

export function registerCharacterIPC(ipcMain: IpcMain, dialog: Dialog): void {
  // 列表
  ipcMain.handle('character:list', async () => {
    return listCharacters()
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
    saveCharacter(character)
    log.info('角色已保存', { id: character.id, name: character.name })
  })

  // 删除
  ipcMain.handle('character:delete', async (_e, id: string) => {
    safeId(id)
    deleteCharacter(id)
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

      const character = await importCharacterFromPng(filePath)
      saveCharacter(character)

      safeSend(event.sender,'character:importProgress', {
        current: 1, total: 1, fileName: character.name, status: 'done' as const,
      })

      log.info('角色已导入 (PNG)', { id: character.id, name: character.name })
      return { success: true, character }
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

      const character = await importCharacterFromJson(filePath)
      saveCharacter(character)
      const needAvatar = !character.avatar

      safeSend(event.sender,'character:importProgress', {
        current: 1, total: 1, fileName: character.name, status: 'done' as const,
      })

      log.info('角色已导入 (JSON)', { id: character.id, name: character.name })
      return { success: true, character, needAvatar }
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

      for (let i = 0; i < result.filePaths.length; i++) {
        const filePath = result.filePaths[i]
        const fileName = filePath.split(/[\\/]/).pop() || filePath

        // 发送进度事件
        safeSend(event.sender,'character:importProgress', {
          current: i + 1,
          total,
          fileName,
          status: 'processing' as const,
        })

        try {
          const ext = filePath.split('.').pop()?.toLowerCase()
          let character: Character

          if (ext === 'png') {
            character = await importCharacterFromPng(filePath)
          } else if (ext === 'json') {
            character = await importCharacterFromJson(filePath)
          } else {
            safeSend(event.sender,'character:importProgress', {
              current: i + 1, total, fileName, status: 'error' as const,
            })
            batchResults.push({ name: fileName, success: false, error: '不支持的文件格式' })
            failCount++
            continue
          }

          saveCharacter(character)
          const needAvatar = !character.avatar
          safeSend(event.sender,'character:importProgress', {
            current: i + 1, total, fileName: character.name, status: 'done' as const,
          })
          batchResults.push({ name: character.name, success: true, needAvatar })
          successCount++
        } catch (e) {
          safeSend(event.sender,'character:importProgress', {
            current: i + 1, total, fileName, status: 'error' as const,
          })
          batchResults.push({ name: fileName, success: false, error: (e as Error).message })
          failCount++
        }
      }

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
    const result = await reloadAvatarFromUrl(characterId, url)
    if (!result.success) {
      log.warn('封面加载失败', { characterId, error: result.error, code: result.code })
    }
    return result
  })
}
