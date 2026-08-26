/**
 * 在线更新服务（electron-updater 封装）
 *
 * 固定双源策略：
 * 1. 官方服务器 latest.yml 与 GitHub Releases 并行检查并分别展示结果；
 * 2. 自动下载与安装始终使用 GitHub Provider，服务器仅提供手动下载。
 *
 * 状态通过 webContents.send 转发给渲染层：
 *   IPC_EVENTS.updaterEvent -> UpdaterState
 *
 * 注意：仅在打包安装（NSIS 安装器）环境下可用；开发模式会在调用底层
 * updater 前明确返回 error 状态。
 */

import type { IpcMain } from 'electron'
import { app, BrowserWindow } from 'electron'
import { createLogger } from './logger'
import { IPC_EVENTS } from '../../shared/ipc-channels'
import type { UpdateSourceResult, UpdaterState } from '../../shared/ipc-api'

const OFFICIAL_SERVER_FEED_URL = 'https://cjbtj.xyz/qingyu/update'
const OFFICIAL_SERVER_LATEST_URL = `${OFFICIAL_SERVER_FEED_URL}/latest.yml`
const GITHUB_PROVIDER = { provider: 'github' as const, owner: 'GUAPIXIA', repo: 'qingyu' }

const logger = createLogger('updater')
let state: UpdaterState = { status: 'idle', message: '' }
// 延迟加载的 electron-updater 实例（避免在开发/单测环境顶层引入副作用）
type AutoUpdater = import('electron-updater').AppUpdater
let autoUpdater: AutoUpdater | null = null

/** checkForUpdates 返回的版本信息（避免直接依赖 builder-util-runtime 类型） */
interface UpdateInfoLike {
  version: string
  releaseNotes?: unknown
  files?: ReadonlyArray<unknown>
  path?: string
  sha512?: string
  releaseDate?: string
}

/** 动态取主窗口（注册时机早于 createWindow，不能缓存窗口引用） */
function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function sendEvent(): void {
  try {
    getMainWindow()?.webContents.send(IPC_EVENTS.updaterEvent, state)
  } catch (err) {
    logger.warn('转发更新事件失败', { err: String(err) })
  }
}

function setState(patch: Partial<UpdaterState>): UpdaterState {
  state = { ...state, ...patch }
  sendEvent()
  return state
}

async function loadAutoUpdater(): Promise<AutoUpdater> {
  if (!autoUpdater) {
    // 动态 import：esbuild 打包为 cjs，运行于主进程
    const mod = await import('electron-updater')
    autoUpdater = mod.autoUpdater
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    bindUpdaterEvents(autoUpdater)
  }
  return autoUpdater
}

function bindUpdaterEvents(updater: AutoUpdater): void {
  updater.on('checking-for-update', () => setState({ status: 'checking', message: '正在检查更新…' }))
  updater.on('download-progress', (progress) => {
    setState({
      status: 'downloading',
      message: '正在下载更新…',
      percent: Math.min(100, Math.round(progress.percent)),
    })
  })
  updater.on('update-downloaded', (info) => {
    setState({
      status: 'downloaded',
      message: '更新已下载完成',
      version: info.version,
    })
  })
  updater.on('error', (err) => {
    logger.error('更新错误', { err: String(err) })
    setState({ status: 'error', message: err?.message || String(err), percent: undefined })
  })
}

/** 从 UpdateInfo 提取展示用更新日志（string 或 GitHub release notes 结构） */
function extractNotes(info: unknown): string | undefined {
  const notes = (info as { releaseNotes?: unknown }).releaseNotes
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    return notes.map((n) => (typeof n === 'object' && n && 'note' in n ? String((n as { note: unknown }).note ?? '') : String(n))).join('\n')
  }
  return undefined
}

function normalizeVersion(value: string): { core: number[]; prerelease: Array<number | string> | null } | null {
  const match = value.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  const prerelease = match[4]
    ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : null
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease }
}

/** 按 SemVer 规则判断 remote 是否高于 local（覆盖项目使用的 alpha/beta/rc 版本）。 */
export function isNewerVersion(local: string, remote: string): boolean {
  const left = normalizeVersion(local)
  const right = normalizeVersion(remote)
  if (!left || !right) return false
  for (let index = 0; index < 3; index += 1) {
    if (right.core[index] !== left.core[index]) return right.core[index] > left.core[index]
  }
  if (left.prerelease === null) return false
  if (right.prerelease === null) return true
  const max = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < max; index += 1) {
    const l = left.prerelease[index]
    const r = right.prerelease[index]
    if (l === undefined) return true
    if (r === undefined) return false
    if (l === r) continue
    if (typeof l === 'number' && typeof r === 'string') return true
    if (typeof l === 'string' && typeof r === 'number') return false
    return r > l
  }
  return false
}

function yamlValue(body: string, key: string): string | undefined {
  const match = body.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'))
  if (!match) return undefined
  const value = match[1].trim()
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1)
  }
  return value
}

/** 解析 electron-builder 生成的 latest.yml 中本功能所需的最小字段。 */
export function parseServerLatestYaml(body: string): { version: string; downloadUrl: string } {
  const version = yamlValue(body, 'version')
  const filePath = yamlValue(body, 'path') ?? body.match(/^\s*-\s+url:\s*(.+?)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, '')
  if (!version || !normalizeVersion(version)) throw new Error('服务器更新清单版本号无效')
  if (!filePath) throw new Error('服务器更新清单缺少安装包路径')

  const feedUrl = new URL(`${OFFICIAL_SERVER_FEED_URL}/`)
  const downloadUrl = new URL(filePath, feedUrl)
  if (downloadUrl.protocol !== 'https:' || downloadUrl.origin !== feedUrl.origin || !downloadUrl.pathname.startsWith(feedUrl.pathname)) {
    throw new Error('服务器更新清单包含不安全的安装包地址')
  }
  return { version, downloadUrl: downloadUrl.toString() }
}

async function checkServerLatest(currentVersion: string): Promise<UpdateSourceResult> {
  try {
    const response = await fetch(OFFICIAL_SERVER_LATEST_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const parsed = parseServerLatestYaml(await response.text())
    return {
      status: isNewerVersion(currentVersion, parsed.version) ? 'available' : 'none',
      version: parsed.version,
      downloadUrl: parsed.downloadUrl,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('服务器更新清单获取失败', { err: message })
    return { status: 'error', message }
  }
}

async function checkGitHub(updater: AutoUpdater): Promise<UpdateSourceResult> {
  updater.setFeedURL(GITHUB_PROVIDER)
  try {
    const result = await updater.checkForUpdates()
    if (!result) return { status: 'error', message: 'GitHub 更新服务未返回检查结果' }
    const info = result.updateInfo as UpdateInfoLike | undefined
    if (!info?.version) return { status: 'error', message: 'GitHub 更新清单缺少版本号' }
    return {
      status: result.isUpdateAvailable ? 'available' : 'none',
      version: info.version,
      releaseNotes: extractNotes(info),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('GitHub 更新检查失败', { err: message })
    return { status: 'error', message }
  }
}

/** 并行检查官方服务器与 GitHub；自动下载 Provider 始终保持 GitHub。 */
export async function checkForUpdates(): Promise<UpdaterState> {
  setState({
    status: 'checking',
    message: '正在检查服务器与 GitHub…',
    percent: undefined,
    version: undefined,
    releaseNotes: undefined,
    server: undefined,
    github: undefined,
    hasAvailableUpdate: false,
  })

  if (!app.isPackaged) {
    return setState({ status: 'error', message: '当前环境不支持在线更新（开发模式请手动构建安装包）' })
  }

  let updater: AutoUpdater
  try {
    updater = await loadAutoUpdater()
  } catch (err) {
    logger.error('加载 electron-updater 失败', { err: String(err) })
    return setState({ status: 'error', message: '当前环境不支持在线更新（开发模式请手动构建安装包）' })
  }

  const currentVersion = app.getVersion()
  const [server, github] = await Promise.all([
    checkServerLatest(currentVersion),
    checkGitHub(updater),
  ])
  const hasAvailableUpdate = server.status === 'available' || github.status === 'available'

  if (server.status === 'error' && github.status === 'error') {
    return setState({
      status: 'error',
      message: `检查更新失败（服务器：${server.message}；GitHub：${github.message}）`,
      server,
      github,
      hasAvailableUpdate: false,
      percent: undefined,
    })
  }

  if (!hasAvailableUpdate) {
    const partialError = server.status === 'error'
      ? '（服务器获取失败）'
      : github.status === 'error'
        ? '（GitHub 获取失败）'
        : ''
    return setState({
      status: 'none',
      message: `未发现新版本${partialError}`,
      server,
      github,
      hasAvailableUpdate: false,
      percent: undefined,
    })
  }

  const preferred = github.status === 'available' ? github : server
  return setState({
    status: 'available',
    message: github.status === 'available'
      ? '发现新版本，可通过 GitHub 自动更新'
      : '服务器已发布新版本，GitHub 暂未同步',
    version: preferred.version,
    releaseNotes: github.releaseNotes,
    server,
    github,
    hasAvailableUpdate: true,
    percent: undefined,
  })
}

/** 下载更新（进度经 download-progress 事件推送） */
export async function downloadUpdate(): Promise<UpdaterState> {
  if (!autoUpdater || state.github?.status !== 'available') {
    return setState({ status: 'error', message: 'GitHub 没有可自动下载的更新，请先检查更新' })
  }
  try {
    autoUpdater.setFeedURL(GITHUB_PROVIDER)
    await autoUpdater.downloadUpdate()
    return state
  } catch (err) {
    logger.error('下载更新失败', { err: String(err) })
    return setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

/** 退出并安装更新 */
export function installUpdate(): void {
  if (state.status === 'downloaded') {
    autoUpdater?.quitAndInstall(true, true)
  }
}

/** 当前状态快照 */
export function getState(): UpdaterState {
  return state
}

/** 注册 IPC（main.ts 在 app.whenReady 后调用一次） */
export function registerUpdaterIPC(ipcMain: IpcMain): void {
  ipcMain.handle('updater:check', () => checkForUpdates())
  ipcMain.handle('updater:download', () => downloadUpdate())
  ipcMain.handle('updater:install', () => {
    installUpdate()
  })
  ipcMain.handle('updater:getState', () => getState())
}
