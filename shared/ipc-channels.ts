/**
 * IPC 事件通道常量（shared 层，preload 订阅与主进程广播共用）
 * 防止 channel 字符串在 preload/main/ipc 三处硬编码造成契约漂移。
 * 注：invoke channel 常量化为后续批次；事件通道已全部接入。
 */
export const IPC_EVENTS = {
  aiChunk: 'ai:chunk',
  aiDone: 'ai:done',
  aiError: 'ai:error',
  aiUsage: 'ai:usage',
  characterImportProgress: 'character:importProgress',
  // 阶段 0c：会话变更事件总线
  // session:changed 渲染层->主进程上报；session:updated 主进程广播（供桥接层转推 WS）
  sessionChanged: 'session:changed',
  sessionUpdated: 'session:updated',
} as const

export type IpcEventChannel = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS]
