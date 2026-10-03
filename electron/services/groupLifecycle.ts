import { join } from 'node:path'
import { DIRS, readJson } from './storage'
type GroupScope = { groupId: string; sessionId?: string }
const sourceHandlers = new Set<(scope: GroupScope) => Promise<void>>()
const deletingHandlers = new Set<(scope: GroupScope) => Promise<void>>()
export function onGroupSpatialSourceChanged(handler: (scope: GroupScope) => Promise<void>): () => void {
  sourceHandlers.add(handler)
  return () => { sourceHandlers.delete(handler) }
}
export function notifyGroupSpatialSourceChanged(scope: GroupScope): void {
  for (const handler of sourceHandlers) void handler(scope).catch(() => { /* 编辑器重新读取时展示错误，群聊保存本身保持成功。 */ })
}
/** 身份设定或角色卡更改时刷新已绑定群聊；未绑定会话不会建图。 */
export function notifyGroupSpatialActorsChanged(characterId?: string): void {
  const groups = readJson<Array<{ id: string; memberIds: string[] }>>(join(DIRS.groups(), 'index.json'))
  if (!Array.isArray(groups)) return
  for (const group of groups) if (group && typeof group.id === 'string' && (!characterId || (Array.isArray(group.memberIds) && group.memberIds.includes(characterId)))) notifyGroupSpatialSourceChanged({ groupId: group.id })
}
export function onGroupSessionDeleting(handler: (scope: GroupScope) => Promise<void>): () => void {
  deletingHandlers.add(handler)
  return () => { deletingHandlers.delete(handler) }
}
export async function prepareGroupSessionDeletion(scope: GroupScope): Promise<void> {
  for (const handler of deletingHandlers) await handler(scope)
}
