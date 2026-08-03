import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { DIRS, writeJson, readJson, readJsonAsync } from './storage'
import type { Character, Lorebook, LoreEntry, RegexRule, QuickReply, QuickReplyStore } from '../../shared/types'
import { createLogger } from './logger'
import { nanoid } from 'nanoid'
import { validateCharacterCard, formatValidationErrors } from './charCardValidator'

const log = createLogger('charCard')

/** 全局 keep-alive Agent — 复用 TCP/TLS 连接，避免每次下载都重新握手 */
const httpKeepAliveAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,      // 空闲连接保留 30 秒
  maxSockets: 10,             // 每个 host 最多 10 个并发连接
  maxFreeSockets: 5,          // 空闲时保留 5 个
  timeout: 30000,             // socket 超时
})

const httpsKeepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 30000,
})

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
export async function importCharacterFromPng(filePath: string, proxyUrl?: string): Promise<Character> {
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
  const character = await normalizeCharacter(parsed, avatarBase64, proxyUrl)
  log.info('PNG 角色卡导入成功', { name: character.name, path: filePath.substring(0, 80) })
  return character
}

/** 从 JSON 文件导入角色卡 */
export async function importCharacterFromJson(filePath: string, proxyUrl?: string): Promise<Character> {
  const raw = readFileSync(filePath, 'utf-8')
  const parsed = JSON.parse(raw)

  // 检测 SillyTavern 世界书格式：有 entries + scan_depth 且无 spec/data 包装
  if (
    parsed.entries &&
    (Array.isArray(parsed.entries) ? parsed.entries.length > 0 : Object.keys(parsed.entries).length > 0) &&
    typeof parsed.scan_depth === 'number' &&
    !parsed.spec &&
    !parsed.data
  ) {
    const entryCount = Array.isArray(parsed.entries) ? parsed.entries.length : Object.keys(parsed.entries).length
    throw new Error(
      `这个文件是世界书（Lorebook），包含 ${entryCount} 条条目，不是角色卡。\n请在世界书页面使用"导入 JSON"功能导入。`
    )
  }

  const character = await normalizeCharacter(parsed, undefined, proxyUrl)
  log.info('JSON 角色卡导入成功', { name: character.name, path: filePath.substring(0, 80), hasAvatar: !!character.avatar })
  return character
}

/** 图片下载错误码 */
export type ImageDownloadCode = 'TIMEOUT' | 'HTTP_ERROR' | 'NETWORK_ERROR' | 'INVALID_URL' | 'INVALID_FORMAT' | 'SSRF_BLOCKED' | 'UNKNOWN'

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

/** 解析代理 URL */
function parseProxyUrl(proxyUrl: string): { host: string; port: number } | null {
  try {
    const u = new URL(proxyUrl)
    if (!u.hostname || !u.port) return null
    return { host: u.hostname, port: parseInt(u.port, 10) }
  } catch {
    return null
  }
}

/** 单次下载尝试（内部函数），可通过代理或直连 */
function _downloadOne(url: string, proxy: { host: string; port: number } | null, maxRedirects: number): Promise<DownloadResult> {
  const trimmed = url.trim()
  const isHttps = trimmed.startsWith('https')
  const targetUrl = new URL(trimmed)

  return new Promise((resolve) => {
    let settled = false
    let req: import('node:http').ClientRequest | null = null

    const safeResolve = (result: DownloadResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }

    const timeout = setTimeout(() => {
      log.warn('封面下载超时', { url: trimmed.substring(0, 100), timeoutMs: DOWNLOAD_TIMEOUT_MS, viaProxy: !!proxy })
      if (req) {
        try { req.destroy() } catch { /* ignore */ }
      }
      safeResolve({ success: false, error: '下载超时，请检查网络连接', code: 'TIMEOUT' })
    }, DOWNLOAD_TIMEOUT_MS)

    try {
      if (proxy) {
        // ===== 通过代理下载 =====
        const connectOpts: import('node:http').RequestOptions = {
          host: proxy.host,
          port: proxy.port,
          method: 'CONNECT',
          path: `${targetUrl.hostname}:${targetUrl.port || (isHttps ? 443 : 80)}`,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          timeout: DOWNLOAD_TIMEOUT_MS,
        }

        log.debug('通过代理连接', { proxy: `${proxy.host}:${proxy.port}`, target: `${targetUrl.hostname}:${targetUrl.port || (isHttps ? 443 : 80)}` })

        req = http.request(connectOpts)
        req.on('connect', (_res: import('node:http').IncomingMessage, socket: import('node:net').Socket) => {
          if (_res.statusCode !== 200) {
            log.warn('代理 CONNECT 失败', { statusCode: _res.statusCode })
            safeResolve({ success: false, error: `代理连接失败: HTTP ${_res.statusCode}`, code: 'NETWORK_ERROR' })
            return
          }

          if (isHttps) {
            const httpsReq = https.request({
              host: targetUrl.hostname,
              port: targetUrl.port || 443,
              path: targetUrl.pathname + targetUrl.search,
              method: 'GET',
              headers: {
                'Host': targetUrl.hostname,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
              },
              socket,
              agent: false,
              timeout: DOWNLOAD_TIMEOUT_MS,
            }, handleResponse)
            httpsReq.on('error', (err: Error) => {
              if (settled) return
              log.warn('代理 HTTPS 请求失败', { error: err.message })
              safeResolve({ success: false, error: `代理请求失败: ${err.message}`, code: 'NETWORK_ERROR' })
            })
            httpsReq.end()
          } else {
            const httpReq = http.request({
              host: proxy.host,
              port: proxy.port,
              path: trimmed,
              method: 'GET',
              headers: {
                'Host': targetUrl.hostname,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
              },
              socket,
              agent: false,
              timeout: DOWNLOAD_TIMEOUT_MS,
            }, handleResponse)
            httpReq.on('error', (err: Error) => {
              if (settled) return
              log.warn('代理 HTTP 请求失败', { error: err.message })
              safeResolve({ success: false, error: `代理请求失败: ${err.message}`, code: 'NETWORK_ERROR' })
            })
            httpReq.end()
          }
        })
        req.on('error', (err: Error) => {
          if (settled) return
          log.warn('代理连接失败', { proxy: `${proxy.host}:${proxy.port}`, error: err.message })
          safeResolve({ success: false, error: `代理连接失败: ${err.message}`, code: 'NETWORK_ERROR' })
        })
        req.end()
      } else {
        // ===== 直连下载 =====
        const getter = isHttps ? https : http
        req = getter.get(trimmed, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
          },
          timeout: DOWNLOAD_TIMEOUT_MS,
          agent: isHttps ? httpsKeepAliveAgent : httpKeepAliveAgent,
        }, handleResponse).on('error', (err: Error) => {
          if (settled) return
          log.warn('封面下载连接失败', { url: trimmed.substring(0, 100), error: err.message })
          safeResolve({ success: false, error: `连接失败: ${err.message}`, code: 'NETWORK_ERROR' })
        })
      }

      // 统一的响应处理函数
      function handleResponse(res: import('node:http').IncomingMessage) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          log.debug('封面下载重定向', { from: trimmed.substring(0, 80), statusCode: res.statusCode })
          // 递归跟随重定向，保持代理选择
          _downloadOne(res.headers.location, proxy, maxRedirects - 1).then(safeResolve)
          return
        }
        if (res.statusCode !== 200) {
          const errorChunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => { if (errorChunks.length < 1) errorChunks.push(chunk) })
          res.on('end', () => {
            const preview = errorChunks.length > 0
              ? errorChunks[0].subarray(0, 500).toString('utf-8').replace(/\s+/g, ' ').trim()
              : '(空响应)'
            log.warn('封面下载 HTTP 错误', { url: trimmed.substring(0, 100), statusCode: res.statusCode, bodyPreview: preview })
            safeResolve({ success: false, error: `服务器返回 HTTP ${res.statusCode}`, code: 'HTTP_ERROR', statusCode: res.statusCode })
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
          log.info('封面下载成功', { url: trimmed.substring(0, 100), size: buffer.length, mime, viaProxy: !!proxy })
          safeResolve({ success: true, data: dataUrl })
        })
        res.on('error', (err: Error) => {
          if (settled) return
          log.warn('封面下载流错误', { url: trimmed.substring(0, 100), error: err.message })
          safeResolve({ success: false, error: `网络传输中断: ${err.message}`, code: 'NETWORK_ERROR' })
        })
      }
    } catch (err) {
      log.error('封面下载异常', { url: trimmed.substring(0, 100), error: err instanceof Error ? err.message : String(err) })
      safeResolve({ success: false, error: `下载异常: ${err instanceof Error ? err.message : '未知错误'}`, code: 'UNKNOWN' })
    }
  })
}

/** 下载图片并转为 base64 data URL
 *  如果配置了代理，直连和代理同时竞速，谁先返回用谁 */
async function downloadImageAsBase64(url: string, proxyUrl?: string, maxRedirects: number = 5): Promise<DownloadResult> {
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

  // SSRF 防护：拒绝私有 IP、localhost、元数据端点
  try {
    const parsed = new URL(trimmed)
    const hostname = parsed.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      log.warn('SSRF 防护：拒绝 localhost', { hostname })
      return { success: false, error: '不允许访问本地地址', code: 'SSRF_BLOCKED' }
    }
    if (hostname.match(/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/)) {
      log.warn('SSRF 防护：拒绝私有 IP', { hostname })
      return { success: false, error: '不允许访问内网地址', code: 'SSRF_BLOCKED' }
    }
    if (hostname === '169.254.169.254') {
      log.warn('SSRF 防护：拒绝云元数据端点', { hostname })
      return { success: false, error: '不允许访问元数据服务', code: 'SSRF_BLOCKED' }
    }
  } catch {
    log.warn('URL 解析失败', { url: trimmed.substring(0, 100) })
    return { success: false, error: '无法解析图片 URL', code: 'INVALID_URL' }
  }

  // 防止无限重定向
  if (maxRedirects <= 0) {
    log.warn('封面下载重定向次数超出限制', { url: trimmed.substring(0, 100) })
    return { success: false, error: '重定向次数过多，下载失败', code: 'NETWORK_ERROR' }
  }

  // 解析代理配置
  const proxy = proxyUrl ? parseProxyUrl(proxyUrl) : null

  // 无代理：直连
  if (!proxy) {
    return _downloadOne(trimmed, null, maxRedirects)
  }

  // 有代理：直连与代理竞速，谁先返回成功用谁
  log.info('封面下载竞速', { url: trimmed.substring(0, 100), proxy: `${proxy.host}:${proxy.port}` })
  try {
    return await Promise.any([
      _downloadOne(trimmed, null, maxRedirects),
      _downloadOne(trimmed, proxy, maxRedirects),
    ])
  } catch {
    // 全部失败
    log.warn('封面下载：直连和代理均失败', { url: trimmed.substring(0, 100) })
    return { success: false, error: '直连和代理均下载失败，请检查网络', code: 'NETWORK_ERROR' }
  }
}

/** 将各种格式归一化为 Character */
async function normalizeCharacter(parsed: unknown, avatarBase64?: string, proxyUrl?: string): Promise<Character> {
  // 导入时校验角色卡基本结构（拦截损坏/非法卡）
  const validation = validateCharacterCard(parsed)
  if (!validation.ok) {
    throw new Error(`角色卡校验失败：${formatValidationErrors(validation)}`)
  }
  const data = (parsed as { data?: unknown }).data ?? parsed
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
          const result = await downloadImageAsBase64(imageUrl, proxyUrl)
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
      const entries: LoreEntry[] = charBook.entries.map((e: unknown, i: number) => ({
        id: e.uid?.toString() ?? nanoid(),
        keywords: Array.isArray(e.key) ? e.key.filter(Boolean) : (e.key ? String(e.key).split(',').map((s: string) => s.trim()).filter(Boolean) : []),
        content: e.content ?? '',
        position: e.position === 'before' || e.position === 0 ? 'before_char'
          : e.position === 'after' || e.position === 1 ? 'after_char'
          : e.position === 'depth' || e.position === 'at_depth' || e.position === 2 ? 'at_depth'
          : 'at_end',
        depth: typeof e.depth === 'number' ? Math.max(0, e.depth) : 0,
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { avatar: _avatar, cover: _cover, ...rest } = character
  writeJson(filePath, { ...rest, avatar: '', cover: '' })
}

/** 读取角色列表（仅元数据，图片通过 tavern:// 协议按需加载） */
export async function listCharacters(): Promise<Character[]> {
  const charDir = DIRS.characters()
  if (!existsSync(charDir)) return []

  const files = readdirSync(charDir).filter((f) => f.endsWith('.json'))

  // 并行读取所有角色 JSON（不含图片 base64，避免 IPC 传输大量数据）
  const results = await Promise.all(
    files.map((file) => readJsonAsync<Character>(join(charDir, file), 'characters')),
  )

  const chars: Character[] = []
  for (const char of results) {
    if (char) {
      chars.push(char)
    }
  }

  // 按更新时间倒序
  return chars.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 读取单个角色 */
export function getCharacter(id: string): Character | null {
  const filePath = join(DIRS.characters(), `${id}.json`)
  const char = readJson<Character>(filePath, 'characters')
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
export async function reloadAvatarFromUrl(characterId: string, url: string, proxyUrl?: string): Promise<{ success: boolean; avatar: string; error?: string; code?: string }> {
  log.info('重新加载封面', { characterId, url: url.substring(0, 100) })
  const result = await downloadImageAsBase64(url, proxyUrl)
  if (!result.success || !result.data) {
    log.warn('重新加载封面失败', { characterId, code: result.code ?? 'UNKNOWN', error: result.error ?? '' })
    return { success: false, avatar: '', error: result.error, code: result.code }
  }
  saveAvatar(characterId, result.data)
  saveCover(characterId, result.data) // 封面同步更新
  log.info('重新加载封面成功', { characterId })
  return { success: true, avatar: result.data }
}

// ===================== 角色卡前端扩展适配（regex_scripts / quick_replies） =====================

/** 官方 SillyTavern regex_scripts 条目 → 项目 RegexRule（不支持的返回 null） */
function convertRegexScript(script: unknown): RegexRule | null {
  if (!script || typeof script !== 'object') return null
  const s = script as Record<string, unknown>
  const pattern = typeof s.findRegex === 'string' ? s.findRegex : ''
  if (!pattern) return null
  const replacement = typeof s.replaceString === 'string' ? s.replaceString : ''

  // promptOnly：仅作用在 prompt 阶段，项目无此阶段 → 跳过
  if (s.promptOnly === true) return null

  // placement → scope（ST 默认 user_input + ai_output = both）
  const placement: unknown[] = Array.isArray(s.placement) ? s.placement : []
  const hasInput = placement.length === 0 || placement.includes('user_input')
  const hasOutput = placement.length === 0 || placement.includes('ai_output')
  const scope: RegexRule['scope'] = hasInput && hasOutput ? 'both' : hasInput ? 'input' : 'output'

  // markdownOnly：仅 output 有 markdown 阶段（input 规则实际不会生效 → 跳过）
  let stage: RegexRule['stage'] = 'text'
  if (s.markdownOnly === true) {
    if (!hasOutput) return null
    stage = 'markdown'
  }

  return {
    id: nanoid(),
    name: typeof s.scriptName === 'string' && s.scriptName.trim() ? s.scriptName : '角色卡正则',
    pattern,
    replacement,
    // ST 默认大小写不敏感
    flags: 'gi',
    enabled: s.disabled !== true,
    scope,
    group: '角色卡导入',
    stage,
  }
}

/** 官方 SillyTavern quick_replies 条目 → 项目 QuickReply（不支持的返回 null） */
function convertCardQuickReply(qr: unknown, index: number): QuickReply | null {
  if (!qr || typeof qr !== 'object') return null
  const q = qr as Record<string, unknown>
  const label = typeof q.label === 'string' && q.label.trim() ? q.label : '快捷回复'
  const message = typeof q.message === 'string' ? q.message : (typeof q.content === 'string' ? q.content : '')
  if (!message) return null
  const isCommand = q.messageType === 'command' || q.messageType === 'slash'
  const hotkey = typeof q.hotkey === 'number' && q.hotkey >= 1 && q.hotkey <= 9 ? q.hotkey : undefined
  return {
    id: typeof q.id === 'string' && q.id ? q.id : nanoid(),
    label,
    content: message,
    action: isCommand ? 'command' : 'text',
    command: isCommand ? message : undefined,
    sendWithAI: true,
    hotkey,
    order: index,
    enabled: true,
  }
}

export interface CardExtrasResult {
  regexCount: number
  quickReplyCount: number
  /** 因不支持而跳过的项描述 */
  skipped: string[]
}

/**
 * 角色卡前端扩展落地（幂等，可重复导入）：
 * - extensions.regex_scripts → 正则规则库（group「角色卡导入」）
 * - extensions.quick_replies → 角色级快捷回复
 * 失败不阻断角色导入。
 */
export function importCardFrontendExtensions(character: Character): CardExtrasResult {
  const result: CardExtrasResult = { regexCount: 0, quickReplyCount: 0, skipped: [] }
  const exts = character.extensions
  if (!exts || typeof exts !== 'object') return result

  // ---- 正则脚本 ----
  if (Array.isArray(exts.regex_scripts)) {
    const rulesPath = join(DIRS.config(), 'regex', 'rules.json')
    let existing: RegexRule[] = []
    try {
      if (existsSync(rulesPath)) existing = JSON.parse(readFileSync(rulesPath, 'utf-8')) as RegexRule[]
    } catch { /* 文件损坏则从空列表开始 */ }
    const existingKeys = new Set(existing.map(r => `${r.pattern}|${r.scope}|${r.stage ?? 'text'}`))
    for (const script of exts.regex_scripts) {
      const rule = convertRegexScript(script)
      if (!rule) {
        const s = script as Record<string, unknown> | null
        if (s && typeof s.scriptName === 'string') result.skipped.push(`正则「${s.scriptName}」`)
        continue
      }
      const key = `${rule.pattern}|${rule.scope}|${rule.stage}`
      if (existingKeys.has(key)) continue // 已导入过（幂等）
      existingKeys.add(key)
      existing.push(rule)
      result.regexCount++
    }
    if (result.regexCount > 0) {
      try {
        mkdirSync(join(DIRS.config(), 'regex'), { recursive: true })
        writeFileSync(rulesPath, JSON.stringify(existing, null, 2), 'utf-8')
      } catch (e) {
        log.error('角色卡正则落地失败', { error: (e as Error).message })
        result.regexCount = 0
      }
    }
  }

  // ---- 快捷回复 ----
  if (Array.isArray(exts.quick_replies)) {
    const storePath = join(DIRS.config(), 'quickReplies.json')
    let store: QuickReplyStore = { global: [], byCharacter: {} }
    try {
      const raw = readJson<QuickReplyStore>(storePath)
      if (raw && Array.isArray(raw.global)) store = { global: raw.global, byCharacter: raw.byCharacter ?? {} }
    } catch { /* 重置 */ }
    const charList = store.byCharacter[character.id] ?? []
    const existingIds = new Set(charList.map(q => q.id))
    for (let i = 0; i < exts.quick_replies.length; i++) {
      const q = convertCardQuickReply(exts.quick_replies[i], i)
      if (!q) continue
      if (existingIds.has(q.id)) continue // 幂等
      existingIds.add(q.id)
      charList.push(q)
      result.quickReplyCount++
    }
    if (result.quickReplyCount > 0) {
      store.byCharacter[character.id] = charList
      try {
        writeJson(storePath, store)
      } catch (e) {
        log.error('角色卡快捷回复落地失败', { error: (e as Error).message })
        result.quickReplyCount = 0
      }
    }
  }

  if (result.regexCount > 0 || result.quickReplyCount > 0 || result.skipped.length > 0) {
    log.info('角色卡前端扩展已导入', { name: character.name, ...result })
  }
  return result
}
