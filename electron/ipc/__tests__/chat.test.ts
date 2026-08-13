/**
 * chat 会话元数据缓存单元测试（P2/E3 修复）
 * 验证 computeMessageMetaCached：统计正确性 + mtime/size 缓存失效（文件变更后重算）
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// electron mock：userData 隔离到临时目录
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-chat-test' },
}))

import { computeMessageMetaCached, readMessages, appendMessage, messagesCacheInvalidate, compactSessionFile } from '../chat'

const TEST_DIR = '/tmp/qingyu-chat-test/data/chats/char-001'
const SESSION_FILE = join(TEST_DIR, 's1.jsonl')

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  writeFileSync(SESSION_FILE, '')
})

afterEach(() => {
  rmSync('/tmp/qingyu-chat-test', { recursive: true, force: true })
})

describe('computeMessageMetaCached', () => {
  it('文件不存在返回空统计', () => {
    expect(computeMessageMetaCached('char-001', 'missing')).toEqual({ count: 0, lastMessage: '' })
  })

  it('统计行数与最后一条消息摘要', () => {
    writeFileSync(SESSION_FILE, [
      JSON.stringify({ id: 'a', content: '第一条' }),
      JSON.stringify({ id: 'b', content: '第二条消息内容' }),
      JSON.stringify({ id: 'c', content: '最后一条消息', role: 'assistant' }),
      '',
    ].join('\n'))
    const meta = computeMessageMetaCached('char-001', 's1')
    expect(meta.count).toBe(3)
    expect(meta.lastMessage).toContain('最后一条消息')
  })

  it('文件未变化时重复调用返回一致结果（缓存命中）', () => {
    writeFileSync(SESSION_FILE, JSON.stringify({ id: 'a', content: 'x' }) + '\n')
    const first = computeMessageMetaCached('char-001', 's1')
    const second = computeMessageMetaCached('char-001', 's1')
    expect(second).toEqual(first)
  })

  it('文件追加后缓存失效并重算', () => {
    writeFileSync(SESSION_FILE, JSON.stringify({ id: 'a', content: 'x' }) + '\n')
    const first = computeMessageMetaCached('char-001', 's1')
    expect(first.count).toBe(1)
    // 追加两条（appendFileSync 改变 mtime/size）
    appendFileSync(SESSION_FILE, JSON.stringify({ id: 'b', content: 'y' }) + '\n')
    appendFileSync(SESSION_FILE, JSON.stringify({ id: 'c', content: 'z' }) + '\n')
    const second = computeMessageMetaCached('char-001', 's1')
    expect(second.count).toBe(3)
    expect(second.lastMessage).toContain('z')
  })

  it('文件被删除后返回空统计（不命中缓存）', () => {
    writeFileSync(SESSION_FILE, JSON.stringify({ id: 'a', content: 'x' }) + '\n')
    computeMessageMetaCached('char-001', 's1')
    rmSync(SESSION_FILE, { force: true })
    expect(computeMessageMetaCached('char-001', 's1')).toEqual({ count: 0, lastMessage: '' })
  })

  it('不同会话互不影响', () => {
    writeFileSync(SESSION_FILE, JSON.stringify({ id: 'a', content: '单聊' }) + '\n')
    const otherFile = join(TEST_DIR, 's2.jsonl')
    writeFileSync(otherFile, JSON.stringify({ id: 'b', content: '另一会话' }) + '\n')
    expect(computeMessageMetaCached('char-001', 's1').count).toBe(1)
    expect(computeMessageMetaCached('char-001', 's2').count).toBe(1)
  })
})

// ===================== readMessages LRU 缓存（P-6） =====================

describe('readMessages 读取缓存', () => {
  const CHAR_DIR = '/tmp/qingyu-chat-test/data/chats/char-cache'
  const SESSION_FILE = join(CHAR_DIR, 's1.jsonl')

  function msg(id: string, content: string, ts = 1000) {
    return {
      id, role: 'user' as const, characterId: 'char-cache', sessionId: 's1',
      content, images: [], isEditing: false, timestamp: ts,
    }
  }

  beforeEach(() => {
    mkdirSync(CHAR_DIR, { recursive: true })
    writeFileSync(SESSION_FILE, '')
    vi.restoreAllMocks()
  })

  afterEach(() => {
    rmSync('/tmp/qingyu-chat-test', { recursive: true, force: true })
    messagesCacheInvalidate('char-cache')
  })

  it('连续读取命中缓存：磁盘变更后仍返回缓存内容', () => {
    writeFileSync(
      SESSION_FILE,
      JSON.stringify(msg('a', '第一条', 1000)) + '\n' + JSON.stringify(msg('b', '第二条', 2000)) + '\n',
    )
    const first = readMessages('char-cache', 's1')
    expect(first.map(m => m.id)).toEqual(['a', 'b'])
    // 磁盘直接追加一条"影子消息"（模拟绕过 appendMessage 的外部写入）
    appendFileSync(SESSION_FILE, JSON.stringify(msg('c', '影子', 3000)) + '\n')
    const second = readMessages('char-cache', 's1')
    // 仍返回缓存的 2 条，不含影子消息 → 证明命中缓存未读盘
    expect(second.map(m => m.id)).toEqual(['a', 'b'])
  })

  it('appendMessage 后缓存增量更新：不重新读盘', () => {
    writeFileSync(SESSION_FILE, JSON.stringify(msg('a', '第一条', 1000)) + '\n')
    readMessages('char-cache', 's1') // 预热缓存
    // 磁盘直接追加影子消息后，再通过 appendMessage 正常写入
    appendFileSync(SESSION_FILE, JSON.stringify(msg('c', '影子', 3000)) + '\n')
    appendMessage('char-cache', 's1', msg('b', '第二条', 2000))
    const msgs = readMessages('char-cache', 's1')
    // 缓存增量 = [a, b]，不含影子消息 → 证明未重新读盘（否则会读到影子）
    expect(msgs.map(m => m.id)).toEqual(['a', 'b'])
    expect(msgs[1].content).toBe('第二条')
  })

  it('appendMessage 同 id 覆盖：与读盘去重语义一致', () => {
    writeFileSync(SESSION_FILE, JSON.stringify(msg('a', '旧内容', 1000)) + '\n')
    readMessages('char-cache', 's1')
    appendMessage('char-cache', 's1', msg('a', '新内容', 1000))
    const msgs = readMessages('char-cache', 's1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('新内容')
  })

  it('不同会话缓存互不影响', () => {
    writeFileSync(SESSION_FILE, JSON.stringify(msg('a', 's1 消息', 1000)) + '\n')
    writeFileSync(join(CHAR_DIR, 's2.jsonl'), JSON.stringify(msg('b', 's2 消息', 1000)) + '\n')
    expect(readMessages('char-cache', 's1')[0].content).toBe('s1 消息')
    expect(readMessages('char-cache', 's2')[0].content).toBe('s2 消息')
    expect(readMessages('char-cache', 's1')[0].content).toBe('s1 消息')
  })

  it('失效后重新读盘（能看到磁盘上的新数据）', () => {
    writeFileSync(SESSION_FILE, JSON.stringify(msg('a', '第一条', 1000)) + '\n')
    readMessages('char-cache', 's1')
    // 磁盘追加新消息（模拟缓存失效前的外部写入）
    appendFileSync(SESSION_FILE, JSON.stringify(msg('b', '磁盘新消息', 2000)) + '\n')
    messagesCacheInvalidate('char-cache', 's1')
    const msgs = readMessages('char-cache', 's1')
    expect(msgs.map(m => m.id)).toEqual(['a', 'b'])
  })

  it('超出缓存上限后最旧条目被淘汰：重新读盘', () => {
    for (let i = 0; i < 35; i++) {
      writeFileSync(join(CHAR_DIR, `s${i}.jsonl`), JSON.stringify(msg(`m${i}`, `消息${i}`, 1000 + i)) + '\n')
      readMessages('char-cache', `s${i}`)
    }
    // s0 是最早插入的，应已被淘汰（上限 30）。直接改磁盘，读取应能看到新内容
    writeFileSync(join(CHAR_DIR, 's0.jsonl'), JSON.stringify(msg('m0', '磁盘更新后的内容', 1000)) + '\n')
    const msgs = readMessages('char-cache', 's0')
    expect(msgs[0].content).toBe('磁盘更新后的内容')
  })
})

// ===================== 消息文件 compact（P-8） =====================

describe('compactSessionFile 消息文件压缩', () => {
  const CHAR_DIR = '/tmp/qingyu-chat-test/data/chats/char-compact'
  const SESSION_FILE = join(CHAR_DIR, 's1.jsonl')

  function msg(id: string, content: string, ts = 1000) {
    return {
      id, role: 'user' as const, characterId: 'char-compact', sessionId: 's1',
      content, images: [], isEditing: false, timestamp: ts,
    }
  }

  beforeEach(() => {
    mkdirSync(CHAR_DIR, { recursive: true })
    writeFileSync(SESSION_FILE, '')
    vi.restoreAllMocks()
  })

  afterEach(() => {
    rmSync('/tmp/qingyu-chat-test', { recursive: true, force: true })
    messagesCacheInvalidate('char-compact')
  })

  it('同 id 多次追加后 compact 去重：文件只剩最新版本一行', async () => {
    writeFileSync(SESSION_FILE, JSON.stringify(msg('a', 'v1', 1000)) + '\n')
    readMessages('char-compact', 's1') // 预热缓存
    // 模拟频繁编辑：同 id 追加 5 个版本
    appendMessage('char-compact', 's1', msg('a', 'v2', 1000))
    appendMessage('char-compact', 's1', msg('a', 'v3', 1000))
    appendMessage('char-compact', 's1', msg('a', 'v4', 1000))
    appendMessage('char-compact', 's1', msg('a', 'v5', 1000))
    appendMessage('char-compact', 's1', msg('a', 'v6', 1000))
    const beforeLines = readFileSync(SESSION_FILE, 'utf-8').split('\n').filter(Boolean).length
    expect(beforeLines).toBe(6)

    await compactSessionFile('char-compact', 's1')

    const afterLines = readFileSync(SESSION_FILE, 'utf-8').split('\n').filter(Boolean).length
    expect(afterLines).toBe(1)
    // 缓存同步为最新版本
    expect(readMessages('char-compact', 's1')[0].content).toBe('v6')
  })

  it('compact 保留不同 id 的消息并去重同 id 旧版本', async () => {
    writeFileSync(
      SESSION_FILE,
      JSON.stringify(msg('a', 'a-旧', 1000)) + '\n' + JSON.stringify(msg('b', 'b-内容', 2000)) + '\n',
    )
    readMessages('char-compact', 's1')
    appendMessage('char-compact', 's1', msg('a', 'a-新', 1000))
    await compactSessionFile('char-compact', 's1')

    const msgs = readMessages('char-compact', 's1', true)
    expect(msgs).toHaveLength(2)
    expect(msgs.find(m => m.id === 'a')?.content).toBe('a-新')
    expect(msgs.find(m => m.id === 'b')?.content).toBe('b-内容')
  })

  it('乱序消息在读取时按 timestamp 排序（P-8 有序检测）', () => {
    writeFileSync(
      SESSION_FILE,
      JSON.stringify(msg('a', '较晚', 3000)) + '\n' + JSON.stringify(msg('b', '较早', 1000)) + '\n',
    )
    const msgs = readMessages('char-compact', 's1')
    expect(msgs.map(m => m.id)).toEqual(['b', 'a'])
  })
})
