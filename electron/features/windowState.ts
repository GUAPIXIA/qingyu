import { app, screen, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { readJson, writeJson } from '../services/storage'
import { createLogger } from '../services/logger'

/**
 * 主窗口尺寸 / 位置 / 最大化状态的持久化。
 *
 * 只属于本机界面偏好：退出时写入 `userData/window-state.json`，下次启动恢复。
 * 显示器配置变化（拔掉外接屏、分辨率变小）时，把保存的坐标收敛回可见区域，
 * 避免窗口启动后出现在屏幕外。
 */

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

const MIN_WIDTH = 900
const MIN_HEIGHT = 600
const DEFAULT_STATE: WindowState = { width: 1280, height: 800, maximized: false }
const SAVE_DEBOUNCE_MS = 400
/** 判定「窗口可见」的最小重叠面积（避免只剩一条边也算可见） */
const MIN_VISIBLE_WIDTH = 120
const MIN_VISIBLE_HEIGHT = 80

const log = () => createLogger('windowState')

function stateFilePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

/** 把保存的 bounds 收敛到当前显示器可见区域 */
function clampToVisibleArea(state: WindowState): WindowState {
  const width = Math.max(MIN_WIDTH, Math.round(state.width))
  const height = Math.max(MIN_HEIGHT, Math.round(state.height))
  const displays = screen.getAllDisplays()
  if (state.x === undefined || state.y === undefined || displays.length === 0) {
    return { width, height, maximized: state.maximized }
  }

  const x = state.x
  const y = state.y
  const visible = displays.some((display) => {
    const area = display.workArea
    const overlapX = Math.min(x + width, area.x + area.width) - Math.max(x, area.x)
    const overlapY = Math.min(y + height, area.y + area.height) - Math.max(y, area.y)
    return overlapX >= MIN_VISIBLE_WIDTH && overlapY >= MIN_VISIBLE_HEIGHT
  })
  if (visible) return { x, y, width, height, maximized: state.maximized }

  log().warn('保存的窗口位置不在任何显示器内，回退为默认尺寸并居中', { x, y, width, height })
  return { width, height, maximized: state.maximized }
}

/** 读取上次退出时的窗口状态（损坏 / 缺失时返回默认值） */
export function loadWindowState(): WindowState {
  const stored = readJson<Partial<WindowState>>(stateFilePath())
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_STATE }
  return clampToVisibleArea({
    x: typeof stored.x === 'number' && Number.isFinite(stored.x) ? stored.x : undefined,
    y: typeof stored.y === 'number' && Number.isFinite(stored.y) ? stored.y : undefined,
    width: typeof stored.width === 'number' && Number.isFinite(stored.width) ? stored.width : DEFAULT_STATE.width,
    height: typeof stored.height === 'number' && Number.isFinite(stored.height) ? stored.height : DEFAULT_STATE.height,
    maximized: stored.maximized === true,
  })
}

/** 监听窗口的尺寸/位置/最大化变化并落盘（防抖 400ms，关闭前强制写一次） */
export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null

  const save = () => {
    if (win.isDestroyed()) return
    try {
      const bounds = win.getNormalBounds()
      const state: WindowState = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized: win.isMaximized(),
      }
      writeJson(stateFilePath(), state)
    } catch (error) {
      log().warn('保存窗口状态失败', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      save()
    }, SAVE_DEBOUNCE_MS)
  }

  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    save()
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)
  win.on('close', flush)
  win.once('closed', () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  })
}
