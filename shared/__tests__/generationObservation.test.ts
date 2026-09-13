import { describe, expect, it } from 'vitest'
import type { ChatParams } from '../types'
import {
  buildGenerationObservation,
  classifyFailureOutcome,
  classifyTruncationKind,
  normalizeFinishReason,
  resolveObservability,
} from '../generationObservation'

function makeParams(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    requestId: 'req-1',
    messages: [{ role: 'user', content: '你好' }],
    provider: 'openai',
    apiKey: 'k',
    baseUrl: 'https://example.invalid/v1',
    model: 'deepseek/deepseek-v4.1-flash',
    temperature: 0.8,
    topP: 0.95,
    maxTokens: 4096,
    frequencyPenalty: 0,
    presencePenalty: 0,
    stream: true,
    ...overrides,
  }
}

describe('resolveObservability', () => {
  it('缺省视为辅助调用（aux）', () => {
    expect(resolveObservability(makeParams()).source).toBe('aux')
    expect(resolveObservability(makeParams()).responseLengthMode).toBeUndefined()
  })

  it('透传观测元数据', () => {
    const obs = resolveObservability(makeParams({
      observability: {
        source: 'single',
        generationType: 'regenerate',
        responseLengthMode: 'balanced',
        hardMaxChars: 600,
        responseIntent: 'detailed',
        sceneFactor: 0.85,
        characterId: 'c1',
        sessionId: 's1',
      },
    }))
    expect(obs.source).toBe('single')
    expect(obs.generationType).toBe('regenerate')
    expect(obs.responseLengthMode).toBe('balanced')
    expect(obs.hardMaxChars).toBe(600)
    // S5：意图识别与场景系数进入观测，便于核对误判
    expect(obs.responseIntent).toBe('detailed')
    expect(obs.sceneFactor).toBe(0.85)
  })
})

describe('classifyTruncationKind（区分正文过长 / 推理占满）', () => {
  it('reasoning 占 completion 绝大部分且正文近空 → 推理占满', () => {
    expect(classifyTruncationKind({ bodyVisibleChars: 5, completionTokens: 3000, reasoningTokens: 2800 }))
      .toBe('reasoning_filled')
  })

  it('正文可观 → 正文过长（即使有 reasoning）', () => {
    expect(classifyTruncationKind({ bodyVisibleChars: 500, completionTokens: 2000, reasoningTokens: 800 }))
      .toBe('body_filled')
  })

  it('reasoning token 不可得（unknown）→ unknown，绝不推断为 0', () => {
    expect(classifyTruncationKind({ bodyVisibleChars: 500, completionTokens: 2000, reasoningTokens: 'unknown' }))
      .toBe('body_filled')
    expect(classifyTruncationKind({ bodyVisibleChars: 20, completionTokens: 2000, reasoningTokens: 'unknown' }))
      .toBe('unknown')
    expect(classifyTruncationKind({ bodyVisibleChars: 20, completionTokens: 'unknown', reasoningTokens: 1800 }))
      .toBe('unknown')
  })
})

describe('classifyFailureOutcome（验收四类状态区分）', () => {
  it('用户停止：signal aborted → user_cancelled / cancelled', () => {
    const r = classifyFailureOutcome(new Error('Aborted'), { signalAborted: true })
    expect(r).toEqual({ outcome: 'user_cancelled', finishReason: 'cancelled', errorKind: 'aborted' })
  })

  it('渲染层看门狗超时（reason=timeout）按超时失败计，不算用户停止', () => {
    const r = classifyFailureOutcome(new Error('Aborted'), { signalAborted: true, cancelReason: 'timeout' })
    expect(r.outcome).toBe('error')
    expect(r.errorKind).toBe('timeout')
  })

  it('主进程合并超时（AbortError 且用户 signal 未中止）按超时计', () => {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    const r = classifyFailureOutcome(err, { signalAborted: false })
    expect(r).toMatchObject({ outcome: 'error', errorKind: 'timeout' })
  })

  it('停止字符串命中按正常完成计', () => {
    const r = classifyFailureOutcome(new Error('Aborted'), { signalAborted: true, cancelReason: 'stop_string' })
    expect(r).toEqual({ outcome: 'completed', finishReason: 'stop', errorKind: undefined })
  })

  it('网络中断：fetch failed → error/network/network_error', () => {
    const r = classifyFailureOutcome(new Error('fetch failed: ECONNREFUSED'), { signalAborted: false })
    expect(r).toMatchObject({ outcome: 'error', finishReason: 'network_error', errorKind: 'network' })
  })

  it('触顶（length 元数据或错误文案）→ truncated/length', () => {
    const viaMeta = classifyFailureOutcome(new Error('whatever'), { signalAborted: false, finishReason: 'length' })
    expect(viaMeta).toMatchObject({ outcome: 'truncated', finishReason: 'length' })
    const viaMessage = classifyFailureOutcome(
      new Error('模型输出达到长度上限，内容可能不完整，请重试或提高最大 Token'),
      { signalAborted: false },
    )
    expect(viaMessage).toMatchObject({ outcome: 'truncated', finishReason: 'length', errorKind: 'length_limit' })
  })

  it('推理吃满硬上限单独归类，不与普通正文过长混淆', () => {
    const result = classifyFailureOutcome(
      new Error('推理已占满模型输出硬上限，未留下正文空间'),
      { signalAborted: false },
    )
    expect(result).toMatchObject({
      outcome: 'truncated',
      finishReason: 'length',
      errorKind: 'reasoning_budget_exhausted',
    })
  })

  it('空输出与内容审核分别归类', () => {
    expect(classifyFailureOutcome(new Error('模型未返回任何内容，请重试或检查模型是否可用'), { signalAborted: false }))
      .toMatchObject({ errorKind: 'empty_output' })
    expect(classifyFailureOutcome(new Error('模型响应被上游内容审核拦截（content_filter）'), { signalAborted: false }))
      .toMatchObject({ outcome: 'error', finishReason: 'content_filter' })
  })

  it('其他 API 错误 → error/api/unknown', () => {
    expect(classifyFailureOutcome(new Error('OpenAI API 错误 400: bad request'), { signalAborted: false }))
      .toMatchObject({ outcome: 'error', finishReason: 'unknown', errorKind: 'api' })
  })
})

describe('normalizeFinishReason', () => {
  it('映射各上游原始值；未识别为 unknown', () => {
    expect(normalizeFinishReason('stop')).toBe('stop')
    expect(normalizeFinishReason('end_turn')).toBe('stop')
    expect(normalizeFinishReason('STOP')).toBe('stop')
    expect(normalizeFinishReason('length')).toBe('length')
    expect(normalizeFinishReason('max_tokens')).toBe('length')
    expect(normalizeFinishReason('MAX_TOKENS')).toBe('length')
    expect(normalizeFinishReason('SAFETY')).toBe('content_filter')
    expect(normalizeFinishReason('tool_use')).toBe('tool_calls')
    expect(normalizeFinishReason('weird')).toBe('unknown')
    expect(normalizeFinishReason(undefined)).toBe('unknown')
  })
})

describe('buildGenerationObservation', () => {
  it('正文口径剥离思考块；token 不可得记 unknown 不填 0', () => {
    const obs = buildGenerationObservation(makeParams({
      observability: { source: 'single', responseLengthMode: 'auto', hardMaxChars: 551 },
    }), {
      startedAt: 1000,
      finishedAt: 3500,
      text: '<thought>写作计划</thought>\n\n她抬起头，看着远处的港口。',
      outcome: 'completed',
      finishReason: 'stop',
      attempts: 1,
    })
    expect(obs.bodyVisibleChars).toBe(13)
    expect(obs.completionTokens).toBe('unknown')
    expect(obs.reasoningTokens).toBe('unknown')
    expect(obs.responseLengthMode).toBe('auto')
    expect(obs.hardMaxChars).toBe(551)
    // 未下发 S5 字段时记录中不出现（不产生噪声）
    expect(obs.responseIntent).toBeUndefined()
    expect(obs.sceneFactor).toBeUndefined()
    expect(obs.durationMs).toBe(2500)
    expect(obs.source).toBe('single')
    expect(obs.diagnostics.completeSentence).toBe(true)
    expect(obs.diagnostics.closedThought).toBe(true)
    expect(obs.truncationKind).toBeUndefined()
  })

  it('length 结束时给出触顶细分', () => {
    const obs = buildGenerationObservation(makeParams(), {
      startedAt: 0,
      finishedAt: 10,
      text: '半句话',
      outcome: 'truncated',
      finishReason: 'length',
      completionTokens: 3000,
      reasoningTokens: 2900,
      attempts: 1,
    })
    expect(obs.truncationKind).toBe('reasoning_filled')
  })

  it('错误终局记录 errorKind 与尾部采样', () => {
    const obs = buildGenerationObservation(makeParams(), {
      startedAt: 0,
      finishedAt: 10,
      text: '已产出的部分内容',
      outcome: 'error',
      finishReason: 'network_error',
      errorKind: 'network',
      attempts: 2,
    })
    expect(obs.errorKind).toBe('network')
    expect(obs.attempts).toBe(2)
    expect(obs.tailSample).toBe('已产出的部分内容')
  })
})
