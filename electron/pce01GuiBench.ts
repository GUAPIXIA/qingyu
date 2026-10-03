/**
 * PCE-01 GUI A/B 取证 harness（阶段 2 补充门禁）。
 *
 * 在真实 Electron 主进程内测量用户可感知 wall-clock：
 * - 冷启动（process start → window ready-to-show）
 * - 设置保存（writeThroughDomain，与 settings:save 同路径）
 * - 消息发送 / 编辑（appendMessage，与 chat:saveMessage 同路径）
 * - 打开会话（readMessages，与 chat:listMessages 同路径）
 *
 * 同时做无弹窗 / 无业务后台网络 / 核心旅程 smoke。
 * 仅当 process.env.PCE01_GUI_BENCH === '1' 时执行；默认零开销。
 */
import { app, BrowserWindow, dialog, session } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Message } from '../shared/types'

const PROC_START_MS = Date.now() - Math.round(process.uptime() * 1000)

type Arm = 'A' | 'B'

export interface GuiBenchReport {
  arm: Arm
  userData: string
  coldStart: {
    processStartToReadyMs: number | null
    processStartToWindowMs: number | null
    readyToWindowMs: number | null
  }
  ops: Record<string, { n: number; min: number; median: number; p95: number; max: number; mean: number }>
  smoke: {
    dialogsShown: number
    dialogTitles: string[]
    networkRequests: number
    networkUrls: string[]
    migrationWizardLike: boolean
    bootstrapLogHits: number
    coreJourney: {
      characterSaved: boolean
      sessionOpened: boolean
      messageSaved: boolean
      messageEdited: boolean
      settingsSaved: boolean
      filesOnDisk: string[]
    }
    needsFullRescanProbe?: {
      corruptedMeta: boolean
      localWriteStillWorks: boolean
      healthNeedsFullRescan: boolean
    }
  }
  notes: string[]
}

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b)
  const q = (p: number) => {
    if (!s.length) return 0
    const i = (s.length - 1) * p
    const lo = Math.floor(i)
    const hi = Math.ceil(i)
    return s[lo] + (s[hi] - s[lo]) * (i - lo)
  }
  return {
    n: s.length,
    min: +(s[0] ?? 0).toFixed(3),
    median: +q(0.5).toFixed(3),
    p95: +q(0.95).toFixed(3),
    max: +(s[s.length - 1] ?? 0).toFixed(3),
    mean: +(s.reduce((a, b) => a + b, 0) / (s.length || 1)).toFixed(3),
  }
}

function makeMessage(characterId: string, sessionId: string, id: string, role: Message['role'], content: string): Message {
  return {
    id,
    sessionId,
    characterId,
    role,
    content,
    images: [],
    isEditing: false,
    timestamp: Date.now(),
  }
}

function sample(name: string, samples: number[], fn: () => void, iter: number, warmup = 3) {
  for (let i = 0; i < warmup; i++) fn()
  for (let i = 0; i < iter; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  void name
}

let readyAtMs: number | null = null
let windowAtMs: number | null = null

/** main.ts 在 app ready 后调用一次。默认 no-op。 */
export function schedulePce01GuiBench(): void {
  if (process.env.PCE01_GUI_BENCH !== '1') return
  readyAtMs = Date.now()
  // 等主窗口 ready-to-show 再开跑，保证冷启动覆盖真实 UI 路径
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    if (windowAtMs == null) windowAtMs = Date.now()
    setTimeout(() => void runBench().catch((err) => failBench(err)), 300)
    return
  }
  app.on('browser-window-created', (_e, w) => {
    w.once('ready-to-show', () => {
      if (windowAtMs == null) windowAtMs = Date.now()
      setTimeout(() => void runBench().catch((err) => failBench(err)), 300)
    })
  })
}

function failBench(err: unknown): void {
  const out = process.env.PCE01_OUT || join(process.cwd(), 'output', 'pce01', 'gui-bench-fail.json')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify({ ok: false, error: String(err) }, null, 2), 'utf8')
  console.error('[pce01-gui] FAIL', err)
  app.exit(1)
}

async function runBench(): Promise<void> {
  const arm = (process.env.PCE01_ARM === 'B' ? 'B' : 'A') as Arm
  const userData = app.getPath('userData')
  const iter = Number(process.env.PCE01_ITER ?? 25)
  const outPath = process.env.PCE01_OUT || join(process.cwd(), 'output', 'pce01', `gui-bench-${arm}.json`)
  const runSmoke = process.env.PCE01_SMOKE !== '0'
  const notes: string[] = []

  // ---- 监听：弹窗 / 网络 ----
  const dialogsShown: string[] = []
  for (const key of ['showMessageBox', 'showMessageBoxSync', 'showOpenDialog', 'showSaveDialog', 'showErrorBox'] as const) {
    const orig = (dialog as unknown as Record<string, unknown>)[key]
    if (typeof orig !== 'function') continue
    ;(dialog as unknown as Record<string, unknown>)[key] = (..._args: unknown[]) => {
      dialogsShown.push(String(key))
      notes.push(`dialog:${key}`)
      // bench 中阻断真实弹窗，避免挂死
      if (key === 'showMessageBoxSync' || key === 'showErrorBox') return 0
      return Promise.resolve({ canceled: true, filePaths: [], response: 0 })
    }
  }

  const networkUrls: string[] = []
  try {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
      networkUrls.push(details.url)
      cb({ cancel: false })
    })
  } catch {
    notes.push('webRequest hook failed')
  }

  // ---- 动态 import 生产写路径 ----
  const chat = await import('./ipc/chat')
  const { writeThroughDomain, getSyncHealth, isSyncReady } = await import('./domain/syncDomainService')
  const { readSettingsFromDisk } = await import('./ipc/settings')
  void readSettingsFromDisk

  const characterId = 'pce01-char'
  const sessionId = 'pce01-sess'
  const charDir = join(userData, 'data', 'characters')
  const sessDir = join(userData, 'data', 'chats', characterId)
  mkdirSync(charDir, { recursive: true })
  mkdirSync(sessDir, { recursive: true })

  // ---- 冷启动样本（本轮进程）----
  const coldStart = {
    processStartToReadyMs: readyAtMs != null ? readyAtMs - PROC_START_MS : null,
    processStartToWindowMs: windowAtMs != null ? windowAtMs - PROC_START_MS : null,
    readyToWindowMs: readyAtMs != null && windowAtMs != null ? windowAtMs - readyAtMs : null,
  }

  const ops: Record<string, number[]> = {
    settingsSave: [],
    messageSend: [],
    messageEdit: [],
    openSession: [],
  }

  // ---- 热路径 ----
  const settingsPath = join(userData, 'data', 'config', 'settings.json')
  sample('settingsSave', ops.settingsSave, () => {
    writeThroughDomain({
      domain: 'settings_public',
      entityType: 'settings_public',
      entityId: 'settings-public',
      payload: { theme: 'dark', bench: true, at: Date.now() },
      schemaVersion: 1,
      files: [{ path: settingsPath, content: JSON.stringify({ theme: 'dark', bench: true, at: Date.now() }) }],
    })
  }, iter)

  // 预置会话消息文件（已有 10k 时 openSession 测真实读）
  const msgFile = join(sessDir, `${sessionId}.jsonl`)
  if (!existsSync(msgFile)) {
    // 最小种子，保证 openSession 有对象
    chat.appendMessage(characterId, sessionId, makeMessage(characterId, sessionId, 'seed-1', 'user', '种子消息'))
  }

  sample('messageSend', ops.messageSend, () => {
    const id = `m-send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    chat.appendMessage(characterId, sessionId, makeMessage(characterId, sessionId, id, 'user', `发送 ${id}`))
  }, iter)

  const editId = `m-edit-${Date.now()}`
  chat.appendMessage(characterId, sessionId, makeMessage(characterId, sessionId, editId, 'assistant', '待编辑'))
  sample('messageEdit', ops.messageEdit, () => {
    chat.appendMessage(characterId, sessionId, makeMessage(characterId, sessionId, editId, 'assistant', `编辑于 ${Date.now()}`))
  }, iter)

  sample('openSession', ops.openSession, () => {
    // 强制绕过读缓存，测「打开会话」真实文件读路径
    const msgs = chat.readMessages(characterId, sessionId, true)
    if (!Array.isArray(msgs)) throw new Error('readMessages 未返回数组')
  }, Math.min(iter, 15), 2)

  // ---- 核心旅程 smoke ----
  const filesOnDisk: string[] = []
  let characterSaved = false
  let sessionOpened = false
  let messageSaved = false
  let messageEdited = false
  let settingsSaved = false

  if (runSmoke) {
    const charPath = join(charDir, 'pce01-char.json')
    writeThroughDomain({
      domain: 'character',
      entityType: 'character',
      entityId: characterId,
      payload: { id: characterId, name: 'PCE01', description: 'bench' },
      schemaVersion: 1,
      files: [{ path: charPath, content: JSON.stringify({ id: characterId, name: 'PCE01', description: 'bench' }) }],
    })
    characterSaved = existsSync(charPath)
    if (characterSaved) filesOnDisk.push(charPath)

    const list = chat.readMessages(characterId, sessionId)
    sessionOpened = Array.isArray(list) && list.length > 0

    const smokeMsg = makeMessage(characterId, sessionId, `smoke-${Date.now()}`, 'user', 'smoke 发送')
    chat.appendMessage(characterId, sessionId, smokeMsg)
    messageSaved = chat.readMessages(characterId, sessionId).some((m) => m.id === smokeMsg.id)

    chat.appendMessage(characterId, sessionId, { ...smokeMsg, content: 'smoke 编辑后' })
    const afterEdit = chat.readMessages(characterId, sessionId).find((m) => m.id === smokeMsg.id)
    messageEdited = afterEdit?.content === 'smoke 编辑后'

    writeThroughDomain({
      domain: 'settings_public',
      entityType: 'settings_public',
      entityId: 'settings-public',
      payload: { theme: 'dark', smoke: true },
      schemaVersion: 1,
      files: [{ path: settingsPath, content: JSON.stringify({ theme: 'dark', smoke: true }) }],
    })
    settingsSaved = existsSync(settingsPath)
    if (settingsSaved) filesOnDisk.push(settingsPath)
    if (existsSync(msgFile)) filesOnDisk.push(msgFile)
  }

  // ---- needsFullRescan 探针（可选，B 臂更有意义）----
  let needsFullRescanProbe: GuiBenchReport['smoke']['needsFullRescanProbe']
  if (process.env.PCE01_RESCAN_PROBE === '1') {
    const { markNeedsFullRescan } = await import('./domain/syncDomainService')
    markNeedsFullRescan('pce01-gui-probe', userData)
    const health = getSyncHealth(userData)
    // 本地写仍应成功
    let localWriteStillWorks = true
    try {
      chat.appendMessage(characterId, sessionId, makeMessage(characterId, sessionId, `rescan-${Date.now()}`, 'user', 'rescan probe'))
    } catch {
      localWriteStillWorks = false
    }
    needsFullRescanProbe = {
      corruptedMeta: false,
      localWriteStillWorks,
      healthNeedsFullRescan: health.needsFullRescan === true && isSyncReady(userData) === false,
    }
  }

  const bootstrapLogHits = 0 // bootstrap 仅 flag 开启时发生；由编排脚本对照 userData 文件判定
  const migrationWizardLike = dialogsShown.some((d) => d.includes('MessageBox') || d.includes('dialog'))

  const report: GuiBenchReport = {
    arm,
    userData,
    coldStart,
    ops: Object.fromEntries(
      Object.entries(ops).map(([k, v]) => [k, stats(v)]),
    ),
    smoke: {
      dialogsShown: dialogsShown.length,
      dialogTitles: dialogsShown,
      networkRequests: networkUrls.length,
      networkUrls: networkUrls.slice(0, 20),
      migrationWizardLike,
      bootstrapLogHits,
      coreJourney: {
        characterSaved,
        sessionOpened,
        messageSaved,
        messageEdited,
        settingsSaved,
        filesOnDisk,
      },
      needsFullRescanProbe,
    },
    notes,
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8')
  console.log('[pce01-gui] wrote', outPath, { arm, coldStart, ops: report.ops })
  // 给渲染层一点落盘时间再退出
  setTimeout(() => app.exit(0), 200)
}
