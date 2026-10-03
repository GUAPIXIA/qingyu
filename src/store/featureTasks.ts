import { nanoid } from 'nanoid'
import type { ChatParams } from '../../shared/types'
import { featureFingerprint, featureOwnerKey, type FeatureTaskOwner, type FeatureSource, type TextFeature } from '../../shared/featureSource'
import type { AIDonePayload } from '../../shared/ipc-api'

export interface FeatureTask {
  id: string
  key: string
  owner: FeatureTaskOwner
  feature: TextFeature
  source: FeatureSource
  messageId?: string
  activeRequestId?: string
  controller: AbortController
  status: 'running' | 'completed' | 'cancelled' | 'failed'
}
const tasks = new Map<string, FeatureTask>()
let restoreAPI: typeof window.api.ai | undefined
let unbindRestore: (() => void) | undefined
function bindRestoreCancellation(): void {
  if (restoreAPI === window.api.ai) return
  unbindRestore?.()
  restoreAPI = window.api.ai
  unbindRestore = restoreAPI.onFeatureDataRestoring?.(() => cancelFeatureTasks())
}
export function abortFeatureTask(task: FeatureTask): void {
  const requestId = task.activeRequestId
  task.controller.abort()
  // 模型返回后仍可能等待写锁；将取消事实也传到提交端。
  if (requestId !== task.id) void window.api.ai.cancelChat(task.id).catch(() => {})
  finishFeatureTask(task, 'cancelled')
}
export function beginFeatureTask(owner: FeatureTaskOwner, feature: TextFeature, source: FeatureSource, messageId?: string, variant?: string): FeatureTask | null {
  bindRestoreCancellation()
  const key = JSON.stringify([featureOwnerKey(owner), feature, messageId ?? 'session', variant ?? ''])
  const previous = tasks.get(key)
  if (previous) {
    if (featureFingerprint(previous.source) === featureFingerprint(source)) return null
    abortFeatureTask(previous)
  }
  const task: FeatureTask = { id: `feature-${nanoid()}`, key, owner, feature, source, messageId, controller: new AbortController(), status: 'running' }
  tasks.set(key, task)
  return task
}
export function finishFeatureTask(task: FeatureTask, status: FeatureTask['status'] = task.status === 'running' ? 'completed' : task.status): void {
  task.status = task.controller.signal.aborted ? 'cancelled' : status
  if (tasks.get(task.key) === task) tasks.delete(task.key)
}
export function cancelFeatureTasks(owner?: FeatureTaskOwner, messageIds?: readonly string[], feature?: TextFeature): void {
  for (const task of tasks.values()) {
    if (owner && featureOwnerKey(owner) !== featureOwnerKey(task.owner)) continue
    if (feature && task.feature !== feature) continue
    if (messageIds && (!task.messageId || !messageIds.includes(task.messageId))) continue
    abortFeatureTask(task)
  }
}
/** 每个物理请求独立监听、空闲超时和取消；任务的内部重试复用同一身份。 */
export function requestFeatureText(task: FeatureTask, params: ChatParams, onProgress?: (text: string) => void): Promise<{ text: string; completion: AIDonePayload }> {
  return new Promise((resolve, reject) => {
    if (task.controller.signal.aborted) { reject(new Error('功能任务已取消')); return }
    task.activeRequestId = params.requestId
    let text = '', settled = false
    let timer: ReturnType<typeof setTimeout>
    const cleanup = () => {
      clearTimeout(timer)
      if (task.activeRequestId === params.requestId) task.activeRequestId = undefined
      unbindChunk(); unbindDone(); unbindError()
      task.controller.signal.removeEventListener('abort', abort)
    }
    const fail = (error: Error) => { if (settled) return; settled = true; task.status = 'failed'; cleanup(); reject(error) }
    const abort = () => {
      fail(new Error('功能任务已取消'))
      void window.api.ai.cancelChat(params.requestId).catch(() => {})
    }
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        fail(new Error('功能请求超时，请重试'))
        void window.api.ai.cancelChat(params.requestId, 'timeout').catch(() => {})
      }, 60_000)
    }
    const unbindChunk = window.api.ai.onChunk(data => {
      if (settled || data.requestId !== params.requestId) return
      text += data.text
      arm()
      onProgress?.(text)
    })
    const unbindDone = window.api.ai.onComplete(completion => {
      if (settled || completion.requestId !== params.requestId) return
      settled = true; cleanup(); resolve({ text, completion })
    })
    const unbindError = window.api.ai.onError(data => {
      if (data.requestId === params.requestId) fail(new Error(data.error))
    })
    task.controller.signal.addEventListener('abort', abort, { once: true })
    arm()
    void window.api.ai.chat({ ...params, observability: {
      ...params.observability, source: 'aux', taskType: params.observability?.taskType ?? (task.feature === 'editing' ? 'generic' : task.feature),
      ...(task.owner.kind === 'editor' ? {} : {
        characterId: task.owner.kind === 'single' ? task.owner.characterId : `group:${task.owner.groupId}`,
        sessionId: task.owner.sessionId,
      }),
      featureTask: { owner: task.owner, taskId: task.id, logicalSessionId: `${featureOwnerKey(task.owner)}:${task.feature}`, sourceRef: task.source },
    } }).catch(error => fail(error instanceof Error ? error : new Error(String(error))))
  })
}
