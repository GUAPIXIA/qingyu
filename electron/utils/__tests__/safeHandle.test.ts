/**
 * safeHandle 单元测试
 *
 * 验证 IPC 处理器包装器：正常透传、异常记录并 rethrow（错误以 rejected promise 传给渲染进程）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'
import { safeHandle } from '../safeHandle'

/** mock IpcMain：仅捕获 handle 注册的 handler */
function createMockIpcMain() {
  const registered = new Map<string, (...args: unknown[]) => unknown>()
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registered.set(channel, handler)
    }),
  }
  return { ipcMain, registered }
}

describe('safeHandle', () => {
  it('正常路径：返回值原样透传', async () => {
    const { ipcMain, registered } = createMockIpcMain()
    safeHandle(ipcMain as unknown as IpcMain, 'test:ok', async () => 'result')

    const handler = registered.get('test:ok')!
    await expect(handler({}, 'arg1')).resolves.toBe('result')
  })

  it('异常路径：错误记录日志后 rethrow（不吞错）', async () => {
    const { ipcMain, registered } = createMockIpcMain()
    const boom = new Error('boom')
    safeHandle(ipcMain as unknown as IpcMain, 'test:fail', async () => {
      throw boom
    })

    const handler = registered.get('test:fail')!
    // 错误必须以 rejected promise 形式传给渲染进程（行为不变）
    await expect(handler({})).rejects.toThrow('boom')
  })

  it('异常路径：非 Error 值（字符串）也能处理', async () => {
    const { ipcMain, registered } = createMockIpcMain()
    safeHandle(ipcMain as unknown as IpcMain, 'test:string', async () => {
      throw 'plain string error'
    })

    const handler = registered.get('test:string')!
    await expect(handler({})).rejects.toBe('plain string error')
  })

  it('注册时使用 ipcMain.handle 且 channel 正确', () => {
    const { ipcMain } = createMockIpcMain()
    safeHandle(ipcMain as unknown as IpcMain, 'test:channel', async () => undefined)

    expect(ipcMain.handle).toHaveBeenCalledWith('test:channel', expect.any(Function))
  })
})
