import { describe, it, expect } from 'vitest'
import { ensureUserPerspective, buildContinueSystemPrompt, buildContinueContext } from '../aiInputHelper'
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
})
