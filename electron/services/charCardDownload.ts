/**
 * 封面图片下载（P-8 从 charCard.ts 拆分）
 * - keep-alive 连接复用、代理 CONNECT 隧道
 * - SSRF 防护（前置校验 + 重定向目标复验）
 * - 直连/代理竞速下载（先到先得，取消输家释放连接）
 * - 大小/超时限制
 */
import http from 'node:http'
import https from 'node:https'
import { createLogger } from './logger'
import { detectMimeType } from './charCardPng'
import { isSafeUrl } from '../utils/pathGuard'

const log = createLogger('charCardDownload')

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

/** 图片下载错误码 */
export type ImageDownloadCode = 'TIMEOUT' | 'HTTP_ERROR' | 'NETWORK_ERROR' | 'INVALID_URL' | 'INVALID_FORMAT' | 'SSRF_BLOCKED' | 'CANCELLED' | 'UNKNOWN'

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

/** 封面下载大小上限（50MB），防止恶意响应耗尽内存 */
const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024

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
function _downloadOne(url: string, proxy: { host: string; port: number } | null, maxRedirects: number, signal?: AbortSignal): Promise<DownloadResult> {
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

    // N14 修复：支持外部取消（竞速时输家被 abort 以释放连接）
    const onAbort = () => {
      if (req) {
        try { req.destroy() } catch { /* ignore */ }
      }
      safeResolve({ success: false, error: '已取消', code: 'CANCELLED' })
    }

    const timeout = setTimeout(() => {
      log.warn('封面下载超时', { url: trimmed.substring(0, 100), timeoutMs: DOWNLOAD_TIMEOUT_MS, viaProxy: !!proxy })
      if (req) {
        try { req.destroy() } catch { /* ignore */ }
      }
      safeResolve({ success: false, error: '下载超时，请检查网络连接', code: 'TIMEOUT' })
    }, DOWNLOAD_TIMEOUT_MS)

    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

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
            } as import('node:http').RequestOptions, handleResponse)
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
            } as import('node:http').RequestOptions, handleResponse)
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
        const statusCode = res.statusCode ?? 0
        if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
          // M-1 修复：重定向次数上限检查（此前只在入口校验，递归链无拦截，
          // 持续 302 的服务器造成无终止的后台请求链，资源耗尽）
          if (maxRedirects <= 0) {
            safeResolve({ success: false, error: '重定向次数过多', code: 'NETWORK_ERROR' })
            return
          }
          // SSRF 防护：重定向目标重新校验（相对路径基于当前 URL 解析），
          // 防止恶意服务器重定向到内网地址绕过初始检查
          let redirectTarget: string
          try {
            redirectTarget = new URL(res.headers.location, trimmed).toString()
          } catch {
            safeResolve({ success: false, error: '重定向目标无效', code: 'INVALID_URL' })
            return
          }
          if (!isSafeUrl(redirectTarget)) {
            log.warn('封面下载重定向被拒绝（SSRF）', {
              from: trimmed.substring(0, 80),
              to: redirectTarget.substring(0, 80),
            })
            safeResolve({ success: false, error: '重定向目标不安全，已阻止', code: 'SSRF_BLOCKED' })
            return
          }
          log.debug('封面下载重定向', { from: trimmed.substring(0, 80), to: redirectTarget.substring(0, 80), statusCode: res.statusCode })
          // 递归跟随重定向（已解析为绝对 URL），保持代理选择
          _downloadOne(redirectTarget, proxy, maxRedirects - 1, signal).then(safeResolve)
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
        let totalSize = 0
        res.on('data', (chunk: Buffer) => {
          totalSize += chunk.length
          // 大小限制：防止恶意服务器返回超大响应耗尽内存
          if (totalSize > MAX_DOWNLOAD_SIZE) {
            log.warn('封面下载超过大小限制', { url: trimmed.substring(0, 100), maxMB: MAX_DOWNLOAD_SIZE / 1024 / 1024 })
            try { res.destroy() } catch { /* ignore */ }
            safeResolve({ success: false, error: '图片超过大小限制（50MB）', code: 'INVALID_FORMAT' })
            return
          }
          chunks.push(chunk)
        })
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
export async function downloadImageAsBase64(url: string, proxyUrl?: string, maxRedirects: number = 5): Promise<DownloadResult> {
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

  // SSRF 防护：拒绝私有 IP、localhost、元数据端点（复用 pathGuard.isSafeUrl，含 IPv6 方括号剥离）
  if (!isSafeUrl(trimmed)) {
    log.warn('SSRF 防护：拒绝不安全地址', { url: trimmed.substring(0, 100) })
    return { success: false, error: '不允许访问本地/内网/元数据地址', code: 'SSRF_BLOCKED' }
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
  // N14 修复：竞速胜出后取消输家请求，释放连接
  const directController = new AbortController()
  const proxyController = new AbortController()
  // H-3 修复：原 Promise.any 取"第一个 resolve"（_downloadOne 失败路径也是 resolve），
  // 直连毫秒级快速失败会立刻落定并 abort 本可成功的代理链路。改为"第一个成功者胜"。
  const result = await raceFirstSuccess(
    [
      _downloadOne(trimmed, null, maxRedirects, directController.signal),
      _downloadOne(trimmed, proxy, maxRedirects, proxyController.signal),
    ],
    [directController, proxyController]
  )
  if (result) {
    return result
  }
  // 全部失败
  log.warn('封面下载：直连和代理均失败', { url: trimmed.substring(0, 100) })
  return { success: false, error: '直连和代理均下载失败，请检查网络', code: 'NETWORK_ERROR' }
}

/**
 * H-3 修复：竞速下载——第一个成功者胜；全部失败返回 null。
 * 与 Promise.any 的区别：只采纳 success=true 的结果，失败结果不结束竞速；
 * 胜出时 abort 其余未完成请求（保留 N14 的连接释放优化）。
 */
function raceFirstSuccess<T extends { success: boolean }>(
  promises: Array<Promise<T>>,
  aborts: AbortController[]
): Promise<T | null> {
  return new Promise((resolve) => {
    let pending = promises.length
    promises.forEach((p, i) => {
      p.then((r) => {
        if (r.success) {
          // 胜出：abort 其余（含已完成的，无副作用）
          aborts.forEach((a, j) => { if (j !== i) a.abort() })
          resolve(r)
          return
        }
        pending -= 1
        if (pending === 0) resolve(null)
      }).catch(() => {
        pending -= 1
        if (pending === 0) resolve(null)
      })
    })
  })
}
