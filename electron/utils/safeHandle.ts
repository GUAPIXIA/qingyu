import type { IpcMain } from 'electron'

type IpcHandler = Parameters<IpcMain['handle']>[1]

/**
 * 包装 ipcMain.handle（行为不变：错误以 rejected promise 传递给渲染进程）。
 *
 * 注意：main.ts 已全局替换 ipcMain.handle 统一捕获并记录异常（含 API Key 脱敏），
 * safeHandle 包裹的 handler 同样经过该包装——此处不再自行 catch，
 * 避免同一异常被记录两次（此前双重日志：全局包装 + safeHandle 各记一次）。
 */
export function safeHandle(
  ipcMain: IpcMain,
  channel: string,
  handler: IpcHandler,
): void {
  ipcMain.handle(channel, handler)
}
