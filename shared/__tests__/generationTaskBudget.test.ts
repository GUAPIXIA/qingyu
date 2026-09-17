import { describe, expect, it } from 'vitest'
import {
  expandAdaptiveOutputBudget,
  resolveGenerationTaskBudget,
} from '../generationTaskBudget'

describe('resolveGenerationTaskBudget', () => {
  it('同一任务不因模型名称获得不同的硬编码预算', () => {
    const input = {
      task: 'translation' as const,
      inputChars: 120,
      recentReasoningTokens: [800, 1200],
    }
    const named = resolveGenerationTaskBudget({ ...input, model: 'deepseek/deepseek-v4.1-flash' })
    const generic = resolveGenerationTaskBudget({ ...input, model: 'private-model' })

    expect(named.expectedBodyChars).toBe(generic.expectedBodyChars)
    expect(named.requestMaxTokens).toBe(generic.requestMaxTokens)
    expect(named.reasoningReserve).toBe(generic.reasoningReserve)
  })

  it('翻译首次请求尚无样本时也为共享推理留出自动输出窗口的四分之一', () => {
    const plan = resolveGenerationTaskBudget({
      task: 'translation',
      model: 'private-reasoning-model',
      inputChars: 850,
    })

    expect(plan.reasoningReserve).toBe(Math.floor(plan.profile.outputLimit / 4))
    // 实机观测中该端点曾连续消耗 6291 reasoning token；自动模式不应在更低处先截断。
    expect(plan.reasoningReserve).toBeGreaterThan(6291)
  })

  it('自动预算使用实测推理样本，且不再被旧 8192 安全阀截断', () => {
    const plan = resolveGenerationTaskBudget({
      task: 'memory',
      model: 'private-reasoning-model',
      recentReasoningTokens: [6291],
    })

    expect(plan.reasoningReserve).toBe(Math.ceil(6291 * 1.2))
    expect(plan.requestMaxTokens).toBe(plan.bodyReserve + plan.reasoningReserve)
    expect(plan.requestMaxTokens).toBeGreaterThan(8192)
  })

  it('只有用户或端点显式硬上限会截断自动预算', () => {
    const automatic = resolveGenerationTaskBudget({
      task: 'memory',
      model: 'private-reasoning-model',
      recentReasoningTokens: [6291],
    })
    const userCapped = resolveGenerationTaskBudget({
      task: 'memory',
      model: 'private-reasoning-model',
      recentReasoningTokens: [6291],
      userHardCap: 4096,
    })
    const endpointCapped = resolveGenerationTaskBudget({
      task: 'memory',
      model: 'private-reasoning-model',
      recentReasoningTokens: [6291],
      profileOverride: { outputLimit: 6000 },
    })

    expect(automatic.requestMaxTokens).toBeGreaterThan(8192)
    expect(automatic.adaptiveOutputBudget).toBeDefined()
    expect(userCapped.requestMaxTokens).toBe(4096)
    expect(userCapped.adaptiveOutputBudget).toBeUndefined()
    expect(endpointCapped.requestMaxTokens).toBe(6000)
  })

  it('触顶后按当前窗口与正文体量逐次增长，并严格停在端点能力上限', () => {
    const budget = { ceilingTokens: 10000, bodyReserveTokens: 1200 }
    const second = expandAdaptiveOutputBudget({ currentMaxTokens: 2000, budget, observedReasoningTokens: 2000 })
    const third = expandAdaptiveOutputBudget({ currentMaxTokens: second!, budget, observedReasoningTokens: second! })
    const ceiling = expandAdaptiveOutputBudget({ currentMaxTokens: third!, budget, observedReasoningTokens: third! })

    expect(second).toBeGreaterThan(2000)
    expect(third).toBeGreaterThan(second!)
    expect(ceiling).toBe(10000)
    expect(expandAdaptiveOutputBudget({ currentMaxTokens: ceiling!, budget })).toBeNull()
  })
})
