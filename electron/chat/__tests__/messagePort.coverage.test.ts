/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TEST_ROOT = '/tmp/qingyu-messageport-cov-test'
vi.mock('electron', () => ({ app: { getPath: () => TEST_ROOT } }))

import { chatMessagePort } from '../messagePort'
import { DIRS } from '../../services/storage'
import { chatData } from '../../ipc/chat'

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})
afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('messagePort coverage', () => {
  it('findSession 找不到返回 null', async () => {
    const r = await chatMessagePort.findSession('not-exist', 'c1')
    expect(r).toBeNull()
  })

  it('findMessage 找不到返回 null / 会话不存在', async () => {
    expect(await chatMessagePort.findMessage('no-session', 'msg-1')).toBeNull()
    // 创建会话但消息不存在
    mkdirSync(DIRS.characters(), { recursive: true })
    writeFileSync(join(DIRS.characters(), 'char-mp.json'), JSON.stringify({ id: 'char-mp', name: 'T', description: '', personality: '', scenario: '', firstMessage: 'hi', exampleDialog: '', tags: [], lorebookId: null, creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [] }), 'utf-8')
    const session = await chatData.createSession('char-mp', 'mp-test')
    expect(await chatMessagePort.findMessage(session.id, 'not-found')).toBeNull()
  })

  it('findByRequestId 会话不存在返回 null', async () => {
    expect(await chatMessagePort.findByRequestId('no-session', 'req-1')).toBeNull()
  })

  it('findByRequestId 命中', async () => {
    mkdirSync(DIRS.characters(), { recursive: true })
    writeFileSync(join(DIRS.characters(), 'char-mp2.json'), JSON.stringify({ id: 'char-mp2', name: 'T2', description: '', personality: '', scenario: '', firstMessage: 'hi', exampleDialog: '', tags: [], lorebookId: null, creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [] }), 'utf-8')
    const session = await chatData.createSession('char-mp2', 'mp-test2')
    const msgId = 'msg-req-hit'
    // 直接用 messagePort 写入，再查找
    await chatMessagePort.appendUserMessage({ id: msgId, sessionId: session.id, characterId: 'char-mp2', content: 'hello', requestId: 'req-hit-1' })
    const found = await chatMessagePort.findByRequestId(session.id, 'req-hit-1')
    expect(found?.id).toBe(msgId)
    expect(await chatMessagePort.findByRequestId(session.id, 'not-hit')).toBeNull()
  })

  it('appendSwipedCandidate 命中并追加', async () => {
    mkdirSync(DIRS.characters(), { recursive: true })
    writeFileSync(join(DIRS.characters(), 'char-mp3.json'), JSON.stringify({ id: 'char-mp3', name: 'T3', description: '', personality: '', scenario: '', firstMessage: 'hi', exampleDialog: '', tags: [], lorebookId: null, creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [] }), 'utf-8')
    const session = await chatData.createSession('char-mp3', 'mp-test3')
    await chatMessagePort.commitAssistantMessage({ id: 'msg-assist-1', sessionId: session.id, characterId: 'char-mp3', content: 'orig', requestId: 'req-a1', generationTaskId: 'task-a1' })
    const res = await chatMessagePort.appendSwipedCandidate('msg-assist-1', 'candidate-2')
    expect(res.swipes.length).toBe(2)
    expect(res.content).toBe('candidate-2')
    const found = await chatMessagePort.findMessage(session.id, 'msg-assist-1')
    expect(found?.swipes?.length).toBe(2)
  })

  it('appendSwipedCandidate 目标不存在抛', async () => {
    await expect(chatMessagePort.appendSwipedCandidate('no-such-id', 'x')).rejects.toThrow('不存在')
  })

  it('updateAssistantMessage 空实现不抛', async () => {
    await expect(chatMessagePort.updateAssistantMessage('any', { content: 'x' })).resolves.toBeUndefined()
  })
})
