import { matchesFeatureSource, groupFeatureScope, type FeatureSource } from '../../shared/featureSource'
import type { ChatSession, GroupSession, GroupChat, Message, GroupMessage } from '../../shared/types'

type BackupFile = { zipPath: string; data: Buffer }

/** 只裁剪任务的连接描述，不裁剪用户正文、指令或世界定义。 */
export function publicFeatureHistory(data: Buffer): Buffer {
  const state = JSON.parse(data.toString('utf-8'))
  for (const task of state.tasks ?? []) {
    delete task.apiKey; delete task.baseUrl; delete task.profile; delete task.connectionProfile
    if (task.model && typeof task.model === 'object') {
      const model = task.model
      task.model = { provider: model.provider, model: model.model, ...(model.profileId ? { profileId: model.profileId } : {}) }
    }
  }
  return Buffer.from(JSON.stringify(state, null, 2))
}

/** 全量恢复沿用包内身份；来源不匹配的附属建议失效，已提交业务数据和提交收据保留。 */
export function prepareFeatureBackupRestore(files: BackupFile[]): void {
  const byPath = new Map(files.map(file => [file.zipPath, file]))
  const groups = byPath.has('groups/index.json')
    ? JSON.parse(byPath.get('groups/index.json')!.data.toString('utf-8')) as GroupChat[] : []
  for (const file of files) {
    const match = /^(chats|groups)\/([^/]+)\/sessions\.json$/.exec(file.zipPath)
    if (!match) continue
    const [, domain, ownerId] = match
    const sessions = JSON.parse(file.data.toString('utf-8')) as Array<ChatSession | GroupSession>
    for (const session of sessions) {
      const declaredOwner = domain === 'chats' ? (session as ChatSession).characterId : (session as GroupSession).groupId
      if (declaredOwner && declaredOwner !== ownerId) throw new Error('功能备份会话归属不匹配')
      const messageFile = byPath.get(`${domain}/${ownerId}/${session.id}.jsonl`)
      const lines = messageFile?.data.toString('utf-8').split('\n').filter(line => line.trim()) ?? []
      // 与读消息的兼容口径一致：忽略损坏行参与来源核对，原始行继续保留在备份中。
      const records = lines.map(line => { try { return JSON.parse(line) } catch { return null } })
      const validRecords = records.filter(message => message?.id && typeof message.content === 'string' && (domain === 'groups' || message.role))
      const messages = (domain === 'chats' ? [...new Map(validRecords.map(message => [message.id, message])).values()] : validRecords) as Array<Message | GroupMessage>
      messages.sort((a, b) => a.timestamp - b.timestamp)
      const group = domain === 'groups' ? groups.find(item => item.id === ownerId) : undefined
      const groupScope = group ? groupFeatureScope(group) : undefined
      let changed = false
      for (const message of messages) {
        if (domain === 'chats' && ((message.characterId && message.characterId !== ownerId) || ((message as Message).sessionId && (message as Message).sessionId !== session.id))) throw new Error('功能备份消息归属不匹配')
        if (domain === 'groups' && (message as GroupMessage).groupId && (message as GroupMessage).groupId !== ownerId) throw new Error('功能备份消息归属不匹配')
        const valid = (source: FeatureSource) => matchesFeatureSource(source, messages, session, groupScope)
        if (message.translationSource && !valid(message.translationSource)) {
          message.translation = null; message.translationSource = undefined; message.translationLanguage = undefined
          if (message.featureTaskIds) delete message.featureTaskIds.translation
          changed = true
        }
        if (message.dialogueDirectionsSource && !valid(message.dialogueDirectionsSource)) {
          message.dialogueDirections = []; message.dialogueDirectionsSource = undefined
          if (message.featureTaskIds) delete message.featureTaskIds.direction
          changed = true
        }
      }
      if (changed && messageFile) messageFile.data = Buffer.from(records.map((record, index) => record ? JSON.stringify(record) : lines[index]).join('\n') + '\n')
      if (session.compressedSource && !matchesFeatureSource(session.compressedSource, messages, session, groupScope)) session.compressedSource = null
      if (session.memorySource && !matchesFeatureSource(session.memorySource, messages, session, groupScope)) session.memorySource = undefined
    }
    file.data = Buffer.from(JSON.stringify(sessions, null, 2))
  }
  for (const file of files.filter(item => /^spatial\/ai-sessions\/[^/]+\.json$/.test(item.zipPath))) {
    const state = JSON.parse(publicFeatureHistory(file.data).toString('utf-8'))
    for (const task of state.tasks ?? []) if (task.state === 'queued' || task.state === 'running') {
      task.state = 'interrupted'; task.error = '备份恢复后结果未知，请核对后重新发起'; task.completedAt = Date.now()
    }
    for (const proposal of state.proposals ?? []) if (proposal.automatic?.status === 'applying') {
      proposal.automatic = { status: 'confirmation', reason: '恢复后需重新核对并确认' }
    }
    file.data = Buffer.from(JSON.stringify(state, null, 2))
  }
}
