import type { GroupChat, GroupMessage } from '../../shared/types'
import type { SpatialVersion } from '../../shared/spatial'
import { logWarn } from '../lib/logger'
import { pushToast } from './useToastStore'
import { useGroupChatStore } from './useGroupChatStore'

const bursts = new Map<string, string>()
const keyOf = (groupId: string, sessionId: string) => JSON.stringify([groupId, sessionId])
export async function prepareGroupSpatialGeneration(group: GroupChat, sessionId: string, generationId: string, version: SpatialVersion | undefined, targetCharacterId?: string, regenerate = false): Promise<string | null> {
  if (useGroupChatStore.getState().currentGroup?.id !== group.id || useGroupChatStore.getState().sessions.find(session => session.id === sessionId)?.spatialBoardEnabled !== true || !version) return null
  const key = keyOf(group.id, sessionId)
  const burstId = bursts.get(key) ?? crypto.randomUUID()
  bursts.set(key, burstId)
  try {
    const captured = await window.api.spatial.prepareGroupDialogue(group.id, sessionId, { generationId, burstId, kind: regenerate ? 'regenerate' : 'normal', expectedVersion: version, targetCharacterId })
    if (!captured && bursts.get(key) === burstId) bursts.delete(key)
    return captured
  } catch (error) {
    logWarn('GroupSpatialSync:prepare', String(error))
    pushToast({ variant: 'info', title: '画板剧情登记失败，本轮正文继续生成' })
    await finishGroupSpatialBurst(group.id, sessionId)
    return null
  }
}
export async function registerGroupSpatialMessages(groupId: string, sessionId: string, generationId: string, captured: string | null, messages: GroupMessage[]): Promise<void> {
  if (!captured || !messages.length) return
  try { await window.api.spatial.groupDialogueSaved(groupId, sessionId, generationId, messages.map(message => message.id)) }
  catch (error) { logWarn('GroupSpatialSync:saved', String(error)); pushToast({ variant: 'info', title: '正文已保存，画板剧情检查点未登记' }) }
}
export async function finishGroupSpatialBurst(groupId: string, sessionId: string): Promise<void> {
  const key = keyOf(groupId, sessionId), id = bursts.get(key)
  if (!id) return
  bursts.delete(key)
  try { await window.api.spatial.closeGroupDialogueBatch(groupId, sessionId, id) }
  catch (error) { logWarn('GroupSpatialSync:close', String(error)); pushToast({ variant: 'info', title: '画板剧情批次未提交，正文保持已保存' }) }
}
