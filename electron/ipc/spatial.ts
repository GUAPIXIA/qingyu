import { BrowserWindow, type IpcMain } from 'electron'
import { join } from 'node:path'
import type { SpatialEditorCommit } from '../../shared/spatial'
import { createLogger } from '../services/logger'
import { spatialService } from '../features/spatial/commitService'
import { spatialAiService } from '../services/spatialAiService'
import { spatialGroupAiService } from '../services/spatialGroupAiService'
import { spatialContextService } from '../features/spatial/contextService'
import type { SpatialAiRequest } from '../../shared/spatial-ai'
import { onChatSessionDeleting, onChatSpatialSourceChanged } from '../services/chatLifecycle'
import { onGroupSessionDeleting, onGroupSpatialSourceChanged } from '../services/groupLifecycle'
import { spatialAiScheduler } from '../services/spatialAiScheduler'
import { sessionFor } from '../features/spatial/commitService'
import type { SpatialDialogueCaptureInput } from '../services/spatialDialogueQueue'
import { DIRS, withFileLock } from '../services/storage'
import { hashSpatialValue, isGroupScope, validateSpatialScope, type SpatialOwnerScope } from '../features/spatial/repository'

export const spatialData = spatialService

async function setSessionEnabled(scope: SpatialOwnerScope, enabled: boolean) {
  validateSpatialScope(scope)
  if (typeof enabled !== 'boolean') throw new Error('画板开关参数无效')
  // 将同一会话的初始化、任务停止和开关持久化按点击顺序完成。
  return withFileLock(join(DIRS.spatial(), `feature-${hashSpatialValue(scope)}`), async () => {
    const before = await sessionFor(scope)
    const snapshot = await spatialService.setEnabled(scope, enabled)
    try {
      if (isGroupScope(scope)) {
        if (enabled) await spatialGroupAiService.get(scope)
        else await spatialGroupAiService.disable(scope)
      } else {
        if (enabled) await spatialAiService.get(scope)
        else await spatialAiService.disable(scope)
      }
    } catch (cause) {
      if (enabled && before.spatialBoardEnabled !== true) await spatialService.setEnabled(scope, false)
      throw cause
    }
    return snapshot
  })
}

export function registerSpatialIPC(ipcMain: IpcMain): void {
  ipcMain.handle('spatial:setEnabled', (_e, characterId: string, sessionId: string, enabled: boolean) => setSessionEnabled({ characterId, sessionId }, enabled))
  ipcMain.handle('spatial:setGroupEnabled', (_e, groupId: string, sessionId: string, enabled: boolean) => setSessionEnabled({ kind: 'group', groupId, sessionId }, enabled))
  ipcMain.handle('spatial:prepareGroupDialogue', (_e, groupId: string, sessionId: string, input: import('../../shared/spatial-ai').SpatialGroupDialogueCapture) => spatialGroupAiService.dialogue.capture({ kind: 'group', groupId, sessionId }, input))
  ipcMain.handle('spatial:groupDialogueSaved', (_e, groupId: string, sessionId: string, generationId: string, messageIds: string[]) => spatialGroupAiService.dialogue.register({ kind: 'group', groupId, sessionId }, generationId, messageIds))
  ipcMain.handle('spatial:closeGroupDialogueBatch', (_e, groupId: string, sessionId: string, burstId: string) => spatialGroupAiService.dialogue.close({ kind: 'group', groupId, sessionId }, burstId))
  ipcMain.handle('spatial:retryGroupDialogue', (_e, groupId: string, sessionId: string, taskId: string) => spatialGroupAiService.dialogue.retry({ kind: 'group', groupId, sessionId }, taskId))
  ipcMain.handle('spatial:groupProposalTargets', (_e, groupId: string, sessionId: string) => spatialGroupAiService.targets({kind:'group',groupId,sessionId}))
  ipcMain.handle('spatial:reviewGroupProposal', (_e, groupId: string, sessionId: string, id: string, input: import('../../shared/spatial-ai').SpatialProposalReviewInput) => spatialGroupAiService.review({kind:'group',groupId,sessionId},id,input))
  ipcMain.handle('spatial:prepareGroupPlace', (_e, groupId: string, sessionId: string, id: string, name: string, parentId: string | null) => spatialGroupAiService.preparePlace({kind:'group',groupId,sessionId},id,name,parentId))
  ipcMain.handle('spatial:undoGroupProposal', (_e, groupId: string, sessionId: string, id: string) => spatialGroupAiService.undo({kind:'group',groupId,sessionId},id))
  onGroupSpatialSourceChanged(async ({ groupId, sessionId }) => {
    await spatialService.refreshGroup(groupId, sessionId)
    for (const session of (await import('../ipc/group')).groupData.readSessions(groupId).filter(item => (!sessionId || item.id === sessionId) && item.spatialAiSessionId)) {
      const scope = { kind: 'group' as const, groupId, sessionId: session.id }
      await spatialGroupAiService.get(scope)
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('spatial:aiUpdated', scope)
    }
  })
  onGroupSessionDeleting(async ({ groupId, sessionId }) => {
    await spatialGroupAiService.deleteScope(groupId, sessionId)
    await spatialService.deleteGroupScope(groupId, sessionId)
  })
  ipcMain.handle('spatial:readGroupContext', (_e, groupId: string, sessionId: string, targetCharacterId?: string) => spatialContextService.readGroup({ kind: 'group', groupId, sessionId }, targetCharacterId))
  ipcMain.handle('spatial:getGroupAiSession', (_e, groupId: string, sessionId: string) => spatialGroupAiService.get({ kind: 'group', groupId, sessionId }))
  ipcMain.handle('spatial:groupInitializationSources', (_e, groupId: string, sessionId: string) => spatialGroupAiService.sources({ kind: 'group', groupId, sessionId }))
  ipcMain.handle('spatial:askGroupAi', (_e, groupId: string, sessionId: string, input: SpatialAiRequest) => spatialGroupAiService.ask({ kind: 'group', groupId, sessionId }, input))
  ipcMain.handle('spatial:cancelGroupAi', (_e, groupId: string, sessionId: string) => spatialGroupAiService.cancel({ kind: 'group', groupId, sessionId }))
  ipcMain.handle('spatial:discardGroupProposal', (_e, groupId: string, sessionId: string, id: string) => spatialGroupAiService.discard({ kind: 'group', groupId, sessionId }, id))
  ipcMain.handle('spatial:editGroupDraft', (_e, groupId: string, sessionId: string, id: string, input: SpatialEditorCommit) => spatialGroupAiService.editDraft({ kind: 'group', groupId, sessionId }, id, input))
  ipcMain.handle('spatial:applyGroupProposal', (_e, groupId: string, sessionId: string, id: string, acknowledge?: boolean) => spatialGroupAiService.apply({ kind: 'group', groupId, sessionId }, id, acknowledge))
  spatialGroupAiService.onUpdated(event => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('spatial:aiUpdated', event)
  })
  ipcMain.handle('spatial:loadGroupBound', (_e, groupId: string, sessionId: string) => spatialService.loadGroupBound(groupId, sessionId))
  ipcMain.handle('spatial:createGroupAndBind', (_e, groupId: string, sessionId: string, name: string) => spatialService.createGroupAndBind(groupId, sessionId, name))
  ipcMain.handle('spatial:bindGroupWorld', (_e, groupId: string, sessionId: string, worldId: string) => spatialService.bindGroupWorld(groupId, sessionId, worldId))
  ipcMain.handle('spatial:applyGroupEditorBatch', (_e, groupId: string, sessionId: string, input: SpatialEditorCommit) => spatialService.applyGroupEditorBatch(groupId, sessionId, input))
  onChatSpatialSourceChanged(async scope => {
    if (!(await sessionFor(scope)).spatialAiSessionId) return
    await spatialAiService.get(scope)
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('spatial:aiUpdated', scope)
  })
  ipcMain.handle('spatial:prepareDialogue', (_e, characterId: string, sessionId: string, input: SpatialDialogueCaptureInput) => spatialAiScheduler.prepare({ characterId, sessionId }, input))
  ipcMain.handle('spatial:dialogueSaved', (_e, characterId: string, sessionId: string, generationId: string, messageId: string) => spatialAiScheduler.saved({ characterId, sessionId }, generationId, messageId))
  ipcMain.handle('spatial:retryDialogue', (_e, characterId: string, sessionId: string, taskId: string) => spatialAiService.dialogue.retry({ characterId, sessionId }, taskId))
  onChatSessionDeleting(scope => spatialAiService.deleteScope(scope))
  spatialAiService.onUpdated((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('spatial:aiUpdated', event)
    }
  })
  ipcMain.handle('spatial:readContext', (_e, characterId: string, sessionId: string) => spatialContextService.read({ characterId, sessionId }))
  ipcMain.handle('spatial:getAiSession', (_e, characterId: string, sessionId: string) => spatialAiService.get({ characterId, sessionId }))
  ipcMain.handle('spatial:initializationSources', (_e, characterId: string, sessionId: string) => spatialAiService.sources({ characterId, sessionId }))
  ipcMain.handle('spatial:askAi', (_e, characterId: string, sessionId: string, input: SpatialAiRequest) => spatialAiService.ask({ characterId, sessionId }, input))
  ipcMain.handle('spatial:cancelAi', (_e, characterId: string, sessionId: string) => spatialAiService.cancel({ characterId, sessionId }))
  ipcMain.handle('spatial:discardProposal', (_e, characterId: string, sessionId: string, id: string) => spatialAiService.discard({ characterId, sessionId }, id))
  ipcMain.handle('spatial:proposalTargets', (_e, characterId: string, sessionId: string) => spatialAiService.targets({ characterId, sessionId }))
  ipcMain.handle('spatial:reviewProposal', (_e, characterId: string, sessionId: string, id: string, input: import('../../shared/spatial-ai').SpatialProposalReviewInput) => spatialAiService.review({ characterId, sessionId }, id, input))
  ipcMain.handle('spatial:preparePlace', (_e, characterId: string, sessionId: string, id: string, name: string, parentId: string | null) => spatialAiService.preparePlace({ characterId, sessionId }, id, name, parentId))
  ipcMain.handle('spatial:undoProposal', (_e, characterId: string, sessionId: string, id: string) => spatialAiService.undo({ characterId, sessionId }, id))
  ipcMain.handle('spatial:editDraft', (_e, characterId: string, sessionId: string, id: string, input: SpatialEditorCommit) => spatialAiService.editDraft({ characterId, sessionId }, id, input))
  ipcMain.handle('spatial:applyProposal', (_e, characterId: string, sessionId: string, id: string, acknowledge?: boolean) => spatialAiService.apply({ characterId, sessionId }, id, acknowledge))
  spatialService.onUpdated((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('spatial:updated', event)
    }
  })
  void spatialService.recoverTransactions().then(async () => { await spatialAiScheduler.recover(); await spatialGroupAiService.dialogue.recover() }).catch((error) => {
    createLogger('spatial').error('空间事务需要恢复核对', { error: error instanceof Error ? error.message : String(error) })
  })
  ipcMain.handle('spatial:listWorlds', () => spatialService.listWorlds())
  ipcMain.handle('spatial:loadBound', (_e, characterId: string, sessionId: string) => spatialService.loadBound(characterId, sessionId))
  ipcMain.handle('spatial:createAndBind', (_e, characterId: string, sessionId: string, name: string) => spatialService.createAndBind(characterId, sessionId, name))
  ipcMain.handle('spatial:bindWorld', (_e, characterId: string, sessionId: string, worldId: string) => spatialService.bindWorld(characterId, sessionId, worldId))
  ipcMain.handle('spatial:applyEditorBatch', (_e, characterId: string, sessionId: string, input: SpatialEditorCommit) =>
    spatialService.applyEditorBatch(characterId, sessionId, input))
  // 老客户端的完整快照不能绕过提交协议。
  ipcMain.handle('spatial:saveBound', () => { throw new Error('整份快照保存已停用，请重新打开画板后提交命令') })
}
