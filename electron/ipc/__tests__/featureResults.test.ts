import { cancelFeatureTask, prepareFeatureDataRestore, registerFeatureRequest } from '../../services/featureTaskLifecycle'
/** @vitest-environment node */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const { root } = vi.hoisted(() => ({ root: `${process.env.TEMP}/qingyu-feature-results-${process.pid}` }))
vi.mock('electron', () => ({ app: { getPath: () => root }, BrowserWindow: { getAllWindows: () => [] } }))
import { registerChatIPC } from '../chat'
import { chatData } from '../../features/chat/chatData'
import { messagesCacheInvalidate, withChatMessageLock } from '../../features/chat/chatRepository'
import { groupData, registerGroupIPC } from '../group'
import { DIRS, writeJson, readJson } from '../../services/storage'
import { getDefaultSettings } from '../../../shared/defaults'
import { featureSource, featureRangeSource, compressionVersion, featureFingerprint, groupFeatureScope, featureSessionRef, type FeatureCommit } from '../../../shared/featureSource'
import type { Message, GroupMessage, ChatSession } from '../../../shared/types'

beforeEach(() => {
  writeJson(join(DIRS.config(), 'settings.json'), getDefaultSettings())
  writeJson(join(DIRS.chats(), 'owner', 'sessions.json'), [{ id: 's1', characterId: 'owner', title: '新对话 1', memoryEnabled: true, createdAt: 1, updatedAt: 1 }])
  writeJson(join(DIRS.groups(), 'owner', 'sessions.json'), [{ id: 's1', groupId: 'owner', title: '新对话 1', memoryEnabled: true, createdAt: 1, updatedAt: 1 }])
  writeJson(join(DIRS.groups(), 'index.json'), [{ id: 'owner', memberIds: ['char'], chatMode: 'mention' }])
  messagesCacheInvalidate('owner', 's1')
})
afterEach(() => { rmSync(root, { recursive: true, force: true }); messagesCacheInvalidate('owner', 's1') })

describe.each(['single', 'group'] as const)('%s 功能原子提交', kind => {
  const group = kind === 'group'
  const file = () => join(group ? DIRS.groups() : DIRS.chats(), 'owner', 's1.jsonl')
  const sessionsFile = () => join(group ? DIRS.groups() : DIRS.chats(), 'owner', 'sessions.json')
  const makeMessage = (updates = {}): Message | GroupMessage => ({
    id: 'm1', characterId: group ? 'char' : 'owner', ...(group ? { groupId: 'owner', round: 1 } : { sessionId: 's1', role: 'assistant', isEditing: false }),
    content: '原始正文。', swipes: ['原始正文。', '原始正文。'], images: [], timestamp: 1, ...updates,
  } as Message | GroupMessage)
  const write = (messages: Array<Message | GroupMessage>) => {
    writeFileSync(file(), messages.map(m => JSON.stringify(m)).join('\n') + '\n')
    if (!group) messagesCacheInvalidate('owner', 's1')
  }
  const read = () => group ? groupData.readMessages('owner', 's1') : chatData.readMessages('owner', 's1')
  const commit = (input: FeatureCommit) => (group ? groupData : chatData).commitFeatureResult('owner', 's1', input)
  const translation = (message = makeMessage()): FeatureCommit => ({ feature: 'translation', taskId: 'task-1', source: featureSource([message], 'message'), messageId: 'm1', language: '中文', text: '译文。' })

  it('普通 JSON 导出只含正文与展示身份，附属功能留在完整备份中', async () => {
    write([makeMessage({ translation: '译文', featureTaskIds: { translation: 'task-export' }, dialogueDirections: [{ id: 'd1', content: '建议', label: '建议' }], spatialCheckpointId: 'checkpoint', images: ['image'] })])
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipc = { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) }
    if (group) registerGroupIPC(ipc as never)
    else registerChatIPC(ipc as never)
    const exported = JSON.parse(await handlers.get(`${group ? 'group' : 'chat'}:exportChat`)!(null, 'owner', 's1', 'json') as string)
    expect(exported[0]).toMatchObject({ id: 'm1', content: '原始正文。', images: ['image'], timestamp: 1 })
    expect(exported[0]).not.toHaveProperty('translation')
    expect(exported[0]).not.toHaveProperty('featureTaskIds')
    expect(exported[0]).not.toHaveProperty('dialogueDirections')
    expect(exported[0]).not.toHaveProperty('spatialCheckpointId')
    if (group) expect(exported[0].characterId).toBe('char')
  })

  it('恢复即使沿用同一消息和会话身份，也拒绝旧请求的排队提交并刷新消息缓存', async () => {
    const message = makeMessage(), input = { ...translation(message), taskId: `restore-${group ? 'group' : 'single'}` }
    write([message]); read()
    registerFeatureRequest({ requestId: input.taskId, observability: { featureTask: { taskId: input.taskId } } } as import('../../../shared/types').ChatParams)
    prepareFeatureDataRestore()
    writeFileSync(file(), JSON.stringify(makeMessage({ content: '恢复的新正文' })) + '\n')
    expect(read()[0].content).toBe('恢复的新正文')
    expect(await commit(input)).toBe(false)
  })

  it('只更新译文，保留并发新增的图片、检查点和方向字段；重放幂等', async () => {
    const message = makeMessage(), input = translation(message)
    write([makeMessage({ images: ['new-image'], dialogueDirections: [{ id: 'd', label: '下一步', content: '前进' }], spatialCheckpointId: 'checkpoint' })])
    expect(await commit(input)).toBe(true)
    expect(await commit(input)).toBe(true)
    expect(read()).toHaveLength(1)
    expect(read()[0]).toMatchObject({ content: '原始正文。', swipes: ['原始正文。', '原始正文。'], images: ['new-image'], translation: '译文。', translationLanguage: '中文', spatialCheckpointId: 'checkpoint', featureTaskIds: { translation: 'task-1' } })
    expect(read()[0].dialogueDirections).toHaveLength(1)
  })

  it.each([
    { content: '新正文。' }, { swipeIndex: 1 }, { spatialGenerationId: 'new' },
    { spatialGroupGenerationId: 'new' }, { narrativeMode: 'omniscient' }, { characterId: 'another' },
  ])('来源身份或正文版本变化拒绝旧结果：%j', async changes => {
    const input = translation()
    write([makeMessage(changes)])
    expect(await commit(input)).toBe(false)
    expect(read()[0].translation).toBeUndefined()
  })

  it('消息被删除后不重新创建', async () => {
    write([])
    expect(await commit(translation())).toBe(false)
    expect(read()).toEqual([])
  })

  it('会话被删除后不创建会话或消息文件', async () => {
    writeJson(sessionsFile(), [])
    expect(await commit(translation())).toBe(false)
    expect(readJson(sessionsFile())).toEqual([])
    expect(existsSync(file())).toBe(false)
  })

  it('翻译语言切换拒绝旧结果', async () => {
    write([makeMessage()])
    writeJson(join(DIRS.config(), 'settings.json'), { ...getDefaultSettings(), translationTargetLang: '英语' })
    expect(await commit(translation())).toBe(false)
  })

  it('手动标题不被自动标题覆盖', async () => {
    write([makeMessage()])
    await (group ? groupData : chatData).renameSession('owner', 's1', '用户标题')
    expect(await commit({ feature: 'title', taskId: 'title-task', source: featureSource(read()), expectedTitle: '新对话 1', text: '自动标题' })).toBe(false)
    expect(readJson<ChatSession[]>(sessionsFile())![0]).toMatchObject({ title: '用户标题' })
  })

  it('压缩范围中新增、编辑或删除消息后不提交；新范围完整提交', async () => {
    write([makeMessage()])
    const source = featureSource(read(), 'range'); source.range = { startTs: 1, endTs: 2 }
    const input: FeatureCommit = { feature: 'compression', taskId: 'compress-task', source, range: source.range, expectedCompression: compressionVersion({}), text: '完整摘要。' }
    write([makeMessage(), makeMessage({ id: 'm2', timestamp: 2 })])
    expect(await commit(input)).toBe(false)
    input.source = { ...featureSource(read(), 'range'), range: source.range }
    expect(await commit(input)).toBe(true)
    expect(readJson<ChatSession[]>(sessionsFile())![0]).toMatchObject({ compressedSummary: '完整摘要。', compressedSource: input.source })
    expect(await commit({ ...input, taskId: 'another' })).toBe(false)
  })

  it('记忆输入略过空消息时，范围仍可正常提交；空消息被编辑后旧来源失效', async () => {
    write([makeMessage(), makeMessage({ id: 'empty', content: '', timestamp: 2 }), makeMessage({ id: 'm2', timestamp: 3 })])
    const all = read(), source = featureRangeSource(all, all.filter(m => m.content.trim()))
    expect(await (group ? groupData : chatData).updateSessionIfMemoryVersion('owner', 's1', 0, { memory: '有效摘要', memoryVersion: 1 }, source)).toMatchObject({ applied: true })
    write([makeMessage(), makeMessage({ id: 'empty', content: '新增正文', timestamp: 2 }), makeMessage({ id: 'm2', timestamp: 3 })])
    expect(await (group ? groupData : chatData).updateSessionIfMemoryVersion('owner', 's1', 1, { memory: '旧来源摘要', memoryVersion: 2 }, source)).toMatchObject({ applied: false })
    expect(readJson<ChatSession[]>(sessionsFile())![0].memory).toBe('有效摘要')
  })

  it('记忆版本未变化但来源消息被编辑时，版本提交仍拒绝', async () => {
    const source = featureSource([makeMessage()], 'range', featureSessionRef({ memoryEnabled: true }, ['memoryEnabled']))
    write([makeMessage({ content: '已修改。' })])
    expect(await (group ? groupData : chatData).updateSessionIfMemoryVersion('owner', 's1', 0, { memory: '旧摘要', memoryVersion: 1 }, source)).toMatchObject({ applied: false })
  })

  it('提交等待消息写锁后再次核对来源，避免读旧写新', async () => {
    write([makeMessage()])
    let release!: () => void
    const lock = group ? groupData.withMessagesLock.bind(groupData, 'owner', 's1') : withChatMessageLock.bind(null, { characterId: 'owner', sessionId: 's1' })
    const editing = lock(async () => { await new Promise<void>(resolve => { release = resolve }); write([makeMessage({ content: '编辑已完成。' })]) })
    await Promise.resolve()
    const result = commit(translation())
    release(); await editing
    expect(await result).toBe(false)
    expect(read()[0].content).toBe('编辑已完成。')
  })

  it('世界书缓存按来源 key 原子合并，保留其他任务的缓存和正文', async () => {
    write([makeMessage()])
    const entry = { summary: '世界书摘要', entryKeys: ['book:entry'], createdAt: 1 }
    expect(await commit({ feature: 'lorebook_compression', taskId: 'lorebook-1', source: { messages: [], mode: 'message', artifactKey: 'revision-1' }, cacheKey: 'revision-1', entry })).toBe(true)
    expect(await commit({ feature: 'lorebook_compression', taskId: 'lorebook-2', source: { messages: [], mode: 'message', artifactKey: 'revision-2' }, cacheKey: 'revision-2', entry })).toBe(true)
    const session = readJson<ChatSession[]>(sessionsFile())![0]
    expect(Object.keys(session.lorebookCompressionCache!)).toEqual(['revision-1', 'revision-2'])
    expect(read()[0].content).toBe('原始正文。')
    writeJson(sessionsFile(), [])
    expect(await commit({ feature: 'lorebook_compression', taskId: 'lorebook-3', source: { messages: [], mode: 'message', artifactKey: 'revision-3' }, cacheKey: 'revision-3', entry })).toBe(false)
  })

  it('手动改名再改回默认标题仍保留用户决定', async () => {
    write([makeMessage()])
    const source = featureSource(read(), 'whole', featureSessionRef({}, ['titleRevision']))
    await (group ? groupData : chatData).renameSession('owner', 's1', '用户标题')
    await (group ? groupData : chatData).renameSession('owner', 's1', '新对话 1')
    expect(await commit({ feature: 'title', taskId: 'title-aba', source, expectedTitle: '新对话 1', text: '旧自动标题' })).toBe(false)
  })

  it('来源记忆任务在会话删除后返回未提交，且不重建会话', async () => {
    const source = featureSource([makeMessage()], 'range')
    writeJson(sessionsFile(), [])
    expect(await (group ? groupData : chatData).updateSessionIfMemoryVersion('owner', 's1', 0, { memory: '旧摘要' }, source)).toMatchObject({ applied: false })
    expect(readJson(sessionsFile())).toEqual([])
  })

  it('模型已完成但等待提交时取消，主进程仍拒绝写回', async () => {
    write([makeMessage()])
    const input = { ...translation(), taskId: `cancelled-${kind}` }
    cancelFeatureTask(input.taskId)
    expect(await commit(input)).toBe(false)
    expect(read()[0].translation).toBeUndefined()
  })

  if (group) it('群成员变化使依赖群聊范围的任务失效', async () => {
    write([makeMessage()])
    const source = featureSource(read()); source.groupFingerprint = featureFingerprint(groupFeatureScope({ memberIds: ['char'], chatMode: 'mention' }))
    writeJson(join(DIRS.groups(), 'index.json'), [{ id: 'owner', memberIds: ['other'], chatMode: 'mention' }])
    expect(await commit({ feature: 'direction', taskId: 'direction-task', source, messageId: 'm1', directions: [] })).toBe(false)
  })
})
