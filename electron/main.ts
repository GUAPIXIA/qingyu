import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron'
import { join } from 'node:path'
import { registerCharacterIPC } from './ipc/character'
import { registerChatIPC } from './ipc/chat'
import { registerSettingsIPC } from './ipc/settings'
import { registerLorebookIPC } from './ipc/lorebook'
import { registerPresetIPC } from './ipc/preset'
import { registerAIIPC } from './services/ai'
import { registerTTSIPC } from './ipc/tts'
import { registerImageGenIPC } from './ipc/imageGen'
import { registerFileIPC } from './ipc/file'
import { registerRegexIPC } from './ipc/regex'
import { registerPersonaIPC } from './ipc/persona'
import { registerUsageIPC } from './ipc/usage'
import { registerMcpIPC } from './ipc/mcp'
import { registerGroupIPC } from './ipc/group'
import { mcpManager } from './mcp/manager'
import { ensureDataDir } from './services/storage'
import { initLogger, createLogger, getRecentLogs } from './services/logger'

const isDev = !app.isPackaged

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
      sandbox: false,
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

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(async () => {
  // 移除默认菜单栏（帮助、窗口等）
  Menu.setApplicationMenu(null)
  // 显式设置应用名称（控制左上角标题栏显示）
  app.setName('轻语')

  await ensureDataDir()
  initLogger(app.getPath('userData'))

  const appLogger = createLogger('main')
  appLogger.info('轻语启动', { version: app.getVersion(), isDev })

  // 注册所有 IPC 处理器
  registerCharacterIPC(ipcMain, dialog)
  registerChatIPC(ipcMain)
  registerSettingsIPC(ipcMain, dialog)
  registerLorebookIPC(ipcMain, dialog)
  registerPresetIPC(ipcMain, dialog)
  registerAIIPC(ipcMain)
  registerTTSIPC(ipcMain)
  registerImageGenIPC(ipcMain)
  registerFileIPC(ipcMain, dialog)
  registerRegexIPC(ipcMain)
  registerPersonaIPC(ipcMain)
  registerUsageIPC(ipcMain)
  registerMcpIPC(ipcMain)
  registerGroupIPC(ipcMain)

  // 自动启动配置为 autoStart 的 MCP server
  const logger = createLogger('main')
  mcpManager.autoStartAll().catch((err) => {
    logger.error('MCP 自动启动失败', { error: err.message })
  })

  // 日志 IPC
  ipcMain.handle('log:write', (_event, level: 'debug' | 'info' | 'warn' | 'error', mod: string, message: string, meta?: Record<string, any>) => {
    const logger = createLogger(mod)
    logger[level](message, meta)
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

// 应用退出前关闭所有 MCP server
app.on('before-quit', async (event) => {
  event.preventDefault()
  try {
    await mcpManager.shutdownAll()
  } catch { /* ignore */ }
  app.exit(0)
})
