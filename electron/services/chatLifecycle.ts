type Scope = { characterId: string; sessionId: string }
const handlers = new Set<(scope: Scope) => Promise<void>>()
const spatialSourceHandlers = new Set<(scope: Scope) => Promise<void>>()
export function onChatSpatialSourceChanged(handler: (scope: Scope) => Promise<void>): () => void {
  spatialSourceHandlers.add(handler)
  return () => { spatialSourceHandlers.delete(handler) }
}
export function notifyChatSpatialSourceChanged(scope: Scope): void {
  for (const handler of spatialSourceHandlers) void handler(scope).catch(() => { /* 辅助状态刷新不反转正文保存。 */ })
}
export function onChatSessionDeleting(handler: (scope: Scope) => Promise<void>): () => void {
  handlers.add(handler)
  return () => { handlers.delete(handler) }
}
export async function prepareChatSessionDeletion(scope: Scope): Promise<void> {
  for (const handler of handlers) await handler(scope)
}
