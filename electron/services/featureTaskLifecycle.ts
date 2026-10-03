import type { ChatParams } from '../../shared/types'

// 只保留身份和取消事实，不保留请求正文或连接凭据。窗口覆盖辅助请求的超时及提交排队。
const cancelled = new Set<string>()
const requests = new Map<string, string>()
const RETENTION_MS = 10 * 60_000
const restoreListeners = new Set<() => void>()
export function onFeatureDataRestoring(listener: () => void): () => void {
  restoreListeners.add(listener)
  return () => { restoreListeners.delete(listener) }
}
/** 文件替换前冻结旧任务；恢复失败也不重发已取消请求。 */
export function prepareFeatureDataRestore(): void {
  for (const taskId of requests.values()) cancelFeatureTask(taskId)
  for (const listener of restoreListeners) listener()
}
export function registerFeatureRequest(params: ChatParams): void {
  const taskId = params.observability?.featureTask?.taskId
  if (!taskId) return
  requests.set(params.requestId, taskId)
  const timer = setTimeout(() => {
    if (requests.get(params.requestId) === taskId) requests.delete(params.requestId)
  }, RETENTION_MS)
  timer.unref?.()
}
export function cancelFeatureTask(requestOrTaskId: string): void {
  const taskId = requests.get(requestOrTaskId) ?? requestOrTaskId
  cancelled.add(taskId)
  const timer = setTimeout(() => cancelled.delete(taskId), RETENTION_MS)
  timer.unref?.()
}
export function isFeatureTaskCancelled(taskId: string): boolean { return cancelled.has(taskId) }
