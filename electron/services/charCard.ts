import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS, writeJson, readJson } from './storage'
import type { Character, Lorebook, LoreEntry } from '../../shared/types'
import { nanoid } from 'nanoid'

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
  const charaBase64 = chunks['chara']
  if (!charaBase64) {
    throw new Error('该 PNG 文件不包含角色卡数据（未找到 chara 字段）')
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
  return await normalizeCharacter(parsed, avatarBase64)
}

/** 从 JSON 文件导入角色卡 */
export async function importCharacterFromJson(filePath: string): Promise<Character> {
  const raw = readFileSync(filePath, 'utf-8')
  const parsed = JSON.parse(raw)
  return await normalizeCharacter(parsed)
}

/** 下载图片并转为 base64 data URL */
async function downloadImageAsBase64(url: string): Promise<string> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(''), 10000)
    try {
      const getter = url.startsWith('https') ? require('node:https') : require('node:http')
      getter.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000,
      }, (res: any) => {
        // 处理重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(timeout)
          resolve(downloadImageAsBase64(res.headers.location))
          return
        }
        if (res.statusCode !== 200) {
          clearTimeout(timeout)
          resolve('')
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          clearTimeout(timeout)
          const buffer = Buffer.concat(chunks)
          const mime = detectMimeType(buffer)
          resolve(`data:${mime};base64,${buffer.toString('base64')}`)
        })
        res.on('error', () => {
          clearTimeout(timeout)
          resolve('')
        })
      }).on('error', () => {
        clearTimeout(timeout)
        resolve('')
      })
    } catch {
      clearTimeout(timeout)
      resolve('')
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
      data.avatar ?? data.image ?? data.image_url ??
      data.thumbnail ?? data.portrait ??
      parsed.avatar ?? parsed.image ?? parsed.image_url ??
      null

    if (imageUrl) {
      if (typeof imageUrl === 'string') {
        if (imageUrl.startsWith('data:image/')) {
          // 已经是 data URL
          finalAvatar = imageUrl
        } else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
          // URL -> 下载
          finalAvatar = await downloadImageAsBase64(imageUrl)
        }
      }
    }
  }

  // V2/V3 兼容：无 first_mes 时使用第一个备用问候语
  let firstMes = data.first_mes ?? data.firstMessage ?? ''
  if (!firstMes) {
    const altGreetings = data.alternate_greetings
    if (Array.isArray(altGreetings) && altGreetings.length > 0) {
      firstMes = typeof altGreetings[0] === 'string' ? altGreetings[0] : ''
    }
  }

  const character: Character = {
    id: nanoid(),
    name: data.name ?? parsed.name ?? '未命名角色',
    avatar: finalAvatar,
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
      mes_example: character.exampleDialog,
      tags: character.tags,
      creator: character.creator,
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
      mes_example: character.exampleDialog,
      tags: character.tags,
      creator: character.creator,
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

/** 保存角色 */
export function saveCharacter(character: Character): void {
  const filePath = join(DIRS.characters(), `${character.id}.json`)
  mkdirSync(DIRS.characters(), { recursive: true })

  if (character.avatar.startsWith('data:')) {
    saveAvatar(character.id, character.avatar)
    // JSON 中不存 avatar base64，只存空字符串（头像从文件读取）
    const { avatar, ...rest } = character
    writeJson(filePath, { ...rest, avatar: '' })
  } else {
    writeJson(filePath, character)
  }
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
      // 从文件读取头像
      const avatar = readAvatar(char.id)
      if (avatar) {
        char.avatar = avatar
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
  }
}
