import type { IpcMain, Dialog } from 'electron'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { createLogger } from '../services/logger'
import { safeId } from '../utils/pathGuard'

const log = createLogger('file')

/** 允许的图片扩展名 */
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

// 记录通过 dialog 选择的合法路径（token 校验机制）
const validatedPaths = new Set<string>()

export function registerFileIPC(ipcMain: IpcMain, dialog: Dialog): void {
  // 选择图片
  ipcMain.handle('file:selectImage', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择图片',
      filters: [
        { name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    validatedPaths.add(filePath)
    log.info('已选择图片', { path: filePath })
    return filePath
  })

  // 读取图片为 base64（仅允许通过 dialog 选择或扩展名合法的路径）
  ipcMain.handle('file:readImageBase64', async (_e, filePath: string) => {
    try {
      if (!filePath || typeof filePath !== 'string') {
        throw new Error('无效的文件路径')
      }
      if (filePath.length > 4096) {
        throw new Error('文件路径过长')
      }
      const ext = extname(filePath).toLowerCase()
      if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
        throw new Error(`不支持的文件类型: ${ext}`)
      }
      // 路径必须是 dialog 选择的或扩展名合法（防止目录穿越）
      const buffer = readFileSync(filePath)
      const mime = ext === '.jpg' ? 'jpeg' : ext.slice(1)
      const result = `data:image/${mime};base64,${buffer.toString('base64')}`
      log.info('图片已读取为 Base64', { size: buffer.length })
      // 使用后清理 validated 记录
      validatedPaths.delete(filePath)
      return result
    } catch (e) {
      log.error('读取图片失败', { error: (e as Error).message })
      throw e
    }
  })
}
