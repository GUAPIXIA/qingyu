// F3：主进程侧数据写入后的广播工具。
//
// 背景：外部 Agent 通过 IPC 写入角色/会话/设置时，已加载的渲染层不会收到任何通知，
// 用户必须重启应用才能看到（阶段 3A 记录的产品发现 F3）。这里提供统一的广播入口，
// 由各 IPC 处理器在写入成功后调用，渲染层据此重新拉取（见 src/hooks/useSessionSync.ts）。
import { BrowserWindow } from 'electron'
import { IPC_EVENTS } from '../../shared/ipc-channels'

/** 向所有存活窗口广播（无窗口时静默） */
export function broadcastToWindows(channel: string, payload?: unknown): void {
  // 单测环境会 mock electron（可能没有 BrowserWindow）——广播是尽力而为的刷新提示，
  // 因此这里不依赖 BrowserWindow 一定可用，避免写入路径因广播失败而报错。
  const getAllWindows = BrowserWindow?.getAllWindows
  if (typeof getAllWindows !== 'function') return
  for (const win of getAllWindows.call(BrowserWindow)) {
    if (win.isDestroyed() || !win.webContents) continue
    try {
      win.webContents.send(channel, payload)
    } catch {
      // 窗口正在销毁时发送可能失败，忽略
    }
  }
}

/** 角色数据写入后广播（新建/更新/删除/导入） */
export function notifyCharactersChanged(): void {
  broadcastToWindows(IPC_EVENTS.characterChanged)
}

/** 设置写入后广播（仅当写入来自主进程侧调用，避免与渲染层自身保存形成回环） */
export function notifySettingsChanged(): void {
  broadcastToWindows(IPC_EVENTS.settingsChanged)
}

/** 会话写入后广播（供其他窗口/渲染层刷新会话列表与消息） */
export function notifySessionUpdated(payload: { sessionId: string; change: 'created' | 'message' | 'title' | 'deleted' | 'swiped' }): void {
  broadcastToWindows(IPC_EVENTS.sessionUpdated, payload)
}
