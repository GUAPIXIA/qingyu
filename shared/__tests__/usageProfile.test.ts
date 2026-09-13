/**
 * W1（主计划 §7.3）纯函数验收：端点指纹、用量聚合、有界索引。
 * 重点：凭据/query/fragment 不进入键；unknown 不转 0；样本与键数量有界；旧记录兼容。
 */
import { describe, expect, it } from 'vitest'
import { endpointFingerprint, normalizeEndpoint } from '../endpointKey'
import {
  USAGE_PROFILE_DEFAULT_GATE,
  USAGE_PROFILE_DEFAULT_TASK,
  USAGE_PROFILE_MAX_KEYS,
  USAGE_PROFILE_MAX_SAMPLES_PER_KEY,
  buildUsageProfiles,
  createUsageProfileIndex,
  normalizeUsageProfileQuery,
  usageProfileKeyOf,
  usageProfileKeyString,
} from '../usageProfile'
import type { GenerationObservation } from '../generationObservation'

function makeRecord(overrides: Partial<GenerationObservation> = {}): GenerationObservation {
  return {
    ts: 1000,
    requestId: 'req-1',
    source: 'single',
    model: 'deepseek/deepseek-v4.1-flash',
    provider: 'openai',
    requestedMaxTokens: 4096,
    stream: true,
    finishReason: 'stop',
    outcome: 'completed',
    bodyVisibleChars: 300,
    completionTokens: 200,
    reasoningTokens: 100,
    durationMs: 1000,
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

describe('端点标准化与指纹（凭据/query/fragment 不进入键）', () => {
  it('凭据、query、fragment 与大小写差异不影响指纹', () => {
    const base = endpointFingerprint('https://api.example.com/v1')
    expect(endpointFingerprint('https://user:secret@api.example.com/v1')).toBe(base)
    expect(endpointFingerprint('https://api.example.com/v1?api_key=sk-123&x=1')).toBe(base)
    expect(endpointFingerprint('https://api.example.com/v1#frag')).toBe(base)
    expect(endpointFingerprint('HTTPS://API.EXAMPLE.COM/v1')).toBe(base)
    expect(endpointFingerprint('https://api.example.com/v1/')).toBe(base)
  })

  it('不同主机或路径得到不同指纹，指纹不包含原始地址', () => {
    const a = endpointFingerprint('https://api.example.com/v1')
    const b = endpointFingerprint('https://api.example.com/v2')
    const c = endpointFingerprint('https://proxy.example.com/v1')
    expect(new Set([a, b, c]).size).toBe(3)
    expect(a).toMatch(/^[0-9a-f]{8}$/)
    expect(a).not.toContain('api.example.com')
  })

  it('非标准输入被保守清理且保持确定性', () => {
    expect(normalizeEndpoint('localhost:11434/v1')).toBe('localhost:11434/v1')
    expect(endpointFingerprint('localhost:11434/v1'))
      .toBe(endpointFingerprint('localhost:11434/v1'))
    expect(normalizeEndpoint('  ')).toBe('')
    expect(endpointFingerprint('')).toBe('')
    // 缺 scheme 的输入同样不得残留凭据
    expect(normalizeEndpoint('http://u:p@host:8080/v1?k=1')).not.toContain('u:p')
  })
})

describe('分桶键与查询归一化', () => {
  it('旧记录缺 taskType/gateLevel 时落到缺省桶，新字段存在时按字段分桶', () => {
    const legacy = usageProfileKeyOf(makeRecord({ endpointFingerprint: 'abcd1234' }))
    expect(legacy.taskType).toBe(USAGE_PROFILE_DEFAULT_TASK)
    expect(legacy.gate).toBe(USAGE_PROFILE_DEFAULT_GATE)
    const directed = usageProfileKeyOf(makeRecord({ taskType: 'direction', gateLevel: 'off' }))
    expect(directed.taskType).toBe('direction')
    expect(directed.gate).toBe('off')
    // 旧记录没有端点字段：落到空指纹桶，不与新记录混淆
    expect(usageProfileKeyOf(makeRecord()).endpointFingerprint).toBe('')
  })

  it('查询输入默认 task=main、gate=缺省桶；端点用原始地址标准化', () => {
    const key = normalizeUsageProfileQuery({
      provider: 'openai',
      baseUrl: 'https://api.example.com/v1?x=1',
      model: 'm',
    })
    expect(key.taskType).toBe(USAGE_PROFILE_DEFAULT_TASK)
    expect(key.gate).toBe(USAGE_PROFILE_DEFAULT_GATE)
    expect(key.endpointFingerprint).toBe(endpointFingerprint('https://api.example.com/v1'))
  })

  it('键字符串对不同分桶稳定且不碰撞', () => {
    const a = usageProfileKeyString({ provider: 'p', endpointFingerprint: 'e', model: 'm', taskType: 'main', gate: 'off' })
    const b = usageProfileKeyString({ provider: 'p', endpointFingerprint: 'e', model: 'm', taskType: 'main', gate: '(default)' })
    expect(a).not.toBe(b)
    expect(a).toBe(usageProfileKeyString({ provider: 'p', endpointFingerprint: 'e', model: 'm', taskType: 'main', gate: 'off' }))
  })
})

describe('用量聚合（unknown 不转 0、有界样本、分别计数）', () => {
  it('unknown reasoning token 不进样本也不参与 P90，但仍计入样本总数', () => {
    const index = createUsageProfileIndex()
    index.ingest(makeRecord({ reasoningTokens: 'unknown', completionTokens: 'unknown' }))
    index.ingest(makeRecord({ reasoningTokens: 500 }))
    const profile = index.lookup(usageProfileKeyOf(makeRecord({ reasoningTokens: 500 })))
    expect(profile).not.toBeNull()
    expect(profile!.sampleCount).toBe(2)
    expect(profile!.recentReasoningTokens).toEqual([500])
    expect(profile!.reasoningP90).toBe(500)
  })

  it('样本不足 5 条标记低置信度；分位与占比按保守口径', () => {
    const index = createUsageProfileIndex()
    for (let i = 0; i < 4; i += 1) index.ingest(makeRecord({ reasoningTokens: 100 + i }))
    const key = usageProfileKeyOf(makeRecord())
    expect(index.lookup(key)!.lowConfidence).toBe(true)

    index.ingest(makeRecord({
      reasoningTokens: 900,
      finishReason: 'length',
      outcome: 'truncated',
      truncationKind: 'reasoning_filled',
    }))
    const profile = index.lookup(key)!
    expect(profile.sampleCount).toBe(5)
    expect(profile.lowConfidence).toBe(false)
    expect(profile.reasoningFilledRate).toBeCloseTo(1 / 5)
  })

  it('成功 / 推理挤占 / 参数拒绝 / 失败分别计数，不只看成功样本', () => {
    const index = createUsageProfileIndex()
    index.ingest(makeRecord())
    index.ingest(makeRecord({ terminationCause: 'reasoning_gate_exceeded', outcome: 'truncated', finishReason: 'length' }))
    index.ingest(makeRecord({ knobAcceptedThisRequest: false }))
    index.ingest(makeRecord({ outcome: 'error', finishReason: 'network_error', errorKind: 'network' }))
    const profile = index.lookup(usageProfileKeyOf(makeRecord()))!
    expect(profile.counts).toEqual({ completed: 2, reasoningFilled: 1, knobRejected: 1, error: 1 })
    expect(profile.reasoningFilledRate).toBeCloseTo(1 / 4)
  })

  it('样本有界：每键最多保留最近 N 条 reasoning 样本', () => {
    const index = createUsageProfileIndex()
    for (let i = 1; i <= USAGE_PROFILE_MAX_SAMPLES_PER_KEY + 5; i += 1) {
      index.ingest(makeRecord({ reasoningTokens: i, ts: 1000 + i }))
    }
    const profile = index.lookup(usageProfileKeyOf(makeRecord()))!
    expect(profile.sampleCount).toBe(USAGE_PROFILE_MAX_SAMPLES_PER_KEY + 5)
    expect(profile.recentReasoningTokens).toHaveLength(USAGE_PROFILE_MAX_SAMPLES_PER_KEY)
    expect(profile.recentReasoningTokens.at(-1)).toBe(USAGE_PROFILE_MAX_SAMPLES_PER_KEY + 5)
    expect(profile.lastUpdatedAt).toBe(1000 + USAGE_PROFILE_MAX_SAMPLES_PER_KEY + 5)
  })

  it('按 provider / 端点 / model / task / gate 隔离，互不污染', () => {
    const index = createUsageProfileIndex()
    index.ingest(makeRecord({ provider: 'openai', endpointFingerprint: 'aaaa0001', reasoningTokens: 100 }))
    index.ingest(makeRecord({ provider: 'openai', endpointFingerprint: 'bbbb0002', reasoningTokens: 9000 }))
    index.ingest(makeRecord({ provider: 'openai', endpointFingerprint: 'aaaa0001', taskType: 'memory', reasoningTokens: 700 }))

    const main = index.lookup(usageProfileKeyOf(makeRecord({ endpointFingerprint: 'aaaa0001' })))!
    expect(main.recentReasoningTokens).toEqual([100])
    const other = index.lookup(usageProfileKeyOf(makeRecord({ endpointFingerprint: 'bbbb0002' })))!
    expect(other.recentReasoningTokens).toEqual([9000])
    const memory = index.lookup(usageProfileKeyOf(makeRecord({ endpointFingerprint: 'aaaa0001', taskType: 'memory' })))!
    expect(memory.recentReasoningTokens).toEqual([700])
    // 未出现过的组合查询为 null（读取失败由调用方回退静态档案）
    expect(index.lookup(usageProfileKeyOf(makeRecord({ model: 'other-model' })))).toBeNull()
  })

  it('正文长度 P95 与门控分桶', () => {
    const index = createUsageProfileIndex()
    for (const chars of [10, 20, 30, 40, 500]) {
      index.ingest(makeRecord({ bodyVisibleChars: chars, gateLevel: 'low' }))
    }
    const profile = index.lookup(usageProfileKeyOf(makeRecord({ gateLevel: 'low' })))!
    expect(profile.bodyVisibleCharsP95).toBe(500)
    expect(index.lookup(usageProfileKeyOf(makeRecord()))).toBeNull()
  })

  it('索引有界：键数超过上限按 LRU 淘汰', () => {
    const index = createUsageProfileIndex({ maxKeys: 3 })
    for (let i = 0; i < 5; i += 1) {
      index.ingest(makeRecord({ model: `model-${i}` }))
    }
    expect(index.size()).toBe(3)
    // 最近写入的仍在
    expect(index.lookup(usageProfileKeyOf(makeRecord({ model: 'model-4' })))).not.toBeNull()
    expect(index.lookup(usageProfileKeyOf(makeRecord({ model: 'model-0' })))).toBeNull()
  })

  it('默认上限为全局 256 键', () => {
    const index = createUsageProfileIndex()
    for (let i = 0; i < USAGE_PROFILE_MAX_KEYS + 10; i += 1) {
      index.ingest(makeRecord({ model: `m-${i}` }))
    }
    expect(index.size()).toBe(USAGE_PROFILE_MAX_KEYS)
  })

  it('buildUsageProfiles 对记录集合直接出聚合', () => {
    const profiles = buildUsageProfiles([
      makeRecord({ endpointFingerprint: 'aaaa0001', reasoningTokens: 100 }),
      makeRecord({ endpointFingerprint: 'aaaa0001', reasoningTokens: 300 }),
      makeRecord({ endpointFingerprint: 'aaaa0001', taskType: 'direction', reasoningTokens: 1536 }),
    ])
    expect(profiles.size).toBe(2)
    const mainKey = usageProfileKeyString(usageProfileKeyOf(makeRecord({ endpointFingerprint: 'aaaa0001' })))
    expect(profiles.get(mainKey)!.recentReasoningTokens).toEqual([100, 300])
  })
})
