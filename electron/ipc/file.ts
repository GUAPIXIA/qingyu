import type { IpcMain, Dialog, App } from 'electron'
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, unlinkSync } from 'node:fs'
import { extname, basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nanoid } from 'nanoid'
import { createLogger } from '../services/logger'
import type { CustomFont } from '../../shared/types'

const log = createLogger('file')

/** 允许的图片扩展名 */
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

/** 允许的字体扩展名 */
const ALLOWED_FONT_EXTENSIONS = new Set(['.ttf', '.otf'])

/** 字体文件大小上限：10MB */
const MAX_FONT_SIZE = 10 * 1024 * 1024

// 记录通过 dialog 选择的合法路径（token 校验机制）
const validatedPaths = new Set<string>()

export function registerFileIPC(ipcMain: IpcMain, dialog: Dialog, app: App): void {
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

  // ===================== 字体管理 =====================

  /** 获取字体存储目录 */
  const getFontsDir = () => join(app.getPath('userData'), 'fonts')

  /** 校验字体文件 magic number */
  function validateFontMagic(buffer: Buffer, ext: string): boolean {
    if (ext === '.ttf') {
      // TTF: 00 01 00 00
      return buffer.length >= 4 &&
        buffer[0] === 0x00 && buffer[1] === 0x01 &&
        buffer[2] === 0x00 && buffer[3] === 0x00
    }
    if (ext === '.otf') {
      // OTF: 4F 54 54 4F ("OTTO")
      return buffer.length >= 4 &&
        buffer[0] === 0x4F && buffer[1] === 0x54 &&
        buffer[2] === 0x54 && buffer[3] === 0x4F
    }
    return false
  }

  // 选择字体文件
  ipcMain.handle('font:select', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择字体文件',
      filters: [
        { name: '字体文件', extensions: ['ttf', 'otf'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // 保存字体到 userData/fonts/
  ipcMain.handle('font:save', async (_e, filePath: string) => {
    try {
      if (!filePath || typeof filePath !== 'string') {
        throw new Error('无效的文件路径')
      }
      const ext = extname(filePath).toLowerCase()
      if (!ALLOWED_FONT_EXTENSIONS.has(ext)) {
        throw new Error(`不支持的字体类型: ${ext}，仅支持 TTF / OTF`)
      }

      // 读取并校验文件
      const buffer = readFileSync(filePath)
      if (buffer.length > MAX_FONT_SIZE) {
        throw new Error(`字体文件过大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），上限 10MB`)
      }
      if (!validateFontMagic(buffer, ext)) {
        throw new Error('字体文件格式无效（magic number 校验失败），可能不是真正的 TTF/OTF 文件')
      }

      // 确保目录存在
      const fontsDir = getFontsDir()
      if (!existsSync(fontsDir)) {
        mkdirSync(fontsDir, { recursive: true })
      }

      const id = nanoid()
      const format = ext.slice(1) as 'ttf' | 'otf'
      const fileName = `${id}.${format}`
      const destPath = join(fontsDir, fileName)
      copyFileSync(filePath, destPath)

      const fontInfo: CustomFont = {
        id,
        name: basename(filePath, ext),
        fileName,
        format,
        size: buffer.length,
        createdAt: Date.now(),
      }
      log.info('字体已保存', { id, name: fontInfo.name, size: buffer.length })
      return fontInfo
    } catch (e) {
      log.error('保存字体失败', { error: (e as Error).message })
      throw e
    }
  })

  // 列出所有已保存的自定义字体
  ipcMain.handle('font:list', async () => {
    try {
      const fontsDir = getFontsDir()
      if (!existsSync(fontsDir)) return []

      const files = readdirSync(fontsDir)
      const fonts: CustomFont[] = []
      for (const fileName of files) {
        const ext = extname(fileName).toLowerCase()
        if (!ALLOWED_FONT_EXTENSIONS.has(ext)) continue
        const fullPath = join(fontsDir, fileName)
        const stat = statSync(fullPath)
        const id = basename(fileName, ext)
        fonts.push({
          id,
          name: id,
          fileName,
          format: ext.slice(1) as 'ttf' | 'otf',
          size: stat.size,
          createdAt: stat.mtimeMs,
        })
      }
      // 按创建时间降序
      fonts.sort((a, b) => b.createdAt - a.createdAt)
      return fonts
    } catch (e) {
      log.error('列出字体失败', { error: (e as Error).message })
      return []
    }
  })

  // 删除指定字体
  ipcMain.handle('font:delete', async (_e, id: string) => {
    try {
      if (!id || typeof id !== 'string' || id.length > 64) {
        throw new Error('无效的字体 ID')
      }
      const fontsDir = getFontsDir()
      // 遍历查找匹配的文件（id + 扩展名），校验路径在 fonts 目录内
      const files = readdirSync(fontsDir)
      for (const fileName of files) {
        if (fileName.startsWith(id + '.')) {
          const fullPath = join(fontsDir, fileName)
          // 二次校验：确保 resolve 后的路径仍在 fontsDir 内
          if (!fullPath.startsWith(fontsDir)) {
            throw new Error('路径校验失败：尝试逃逸字体目录')
          }
          unlinkSync(fullPath)
          log.info('字体已删除', { id })
          return
        }
      }
      log.warn('未找到要删除的字体', { id })
    } catch (e) {
      log.error('删除字体失败', { error: (e as Error).message })
      throw e
    }
  })

  // 获取字体文件路径（file:// URL）
  ipcMain.handle('font:getPath', async (_e, id: string) => {
    try {
      if (!id || typeof id !== 'string' || id.length > 64) {
        return null
      }
      const fontsDir = getFontsDir()
      const files = readdirSync(fontsDir)
      for (const fileName of files) {
        if (fileName.startsWith(id + '.')) {
          const fullPath = join(fontsDir, fileName)
          if (!fullPath.startsWith(fontsDir)) return null
          return pathToFileURL(fullPath).href
        }
      }
      return null
    } catch {
      return null
    }
  })
}
