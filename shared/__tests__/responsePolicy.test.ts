import { describe, expect, it } from 'vitest'
import {
  AUTO_DEFAULT_BASELINE_CHARS,
  AUTO_HARD_MAX_CHARS,
  AUTO_TARGET_MAX_CHARS,
  collectRecentAssistantChars,
  countVisibleChars,
  detectUserLengthIntent,
  median,
  resolveResponseLengthMode,
  resolveResponsePolicy,
  resolveSceneFactor,
} from '../responsePolicy'

describe('countVisibleChars / collectRecentAssistantChars', () => {
  it('剥离思考块与空白后统计可见字符', () => {
    expect(countVisibleChars('<thought>写作计划</thought>\n\n她抬头看雨。')).toBe(6)
    expect(countVisibleChars('  你 好 ')).toBe(2)
    expect(countVisibleChars('')).toBe(0)
  })

  it('仅取最近 N 条已完成助手回复（跳过用户消息与空内容）', () => {
    const samples = collectRecentAssistantChars(
      [
        { role: 'user', content: '问' },
        { role: 'assistant', content: '一二三四五' },
        { role: 'assistant', content: '' },
        { role: 'user', content: '再问' },
        { role: 'assistant', content: '六七八九十' },
      ],
      5,
    )
    expect(samples).toEqual([5, 5])
  })
})

describe('median', () => {
  it('奇数取中间、偶数取平均；无有效样本返回 null', () => {
    expect(median([1, 9, 5])).toBe(5)
    expect(median([1, 9])).toBe(5)
    expect(median([])).toBeNull()
    expect(median([Number.NaN])).toBeNull()
  })
})

describe('resolveResponseLengthMode 优先级', () => {
  it('用户本轮明确要求 > 会话 > 预设 > 自动', () => {
    expect(resolveResponseLengthMode({ userIntent: 'brief', sessionMode: 'detailed', presetHint: 'brief' }))
      .toEqual({ mode: 'brief', source: 'user' })
    expect(resolveResponseLengthMode({ sessionMode: 'detailed', presetHint: 'brief' }))
      .toEqual({ mode: 'detailed', source: 'session' })
    expect(resolveResponseLengthMode({ presetHint: 'brief' })).toEqual({ mode: 'brief', source: 'preset' })
    expect(resolveResponseLengthMode({ defaultMode: 'detailed' })).toEqual({ mode: 'detailed', source: 'settings' })
    expect(resolveResponseLengthMode({ presetHint: 'brief', defaultMode: 'detailed' }))
      .toEqual({ mode: 'brief', source: 'preset' })
    expect(resolveResponseLengthMode({})).toEqual({ mode: 'auto', source: 'auto' })
  })

  it('无效与 auto 取值视为未设置（回退下一优先级）', () => {
    // @ts-expect-error 非法值防御
    expect(resolveResponseLengthMode({ sessionMode: 'tiny', presetHint: 'detailed' }).mode).toBe('detailed')
    expect(resolveResponseLengthMode({ sessionMode: 'auto', presetHint: 'detailed' }).mode).toBe('detailed')
    expect(resolveResponseLengthMode({ sessionMode: 'auto' }).source).toBe('auto')
  })
})

describe('resolveResponsePolicy 固定区间', () => {
  it('brief / balanced / detailed 使用方案表格区间', () => {
    const brief = resolveResponsePolicy({ presetHint: 'brief' })
    expect(brief).toMatchObject({
      mode: 'brief',
      source: 'preset',
      preferredMinChars: 40,
      preferredMaxChars: 140,
      hardMaxChars: 260,
      maxNewBeats: 1,
    })
    const balanced = resolveResponsePolicy({ sessionMode: 'balanced' })
    expect(balanced.preferredMinChars).toBe(120)
    expect(balanced.preferredMaxChars).toBe(360)
    expect(balanced.hardMaxChars).toBe(600)
    expect(balanced.source).toBe('session')
    const detailed = resolveResponsePolicy({ presetHint: 'detailed' })
    expect(detailed.hardMaxChars).toBe(1100)
    expect(detailed.maxNewBeats).toBe(2)
  })
})

describe('resolveResponsePolicy 自动模式', () => {
  it('无样本时回退默认基线 240', () => {
    const policy = resolveResponsePolicy({})
    expect(policy.mode).toBe('auto')
    expect(policy.source).toBe('auto')
    // target = 240 → min 132 / max 324 / hard 551
    expect(policy.preferredMinChars).toBe(Math.round(AUTO_DEFAULT_BASELINE_CHARS * 0.55))
    expect(policy.preferredMaxChars).toBe(Math.round(AUTO_DEFAULT_BASELINE_CHARS * 1.35))
    expect(policy.hardMaxChars).toBeLessThanOrEqual(AUTO_HARD_MAX_CHARS)
  })

  it('最近回复中位数回归，不被单个超长样本拉高', () => {
    const policy = resolveResponsePolicy({ recentAssistantVisibleChars: [200, 220, 240, 260, 5000] })
    // 中位数 240，不受 5000 拉高
    expect(policy.preferredMaxChars).toBe(Math.round(240 * 1.35))
  })

  it('高压短回合收缩、开场放大，目标钳制在 80–700', () => {
    const compressed = resolveResponsePolicy({ recentAssistantVisibleChars: [300, 300, 300], sceneFactor: 0.7 })
    expect(compressed.preferredMaxChars).toBe(Math.round(210 * 1.35))
    const expanded = resolveResponsePolicy({ recentAssistantVisibleChars: [300, 300, 300], sceneFactor: 1.6 })
    expect(expanded.preferredMaxChars).toBe(Math.round(480 * 1.35))
    const cappedHigh = resolveResponsePolicy({ recentAssistantVisibleChars: [900, 900], sceneFactor: 2 })
    expect(cappedHigh.preferredMaxChars).toBe(Math.round(AUTO_TARGET_MAX_CHARS * 1.35))
    expect(cappedHigh.hardMaxChars).toBeLessThanOrEqual(AUTO_HARD_MAX_CHARS)
  })

  it('自动目标永远不会超出硬保护线 900', () => {
    const policy = resolveResponsePolicy({ recentAssistantVisibleChars: [700, 700], sceneFactor: 2 })
    expect(policy.hardMaxChars).toBeLessThanOrEqual(900)
    expect(policy.targetParagraphs).toEqual({ min: 1, max: 5 })
    expect(policy.maxNewBeats).toBe(1)
  })
})

describe('detectUserLengthIntent 用户篇幅意图（S5）', () => {
  it('识别明确的简短要求', () => {
    for (const text of ['简短回答就好', '简单说说', '只回答一句', '用一句话回答', '短一点', '别写太长', '精简一下', '长话短说']) {
      expect(detectUserLengthIntent(text), text).toBe('brief')
    }
  })

  it('识别明确的展开要求', () => {
    for (const text of ['详细说说', '写详细一点', '再详细一些', '展开讲讲', '具体说说', '多写一点', '描写细致一点', '写长一点']) {
      expect(detectUserLengthIntent(text), text).toBe('detailed')
    }
  })

  it('普通内容不误触发篇幅意图', () => {
    for (const text of [
      '这本书写得很详细，我昨晚看完了',
      '她简单地打了个招呼就走了',
      '我们下一句该说什么',
      '今天天气不错',
      '你详细问问他当时的情况',
      '他说了一句话就走了',
      '他把地图展开铺在桌上',
      '这条路的距离长一点',
    ]) {
      expect(detectUserLengthIntent(text), text).toBeNull()
    }
  })

  it('同时出现两类信号时以简短优先（收紧更安全）', () => {
    expect(detectUserLengthIntent('别太长，但可以详细说说背景')).toBe('brief')
  })

  it('空输入返回 null', () => {
    expect(detectUserLengthIntent('')).toBeNull()
    expect(detectUserLengthIntent(null)).toBeNull()
    expect(detectUserLengthIntent(undefined)).toBeNull()
  })
})

describe('resolveSceneFactor 场景系数（S5）', () => {
  it('首轮开场放大', () => {
    expect(resolveSceneFactor({ latestUserText: '你好', hasAssistantReply: false })).toBe(1.15)
  })

  it('明确场景切换放大（优先于首轮判定）', () => {
    expect(resolveSceneFactor({ latestUserText: '【场景】雨夜的老城车站', hasAssistantReply: true })).toBe(1.25)
    expect(resolveSceneFactor({ latestUserText: '我们转场到下一个城市吧', hasAssistantReply: false })).toBe(1.25)
  })

  it('高压即时问答收缩', () => {
    expect(resolveSceneFactor({ latestUserText: '你去哪？', hasAssistantReply: true })).toBe(0.85)
    expect(resolveSceneFactor({ latestUserText: '真的吗?', hasAssistantReply: true })).toBe(0.85)
  })

  it('普通回合保持默认系数 1', () => {
    expect(resolveSceneFactor({ latestUserText: '她推开门走了进去，屋里一片漆黑。', hasAssistantReply: true })).toBe(1)
    // 长问句不属于即时问答
    expect(resolveSceneFactor({
      latestUserText: '你昨天说的那件事，到底打算什么时候告诉我？',
      hasAssistantReply: true,
    })).toBe(1)
  })
})
