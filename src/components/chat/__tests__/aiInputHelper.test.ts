import { describe, it, expect, vi } from 'vitest'
import {
  callAiHelper,
  ensureUserPerspective,
  normalizeContinueOutput,
  parseContinueResult,
  extractTaggedResult,
  buildContinueSystemPrompt,
  buildContinueContext,
} from '../aiInputHelper'
import type { Character, Message } from '../../../../shared/types'

function createCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'char-1',
    name: 'Alice',
    avatar: '',
    description: '',
    personality: '',
    scenario: '',
    firstMessage: '',
    exampleDialog: '',
    tags: [],
    lorebookId: null,
    creator: '',
    createdAt: 0,
    updatedAt: 0,
    alternateGreetings: [],
    ...overrides,
  }
}

function makeMessage(role: 'user' | 'assistant', content: string): Message {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 's1',
    characterId: 'char-1',
    role,
    content,
    images: [],
    isEditing: false,
    timestamp: 0,
  }
}

describe('ensureUserPerspective', () => {
  it('普通文本原样返回（trim）', () => {
    expect(ensureUserPerspective('  你好世界  ', '小明', 'Alice')).toBe('你好世界')
  })

  it('AI 以角色名开头但无用户部分 → 返回空串', () => {
    expect(ensureUserPerspective('Alice: 你好呀，很高兴见到你', '小明', 'Alice')).toBe('')
  })

  it('AI 以角色名开头且包含用户部分 → 提取用户发言', () => {
    expect(ensureUserPerspective('Alice: 你好\n小明: 我很好，谢谢', '小明', 'Alice')).toBe('我很好，谢谢')
  })

  it('角色名/用户名含正则特殊字符时正确转义', () => {
    // C++ 若未转义会把 + 当量词导致匹配异常
    expect(ensureUserPerspective('C++: 你好\n小明: 收到', '小明', 'C++')).toBe('收到')
    expect(ensureUserPerspective('普通回复', '小明', 'C++')).toBe('普通回复')
  })

  it('用户部分跨多个段落时完整提取（不被截断为一段）', () => {
    expect(ensureUserPerspective(
      'Alice: 你好\n小明: 第一段。\n\n第二段。\n\n*动作*', '小明', 'Alice',
    )).toBe('第一段。\n\n第二段。\n\n*动作*')
  })

  it('用户多段发言后角色再次开口 → 截到角色开口前', () => {
    expect(ensureUserPerspective(
      'Alice: 来了。\n小明: 第一段。\n\n第二段。\nAlice: 你怎么了？\n小明: 没事。', '小明', 'Alice',
    )).toBe('第一段。\n\n第二段。')
  })

  it('角色/用户名带 Markdown 星号装饰时仍能识别与提取', () => {
    expect(ensureUserPerspective('**Alice**：你好\n**小明**：我很好', '小明', 'Alice')).toBe('我很好')
    expect(ensureUserPerspective('***Alice***：你好呀', '小明', 'Alice')).toBe('')
    expect(ensureUserPerspective('*Alice*: 来了。\n 小明: 收到', '小明', 'Alice')).toBe('收到')
  })
})

describe('normalizeContinueOutput', () => {
  it('全局叙事保留以焦点角色名开头的有效旁白', () => {
    expect(normalizeContinueOutput('Alice：她推开门，望向远处的山脉。', '小明', 'Alice', 'omniscient'))
      .toBe('Alice：她推开门，望向远处的山脉。')
  })

  it('代入模式继续阻止助手替角色发言', () => {
    expect(normalizeContinueOutput('Alice：你好呀', '小明', 'Alice', 'immersive')).toBe('')
  })
})

describe('严格辅助结果协议', () => {
  it('只提取 thought 之外唯一的目标标签正文', () => {
    expect(extractTaggedResult(
      '<thought>Need final answer.</thought>\n<continuation>夜色渐深，远处传来钟声。</continuation>',
      'continuation',
    )).toBe('夜色渐深，远处传来钟声。')
    expect(extractTaggedResult('Need final only.', 'continuation')).toBe('')
  })

  it('续写必须是标签内的中文正文，英文分析不可回填', () => {
    expect(parseContinueResult(
      '<continuation>Aiko 抬起头，走廊尽头传来急促的脚步声。</continuation>',
      '小明', 'Aiko', 'omniscient',
    )).toBe('Aiko 抬起头，走廊尽头传来急促的脚步声。')
    expect(parseContinueResult(
      '<continuation>We need continue the scene and avoid dialogue.</continuation>',
      '小明', 'Aiko', 'omniscient',
    )).toBe('')
    expect(parseContinueResult('Need final only. 应该继续推进剧情。', '小明', 'Aiko', 'omniscient')).toBe('')
  })
})

describe('buildContinueSystemPrompt', () => {
  it('hasInput=true 提示"续写未完成消息"', () => {
    const p = buildContinueSystemPrompt('小明', 'Alice', true)
    expect(p).toContain('小明')
    expect(p).toContain('Alice')
    expect(p).toContain('续写用户未完成的消息')
  })

  it('hasInput=false 提示"生成一条回复"', () => {
    const p = buildContinueSystemPrompt('小明', 'Alice', false)
    expect(p).toContain('生成一条合适的用户回复')
  })

  it('全局叙事有输入时允许自然分段并要求完整收尾', () => {
    const p = buildContinueSystemPrompt('小明', 'Alice', true, 'omniscient')
    expect(p).toContain('用户侧的剧情推进助手')
    expect(p).toContain('可按叙事节奏分段')
    expect(p).toContain('完整句收尾')
    expect(p).not.toContain('30–120 个中文字符')
    expect(p).toContain('不替对方角色完成详细反应')
    expect(p).not.toContain('全局叙事续写助手')
    expect(p).toContain('简体中文')
    expect(p).toContain('<continuation>')
  })

  it('全局叙事无输入时优先推进最近未解决矛盾', () => {
    const p = buildContinueSystemPrompt('小明', 'Alice', false, 'omniscient')
    expect(p).toContain('最近对话中尚未解决的矛盾')
    expect(p).toContain('事件、压力、线索、阻碍或转折')
    expect(p).toContain('不一次解决当前冲突')
  })
})

describe('buildContinueContext', () => {
  it('system 消息包含角色设定与场景，消息按角色映射，末条为续写指令', () => {
    const character = createCharacter({ description: '温柔学姐', scenario: '校园' })
    const recent = [makeMessage('user', '你好'), makeMessage('assistant', '你好呀')]
    const ctx = buildContinueContext({
      character,
      userName: '小明',
      charName: 'Alice',
      recentMessages: recent,
      originalInput: '我想问',
      hasInput: true,
    })

    expect(ctx[0].role).toBe('system')
    expect(ctx[0].content).toContain('当前角色：Alice')
    expect(ctx[0].content).toContain('温柔学姐')
    expect(ctx[0].content).toContain('校园')

    // 最近消息映射（user/assistant 角色保留）
    expect(ctx[1]).toEqual({ role: 'user', content: '你好' })
    expect(ctx[2]).toEqual({ role: 'assistant', content: '你好呀' })

    // 末条续写指令
    expect(ctx[ctx.length - 1].role).toBe('user')
    expect(ctx[ctx.length - 1].content).toContain('续写以下未完成的消息')
    expect(ctx[ctx.length - 1].content).toContain('我想问')
  })

  it('历史消息中的 <thought> 内心独白不进入续写上下文', () => {
    const recent = [
      makeMessage('assistant', '<thought>他的手握得太紧了……我该怎么办。</thought>\n\n她抬起眼，声音很轻。'),
      makeMessage('user', '你好'),
    ]
    const ctx = buildContinueContext({
      character: createCharacter(),
      userName: '小明',
      charName: 'Alice',
      recentMessages: recent,
      originalInput: '',
      hasInput: false,
    })
    expect(ctx[1].role).toBe('assistant')
    expect(ctx[1].content).toBe('她抬起眼，声音很轻。')
    expect(ctx[1].content).not.toContain('内心独白')
  })

  it('无输入时末条为"根据上下文生成回复"', () => {
    const ctx = buildContinueContext({
      character: createCharacter(),
      userName: '小明',
      charName: 'Alice',
      recentMessages: [],
      originalInput: '',
      hasInput: false,
    })
    expect(ctx[ctx.length - 1].content).toContain('根据上下文生成一条回复')
  })

  it('全局叙事模式使用完整但克制的剧情推动指令', () => {
    const ctx = buildContinueContext({
      character: createCharacter(),
      userName: '小明',
      charName: 'Alice',
      recentMessages: [],
      originalInput: '',
      hasInput: false,
      narrativeMode: 'omniscient',
    })
    expect(ctx[0].content).toContain('用户侧的剧情推进助手')
    expect(ctx[0].content).toContain('只以故事外部旁白的身份输出第三人称叙事')
    expect(ctx[0].content).toContain('不生成角色对白、角色名前缀或整段对话')
    expect(ctx.at(-1)?.content).toContain('尚未解决的矛盾')
    expect(ctx.at(-1)?.content).toContain('自然完整的剧情推动')
    expect(ctx.at(-1)?.content).toContain('写完最后一句')
    expect(ctx.at(-1)?.content).not.toContain('1–3 句')
    expect(ctx.at(-1)?.content).not.toContain('生成下一段全局叙述')
  })
})

describe('续写强度档位', () => {
  it('全局叙事 subtle：只写细微变化且不引入新事件', () => {
    const p = buildContinueSystemPrompt('小明', 'Alice', true, 'omniscient', 'subtle')
    expect(p).toContain('不引入新事件、新角色或新冲突')
    expect(p).not.toContain('事件、压力、线索、阻碍或转折')
    // 保留与档位无关的通用约束
    expect(p).toContain('完整句收尾')
    expect(p).toContain('不替对方角色完成详细反应')
  })

  it('全局叙事 steady：小幅推进', () => {
    const p = buildContinueSystemPrompt('小明', 'Alice', false, 'omniscient', 'steady')
    expect(p).toContain('小幅推进')
    expect(p).not.toContain('不引入新事件、新角色或新冲突')
  })

  it('全局叙事 bold：允许重大转折与场景切换', () => {
    const p = buildContinueSystemPrompt('小明', 'Alice', true, 'omniscient', 'bold')
    expect(p).toContain('重大转折、场景切换、时间推进或新的冲突线')
    expect(p).toContain('不要替 Alice 说话或完成详细心理与连续动作')
    expect(p).toContain('不替对方角色完成详细反应')
  })

  it('全局叙事 active（默认）：保持强度功能引入前的原文案', () => {
    const explicit = buildContinueSystemPrompt('小明', 'Alice', false, 'omniscient', 'active')
    const defaulted = buildContinueSystemPrompt('小明', 'Alice', false, 'omniscient')
    expect(explicit).toBe(defaulted)
    expect(explicit).toContain('事件、压力、线索、阻碍或转折')
    expect(explicit).toContain('只提出变化并把故事推到下一个反应点')
    expect(explicit).not.toContain('重大转折')
  })

  it('代入模式按档位增减补全幅度约束', () => {
    const subtle = buildContinueSystemPrompt('小明', 'Alice', true, 'immersive', 'subtle')
    expect(subtle).toContain('不引入新的剧情发展')
    const bold = buildContinueSystemPrompt('小明', 'Alice', true, 'immersive', 'bold')
    expect(bold).toContain('重大转折、场景变化或新的冲突方向')
    const active = buildContinueSystemPrompt('小明', 'Alice', true, 'immersive')
    expect(active).not.toContain('不引入新的剧情发展')
    expect(active).not.toContain('重大转折、场景变化或新的冲突方向')
  })

  it('buildContinueContext 透传强度到末条指令，非法值回退默认档', () => {
    const base = {
      character: createCharacter(),
      userName: '小明',
      charName: 'Alice',
      recentMessages: [],
      originalInput: '城门外传来',
      hasInput: true,
      narrativeMode: 'omniscient' as const,
    }
    const subtle = buildContinueContext({ ...base, intensity: 'subtle' })
    expect(subtle.at(-1)?.content).toContain('保持当前走向，仅加入细微变化')
    expect(subtle.at(-1)?.content).toContain('城门外传来')

    const bold = buildContinueContext({ ...base, intensity: 'bold' })
    expect(bold.at(-1)?.content).toContain('幅度较大的剧情转折或场景变化')

    const fallback = buildContinueContext({ ...base, intensity: 'extreme' as never })
    expect(fallback.at(-1)?.content).toContain('自然完整的剧情推动')
  })

  it('内容长度独立控制最终输入框篇幅，不改变剧情转折指令', () => {
    const brief = buildContinueSystemPrompt('小明', 'Alice', true, 'omniscient', 'active', 'brief')
    const extended = buildContinueSystemPrompt('小明', 'Alice', true, 'omniscient', 'active', 'extended')

    expect(brief).toContain('最终输入框内容为目标，保持精简，通常为一至两句')
    expect(extended).toContain('最终输入框内容为目标，允许完整展开细节与过程，可写多个自然段')
    expect(brief).toContain('事件、压力、线索、阻碍或转折')
    expect(extended).toContain('事件、压力、线索、阻碍或转折')
  })

  it('buildContinueContext 透传内容长度并对非法值回退适中档', () => {
    const base = {
      character: createCharacter(),
      userName: '小明',
      charName: 'Alice',
      recentMessages: [],
      originalInput: '他推开门，',
      hasInput: true,
    }
    expect(buildContinueContext({ ...base, length: 'detailed' })[0].content)
      .toContain('可写两到三个自然段')
    expect(buildContinueContext({ ...base, length: 'invalid' as never })[0].content)
      .toContain('信息完整、节奏自然的短段落')
  })
})

describe('callAiHelper', () => {
  it('将完整的续写上下文发送给模型，而不是只保留首尾消息', async () => {
    let done: ((requestId: string) => void) | undefined
    let chunk: ((data: { requestId: string; text: string }) => void) | undefined
    vi.mocked(window.api.ai.onChunk).mockImplementation((callback) => {
      chunk = callback
      return vi.fn()
    })
    vi.mocked(window.api.ai.onDone).mockImplementation((callback) => {
      done = callback
      return vi.fn()
    })

    const messages = [
      { role: 'system' as const, content: '续写规则' },
      { role: 'user' as const, content: '上一轮用户消息' },
      { role: 'assistant' as const, content: '上一轮角色回复' },
      { role: 'user' as const, content: '请生成用户回复' },
    ]
    const result = callAiHelper({
      messages,
      profile: { provider: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.example.com' },
      activeModel: 'test-model',
      preset: null,
      activeRequestIds: new Set(),
    })

    const params = vi.mocked(window.api.ai.chat).mock.calls.at(-1)?.[0]
    expect(params?.messages).toEqual(messages)

    chunk?.({ requestId: params!.requestId, text: '继续前进' })
    done?.(params!.requestId)
    await expect(result).resolves.toBe('继续前进')
  })

  it('推理模型只返回 thought 块时不再回填推理内容', async () => {
    let done: ((requestId: string) => void) | undefined
    let chunk: ((data: { requestId: string; text: string }) => void) | undefined
    vi.mocked(window.api.ai.onChunk).mockImplementation((callback) => {
      chunk = callback
      return vi.fn()
    })
    vi.mocked(window.api.ai.onDone).mockImplementation((callback) => {
      done = callback
      return vi.fn()
    })

    const result = callAiHelper({
      messages: [{ role: 'user', content: '续写' }],
      profile: { provider: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.example.com' },
      activeModel: 'deepseek/deepseek-v4-flash',
      preset: null,
      activeRequestIds: new Set(),
    })

    const requestId = vi.mocked(window.api.ai.chat).mock.calls.at(-1)?.[0].requestId
    chunk?.({ requestId: requestId!, text: '<thought>夜色渐深，远处传来钟声。</thought>' })
    done?.(requestId!)

    await expect(result).resolves.toBe('')
  })

  it('辅助请求可显式关闭推理模式', async () => {
    let done: ((requestId: string) => void) | undefined
    vi.mocked(window.api.ai.onDone).mockImplementation((callback) => {
      done = callback
      return vi.fn()
    })
    const result = callAiHelper({
      messages: [{ role: 'user', content: '续写' }],
      reasoningMode: 'disabled',
      profile: { provider: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.example.com' },
      activeModel: 'deepseek/deepseek-v4-flash',
      preset: null,
      activeRequestIds: new Set(),
    })
    const params = vi.mocked(window.api.ai.chat).mock.calls.at(-1)?.[0]
    expect(params?.reasoningMode).toBe('disabled')
    done?.(params!.requestId)
    await expect(result).resolves.toBe('')
  })
})
