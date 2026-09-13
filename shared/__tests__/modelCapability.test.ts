/**
 * W6（主计划 §7.8）验收：模型能力档案的来源优先级与端点隔离。
 * 覆盖：精确匹配优先 / 族通配低置信 / 无数据保守回退 / 用户覆盖优先 /
 * 运行时纠正只能收紧 / 同名模型不同端点隔离。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OUTPUT_PROFILE,
  getModelOutputProfile,
  resolveModelOutputProfile,
} from '../modelOutputProfile'
import {
  capabilityScopeKey,
  createModelCapabilityStore,
  resolveEndpointOutputProfile,
} from '../modelCapability'
import { getDefaultMaxContext } from '../chat-core/tokenCounter'

describe('能力来源优先级（精确 → 族通配 → 回退）', () => {
  it('精确登记命中为高置信，并给出内置上下文窗口', () => {
    const ds = getModelOutputProfile('deepseek/deepseek-v4.1-flash')
    expect(ds.matchedBy).toBe('exact')
    expect(ds.confidence).toBe('high')
    expect(ds.contextLimit).toBe(65536)

    const claude = getModelOutputProfile('claude-4-sonnet')
    expect(claude.matchedBy).toBe('exact')
    expect(claude.contextLimit).toBe(200000)
  })

  it('未登记型号退到族通配：低置信且只修正上下文窗口，不放大推理策略', () => {
    const family = getModelOutputProfile('anthropic/claude-fable-5-1')
    expect(family.matchedBy).toBe('family')
    expect(family.confidence).toBe('low')
    expect(family.contextLimit).toBe(200000)
    // 输出上限与推理策略保持保守回退，不因族识别而放大
    expect(family.outputLimit).toBe(DEFAULT_OUTPUT_PROFILE.outputLimit)
    expect(family.defaultReasoningReserve).toBe(DEFAULT_OUTPUT_PROFILE.defaultReasoningReserve)
  })

  it('无数据保持当前保守行为（32K 窗口 + 无推理余量假设）', () => {
    const unknown = getModelOutputProfile('某未登记聚合模型-9')
    expect(unknown.matchedBy).toBe('fallback')
    expect(unknown.confidence).toBe('low')
    expect(unknown.contextLimit).toBe(32768)
    expect(unknown.defaultReasoningReserve).toBe(0)
    expect(getDefaultMaxContext('某未登记聚合模型-9')).toBe(32768)
  })

  it('getDefaultMaxContext 不再对 DeepSeek 族做统一放大推断', () => {
    expect(getDefaultMaxContext('deepseek-v4-pro')).toBe(65536)
    expect(getDefaultMaxContext('deepseek')).toBe(65536)
    // 未登记型号不再命中 64K/128K 的宽推断
    expect(getDefaultMaxContext('deepseek-v5-unknown-variant')).toBe(65536)
    expect(getDefaultMaxContext(undefined)).toBe(32768)
  })
})

describe('用户覆盖与运行时纠正', () => {
  it('用户明确覆盖优先于内置能力（可收紧也可放大）', () => {
    const tightened = resolveModelOutputProfile('deepseek/deepseek-v4.1-flash', {
      userOverride: { outputLimit: 4096, contextLimit: 32768 },
    })
    expect(tightened.outputLimit).toBe(4096)
    expect(tightened.contextLimit).toBe(32768)

    const raised = resolveModelOutputProfile('deepseek/deepseek-v4.1-flash', {
      userOverride: { outputLimit: 16384 },
    })
    expect(raised.outputLimit).toBe(16384)
    // 未覆盖的字段仍取内置值
    expect(raised.contextLimit).toBe(65536)
  })

  it('运行时纠正只能收紧：大于内置值时不生效，置信度降为低', () => {
    const profile = resolveModelOutputProfile('deepseek/deepseek-v4.1-flash', {
      runtimeCorrection: { outputLimit: 999999, contextLimit: 999999, reason: 'context_limit', updatedAt: 1 },
    })
    // 内置 8192/65536 未被放大
    expect(profile.outputLimit).toBe(8192)
    expect(profile.contextLimit).toBe(65536)
    expect(profile.confidence).toBe('low')
    expect(profile.matchedBy).toBe('runtime')
  })

  it('纠正可把能力收紧到实测值，且用户覆盖后再被纠正继续收紧', () => {
    const corrected = resolveModelOutputProfile('gpt-4o', {
      userOverride: { contextLimit: 128000 },
      runtimeCorrection: { contextLimit: 60000, reason: 'context_limit', updatedAt: 2 },
    })
    expect(corrected.contextLimit).toBe(60000)
  })

  it('非法纠正值被忽略（NaN/0/负数不改变内置能力）', () => {
    const profile = resolveModelOutputProfile('gpt-4o', {
      runtimeCorrection: { outputLimit: Number.NaN, contextLimit: 0, reason: 'output_limit', updatedAt: 1 },
    })
    expect(profile.outputLimit).toBe(DEFAULT_OUTPUT_PROFILE.outputLimit === 8192 ? 8192 : profile.outputLimit)
    expect(profile.matchedBy).toBe('runtime')
  })
})

describe('端点隔离（同名模型不同端点互不污染）', () => {
  const scopeA = { provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'deepseek-v4-pro' }
  const scopeB = { provider: 'openai', baseUrl: 'https://proxy.example.com/v1', model: 'deepseek-v4-pro' }

  it('端点 A 的纠正不影响端点 B；键不含完整 URL', () => {
    const store = createModelCapabilityStore()
    store.noteCorrection(scopeA, { contextLimit: 32000, reason: 'context_limit', updatedAt: 1 })

    expect(resolveEndpointOutputProfile({ model: scopeA.model, scope: scopeA, store }).contextLimit).toBe(32000)
    // 同名模型在另一端点保持内置能力
    expect(resolveEndpointOutputProfile({ model: scopeB.model, scope: scopeB, store }).contextLimit).toBe(65536)
    expect(capabilityScopeKey(scopeA)).not.toContain('api.example.com')
    expect(capabilityScopeKey(scopeA)).not.toBe(capabilityScopeKey(scopeB))
  })

  it('重置入口可按端点清理', () => {
    const store = createModelCapabilityStore()
    store.noteCorrection(scopeA, { outputLimit: 4096, reason: 'output_limit', updatedAt: 1 })
    store.noteCorrection(scopeB, { outputLimit: 2048, reason: 'output_limit', updatedAt: 1 })
    expect(store.size()).toBe(2)
    store.reset(scopeA)
    expect(store.getCorrection(scopeA)).toBeNull()
    expect(store.getCorrection(scopeB)).not.toBeNull()
    store.reset()
    expect(store.size()).toBe(0)
  })
})
