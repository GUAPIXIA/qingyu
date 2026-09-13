import { describe, expect, it } from 'vitest'
import type { ChatParams } from '../types'
import {
  buildGenerationObservation,
  classifyFailureOutcome,
  classifyTruncationKind,
  normalizeFinishReason,
  resolveObservability,
} from '../generationObservation'
import { observationTerminationCause } from '../generationTermination'

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

/**
 * W0 冻结契约：单聊、群聊、Bridge 三种来源必须共用同一套
 * finishReason → outcome / terminationCause / truncationKind 映射，
 * 任何一端单独改口径都会先打红这组用例。
 */
describe('finishReason 与 terminationCause 契约（单聊/群聊/Bridge 共用，W0 冻结）', () => {
  const makeSourceParams = (source: 'single' | 'group' | 'bridge') =>
    makeParams({ observability: { source } })

  it.each(['single', 'group', 'bridge'] as const)('%s：正常完成 / 触顶 / 用户停止三态闭环', (source) => {
    const done = (state: Parameters<typeof buildGenerationObservation>[1]) =>
      buildGenerationObservation(makeSourceParams(source), state)

    const stop = done({
      startedAt: 0,
      finishedAt: 10,
      text: '她推开门，走进房间。',
      outcome: 'completed',
      finishReason: 'stop',
      terminationCause: observationTerminationCause({ outcome: 'completed', finishReason: 'stop' }),
      attempts: 1,
    })
    expect(stop).toMatchObject({ finishReason: 'stop', outcome: 'completed', terminationCause: 'provider_stop' })
    expect(stop.truncationKind).toBeUndefined()

    const length = done({
      startedAt: 0,
      finishedAt: 10,
      text: '她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。然后她伸手拿',
      outcome: 'truncated',
      finishReason: 'length',
      terminationCause: observationTerminationCause({ outcome: 'truncated', finishReason: 'length' }),
      completionTokens: 2000,
      reasoningTokens: 800,
      attempts: 1,
    })
    expect(length).toMatchObject({
      finishReason: 'length',
      outcome: 'truncated',
      terminationCause: 'provider_length',
      truncationKind: 'body_filled',
    })

    const cancelled = done({
      startedAt: 0,
      finishedAt: 10,
      text: '用户已经看到的正文。',
      outcome: 'user_cancelled',
      finishReason: 'cancelled',
      terminationCause: observationTerminationCause({
        outcome: 'user_cancelled',
        finishReason: 'cancelled',
        errorKind: 'aborted',
      }),
      attempts: 1,
    })
    expect(cancelled).toMatchObject({
      finishReason: 'cancelled',
      outcome: 'user_cancelled',
      terminationCause: 'user_cancel',
    })
  })

  it('传输中断 → error/network_error/transport_error，不按完成口径记录', () => {
    const obs = buildGenerationObservation(makeSourceParams('bridge'), {
      startedAt: 0,
      finishedAt: 10,
      text: '已产出的一半。',
      outcome: 'error',
      finishReason: 'network_error',
      errorKind: 'network',
      terminationCause: observationTerminationCause({
        outcome: 'error',
        finishReason: 'network_error',
        errorKind: 'network',
      }),
      attempts: 2,
    })
    expect(obs).toMatchObject({
      outcome: 'error',
      finishReason: 'network_error',
      terminationCause: 'transport_error',
      errorKind: 'network',
      attempts: 2,
    })
    expect(obs.truncationKind).toBeUndefined()
  })

  it('direction 任务：1536 全被推理占用、正文为空、length → reasoning_filled（§2.1 失败形态）', () => {
    const obs = buildGenerationObservation(makeParams({
      maxTokens: 1536,
      observability: { source: 'aux', taskType: 'direction' },
    }), {
      startedAt: 0,
      finishedAt: 20,
      text: '',
      outcome: 'truncated',
      finishReason: 'length',
      terminationCause: observationTerminationCause({ outcome: 'truncated', finishReason: 'length' }),
      completionTokens: 1536,
      reasoningTokens: 1536,
      attempts: 1,
    })
    expect(obs).toMatchObject({
      taskType: 'direction',
      requestedMaxTokens: 1536,
      bodyVisibleChars: 0,
      finishReason: 'length',
      outcome: 'truncated',
      terminationCause: 'provider_length',
      truncationKind: 'reasoning_filled',
    })
    expect(obs.reasoningTokens).toBe(1536)
  })
})

/** 阶段8（主计划 W2）：门控观测字段与推理挤占的结构化终局 */
describe('阶段8 门控观测字段（W2）', () => {
  it('门控字段随请求透传进观测记录，缺省不产生噪声', () => {
    const obs = buildGenerationObservation(makeParams({
      observability: {
        source: 'single',
        gateLevel: 'low',
        gateKnob: 'reasoning-effort',
        knobAcceptedThisRequest: false,
        earlyAbort: true,
        downgradeRetry: true,
      },
    }), {
      startedAt: 0,
      finishedAt: 10,
      text: '',
      outcome: 'truncated',
      finishReason: 'length',
      terminationCause: 'reasoning_gate_exceeded',
      attempts: 1,
    })
    expect(obs).toMatchObject({
      gateLevel: 'low',
      gateKnob: 'reasoning-effort',
      knobAcceptedThisRequest: false,
      earlyAbort: true,
      downgradeRetry: true,
      terminationCause: 'reasoning_gate_exceeded',
    })
    // 提前中止已在流级确认推理挤占：token 不可得也判 reasoning_filled
    expect(obs.truncationKind).toBe('reasoning_filled')

    const bare = buildGenerationObservation(makeParams(), {
      startedAt: 0,
      finishedAt: 10,
      text: '正常正文。',
      outcome: 'completed',
      finishReason: 'stop',
      attempts: 1,
    })
    expect(bare.gateLevel).toBeUndefined()
    expect(bare.earlyAbort).toBeUndefined()
    expect(bare.downgradeRetry).toBeUndefined()
  })

  it('classifyTruncationKind：earlyAbort 优先于 token 上报', () => {
    expect(classifyTruncationKind({
      bodyVisibleChars: 0,
      completionTokens: 'unknown',
      reasoningTokens: 'unknown',
      earlyAbort: true,
    })).toBe('reasoning_filled')
    // 无早期中止时维持原判定，不误伤正常截断
    expect(classifyTruncationKind({
      bodyVisibleChars: 0,
      completionTokens: 'unknown',
      reasoningTokens: 'unknown',
    })).toBe('unknown')
  })
})
