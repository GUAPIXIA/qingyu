/**
 * 在线公告 IPC 接口
 *
 * - announcement:fetchList    获取公告列表
 * - announcement:fetchDetail  获取公告详情
 * - announcement:getServerUrl 获取公告服务器地址
 * - announcement:setServerUrl 设置公告服务器地址
 */

import type { IpcMain } from 'electron'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { DIRS, readJson, writeJson } from '../services/storage'
import { createLogger } from '../services/logger'
import { isSafeUrl } from '../utils/pathGuard'
import type { Announcement } from '../../shared/types'

const log = createLogger('announcement-ipc')

/** 默认公告服务器地址 */
const DEFAULT_SERVER_URL = 'http://cjbtj.xyz'

/** 公告服务器 URL 存储文件 */
const ANNOUNCE_CONFIG_FILE = () => join(DIRS.config(), 'announce-config.json')

/** 公告缓存文件 */
const ANNOUNCE_CACHE_FILE = () => join(DIRS.config(), 'announcements-cache.json')

/** 读取服务器 URL */
function getServerUrl(): string {
  const config = readJson<{ serverUrl: string }>(ANNOUNCE_CONFIG_FILE())
  return config?.serverUrl || DEFAULT_SERVER_URL
}

/** 设置服务器 URL */
function setServerUrl(url: string): void {
  writeJson(ANNOUNCE_CONFIG_FILE(), { serverUrl: url })
}

/** 发起 HTTP GET 请求 */
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    mod.get(url, { timeout: 10000 }, (res: import('node:http').IncomingMessage) => {
      const statusCode = res.statusCode ?? 0
      if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
        res.resume()
        return httpGet(res.headers.location).then(resolve, reject)
      }
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        if (statusCode >= 200 && statusCode < 300) {
          resolve(data)
        } else {
          res.resume()
          reject(new Error(`HTTP ${statusCode}`))
        }
      })
    }).on('error', reject).on('timeout', function(this: import('node:http').ClientRequest) { this.destroy(); reject(new Error('请求超时')) })
  })
}

/** 读取缓存 */
function readCache(): Announcement[] {
  return readJson<Announcement[]>(ANNOUNCE_CACHE_FILE()) ?? []
}

/** 写入缓存 */
function writeCache(items: Announcement[]): void {
  writeJson(ANNOUNCE_CACHE_FILE(), items)
}

/** 注册公告 IPC 处理器 */
export function registerAnnouncementIPC(ipcMain: IpcMain): void {
  // 获取公告列表
  ipcMain.handle('announcement:fetchList', async (_e, page = 1, pageSize = 20) => {
    // 参数校验（防 URL 参数注入/超长请求）
    const safePage = Number.isFinite(page) && page >= 1 ? Math.min(Math.floor(page), 100000) : 1
    const safeSize = Number.isFinite(pageSize) && pageSize >= 1 ? Math.min(Math.floor(pageSize), 100) : 20
    const baseUrl = getServerUrl()
    const url = `${baseUrl}/api/announcements?page=${safePage}&pageSize=${safeSize}`

    try {
      const body = await httpGet(url)
      const data = JSON.parse(body)
      // 缓存列表（仅缓存 items，离线备用）
      if (data.items) {
        writeCache(data.items)
      }
      return data
    } catch (err) {
      log.warn('获取公告列表失败，使用缓存', { error: err instanceof Error ? err.message : String(err) })
      const cached = readCache()
      return { items: cached, total: cached.length, page: safePage, pageSize: safeSize }
    }
  })

  // 获取公告详情
  ipcMain.handle('announcement:fetchDetail', async (_e, id: number) => {
    // 参数校验：id 必须为正整数（防 URL 路径注入）
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('公告 ID 无效')
    }
    const baseUrl = getServerUrl()
    const url = `${baseUrl}/api/announcements/${id}`

    try {
      const body = await httpGet(url)
      return JSON.parse(body) as Announcement
    } catch (err) {
      log.warn('获取公告详情失败，使用缓存', { id, error: err instanceof Error ? err.message : String(err) })
      const cached = readCache()
      return cached.find((a) => a.id === id) ?? null
    }
  })

  // 获取服务器地址
  ipcMain.handle('announcement:getServerUrl', async () => {
    return getServerUrl()
  })

  // 设置服务器地址
  ipcMain.handle('announcement:setServerUrl', async (_e, url: string) => {
    if (!isSafeUrl(url)) {
      throw new Error('URL 不安全：拒绝私有 IP、localhost 或非 HTTP(S) 协议')
    }
    setServerUrl(url)
  })

  // 检查最新版本
  ipcMain.handle('app:checkVersion', async () => {
    const baseUrl = getServerUrl()
    const url = `${baseUrl}/api/version`

    try {
      const body = await httpGet(url)
      return JSON.parse(body) as { version: string; changelog: string; downloadUrl: string }
    } catch (err) {
      log.warn('检查版本失败', { error: err instanceof Error ? err.message : String(err) })
      return null
    }
  })

  log.info('公告 IPC 已注册')
}
