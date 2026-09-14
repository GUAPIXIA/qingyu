import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-observation-test' },
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import {
  appendObservationToFile,
  getUsageProfileDiagnostics,
  queryGenerationDiagnostics,
  queryUsageProfile,
  recordGenerationObservation,
  resetUsageProfileIndexForTests,
  resolveObservationsFilePath,
} from '../generationObservation'
import { endpointFingerprint } from '../../../shared/endpointKey'
import type { GenerationObservation } from '../../../shared/generationObservation'

function makeObservation(overrides: Partial<GenerationObservation> = {}): GenerationObservation {
  return {
    ts: Date.now(),
    requestId: 'req-1',
    source: 'single',
    model: 'deepseek-v4',
    requestedMaxTokens: 4096,
    stream: true,
    finishReason: 'stop',
    outcome: 'completed',
    bodyVisibleChars: 120,
    completionTokens: 800,
    reasoningTokens: 'unknown',
    durationMs: 3000,
    attempts: 1,
    diagnostics: {
      completeSentence: true,
      balancedQuotes: true,
      balancedAsterisks: true,
      closedThought: true,
    },
    ...overrides,
  }
}

describe('generationObservation 落盘', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qingyu-obs-'))
    filePath = join(dir, 'generation-observations.jsonl')
  })

  it('追加 JSONL（每行一条）', () => {
    appendObservationToFile(filePath, makeObservation({ requestId: 'a' }))
    appendObservationToFile(filePath, makeObservation({ requestId: 'b' }))
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    const second = JSON.parse(lines[1]) as GenerationObservation
    expect(second.requestId).toBe('b')
  })

  it('超过阈值轮转为 .old（最多保留一代）', () => {
    appendObservationToFile(filePath, makeObservation({ requestId: 'old' }))
    // 手动膨胀文件超过 5MB 阈值
    writeFileSync(filePath, 'x'.repeat(5 * 1024 * 1024 + 1), 'utf-8')
    appendObservationToFile(filePath, makeObservation({ requestId: 'new' }))
    expect(existsSync(`${filePath}.old`)).toBe(true)
    expect(statSync(filePath).size).toBeLessThan(5 * 1024 * 1024)
    const content = readFileSync(filePath, 'utf-8')
    expect(content).toContain('"new"')
    expect(content).not.toContain('"old"')
    rmSync(dir, { recursive: true, force: true })
  })

  it('解析默认路径（userData/data/diagnostics）', () => {
    expect(resolveObservationsFilePath().replace(/\\/g, '/')).toContain('/data/diagnostics/generation-observations.jsonl')
  })
})

/**
 * W1（主计划 §7.3）：观测回读的有界读取与内存聚合。
 * 覆盖验收项：损坏行跳过、`.old` 合并、有界样本、unknown 不当 0、读取失败回退。
 */
describe('W1：用量档案回读（有界读取 + 内存聚合）', () => {
  const observedBaseUrl = 'https://api.example.com/v1'
  const otherBaseUrl = 'https://proxy.example.com/v1'
  const fingerprint = endpointFingerprint(observedBaseUrl)

  function writeJsonl(path: string, lines: string[]): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8')
  }

  function recordAt(baseUrl: string, overrides: Partial<GenerationObservation> = {}): GenerationObservation {
    return makeObservation({
      provider: 'openai',
      model: 'deepseek-v4',
      endpointFingerprint: endpointFingerprint(baseUrl),
      ...overrides,
    })
  }

  beforeEach(() => {
    resetUsageProfileIndexForTests()
    rmSync(dirname(resolveObservationsFilePath()), { recursive: true, force: true })
  })

  it('懒加载合并 .old 与当前文件，损坏行只计诊断', () => {
    const path = resolveObservationsFilePath()
    writeJsonl(`${path}.old`, [
      JSON.stringify(recordAt(observedBaseUrl, { requestId: 'old-1', reasoningTokens: 800 })),
    ])
    writeJsonl(path, [
      JSON.stringify(recordAt(observedBaseUrl, { requestId: 'new-1', reasoningTokens: 1200 })),
      '{ 这一行损坏',
      'null',
      JSON.stringify(recordAt(observedBaseUrl, { requestId: 'new-2', reasoningTokens: 'unknown' })),
    ])

    const profile = queryUsageProfile({ provider: 'openai', baseUrl: observedBaseUrl, model: 'deepseek-v4' })
    expect(profile).not.toBeNull()
    // 3 条有效记录（含 unknown），样本只含可得的 2 条
    expect(profile!.sampleCount).toBe(3)
    expect(profile!.recentReasoningTokens).toEqual([800, 1200])
    expect(profile!.reasoningP90).toBe(1200)
    expect(profile!.lowConfidence).toBe(true)
    expect(getUsageProfileDiagnostics()).toMatchObject({ loaded: true, skippedLines: 2 })
  })

  it('端点与模型隔离：查询只命中对应分桶', () => {
    const path = resolveObservationsFilePath()
    writeJsonl(path, [
      JSON.stringify(recordAt(observedBaseUrl, { requestId: 'a', reasoningTokens: 900 })),
      JSON.stringify(recordAt(otherBaseUrl, { requestId: 'b', reasoningTokens: 5000 })),
      JSON.stringify(recordAt(observedBaseUrl, { requestId: 'c', model: 'other-model', reasoningTokens: 200 })),
    ])

    const main = queryUsageProfile({ provider: 'openai', baseUrl: observedBaseUrl, model: 'deepseek-v4' })
    expect(main!.recentReasoningTokens).toEqual([900])
    const other = queryUsageProfile({ provider: 'openai', baseUrl: otherBaseUrl, model: 'deepseek-v4' })
    expect(other!.recentReasoningTokens).toEqual([5000])
    // 未出现过的组合返回 null（调用方回退静态档案）
    expect(queryUsageProfile({ provider: 'openai', baseUrl: observedBaseUrl, model: 'missing-model' })).toBeNull()
  })

  it('无文件 / 首次查询为空时返回 null 且不抛出', () => {
    expect(queryUsageProfile({ provider: 'openai', baseUrl: observedBaseUrl, model: 'deepseek-v4' })).toBeNull()
    expect(getUsageProfileDiagnostics().loaded).toBe(true)
  })

  it('已加载后新观测同步进入索引，无需重新扫盘', () => {
    const path = resolveObservationsFilePath()
    writeJsonl(path, [JSON.stringify(recordAt(observedBaseUrl, { requestId: 'first', reasoningTokens: 100 }))])
    expect(queryUsageProfile({ provider: 'openai', baseUrl: observedBaseUrl, model: 'deepseek-v4' })!
      .recentReasoningTokens).toEqual([100])
    const scannedBefore = getUsageProfileDiagnostics().scannedRecords

    recordGenerationObservation(recordAt(observedBaseUrl, { requestId: 'second', reasoningTokens: 700 }))
    const profile = queryUsageProfile({ provider: 'openai', baseUrl: observedBaseUrl, model: 'deepseek-v4' })
    expect(profile!.recentReasoningTokens).toEqual([100, 700])
    // 增量更新：没有再次整文件扫描
    expect(getUsageProfileDiagnostics().scannedRecords).toBe(scannedBefore)
    // 且确实落盘（同一份 JSONL，不新建文件）
    expect(readFileSync(path, 'utf-8')).toContain('"second"')
  })

  it('门控分桶：gateLevel 不同的记录互不混合（旧记录落缺省桶）', () => {
    const path = resolveObservationsFilePath()
    writeJsonl(path, [
      JSON.stringify(recordAt(observedBaseUrl, { requestId: 'legacy', reasoningTokens: 3000 })),
      JSON.stringify(recordAt(observedBaseUrl, { requestId: 'gated', reasoningTokens: 100, gateLevel: 'low' })),
    ])
    const legacy = queryUsageProfile({ provider: 'openai', baseUrl: observedBaseUrl, model: 'deepseek-v4' })
    expect(legacy!.recentReasoningTokens).toEqual([3000])
    const low = queryUsageProfile({
      provider: 'openai',
      baseUrl: observedBaseUrl,
      model: 'deepseek-v4',
      gate: 'low',
    })
    expect(low!.recentReasoningTokens).toEqual([100])
    // 指纹可用于核对渲染层缓存键（不含完整 URL）
    expect(fingerprint).toMatch(/^[0-9a-f]{8}$/)
  })

  it('IPC 聚合结果只含数值与计数：不含正文、完整 URL 或磁盘路径', () => {
    const path = resolveObservationsFilePath()
    writeJsonl(path, [
      JSON.stringify(recordAt(observedBaseUrl, {
        requestId: 'privacy',
        reasoningTokens: 500,
        tailSample: '这是一段正文尾部采样',
        characterId: 'char-secret',
      })),
    ])
    const profile = queryUsageProfile({ provider: 'openai', baseUrl: observedBaseUrl, model: 'deepseek-v4' })!
    const serialized = JSON.stringify(profile)
    expect(serialized).not.toContain(observedBaseUrl)
    expect(serialized).not.toContain('正文尾部采样')
    expect(serialized).not.toContain(path)
    expect(serialized).not.toContain('char-secret')
    expect(serialized).not.toContain(fingerprint)
    expect(Object.keys(profile).sort()).toEqual([
      'bodyVisibleCharsP95',
      'counts',
      'lastUpdatedAt',
      'lowConfidence',
      'reasoningFilledRate',
      'reasoningP90',
      'recentReasoningTokens',
      'sampleCount',
    ])
  })

  it('W10 诊断返回分类桶与最后一轮计划/实际值，且不泄露原始记录字段', () => {
    const path = resolveObservationsFilePath()
    writeJsonl(path, [
      JSON.stringify(recordAt(observedBaseUrl, {
        requestId: 'secret-request-id',
        generationType: 'normal',
        requestedMaxTokens: 4096,
        hardMaxChars: 600,
        plannedBodyTokens: 846,
        plannedReasoningTokens: 3072,
        responseLengthMode: 'balanced',
        reasoningTokens: 700,
        completionTokens: 900,
        bodyVisibleChars: 580,
        tailSample: '不应进入设置页的正文',
      })),
    ])

    const diagnostics = queryGenerationDiagnostics({
      provider: 'openai',
      baseUrl: observedBaseUrl,
      model: 'deepseek-v4',
    })
    expect(diagnostics.usageBuckets).toHaveLength(1)
    expect(diagnostics.lastRequest).toMatchObject({
      taskType: 'main',
      requestedMaxTokens: 4096,
      hardMaxChars: 600,
      plannedBodyTokens: 846,
      plannedReasoningTokens: 3072,
      completionTokens: 900,
      reasoningTokens: 700,
      bodyVisibleChars: 580,
    })
    const serialized = JSON.stringify(diagnostics)
    expect(serialized).not.toContain(observedBaseUrl)
    expect(serialized).not.toContain('secret-request-id')
    expect(serialized).not.toContain('不应进入设置页的正文')
    expect(serialized).not.toContain(path)
  })
})
