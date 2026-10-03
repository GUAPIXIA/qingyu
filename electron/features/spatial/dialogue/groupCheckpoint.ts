import type { GroupMessage } from '../../../../shared/types'

/** 群聊仍走 legacy 流式 IPC；只给已捕获且主进程完整结束的请求签入正文检查点。 */
const requests = new Map<string, { groupId: string; sessionId: string; complete: boolean }>()
export function captureGroupSpatialCheckpoint(id: string, groupId: string, sessionId: string): void {
  requests.set(id, { groupId, sessionId, complete: false })
  while (requests.size > 500) requests.delete(requests.keys().next().value!)
}
export function completeGroupSpatialCheckpoint(id: string, complete: boolean): void {
  const request = requests.get(id)
  if (request) request.complete = complete
}
export function certifyGroupSpatialMessage(groupId: string, sessionId: string, message: GroupMessage): GroupMessage {
  const request = message.spatialGroupGenerationId ? requests.get(message.spatialGroupGenerationId) : undefined
  const complete = request?.complete && request.groupId === groupId && request.sessionId === sessionId &&
    message.groupId === groupId && message.characterId !== '__user__' && !message.generationError && !message.generationNotice
  return { ...message, spatialGroupComplete: !!complete }
}
export function clearGroupSpatialCheckpoints(): void { requests.clear() }
