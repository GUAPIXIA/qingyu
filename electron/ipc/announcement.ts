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
import { existsSync } from 'node:fs'
import { DIRS, readJson, writeJson } from '../services/storage'
import { createLogger } from '../services/logger'
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
    const mod = url.startsWith('https') ? require('node:https') : require('node:http')
    mod.get(url, { timeout: 10000 }, (res: any) => {
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data)
        } else {
          reject(new Error(`HTTP ${res.statusCode}`))
        }
      })
    }).on('error', reject).on('timeout', function(this: any) { this.destroy(); reject(new Error('请求超时')) })
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
    const baseUrl = getServerUrl()
    const url = `${baseUrl}/api/announcements?page=${page}&pageSize=${pageSize}`

    try {
      const body = await httpGet(url)
      const data = JSON.parse(body)
      // 缓存列表（仅缓存 items，离线备用）
      if (data.items) {
        writeCache(data.items)
      }
      return data
    } catch (err: any) {
      log.warn('获取公告列表失败，使用缓存', { error: err.message })
      const cached = readCache()
      return { items: cached, total: cached.length, page, pageSize }
    }
  })

  // 获取公告详情
  ipcMain.handle('announcement:fetchDetail', async (_e, id: number) => {
    const baseUrl = getServerUrl()
    const url = `${baseUrl}/api/announcements/${id}`

    try {
      const body = await httpGet(url)
      return JSON.parse(body) as Announcement
    } catch (err: any) {
      log.warn('获取公告详情失败，使用缓存', { id, error: err.message })
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
    setServerUrl(url)
  })

  // 检查最新版本
  ipcMain.handle('app:checkVersion', async () => {
    const baseUrl = getServerUrl()
    const url = `${baseUrl}/api/version`

    try {
      const body = await httpGet(url)
      return JSON.parse(body) as { version: string; changelog: string; downloadUrl: string }
    } catch (err: any) {
      log.warn('检查版本失败', { error: err.message })
      return null
    }
  })

  log.info('公告 IPC 已注册')
}
