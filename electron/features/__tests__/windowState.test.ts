import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

/**
 * 主窗口状态持久化：窗口尺寸/位置/最大化在重启后恢复。
 * electron 的 app/screen 通过 vi.mock 替换，落盘目录用临时目录。
 */
const env = vi.hoisted(() => ({
  root: '',
  displays: [] as Array<{ workArea: { x: number; y: number; width: number; height: number } }>,
}))

vi.mock('electron', () => ({
  app: { getPath: () => env.root },
  screen: { getAllDisplays: () => env.displays },
}))

import { loadWindowState, trackWindowState } from '../windowState'

const PRIMARY_DISPLAY = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }

function stateFile(): string {
  return join(env.root, 'window-state.json')
}

interface FakeWindow {
  win: BrowserWindow
  emit: (event: string) => void
}

function createFakeWindow(bounds: { x: number; y: number; width: number; height: number }, maximized = false): FakeWindow {
  const handlers = new Map<string, () => void>()
  const win = {
    isDestroyed: () => false,
    getNormalBounds: () => bounds,
    isMaximized: () => maximized,
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler)
      return win
    },
    once: (event: string, handler: () => void) => {
      handlers.set(event, handler)
      return win
    },
  }
  return { win: win as unknown as BrowserWindow, emit: (event: string) => handlers.get(event)?.() }
}

describe('windowState 主窗口状态持久化', () => {
  beforeEach(() => {
    env.root = mkdtempSync(join(tmpdir(), 'qingyu-window-state-'))
    env.displays = [PRIMARY_DISPLAY]
  })

  afterEach(() => {
    rmSync(env.root, { recursive: true, force: true })
  })

  it('没有保存记录时返回默认 1280×800 且不指定坐标', () => {
    const state = loadWindowState()
    expect(state.width).toBe(1280)
    expect(state.height).toBe(800)
    expect(state.maximized).toBe(false)
    expect(state.x).toBeUndefined()
    expect(state.y).toBeUndefined()
  })

  it('关闭窗口时记录 bounds 与最大化状态，下次启动恢复', () => {
    const { win, emit } = createFakeWindow({ x: 120, y: 80, width: 1440, height: 900 }, true)
    trackWindowState(win)
    emit('close')

    const saved = JSON.parse(readFileSync(stateFile(), 'utf-8')) as Record<string, unknown>
    expect(saved).toMatchObject({ x: 120, y: 80, width: 1440, height: 900, maximized: true })

    const restored = loadWindowState()
    expect(restored).toMatchObject({ x: 120, y: 80, width: 1440, height: 900, maximized: true })
  })

  it('尺寸/位置变化走防抖，关窗前会立即落盘', () => {
    vi.useFakeTimers()
    try {
      const { win, emit } = createFakeWindow({ x: 10, y: 10, width: 1000, height: 700 })
      trackWindowState(win)

      emit('resize')
      expect(existsSync(stateFile())).toBe(false)
      vi.advanceTimersByTime(500)
      expect(existsSync(stateFile())).toBe(true)

      // 防抖窗口内关闭：close 立即写入最新 bounds
      const next = createFakeWindow({ x: 20, y: 30, width: 1100, height: 720 })
      trackWindowState(next.win)
      next.emit('move')
      next.emit('close')
      const saved = JSON.parse(readFileSync(stateFile(), 'utf-8')) as Record<string, unknown>
      expect(saved).toMatchObject({ x: 20, y: 30, width: 1100, height: 720 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('保存的坐标不在任何显示器内时丢弃坐标，避免窗口出现在屏幕外', () => {
    writeFileSync(stateFile(), JSON.stringify({ x: 5000, y: 4000, width: 1280, height: 800, maximized: false }))
    const state = loadWindowState()
    expect(state.x).toBeUndefined()
    expect(state.y).toBeUndefined()
    expect(state.width).toBe(1280)
    expect(state.height).toBe(800)
  })

  it('保存的尺寸小于最小窗口尺寸时收敛到 900×600', () => {
    writeFileSync(stateFile(), JSON.stringify({ x: 10, y: 10, width: 400, height: 300, maximized: false }))
    const state = loadWindowState()
    expect(state.width).toBe(900)
    expect(state.height).toBe(600)
  })

  it('状态文件损坏时回退默认值且不抛错', () => {
    writeFileSync(stateFile(), '{not json')
    const state = loadWindowState()
    expect(state).toMatchObject({ width: 1280, height: 800, maximized: false })
  })
})
