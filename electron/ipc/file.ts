import type { IpcMain, Dialog } from 'electron'
import { readFileSync } from 'node:fs'

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
    return result.filePaths[0]
  })

  // 读取图片为 base64
  ipcMain.handle('file:readImageBase64', async (_e, filePath: string) => {
    const buffer = readFileSync(filePath)
    const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png'
    const mime = ext === 'jpg' ? 'jpeg' : ext
    return `data:image/${mime};base64,${buffer.toString('base64')}`
  })
}
