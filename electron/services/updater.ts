/**
 * 在线更新服务（electron-updater 封装）
 *
 * 双通道策略：
 * 1. 镜像源优先 —— 自托管公告服务端的静态目录（generic provider），
 *    国内用户下载快；未配置或检查失败时自动回退。
 * 2. GitHub Releases 兜底 —— CI 自动发版的权威来源。
 *
 * 状态通过 webContents.send 转发给渲染层：
 *   IPC_EVENTS.updaterEvent -> UpdaterState
 *
 * 注意：仅在打包安装（NSIS 安装器）环境下可用；开发模式下 checkForUpdates
 * 会抛出异常，统一捕获后以 error 状态上报。
 */

import type { IpcMain } from 'electron'
import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { DIRS, readJson, writeJson } from './storage'
import { createLogger } from './logger'
import { IPC_EVENTS } from '../../shared/ipc-channels'
import type { UpdateMirrorConfig, UpdaterStatus } from '../../shared/ipc-api'

/** 更新镜像源配置文件 */
const UPDATE_CONFIG_FILE = () => join(DIRS.config(), 'update-config.json')

/** 默认镜像源：留空表示未启用（仅走 GitHub Releases） */
const DEFAULT_MIRROR_URL = ''

interface UpdaterState {
  status: UpdaterStatus
  /** 当前状态说明 / 错误消息 */
  message: string
  /** 可用的新版本号 */
  version?: string
  /** 更新日志 */
  releaseNotes?: string
  /** 下载进度百分比（downloading 状态时有效） */
  percent?: number
  /** 本次结果来源 */
  source?: 'mirror' | 'github'
}

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

/** 读取镜像源配置 */
export function getMirrorConfig(): UpdateMirrorConfig {
  return readJson<UpdateMirrorConfig>(UPDATE_CONFIG_FILE()) ?? { mirrorUrl: DEFAULT_MIRROR_URL }
}

/** 写入镜像源配置（URL 做协议白名单校验） */
export function setMirrorConfig(config: UpdateMirrorConfig): void {
  const mirrorUrl = (config.mirrorUrl || '').trim()
  if (mirrorUrl && !/^https?:\/\/[^\s]+$/i.test(mirrorUrl)) {
    throw new Error('镜像地址必须是 http/https 链接')
  }
  writeJson(UPDATE_CONFIG_FILE(), { mirrorUrl })
}

/** 极简 semver 比较：主干按数值逐段比较；预发布后缀低于正式版，预发布之间字符串比较 */
export function semverGt(a: string, b: string): boolean {
  const [coreA, preA] = a.split('-')
  const [coreB, preB] = b.split('-')
  const pa = coreA.split('.').map(Number)
  const pb = coreB.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const na = Number.isFinite(pa[i]) ? pa[i] : 0
    const nb = Number.isFinite(pb[i]) ? pb[i] : 0
    if (na !== nb) return na > nb
  }
  if (preA && !preB) return false
  if (!preA && preB) return true
  if (preA && preB) return preA > preB
  return false
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

/**
 * 通过指定 provider 检查一次更新。
 * 返回发现的新版本信息（无更新或检查失败返回 null）。
 */
async function checkWithFeed(updater: AutoUpdater, feed: { url?: string }): Promise<UpdateInfoLike | null> {
  updater.setFeedURL(
    feed.url
      ? { provider: 'generic', url: feed.url }
      : { provider: 'github', owner: 'GUAPIXIA', repo: 'qingyu' },
  )
  try {
    const result = await updater.checkForUpdates()
    const info = result?.updateInfo
    if (!info?.version) return null
    return semverGt(info.version, updater.currentVersion.version) ? info : null
  } catch (err) {
    logger.warn('检查更新失败', { feed: feed.url ?? 'github', err: String(err) })
    return null
  }
}

/** 检查更新：镜像源优先，GitHub 回退 */
export async function checkForUpdates(): Promise<UpdaterState> {
  setState({ status: 'checking', message: '正在检查更新…', percent: undefined, version: undefined, releaseNotes: undefined })

  let updater: AutoUpdater
  try {
    updater = await loadAutoUpdater()
  } catch (err) {
    logger.error('加载 electron-updater 失败', { err: String(err) })
    return setState({ status: 'error', message: '当前环境不支持在线更新（开发模式请手动构建安装包）' })
  }

  const { mirrorUrl } = getMirrorConfig()

  // 1) 镜像源优先
  if (mirrorUrl) {
    setState({ message: '正在从镜像源检查更新…', source: 'mirror' })
    const info = await checkWithFeed(updater, { url: mirrorUrl })
    if (info) {
      return setState({
        status: 'available',
        message: `发现新版本 ${info.version}`,
        version: info.version,
        releaseNotes: extractNotes(info),
        source: 'mirror',
        percent: undefined,
      })
    }
  }

  // 2) GitHub Releases 兜底
  setState({ message: '正在从 GitHub 检查更新…', source: 'github' })
  const info = await checkWithFeed(updater, {})
  if (!info) {
    return setState({ status: 'none', message: '已是最新版本', percent: undefined, source: undefined })
  }
  return setState({
    status: 'available',
    message: `发现新版本 ${info.version}`,
    version: info.version,
    releaseNotes: extractNotes(info),
    source: 'github',
    percent: undefined,
  })
}

/** 下载更新（进度经 download-progress 事件推送） */
export async function downloadUpdate(): Promise<UpdaterState> {
  if (!autoUpdater || state.status !== 'available') {
    return setState({ status: 'error', message: '没有可下载的更新，请先检查更新' })
  }
  try {
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
    autoUpdater?.quitAndInstall(false, true)
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
  ipcMain.handle('updater:getMirror', () => getMirrorConfig())
  ipcMain.handle('updater:setMirror', (_e, config: UpdateMirrorConfig) => {
    setMirrorConfig(config)
  })
}
