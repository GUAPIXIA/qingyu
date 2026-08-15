/**
 * 阶段 0a：主进程 ContextDataProvider/Writer 单元测试。
 * 覆盖（方案 §7 阶段 0a 验收）：
 * 1. fetchBuildData 从磁盘正确组装角色/预设/会话/消息/设置/世界书/正则快照；
 * 2. 双端写入一致性：ContextDataWriter.saveMessage 与渲染层同一落盘路径
 *    （chatData.appendMessage），JSONL 格式与字段一致，可被 readMessages 读回；
 * 3. getSession 返回会话完整字段（memory 等）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// electron mock：userData 隔离到临时目录
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-context-test' },
}))

import { DIRS } from '../../services/storage'
import { chatData, messagesCacheInvalidate } from '../../ipc/chat'
import { mainContextProvider, mainContextWriter } from '../mainContextProvider'
import type { Message } from '../../../shared/types'

const TEST_ROOT = '/tmp/qingyu-context-test'
const CHARACTER_ID = 'char-001'
const SESSION_ID = 's1'

function writeFile(dir: string, name: string, content: unknown): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), JSON.stringify(content, null, 2), 'utf-8')
}

function sampleMessage(id: string, content: string, sessionId = SESSION_ID): Message {
  return {
    id,
    sessionId,
    characterId: CHARACTER_ID,
    role: 'assistant',
    content,
    images: [],
    isEditing: false,
    timestamp: 1720000000000,
  }
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  // 角色
  writeFile(DIRS.characters(), `${CHARACTER_ID}.json`, {
    id: CHARACTER_ID,
    name: '测试角色',
    description: '测试描述',
    personality: '冷静',
    scenario: '测试场景',
    systemPrompt: '你是测试角色',
    firstMessage: '你好',
    boundPresetId: 'preset-01',
    boundLorebookIds: ['lb-01'],
    avatar: '',
    cover: '',
  })
  // 设置（含 activeProfileId + activePresetId）
  writeFile(DIRS.config(), 'settings.json', {
    userName: '用户A',
    userDescription: '喜欢冒险',
    activeProfileId: 'profile-01',
    activePresetId: 'preset-01',
    connectionProfiles: [
      {
        id: 'profile-01',
        name: '本地测试',
        provider: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'http://localhost:11434/v1',
        model: 'gpt-4o-mini',
        maxContext: 8192,
        useInstructTemplate: false,
      },
    ],
  })
  // 预设
  writeFile(DIRS.presets(), 'preset-01.json', {
    id: 'preset-01',
    name: '测试预设',
    description: '',
    systemPrompt: '预设系统提示',
    jailbreak: '',
    maxContext: 4096,
    temperature: 0.8,
    topP: 1,
    maxTokens: 512,
    frequencyPenalty: 0,
    presencePenalty: 0,
    isBuiltin: false,
  })
  // 世界书
  writeFile(DIRS.lorebooks(), 'lb-01.json', {
    id: 'lb-01',
    name: '测试世界书',
    description: '',
    enabled: true,
    scanDepth: 10,
    entries: [
      {
        id: 'e1',
        keywords: ['关键词'],
        content: '世界书内容',
        position: 'before_char',
        order: 1,
        probability: 100,
        enabled: true,
      },
    ],
  })
  // 正则
  mkdirSync(join(DIRS.config(), 'regex'), { recursive: true })
  writeFileSync(join(DIRS.config(), 'regex', 'rules.json'), JSON.stringify([
    { id: 'r1', name: '测试正则', find: 'foo', replace: 'bar', enabled: true, scope: 'input', flags: '' },
  ]), 'utf-8')
})

afterEach(() => {
  // 消息读取缓存为模块级 LRU，跨测试残留会导致磁盘读被缓存绕过，必须失效
  messagesCacheInvalidate(CHARACTER_ID)
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('mainContextProvider.fetchBuildData', () => {
  it('从磁盘组装完整快照（角色/预设/设置/世界书/正则）', async () => {
    // 先建会话与消息
    await chatData.createSession(CHARACTER_ID, '测试会话')
    const sessions = await chatData.listSessions(CHARACTER_ID)
    const sid = sessions[0].id
    chatData.saveMessage(CHARACTER_ID, sampleMessage('m1', '第一条', sid))

    const data = await mainContextProvider.fetchBuildData(CHARACTER_ID, sid)

    expect(data.character).not.toBeNull()
    expect(data.character?.name).toBe('测试角色')
    expect(data.preset?.id).toBe('preset-01')
    expect(data.settings.profile?.model).toBe('gpt-4o-mini')
    expect(data.settings.settings.userName).toBe('用户A')
    expect(data.lorebooks).toHaveLength(1)
    expect(data.lorebooks[0].id).toBe('lb-01')
    expect(data.regexRules).toHaveLength(1)
    // 会话快照
    expect(data.chat.currentSessionId).toBe(sid)
    expect(data.chat.messages).toHaveLength(1)
    expect(data.chat.messages[0].content).toBe('第一条')
    expect(data.chat.activeLorebookIds).toEqual(['lb-01'])
    // 主进程暂无语义检索
    expect(data.chat.semanticFactsHits).toEqual([])
    expect(data.chat.semanticLoreHits).toEqual([])
  })

  it('无会话时自动创建默认会话并返回空消息', async () => {
    const data = await mainContextProvider.fetchBuildData(CHARACTER_ID, 'missing-session')
    expect(data.chat.sessions.length).toBeGreaterThan(0)
    expect(data.chat.messages).toEqual([])
  })

  it('显式 presetId 覆盖角色绑定', async () => {
    writeFile(DIRS.presets(), 'preset-02.json', {
      id: 'preset-02',
      name: '预设二',
      description: '',
      systemPrompt: '预设二提示',
      jailbreak: '',
      maxContext: 2048,
      temperature: 0.7,
      topP: 1,
      maxTokens: 256,
      frequencyPenalty: 0,
      presencePenalty: 0,
      isBuiltin: false,
    })
    const data = await mainContextProvider.fetchBuildData(
      CHARACTER_ID,
      's1',
      { presetId: 'preset-02' },
    )
    expect(data.preset?.id).toBe('preset-02')
  })
})

describe('ContextDataWriter 双端写入一致性', () => {
  it('saveMessage 落盘 JSONL 行与 Message 字段一致，可被 readMessages 读回', async () => {
    const session = await chatData.createSession(CHARACTER_ID, '一致性测试')
    const message = sampleMessage('mid-1', '双端写入测试消息', session.id)

    // 写入路径与渲染层 window.api.chat.saveMessage 的底层实现完全一致（appendMessage）
    mainContextWriter.saveMessage(CHARACTER_ID, message)

    // 磁盘 JSONL：最后一行应等于消息的 JSON 序列化（无多余字段）
    const filePath = join(DIRS.chats(), CHARACTER_ID, `${session.id}.jsonl`)
    expect(existsSync(filePath)).toBe(true)
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n')
    expect(JSON.parse(lines[lines.length - 1])).toEqual(message)

    // 读回：与 IPC handler 同一 readMessages 路径
    const readBack = chatData.readMessages(CHARACTER_ID, session.id)
    expect(readBack).toHaveLength(1)
    expect(readBack[0].id).toBe('mid-1')
    expect(readBack[0].content).toBe('双端写入测试消息')
  })

  it('writer 的 delete/rename/memory 方法与 chatData 行为一致', async () => {
    const session = await chatData.createSession(CHARACTER_ID, '操作测试')
    const m = sampleMessage('mid-2', '待删除', session.id)
    mainContextWriter.saveMessage(CHARACTER_ID, m)

    await mainContextWriter.renameSession(CHARACTER_ID, session.id, '新标题')
    await mainContextWriter.updateMemory(CHARACTER_ID, session.id, '记忆摘要')

    const afterRename = await mainContextWriter.listSessions(CHARACTER_ID)
    const updated = afterRename.find((s) => s.id === session.id)
    expect(updated?.title).toBe('新标题')
    expect(updated?.memory).toBe('记忆摘要')

    await mainContextWriter.deleteMessage(CHARACTER_ID, 'mid-2', session.id)
    const afterDelete = chatData.readMessages(CHARACTER_ID, session.id)
    expect(afterDelete).toHaveLength(0)
  })
})

describe('mainContextProvider.getSession', () => {
  it('返回会话完整字段（memory 等）', async () => {
    const session = await chatData.createSession(CHARACTER_ID, '会话A')
    await mainContextWriter.updateMemory(CHARACTER_ID, session.id, '摘要内容')

    const fetched = await mainContextProvider.getSession(CHARACTER_ID, session.id)
    expect(fetched?.id).toBe(session.id)
    expect(fetched?.memory).toBe('摘要内容')
    expect(fetched?.memoryEnabled).toBe(false)
  })
})
