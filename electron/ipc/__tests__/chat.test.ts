/**
 * chat 会话元数据缓存单元测试（P2/E3 修复）
 * 验证 computeMessageMetaCached：统计正确性 + mtime/size 缓存失效（文件变更后重算）
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// electron mock：userData 隔离到临时目录
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-chat-test' },
}))

import { computeMessageMetaCached } from '../chat'
import { DIRS } from '../../services/storage'

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
