import type { IpcMain, Dialog } from 'electron'
import { readFileSync } from 'node:fs'
import { createLogger } from '../services/logger'

const log = createLogger('file')

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
    log.info('已选择图片', { path: result.filePaths[0] })
    return result.filePaths[0]
  })

  // 读取图片为 base64
  ipcMain.handle('file:readImageBase64', async (_e, filePath: string) => {
    try {
      const buffer = readFileSync(filePath)
      const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png'
      const mime = ext === 'jpg' ? 'jpeg' : ext
      const result = `data:image/${mime};base64,${buffer.toString('base64')}`
      log.info('图片已读取为 Base64', { path: filePath, size: buffer.length })
      return result
    } catch (e) {
      log.error('读取图片失败', { path: filePath, error: (e as Error).message })
      throw e
    }
  })
}
