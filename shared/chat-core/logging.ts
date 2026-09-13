/**
 * chat-core 日志出口（B1 反向依赖下沉）。
 *
 * 下沉到 shared/chat-core 的模块同时被渲染层与主进程/Bridge 复用，不能直接 import
 * 任一端的 logger：渲染层 logger 依赖 window.api，主进程 logger 依赖 electron。
 * 各端启动时通过 setChatCoreLogSink 安装自己的实现；未安装时静默——与迁移前
 * 这些模块在主进程侧的日志行为一致（渲染层由 src/lib/logger 在模块加载时安装）。
 */
export interface ChatCoreLogSink {
  info(context: string, message: string): void
  warn(context: string, message: string): void
}

let sink: ChatCoreLogSink | null = null

/** 安装日志实现（传入 null 恢复静默） */
export function setChatCoreLogSink(next: ChatCoreLogSink | null): void {
  sink = next
}

/** 记录 INFO 日志（无 sink 时静默） */
export function logInfo(context: string, message: string): void {
  sink?.info(context, message)
}

/** 记录 WARN 日志（无 sink 时静默） */
export function logWarn(context: string, message: string): void {
  sink?.warn(context, message)
}
