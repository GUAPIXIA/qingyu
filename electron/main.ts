import { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, session } from 'electron'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { registerCharacterIPC } from './ipc/character'
import { registerChatIPC } from './ipc/chat'
import { registerSettingsIPC } from './ipc/settings'
import { registerLorebookIPC } from './ipc/lorebook'
import { registerEmbeddingIPC } from './ipc/embedding'
import { registerQuickReplyIPC } from './ipc/quickReply'
import { registerPresetIPC } from './ipc/preset'
import { registerAIIPC } from './services/ai'
import { registerTTSIPC, killTTS } from './ipc/tts'
import { registerImageGenIPC } from './ipc/imageGen'
import { registerFileIPC } from './ipc/file'
import { registerRegexIPC } from './ipc/regex'
import { registerPersonaIPC } from './ipc/persona'
import { registerUsageIPC } from './ipc/usage'
import { registerMcpIPC } from './ipc/mcp'
import { registerGroupIPC } from './ipc/group'
import { registerAnnouncementIPC } from './ipc/announcement'
import { registerBridgeIPC, bridgeService } from './bridge'
import { IPC_EVENTS } from '../shared/ipc-channels'
import { mcpManager } from './mcp/manager'
import { ensureDataDir, DIRS } from './services/storage'
import { initLogger, createLogger, getRecentLogs } from './services/logger'
import { sanitizeApiKey } from './utils/pathGuard'

// 注册 tavern:// 自定义协议为标准协议（必须在 app.ready 之前）
protocol.registerSchemesAsPrivileged([
  { scheme: 'tavern', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

const isDev = !app.isPackaged

// 全局错误兜底：捕获未处理的 Promise rejection 和未捕获异常，避免静默丢失
process.on('unhandledRejection', (reason) => {
  const logger = createLogger('process')
  if (reason instanceof Error) {
    logger.error('未处理的 Promise rejection', { error: reason.message, stack: reason.stack?.split('\n').slice(0, 5).join(' | ') })
  } else {
    logger.error('未处理的 Promise rejection', { reason: String(reason) })
  }
})

process.on('uncaughtException', (err) => {
  const logger = createLogger('process')
  logger.error('未捕获的异常', { error: err.message, stack: err.stack?.split('\n').slice(0, 5).join(' | ') })
})

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1a1625',
    title: '轻语',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  // 外部链接用系统浏览器打开（仅允许 http/https）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // 页面内导航防护：仅允许应用自身 URL（dev: vite 服务；prod: 本地 index.html），
  // 其余一律拦截并用系统浏览器打开。
  // 防止 AI 消息/角色卡中的 Markdown 链接（<a href> 点击触发页面导航）把主窗口导航到外部站点
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed =
      (isDev && url.startsWith('http://localhost:5173')) ||
      (!isDev && url.startsWith('file://') && url.includes('/dist/index.html'))
    if (!allowed) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url)
      }
    }
  })
}

app.whenReady().then(async () => {
  // 生产环境注入 CSP（本地 file:// 页面无响应头，通过 webRequest 注入）
  // 消息/公告渲染即使出现 HTML 注入也有脚本执行兜底限制
  if (!isDev) {
    const CSP = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: tavern: https: http:",
      "font-src 'self' data: file:",
      "connect-src 'self' https: wss:",  // P0-5: 去掉 http:/ws: 防止 XSS 绕过后外发数据到内网/攻击者服务器
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ')
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CSP],
        },
      })
    })
  }

  // 移除默认菜单栏（帮助、窗口等）
  Menu.setApplicationMenu(null)
  // 显式设置应用名称（控制左上角标题栏显示）
  app.setName('轻语')

  await ensureDataDir()

  // 注册 tavern:// 协议处理器：角色图片直接从磁盘按需加载，不经 base64/IPC
  const charDir = DIRS.characters()
  protocol.handle('tavern', (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'character') {
      return new Response('Not found', { status: 404 })
    }
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length !== 2) return new Response('Bad request', { status: 400 })
    const [id, kind] = parts
    // 路径穿越防护：只允许字母、数字、下划线、短横线
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return new Response('Forbidden', { status: 403 })
    if (kind !== 'avatar' && kind !== 'cover') return new Response('Bad request', { status: 400 })

    const mimeTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
    const extensions = ['png', 'jpg', 'jpeg', 'gif', 'webp']
    // cover 请求先找 _cover 文件，找不到回退到 avatar 文件（与原 cover||avatar 逻辑一致）
    const suffixes = kind === 'cover' ? ['_cover', ''] : ['']
    for (const suffix of suffixes) {
      for (const ext of extensions) {
        const filePath = join(charDir, `${id}${suffix}.${ext}`)
        if (existsSync(filePath)) {
          return new Response(new Uint8Array(readFileSync(filePath)), { headers: { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' } })
        }
      }
    }
    return new Response('Not found', { status: 404 })
  })

  initLogger(app.getPath('userData'))

  const appLogger = createLogger('main')
  appLogger.info('轻语启动', { version: app.getVersion(), isDev })

  // 拦截 ipcMain.handle，统一捕获所有 IPC 处理器异常并记录（不吞错误，仍向渲染进程抛出）
  const _originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    return _originalHandle(channel, async (event, ...args) => {
      try {
        return await handler(event, ...args)
      } catch (err) {
        const ipcLogger = createLogger('ipc')
        const errMsg = err instanceof Error ? err.message : String(err)
        const errStack = err instanceof Error ? err.stack?.split('\n').slice(0, 5).join(' | ') : undefined
        // 脱敏后记录：错误消息/堆栈可能包含 API Key
        ipcLogger.error(`IPC ${channel} 异常`, { error: sanitizeApiKey(errMsg), ...(errStack ? { stack: sanitizeApiKey(errStack) } : {}) })
        throw err
      }
    })
  }) as typeof ipcMain.handle

  // 注册所有 IPC 处理器（注册器集中收口：新增 IPC 模块在此登记，防止遗漏）
  const ipcRegistrars: Array<() => void> = [
    () => registerCharacterIPC(ipcMain, dialog),
    () => registerChatIPC(ipcMain),
    () => registerSettingsIPC(ipcMain, dialog),
    () => registerLorebookIPC(ipcMain, dialog),
    () => registerEmbeddingIPC(ipcMain),
    () => registerQuickReplyIPC(ipcMain, dialog),
    () => registerPresetIPC(ipcMain, dialog),
    () => registerAIIPC(ipcMain),
    () => registerTTSIPC(ipcMain),
    () => registerImageGenIPC(ipcMain),
    () => registerFileIPC(ipcMain, dialog, app),
    () => registerRegexIPC(ipcMain),
    () => registerPersonaIPC(ipcMain),
    () => registerUsageIPC(ipcMain),
    () => registerMcpIPC(ipcMain),
    () => registerGroupIPC(ipcMain),
    () => registerAnnouncementIPC(ipcMain),
    () => registerBridgeIPC(ipcMain),
  ]
  for (const register of ipcRegistrars) {
    register()
  }

  // 阶段 0c + 阶段一：会话变更事件总线——渲染层上报 session:changed -> 广播 session:updated
  // 给**其他**窗口（排除来源窗口，避免发送者自我刷新打断对话）+ 桥接层转推 WS（安卓端实时同步）
  ipcMain.on(IPC_EVENTS.sessionChanged, (event, payload: { sessionId: string; change: string }) => {
    if (!payload || typeof payload.sessionId !== 'string') return
    for (const win of BrowserWindow.getAllWindows()) {
      // 排除来源窗口：发送者不需要（也不应）收到自己的变更通知
      if (win.isDestroyed() || !win.webContents || win.webContents === event.sender) continue
      win.webContents.send(IPC_EVENTS.sessionUpdated, payload)
    }
    bridgeService.broadcastSessionChange(payload.sessionId, payload.change)
  })

  // 应用版本号
  ipcMain.handle('app:getVersion', () => app.getVersion())

  // 打开外部链接（仅允许 http/https）
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) {
      return shell.openExternal(url)
    }
    throw new Error('仅支持 http/https 链接')
  })

  // 自动启动配置为 autoStart 的 MCP server
  const logger = createLogger('main')
  mcpManager.autoStartAll().catch((err) => {
    logger.error('MCP 自动启动失败', { error: err.message })
  })

  // 自动恢复桥接层（重启后 enabled=true 时无需手动在设置页开启）
  try {
    if (bridgeService.getConfig().enabled) {
      bridgeService.start().catch((err) => {
        logger.error('桥接层自动恢复失败', { error: err.message })
      })
    }
  } catch (err) {
    logger.warn('桥接层自动恢复跳过', { error: (err as Error).message })
  }

  // 日志 IPC（level 运行时校验，防止渲染进程传入任意方法名）
  const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'])
  ipcMain.handle('log:write', (_event, level: string, mod: string, message: string, meta?: Record<string, unknown>) => {
    if (!LOG_LEVELS.has(level) || typeof mod !== 'string' || typeof message !== 'string') {
      throw new Error('日志参数无效')
    }
    const logger = createLogger(mod.slice(0, 64))
    if (level === 'debug') logger.debug(message, meta)
    else if (level === 'info') logger.info(message, meta)
    else if (level === 'warn') logger.warn(message, meta)
    else logger.error(message, meta)
  })
  ipcMain.handle('log:getRecent', (_event, limit?: number) => {
    return getRecentLogs(limit || 200)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// L-04 修复：应用退出前关闭所有 MCP server + TTS 进程，等待 pending IPC 写入完成
let isQuitting = false
app.on('before-quit', async (event) => {
  if (isQuitting) return
  isQuitting = true
  event.preventDefault()
  killTTS()
  try {
    await Promise.race([
      mcpManager.shutdownAll(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timeout')), 3000)),
    ])
  } catch { /* ignore */ }
  // 等待 pending IPC 调用（如翻译 saveMessage）完成
  await new Promise(resolve => setTimeout(resolve, 500))
  app.exit(0)
})
