import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS, writeJson, readJson } from './storage'
import type { Character, Lorebook, LoreEntry } from '../../shared/types'
import { createLogger } from './logger'
import { nanoid } from 'nanoid'

const log = createLogger('charCard')

/** PNG 签名 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 检测图片类型并返回正确的 MIME */
function detectMimeType(buffer: Buffer): string {
  // PNG
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'image/png'
  }
  // JPEG: FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  // GIF: 47 49 46 38
  if (buffer.length >= 6 && buffer.subarray(0, 4).toString('ascii') === 'GIF8') {
    return 'image/gif'
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  return 'image/png' // 默认
}

/** PNG tEXt chunk 读取 */
function readPngTextChunks(buffer: Buffer): Record<string, string> {
  const chunks: Record<string, string> = {}
  // PNG 签名校验：必须用 Buffer.equals，不能用 toString('ascii')
  // 因为 toString('ascii') 会把 0x89 截断为 0x09，导致签名永远不匹配
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return chunks
  }
  let offset = 8
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const data = buffer.subarray(dataStart, dataStart + length)
    if (type === 'tEXt') {
      const nullIdx = data.indexOf(0)
      if (nullIdx > 0) {
        const key = data.toString('ascii', 0, nullIdx)
        const value = data.toString('utf-8', nullIdx + 1)
        chunks[key] = value
      }
    } else if (type === 'iTXt') {
      // iTXt 格式: keyword\0  compression_flag(1)  compression_method(1)  language\0  translated\0  text
      const nullIdx = data.indexOf(0)
      if (nullIdx > 0) {
        const key = data.toString('ascii', 0, nullIdx)
        // 跳过 compression_flag(1) + compression_method(1)
        let pos = nullIdx + 3
        const langEnd = data.indexOf(0, pos)
        if (langEnd < 0) continue
        pos = langEnd + 1
        const transEnd = data.indexOf(0, pos)
        if (transEnd < 0) continue
        const textStart = transEnd + 1
        if (textStart < data.length) {
          const value = data.toString('utf-8', textStart)
          chunks[key] = value
        }
      }
    } else if (type === 'IEND') {
      break
    }
    offset = dataStart + length + 4
  }
  return chunks
}

/** 向 PNG 写入 tEXt chunk */
function writePngTextChunk(buffer: Buffer, key: string, value: string): Buffer {
  const keyBytes = Buffer.from(key, 'ascii')
  const valueBytes = Buffer.from(value, 'utf-8')
  const nullByte = Buffer.from([0])
  const chunkData = Buffer.concat([keyBytes, nullByte, valueBytes])
  const typeBytes = Buffer.from('tEXt', 'ascii')
  const lengthBytes = Buffer.alloc(4)
  lengthBytes.writeUInt32BE(chunkData.length, 0)

  const crcData = Buffer.concat([typeBytes, chunkData])
  const crc = crc32(crcData)
  const crcBytes = Buffer.alloc(4)
  crcBytes.writeUInt32BE(crc >>> 0, 0)

  const iendOffset = findIENDOffset(buffer)
  if (iendOffset < 0) return buffer
  const before = buffer.subarray(0, iendOffset)
  const after = buffer.subarray(iendOffset)
  return Buffer.concat([before, lengthBytes, typeBytes, chunkData, crcBytes, after])
}

function findIENDOffset(buffer: Buffer): number {
  for (let i = buffer.length - 12; i >= 8; i--) {
    if (buffer.toString('ascii', i + 4, i + 8) === 'IEND') {
      return i
    }
  }
  return -1
}

const crcTable: number[] = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  crcTable[n] = c
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return crc ^ 0xffffffff
}

/** 从 PNG 文件导入角色卡 */
export async function importCharacterFromPng(filePath: string): Promise<Character> {
  const buffer = readFileSync(filePath)
  const chunks = readPngTextChunks(buffer)
  // 优先读取 v2 的 chara 字段，fallback 到 v3 的 ccv3 字段
  const charaBase64 = chunks['chara'] || chunks['ccv3']
  if (!charaBase64) {
    throw new Error('该 PNG 文件不包含角色卡数据（未找到 chara 或 ccv3 字段）')
  }

  let charaJson: string
  try {
    charaJson = Buffer.from(charaBase64, 'base64').toString('utf-8')
  } catch {
    throw new Error('角色卡 base64 解码失败')
  }

  const parsed = JSON.parse(charaJson)
  // 头像直接用 PNG 文件的 base64
  const avatarBase64 = `data:image/png;base64,${buffer.toString('base64')}`
  const character = await normalizeCharacter(parsed, avatarBase64)
  log.info('PNG 角色卡导入成功', { name: character.name, path: filePath.substring(0, 80) })
  return character
}

/** 从 JSON 文件导入角色卡 */
export async function importCharacterFromJson(filePath: string): Promise<Character> {
  const raw = readFileSync(filePath, 'utf-8')
  const parsed = JSON.parse(raw)
  const character = await normalizeCharacter(parsed)
  log.info('JSON 角色卡导入成功', { name: character.name, path: filePath.substring(0, 80), hasAvatar: !!character.avatar })
  return character
}

/** 图片下载错误码 */
export type ImageDownloadCode = 'TIMEOUT' | 'HTTP_ERROR' | 'NETWORK_ERROR' | 'INVALID_URL' | 'INVALID_FORMAT' | 'UNKNOWN'

/** 图片下载结果 */
export interface DownloadResult {
  success: boolean
  data?: string
  error?: string
  code?: ImageDownloadCode
  statusCode?: number
}

/** 下载超时时间（毫秒）- 大图片（如 2MB+）需要足够时间 */
const DOWNLOAD_TIMEOUT_MS = 30000

/** 下载图片并转为 base64 data URL */
async function downloadImageAsBase64(url: string, maxRedirects: number = 5): Promise<DownloadResult> {
  // 前置 URL 校验
  if (!url || typeof url !== 'string') {
    log.warn('封面 URL 无效', { url: String(url) })
    return { success: false, error: '无效的图片 URL', code: 'INVALID_URL' }
  }
  const trimmed = url.trim()
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    log.warn('封面 URL 协议不支持', { url: trimmed.substring(0, 100) })
    return { success: false, error: 'URL 必须以 http:// 或 https:// 开头', code: 'INVALID_URL' }
  }

  // 防止无限重定向
  if (maxRedirects <= 0) {
    log.warn('封面下载重定向次数超出限制', { url: trimmed.substring(0, 100) })
    return { success: false, error: '重定向次数过多，下载失败', code: 'NETWORK_ERROR' }
  }

  return new Promise((resolve) => {
    // settled 标志：确保 Promise 只 resolve 一次，避免超时后后台请求仍触发 resolve/log
    let settled = false
    // 保存请求引用，超时时可主动取消
    let req: any = null

    const safeResolve = (result: DownloadResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }

    const timeout = setTimeout(() => {
      log.warn('封面下载超时', { url: trimmed.substring(0, 100), timeoutMs: DOWNLOAD_TIMEOUT_MS })
      // 主动取消正在进行的请求，避免超时后后台请求仍完成并记录误导性日志
      if (req) {
        try { req.destroy() } catch { /* ignore */ }
      }
      safeResolve({ success: false, error: '下载超时，请检查网络连接', code: 'TIMEOUT' })
    }, DOWNLOAD_TIMEOUT_MS)

    try {
      const getter = trimmed.startsWith('https') ? require('node:https') : require('node:http')
      req = getter.get(trimmed, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
        },
        timeout: DOWNLOAD_TIMEOUT_MS,
      }, (res: any) => {
        // 处理重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          log.debug('封面下载重定向', { from: trimmed.substring(0, 80), statusCode: res.statusCode })
          // 递归跟随重定向
          downloadImageAsBase64(res.headers.location, maxRedirects - 1).then(safeResolve)
          return
        }
        if (res.statusCode !== 200) {
          // 读取响应体开头以便诊断（如 CDN 返回 HTML 错误页）
          const errorChunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => { if (errorChunks.length < 1) errorChunks.push(chunk) })
          res.on('end', () => {
            const preview = errorChunks.length > 0
              ? errorChunks[0].subarray(0, 500).toString('utf-8').replace(/\s+/g, ' ').trim()
              : '(空响应)'
            log.warn('封面下载 HTTP 错误', { url: trimmed.substring(0, 100), statusCode: res.statusCode, bodyPreview: preview })
            safeResolve({
              success: false,
              error: `服务器返回 HTTP ${res.statusCode}`,
              code: 'HTTP_ERROR',
              statusCode: res.statusCode,
            })
          })
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const buffer = Buffer.concat(chunks)
          if (buffer.length === 0) {
            log.warn('封面下载返回空数据', { url: trimmed.substring(0, 100) })
            safeResolve({ success: false, error: '下载的图片数据为空', code: 'NETWORK_ERROR' })
            return
          }
          const mime = detectMimeType(buffer)
          const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
          log.info('封面下载成功', { url: trimmed.substring(0, 100), size: buffer.length, mime })
          safeResolve({ success: true, data: dataUrl })
        })
        res.on('error', (err: Error) => {
          // 超时取消请求会触发此处，settled 已为 true 时忽略
          if (settled) return
          log.warn('封面下载流错误', { url: trimmed.substring(0, 100), error: err.message })
          safeResolve({ success: false, error: `网络传输中断: ${err.message}`, code: 'NETWORK_ERROR' })
        })
      }).on('error', (err: Error) => {
        // 超时取消请求可能触发此处，settled 已为 true 时忽略
        if (settled) return
        log.warn('封面下载连接失败', { url: trimmed.substring(0, 100), error: err.message })
        safeResolve({ success: false, error: `连接失败: ${err.message}`, code: 'NETWORK_ERROR' })
      })
    } catch (err: any) {
      log.error('封面下载异常', { url: trimmed.substring(0, 100), error: err?.message ?? String(err) })
      safeResolve({ success: false, error: `下载异常: ${err?.message ?? '未知错误'}`, code: 'UNKNOWN' })
    }
  })
}

/** 将各种格式归一化为 Character */
async function normalizeCharacter(parsed: any, avatarBase64?: string): Promise<Character> {
  const data = parsed.data ?? parsed
  const now = Date.now()

  // 确定头像来源：优先级 传入参数 > JSON 中的图片字段
  let finalAvatar = avatarBase64 ?? ''
  if (!finalAvatar) {
    // 检查 JSON 中的图片字段
    const imageUrl =
      data.cover ?? data.avatar ?? data.image ?? data.image_url ??
      data.thumbnail ?? data.portrait ??
      parsed.cover ?? parsed.avatar ?? parsed.image ?? parsed.image_url ??
      null

    if (imageUrl) {
      if (typeof imageUrl === 'string') {
        if (imageUrl.startsWith('data:image/')) {
          // 已经是 data URL
          finalAvatar = imageUrl
        } else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
          // URL -> 下载
          const result = await downloadImageAsBase64(imageUrl)
          if (result.success && result.data) {
            finalAvatar = result.data
            log.info('角色卡封面下载成功', { name: data.name, url: imageUrl.substring(0, 100) })
          } else {
            log.warn('角色卡封面下载失败', {
              name: data.name,
              url: imageUrl.substring(0, 100),
              code: result.code ?? 'UNKNOWN',
              error: result.error ?? '',
              statusCode: result.statusCode ?? null,
            })
          }
        } else if (/^[A-Za-z0-9+/=]{100,}$/.test(imageUrl.trim())) {
          // 纯 base64（无 data:image 前缀），自动检测类型并补全
          try {
            const buffer = Buffer.from(imageUrl.trim(), 'base64')
            const mime = detectMimeType(buffer)
            finalAvatar = `data:${mime};base64,${imageUrl.trim()}`
          } catch {
            log.warn('角色卡封面 base64 解析失败', { name: data.name })
          }
        }
      }
    }
  }

  // V2/V3 兼容：完整提取所有字段
  let firstMes = data.first_mes ?? data.firstMessage ?? ''
  const altGreetings: string[] = []
  if (Array.isArray(data.alternate_greetings)) {
    for (const g of data.alternate_greetings) {
      if (typeof g === 'string' && g.trim()) altGreetings.push(g)
    }
  }
  if (!firstMes && altGreetings.length > 0) {
    firstMes = altGreetings[0]
  }

  // 群聊专用开场白
  const groupGreetings: string[] = []
  if (Array.isArray(data.group_only_greetings)) {
    for (const g of data.group_only_greetings) {
      if (typeof g === 'string' && g.trim()) groupGreetings.push(g)
    }
  }

  // 记录原始图片 URL（用于重新加载封面）
  const rawImageUrl = (!finalAvatar)
    ? (data.avatar ?? data.image ?? data.image_url ?? '')
    : ''
  const importImageUrl = (typeof rawImageUrl === 'string' && !rawImageUrl.startsWith('data:')
    && (rawImageUrl.startsWith('http://') || rawImageUrl.startsWith('https://')))
    ? rawImageUrl : undefined

  const character: Character = {
    id: nanoid(),
    name: data.name ?? parsed.name ?? '未命名角色',
    avatar: finalAvatar,
    cover: finalAvatar, // 封面与头像初始同源，后续可单独更换
    description: data.description ?? '',
    personality: data.personality ?? '',
    scenario: data.scenario ?? '',
    firstMessage: firstMes,
    exampleDialog: data.mes_example ?? data.exampleDialog ?? '',
    tags: data.tags ?? [],
    lorebookId: data.character_book?.id ?? null,
    creator: data.creator ?? '',
    createdAt: now,
    updatedAt: now,
    alternateGreetings: altGreetings,
    systemPrompt: data.system_prompt ?? '',
    postHistoryInstructions: data.post_history_instructions ?? '',
    creatorNotes: data.creator_notes ?? '',
    characterVersion: data.character_version ?? '',
    groupOnlyGreetings: groupGreetings,
    extensions: data.extensions ?? undefined,
    translatedContent: data.extensions?.translatedContent ?? undefined,
    _importImageUrl: importImageUrl,
  }

  // 自动提取内嵌世界书
  const charBook = data.character_book
  if (charBook && charBook.entries && Array.isArray(charBook.entries) && charBook.entries.length > 0) {
    try {
      const lorebookId = nanoid()
      const entries: LoreEntry[] = charBook.entries.map((e: any, i: number) => ({
        id: e.uid?.toString() ?? nanoid(),
        keywords: Array.isArray(e.key) ? e.key.filter(Boolean) : (e.key ? String(e.key).split(',').map((s: string) => s.trim()).filter(Boolean) : []),
        content: e.content ?? '',
        position: e.position === 'before' ? 'before_char' : e.position === 'after' ? 'after_char' : 'at_end',
        order: e.order ?? i,
        probability: e.probability ?? 100,
        enabled: e.disable ? false : (e.enabled !== undefined ? e.enabled : true),
      }))

      const lorebook: Lorebook = {
        id: lorebookId,
        name: charBook.name ?? `${character.name}的世界书`,
        description: charBook.description ?? '',
        entries,
        enabled: true,
        scanDepth: charBook.scan_depth ?? 4,
      }

      const lorebookDir = DIRS.lorebooks()
      mkdirSync(lorebookDir, { recursive: true })
      writeJson(join(lorebookDir, `${lorebookId}.json`), lorebook)
      character.lorebookId = lorebookId
    } catch {
      // 提取失败不阻断角色导入
    }
  }

  // 自动匹配世界书：若角色卡不含内嵌世界书，扫描已有世界书库匹配
  if (!character.lorebookId) {
    try {
      const lorebookDir = DIRS.lorebooks()
      if (existsSync(lorebookDir)) {
        const files = readdirSync(lorebookDir).filter(f => f.endsWith('.json'))
        if (files.length > 0) {
          const charText = [
            character.name,
            character.description,
            character.personality,
            character.scenario,
            ...(character.tags || []),
          ].filter(Boolean).join(' ').toLowerCase()

          let bestScore = 0
          let bestLorebookId: string | null = null

          for (const file of files) {
            const lb: Lorebook = JSON.parse(readFileSync(join(lorebookDir, file), 'utf-8'))
            if (!lb.enabled) continue

            const lbText = [
              lb.name,
              lb.description,
              ...lb.entries.flatMap(e => e.keywords),
            ].filter(Boolean).join(' ').toLowerCase()

            const lbWords = new Set(lbText.split(/\s+/).filter(w => w.length > 1))
            const charWords = new Set(charText.split(/\s+/).filter(w => w.length > 1))
            let score = 0
            for (const w of charWords) {
              if (lbWords.has(w)) score++
            }

            if (score > bestScore) {
              bestScore = score
              bestLorebookId = lb.id
            }
          }

          if (bestScore >= 2 && bestLorebookId) {
            character.lorebookId = bestLorebookId
          }
        }
      }
    } catch {
      // 匹配失败不阻断导入
    }
  }

  return character
}

/** 导出角色卡为 PNG */
export function exportCharacterToPng(character: Character, savePath: string): void {
  let pngBuffer: Buffer
  if (character.avatar.startsWith('data:image/png;base64,')) {
    pngBuffer = Buffer.from(character.avatar.split(',')[1], 'base64')
  } else if (character.avatar.startsWith('data:image/')) {
    // 非 PNG 图片，创建 1x1 透明 PNG 作为基底
    pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    )
  } else {
    pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    )
  }

  const charaJson = JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: character.name,
      description: character.description,
      personality: character.personality,
      scenario: character.scenario,
      first_mes: character.firstMessage,
      alternate_greetings: character.alternateGreetings,
      mes_example: character.exampleDialog,
      system_prompt: character.systemPrompt || '',
      post_history_instructions: character.postHistoryInstructions || '',
      creator_notes: character.creatorNotes || '',
      character_version: character.characterVersion || '',
      group_only_greetings: character.groupOnlyGreetings || [],
      tags: character.tags,
      creator: character.creator,
      extensions: {
        ...(character.extensions || {}),
        ...(character.translatedContent ? { translatedContent: character.translatedContent } : {}),
      },
    },
  })
  const charaBase64 = Buffer.from(charaJson).toString('base64')

  const newBuffer = writePngTextChunk(pngBuffer, 'chara', charaBase64)
  writeFileSync(savePath, newBuffer)
}

/** 导出角色卡为 JSON */
export function exportCharacterToJson(character: Character, savePath: string): void {
  const data = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: character.name,
      description: character.description,
      personality: character.personality,
      scenario: character.scenario,
      first_mes: character.firstMessage,
      alternate_greetings: character.alternateGreetings,
      mes_example: character.exampleDialog,
      system_prompt: character.systemPrompt || '',
      post_history_instructions: character.postHistoryInstructions || '',
      creator_notes: character.creatorNotes || '',
      character_version: character.characterVersion || '',
      group_only_greetings: character.groupOnlyGreetings || [],
      tags: character.tags,
      creator: character.creator,
      extensions: {
        ...(character.extensions || {}),
        ...(character.translatedContent ? { translatedContent: character.translatedContent } : {}),
      },
    },
  }
  writeFileSync(savePath, JSON.stringify(data, null, 2), 'utf-8')
}

/** 保存角色头像（自动检测 MIME 类型） */
export function saveAvatar(characterId: string, base64Data: string): string {
  if (!base64Data) return ''
  const avatarDir = DIRS.characters()
  mkdirSync(avatarDir, { recursive: true })

  const base64 = base64Data.replace(/^data:image\/\w+;base64,/, '')
  const buffer = Buffer.from(base64, 'base64')
  const mime = detectMimeType(buffer)
  const ext = mime.split('/')[1] // png, jpeg, gif, webp
  const fileName = ext === 'jpeg' ? 'jpg' : ext

  const avatarPath = join(avatarDir, `${characterId}.${fileName}`)
  writeFileSync(avatarPath, buffer)
  return avatarPath
}

/** 读取角色头像 base64（自动检测 MIME 类型） */
export function readAvatar(characterId: string): string | null {
  const avatarDir = DIRS.characters()
  // 尝试所有可能的扩展名
  const extensions = ['png', 'jpg', 'jpeg', 'gif', 'webp']
  for (const ext of extensions) {
    const avatarPath = join(avatarDir, `${characterId}.${ext}`)
    if (existsSync(avatarPath)) {
      try {
        const buffer = readFileSync(avatarPath)
        const mime = detectMimeType(buffer)
        return `data:${mime};base64,${buffer.toString('base64')}`
      } catch {
        continue
      }
    }
  }
  return null
}

/** 保存封面 */
export function saveCover(characterId: string, base64Data: string): string {
  if (!base64Data) return ''
  const avatarDir = DIRS.characters()
  mkdirSync(avatarDir, { recursive: true })

  const base64 = base64Data.replace(/^data:image\/\w+;base64,/, '')
  const buffer = Buffer.from(base64, 'base64')
  const mime = detectMimeType(buffer)
  const ext = mime.split('/')[1]
  const fileName = ext === 'jpeg' ? 'jpg' : ext

  const coverPath = join(avatarDir, `${characterId}_cover.${fileName}`)
  writeFileSync(coverPath, buffer)
  return coverPath
}

/** 读取封面 base64 */
export function readCover(characterId: string): string | null {
  const avatarDir = DIRS.characters()
  const extensions = ['png', 'jpg', 'jpeg', 'gif', 'webp']
  for (const ext of extensions) {
    const coverPath = join(avatarDir, `${characterId}_cover.${ext}`)
    if (existsSync(coverPath)) {
      try {
        const buffer = readFileSync(coverPath)
        const mime = detectMimeType(buffer)
        return `data:${mime};base64,${buffer.toString('base64')}`
      } catch {
        continue
      }
    }
  }
  return null
}

/** 保存角色 */
export function saveCharacter(character: Character): void {
  const filePath = join(DIRS.characters(), `${character.id}.json`)
  mkdirSync(DIRS.characters(), { recursive: true })

  // 保存头像和封面到文件
  if (character.avatar.startsWith('data:')) {
    saveAvatar(character.id, character.avatar)
  }
  if (character.cover && character.cover.startsWith('data:')) {
    saveCover(character.id, character.cover)
  }

  // JSON 中不存 base64，只存空字符串（图片从文件读取）
  const { avatar, cover, ...rest } = character
  writeJson(filePath, { ...rest, avatar: '', cover: '' })
}

/** 读取角色列表 */
export function listCharacters(): Character[] {
  const charDir = DIRS.characters()
  if (!existsSync(charDir)) return []

  const chars: Character[] = []
  const files = readdirSync(charDir).filter((f) => f.endsWith('.json'))

  for (const file of files) {
    const char = readJson<Character>(join(charDir, file))
    if (char) {
      // 从文件读取头像和封面
      const avatar = readAvatar(char.id)
      if (avatar) {
        char.avatar = avatar
      }
      const cover = readCover(char.id)
      if (cover) {
        char.cover = cover
      }
      chars.push(char)
    }
  }

  // 按更新时间倒序
  return chars.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 读取单个角色 */
export function getCharacter(id: string): Character | null {
  const filePath = join(DIRS.characters(), `${id}.json`)
  const char = readJson<Character>(filePath)
  if (char) {
    const avatar = readAvatar(id)
    if (avatar) char.avatar = avatar
    const cover = readCover(id)
    if (cover) char.cover = cover
  }
  return char
}

/** 删除角色 */
export function deleteCharacter(id: string): void {
  const charDir = DIRS.characters()
  const jsonPath = join(charDir, `${id}.json`)
  if (existsSync(jsonPath)) unlinkSync(jsonPath)

  // 删除头像文件（所有扩展名）
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
    const avatarPath = join(charDir, `${id}.${ext}`)
    if (existsSync(avatarPath)) {
      try { unlinkSync(avatarPath) } catch { /* 忽略 */ }
    }
    // 也删除封面文件
    const coverPath = join(charDir, `${id}_cover.${ext}`)
    if (existsSync(coverPath)) {
      try { unlinkSync(coverPath) } catch { /* 忽略 */ }
    }
  }
}

/** 重新从 URL 加载角色封面头像 */
export async function reloadAvatarFromUrl(characterId: string, url: string): Promise<{ success: boolean; avatar: string; error?: string; code?: string }> {
  log.info('重新加载封面', { characterId, url: url.substring(0, 100) })
  const result = await downloadImageAsBase64(url)
  if (!result.success || !result.data) {
    log.warn('重新加载封面失败', { characterId, code: result.code ?? 'UNKNOWN', error: result.error ?? '' })
    return { success: false, avatar: '', error: result.error, code: result.code }
  }
  saveAvatar(characterId, result.data)
  saveCover(characterId, result.data) // 封面同步更新
  log.info('重新加载封面成功', { characterId })
  return { success: true, avatar: result.data }
}
