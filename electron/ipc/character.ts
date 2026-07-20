import type { IpcMain, Dialog } from 'electron'
import { join } from 'node:path'
import { DIRS, writeJson, readJson, removeFile, listJsonFiles } from '../services/storage'
import {
  importCharacterFromPng,
  importCharacterFromJson,
  exportCharacterToPng,
  exportCharacterToJson,
  saveCharacter,
  listCharacters,
  getCharacter,
  deleteCharacter,
} from '../services/charCard'
import type { Character } from '../../shared/types'

export function registerCharacterIPC(ipcMain: IpcMain, dialog: Dialog): void {
  // 列表
  ipcMain.handle('character:list', async () => {
    return listCharacters()
  })

  // 读取
  ipcMain.handle('character:get', async (_e, id: string) => {
    return getCharacter(id)
  })

  // 保存
  ipcMain.handle('character:save', async (_e, character: Character) => {
    character.updatedAt = Date.now()
    saveCharacter(character)
  })

  // 删除
  ipcMain.handle('character:delete', async (_e, id: string) => {
    deleteCharacter(id)
  })

  // 导入 PNG
  ipcMain.handle('character:importPng', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: '导入角色卡 (PNG)',
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
        properties: ['openFile'],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }
      const character = await importCharacterFromPng(result.filePaths[0])
      saveCharacter(character)
      character.avatar = ''
      return { success: true, character }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  // 导入 JSON
  ipcMain.handle('character:importJson', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: '导入角色卡 (JSON)',
        filters: [{ name: 'JSON 文件', extensions: ['json'] }],
        properties: ['openFile'],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }
      const character = await importCharacterFromJson(result.filePaths[0])
      saveCharacter(character)
      const needAvatar = !character.avatar
      character.avatar = ''
      return { success: true, character, needAvatar }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  // 导出 PNG
  ipcMain.handle('character:exportPng', async (_e, id: string) => {
    const character = getCharacter(id)
    if (!character) throw new Error('角色不存在')
    const result = await dialog.showSaveDialog({
      title: '导出角色卡',
      defaultPath: `${character.name}.png`,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    })
    if (result.canceled || !result.filePath) return
    exportCharacterToPng(character, result.filePath)
  })

  // 导出 JSON
  ipcMain.handle('character:exportJson', async (_e, id: string) => {
    const character = getCharacter(id)
    if (!character) throw new Error('角色不存在')
    const result = await dialog.showSaveDialog({
      title: '导出角色卡',
      defaultPath: `${character.name}.json`,
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return
    exportCharacterToJson(character, result.filePath)
  })

  // 批量导入
  ipcMain.handle('character:importBatch', async () => {
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

      const batchResults: { name: string; success: boolean; error?: string; needAvatar?: boolean }[] = []
      let successCount = 0
      let failCount = 0

      for (const filePath of result.filePaths) {
        try {
          const ext = filePath.split('.').pop()?.toLowerCase()
          let character: Character

          if (ext === 'png') {
            character = await importCharacterFromPng(filePath)
          } else if (ext === 'json') {
            character = await importCharacterFromJson(filePath)
          } else {
            batchResults.push({ name: filePath.split(/[\\/]/).pop() || filePath, success: false, error: '不支持的文件格式' })
            failCount++
            continue
          }

          saveCharacter(character)
          const needAvatar = !character.avatar
          character.avatar = ''
          batchResults.push({ name: character.name, success: true, needAvatar })
          successCount++
        } catch (e) {
          const fileName = filePath.split(/[\\/]/).pop() || filePath
          batchResults.push({ name: fileName, success: false, error: (e as Error).message })
          failCount++
        }
      }

      return {
        success: true,
        results: batchResults,
        total: batchResults.length,
        successCount,
        failCount,
      }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })
}
