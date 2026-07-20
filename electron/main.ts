import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join } from 'node:path'
import { registerCharacterIPC } from './ipc/character'
import { registerChatIPC } from './ipc/chat'
import { registerSettingsIPC } from './ipc/settings'
import { registerLorebookIPC } from './ipc/lorebook'
import { registerPresetIPC } from './ipc/preset'
import { registerAIIPC } from './services/ai'
import { registerTTSIPC } from './ipc/tts'
import { registerFileIPC } from './ipc/file'
import { registerRegexIPC } from './ipc/regex'
import { registerPersonaIPC } from './ipc/persona'
import { ensureDataDir } from './services/storage'

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
  await ensureDataDir()

  // 注册所有 IPC 处理器
  registerCharacterIPC(ipcMain, dialog)
  registerChatIPC(ipcMain)
  registerSettingsIPC(ipcMain, dialog)
  registerLorebookIPC(ipcMain, dialog)
  registerPresetIPC(ipcMain, dialog)
  registerAIIPC(ipcMain)
  registerTTSIPC(ipcMain)
  registerFileIPC(ipcMain, dialog)
  registerRegexIPC(ipcMain)
  registerPersonaIPC(ipcMain)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
