// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { prepareFeatureBackupRestore, publicFeatureHistory } from '../featureBackup'
import { cancelFeatureTask, isFeatureTaskCancelled, onFeatureDataRestoring, prepareFeatureDataRestore, registerFeatureRequest } from '../featureTaskLifecycle'
import { featureSource, featureFingerprint, groupFeatureScope } from '../../../shared/featureSource'
import { trimFeatureHistory } from '../../../shared/featureHistory'
import type { ChatParams, Message, GroupMessage } from '../../../shared/types'
import type { SpatialAiSession } from '../../../shared/spatial-ai'
const file = (zipPath: string, data: unknown) => ({ zipPath, data: Buffer.from(JSON.stringify(data)) })
const parse = (item: ReturnType<typeof file>) => JSON.parse(item.data.toString())
const message = { id: 'm1', characterId: 'c1', sessionId: 's1', role: 'assistant', content: '正文', timestamp: 1 } as Message

describe('功能数据备份与恢复', () => {
  it('来源按读取时的顺序核对，单聊追加覆盖和损坏行不使有效来源误失效', () => {
    const second = { ...message, id: 'm2', timestamp: 2 }
    const source = featureSource([message, second])
    const sessions = file('chats/c1/sessions.json', [{ id: 's1', characterId: 'c1', compressedSource: source, compressedSummary: '有效摘要' }])
    const lines = [JSON.stringify({ ...message, content: '旧版本' }), JSON.stringify(second), '损坏的旧行', JSON.stringify({ ...message, translation: '译文', translationSource: featureSource([message], 'message') })]
    const messages = { zipPath: 'chats/c1/s1.jsonl', data: Buffer.from(lines.join('\n')) }
    prepareFeatureBackupRestore([sessions, messages])
    expect(parse(sessions)[0].compressedSource).toEqual(source)
    expect(messages.data.toString()).toContain('损坏的旧行')
    expect(JSON.parse(messages.data.toString().split('\n').at(-1)!).translation).toBe('译文')
  })
  it('完整来源与任务去重身份可恢复，过期译文和方向失效', () => {
    const source = featureSource([message], 'message')
    const valid = { ...message, translation: '译文', translationSource: source, featureTaskIds: { translation: 'done-task' } }
    const sessions = file('chats/c1/sessions.json', [{ id: 's1', characterId: 'c1' }])
    const messages = { zipPath: 'chats/c1/s1.jsonl', data: Buffer.from(JSON.stringify(valid) + '\n') }
    prepareFeatureBackupRestore([sessions, messages])
    expect(parse(messages).translation).toBe('译文')
    expect(parse(messages).featureTaskIds.translation).toBe('done-task')
    messages.data = Buffer.from(JSON.stringify({ ...valid, content: '新正文', dialogueDirections: [{ id: 'd1' }], dialogueDirectionsSource: source }))
    prepareFeatureBackupRestore([sessions, messages])
    expect(parse(messages).translation).toBeNull()
    expect(parse(messages).dialogueDirections).toEqual([])
    expect(parse(messages).featureTaskIds.translation).toBeUndefined()
  })
  it('群聊成员变动使建议过期；消息 ID 相同也不能跨群归属', () => {
    const msg = { ...message, sessionId: undefined, groupId: 'g1' } as unknown as GroupMessage
    const source = featureSource([msg], 'message')
    source.groupFingerprint = featureFingerprint(groupFeatureScope({ memberIds: ['c1'], chatMode: 'round_robin' }))
    const sessions = file('groups/g1/sessions.json', [{ id: 's1', groupId: 'g1' }])
    const groups = file('groups/index.json', [{ id: 'g1', memberIds: ['c1', 'c2'], chatMode: 'round_robin' }])
    const messages = file('groups/g1/s1.jsonl', { ...msg, dialogueDirections: [{ id: 'd1' }], dialogueDirectionsSource: source })
    prepareFeatureBackupRestore([sessions, groups, messages])
    expect(parse(messages).dialogueDirections).toEqual([])
    messages.data = Buffer.from(JSON.stringify({ ...msg, dialogueDirections: [{ id: 'd1' }], dialogueDirectionsSource: source }))
    prepareFeatureBackupRestore([sessions, messages])
    expect(parse(messages).dialogueDirections).toEqual([])
    messages.data = Buffer.from(JSON.stringify({ ...msg, groupId: 'g2' }))
    expect(() => prepareFeatureBackupRestore([sessions, groups, messages])).toThrow('归属')
  })
  it('中断任务不恢复执行，已应用收据保留，公开连接描述裁掉凭据', () => {
    const ai = file('spatial/ai-sessions/a1.json', { tasks: [
      { id: 't1', state: 'running', apiKey: 'fixture-secret', baseUrl: 'https://private.invalid', model: { provider: 'openai', model: 'model1', apiKey: 'fixture-secret', baseUrl: 'https://private.invalid', profileId: 'p1' } },
      { id: 't2', state: 'queued' }, { id: 't3', state: 'completed' },
    ], proposals: [{ id: 'p1', status: 'applied', commitId: 'commit1', receipt: { revisionAfter: 2 } }, { id: 'p2', status: 'pending', automatic: { status: 'applying' } }] })
    expect(publicFeatureHistory(ai.data).toString()).not.toContain('fixture-secret')
    prepareFeatureBackupRestore([ai])
    const restored = parse(ai)
    expect(restored.tasks.map((task: { state: string }) => task.state)).toEqual(['interrupted', 'interrupted', 'completed'])
    expect(restored.proposals[0]).toEqual(expect.objectContaining({ commitId: 'commit1', receipt: { revisionAfter: 2 } }))
    expect(restored.proposals[1].automatic.status).toBe('confirmation')
    expect(ai.data.toString()).not.toContain('https://private.invalid')
  })
  it('恢复前取消旧请求和排队提交，恢复后的新任务可独立运行', () => {
    registerFeatureRequest({ requestId: 'old-request', observability: { featureTask: { taskId: 'old-task' } } } as ChatParams)
    let notified = 0
    const unsubscribe = onFeatureDataRestoring(() => notified++)
    prepareFeatureDataRestore(); unsubscribe()
    expect(notified).toBe(1)
    expect(isFeatureTaskCancelled('old-task')).toBe(true)
    expect(isFeatureTaskCancelled('new-task')).toBe(false)
    cancelFeatureTask('old-request')
  })
  it('裁剪仍保留未解决任务、重新核对链、提交引用和对应指令', () => {
    const state = { tasks: [{ id: 'old-task', state: 'completed' }, { id: 'failed', state: 'failed' }, ...Array.from({ length: 110 }, (_, i) => ({ id: `t${i}`, state: 'completed' }))],
      messages: [{ id: 'old-message', proposalId: 'origin' }, ...Array.from({ length: 210 }, (_, i) => ({ id: `m${i}` }))],
      proposals: [{ id: 'origin', status: 'stale', taskId: 'old-task', commitId: 'c1' }, { id: 'reviewed', status: 'pending', reviewedFromId: 'origin' }, ...Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, status: 'discarded' }))],
    } as unknown as SpatialAiSession
    trimFeatureHistory(state)
    expect(state.tasks.map(task => task.id)).toContain('old-task')
    expect(state.tasks.map(task => task.id)).toContain('failed')
    expect(state.messages.map(item => item.id)).toContain('old-message')
    expect(state.proposals.find(item => item.id === 'origin')?.commitId).toBe('c1')
    expect(state.historyTrimmed).toBe(true)
  })
})
