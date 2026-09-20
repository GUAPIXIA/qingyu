/**
 * 向量索引增量失效逻辑单元测试
 *
 * 覆盖：保存索引、标记过期、统计过期、清空过期、仅标记已索引条目。
 * 通过 mock electron 的 userData 路径隔离到临时目录。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { rmSync, mkdirSync, existsSync } from 'node:fs'
import { vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-vector-store-test' },
}))

import { saveVectorIndex, patchVectorIndex, getVectorIndex, markStaleEntries, clearStaleEntries, countStaleEntries, countIndexedEntries, removeVectorIndex } from '../vectorStore'

const TEST_ID = 'lb-test-001'

beforeEach(() => {
  // 清理隔离目录 + 模块级缓存（removeVectorIndex 同时清内存缓存）
  removeVectorIndex(TEST_ID)
  try { rmSync('/tmp/qingyu-vector-store-test', { recursive: true, force: true }) } catch { /* ignore */ }
  mkdirSync('/tmp/qingyu-vector-store-test/vectors', { recursive: true })
})

function vec(...v: number[]): number[] {
  return v
}

describe('vectorStore 增量失效', () => {
  it('保存索引后可读取与计数', () => {
    saveVectorIndex(TEST_ID, 'test-model', {
      e1: vec(1, 0, 0),
      e2: vec(0, 1, 0),
    })
    expect(countIndexedEntries(TEST_ID)).toBe(2)
    const index = getVectorIndex(TEST_ID)
    expect(index?.model).toBe('test-model')
    expect(index?.stale ?? []).toHaveLength(0)
  })

  it('markStaleEntries 标记已索引条目为过期', () => {
    saveVectorIndex(TEST_ID, 'test-model', { e1: vec(1, 0, 0), e2: vec(0, 1, 0) })
    markStaleEntries(TEST_ID, ['e1'])
    expect(countStaleEntries(TEST_ID)).toBe(1)
    const index = getVectorIndex(TEST_ID)
    expect(index?.stale).toContain('e1')
    expect(index?.stale).not.toContain('e2')
  })

  it('未索引的条目不会被标记（新增条目无向量）', () => {
    saveVectorIndex(TEST_ID, 'test-model', { e1: vec(1, 0, 0) })
    markStaleEntries(TEST_ID, ['e2']) // e2 不在索引中
    expect(countStaleEntries(TEST_ID)).toBe(0)
  })

  it('clearStaleEntries 清空过期标记（重建索引后）', () => {
    saveVectorIndex(TEST_ID, 'test-model', { e1: vec(1, 0, 0), e2: vec(0, 1, 0) })
    markStaleEntries(TEST_ID, ['e1', 'e2'])
    expect(countStaleEntries(TEST_ID)).toBe(2)
    clearStaleEntries(TEST_ID)
    expect(countStaleEntries(TEST_ID)).toBe(0)
  })

  it('重复标记不重复计数', () => {
    saveVectorIndex(TEST_ID, 'test-model', { e1: vec(1, 0, 0) })
    markStaleEntries(TEST_ID, ['e1'])
    markStaleEntries(TEST_ID, ['e1'])
    expect(countStaleEntries(TEST_ID)).toBe(1)
  })

  it('无索引时标记静默跳过', () => {
    markStaleEntries(TEST_ID, ['e1']) // 没有保存过索引
    expect(countStaleEntries(TEST_ID)).toBe(0)
  })
})

describe('vectorStore 维度一致性', () => {
  it('同维度向量正常保存', () => {
    saveVectorIndex(TEST_ID, 'test-model', { e1: vec(1, 0, 0), e2: vec(0, 1, 0) })
    expect(countIndexedEntries(TEST_ID)).toBe(2)
  })

  it('维度不一致的条目被跳过（不同维度不混存，避免点积错乱）', () => {
    saveVectorIndex(TEST_ID, 'test-model', {
      e1: vec(1, 0, 0),        // 3 维
      e2: vec(1, 0, 0, 0, 0),  // 5 维 → 应被跳过
    })
    expect(countIndexedEntries(TEST_ID)).toBe(1)
  })

  it('空向量数组不保存', () => {
    saveVectorIndex(TEST_ID, 'test-model', { e1: [], e2: vec(0, 1) })
    expect(countIndexedEntries(TEST_ID)).toBe(1)
  })
})

describe('vectorStore 本地模型索引空间', () => {
  it('按 model-id/version 隔离存储，并参与统一 stale 标记', () => {
    const space = { provider: 'local' as const, model: 'tiny@1.0.0', modelId: 'tiny', modelVersion: '1.0.0' }
    saveVectorIndex(TEST_ID, space.model, { e1: vec(1, 0, 0) }, space)
    expect(existsSync(`/tmp/qingyu-vector-store-test/indexes/embedding/tiny/1.0.0/${TEST_ID}.json`)).toBe(true)
    expect(getVectorIndex(TEST_ID, space)).toMatchObject({ provider: 'local', modelId: 'tiny', modelVersion: '1.0.0', dimensions: 3 })
    markStaleEntries(TEST_ID, ['e1'])
    expect(countStaleEntries(TEST_ID, space)).toBe(1)
  })

  it('本地命名空间支持增量更新、删除与修订号推进', () => {
    const space = { provider: 'local' as const, model: 'tiny@1.0.0', modelId: 'tiny', modelVersion: '1.0.0' }
    saveVectorIndex(TEST_ID, space.model, { e1: vec(1, 0), e2: vec(0, 1) }, space, 1)
    markStaleEntries(TEST_ID, ['e1', 'e2'])
    patchVectorIndex(TEST_ID, space.model, { e1: vec(0.5, 0.5) }, ['e2'], space, 2)
    expect(getVectorIndex(TEST_ID, space)).toMatchObject({ sourceRevision: 2, stale: [], entries: { e1: expect.any(Array) } })
    expect(getVectorIndex(TEST_ID, space)?.entries.e2).toBeUndefined()
  })
})
