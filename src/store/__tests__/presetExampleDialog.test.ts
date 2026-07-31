/**
 * 预设级示例对话模式（第二批）集成测试
 *
 * 验证 buildContext 中 exampleDialogMode 的优先级：预设级 > 全局。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../useChatStore'
import { useSettingsStore } from '../useSettingsStore'
import { getDefaultSettings } from '../../../shared/defaults'
import { lorebookCache } from '../../utils/lorebook'
import type { Character, Message, Preset } from '../../../shared/types'

function makeCharacter(): Character {
  return {
    id: 'c1',
    name: '爱丽丝',
    avatar: '',
    description: '设定',
    personality: '',
    scenario: '',
    firstMessage: '你好',
    exampleDialog: '用户：你是谁？\n爱丽丝：*微笑* 我是雪莉。',
    tags: [],
    lorebookId: null,
    creator: '',
    createdAt: 0,
    updatedAt: 0,
    alternateGreetings: [],
  }
}

function makePreset(mode?: 'always' | 'first_turn' | 'off'): Preset {
  return {
    id: 'p1',
    name: '测试',
    description: '',
    systemPrompt: '',
    jailbreak: '',
    maxContext: 0,
    temperature: 0.8,
    topP: 0.95,
    maxTokens: 1024,
    frequencyPenalty: 0,
    presencePenalty: 0,
    isBuiltin: false,
    exampleDialogMode: mode,
  }
}

function setup(messages: Message[], globalMode: 'always' | 'first_turn' | 'off') {
  useChatStore.setState({ messages, sessions: [], currentSessionId: null, activeLorebookIds: [] })
  useSettingsStore.setState({
    settings: { ...getDefaultSettings(), exampleDialogMode: globalMode },
  })
}

function build(preset: Preset) {
  return useChatStore.getState().buildContext(makeCharacter(), preset)
}

describe('buildContext 预设级示例对话模式', () => {
  beforeEach(() => {
    lorebookCache.clear()
  })

  it('预设 off 覆盖全局 always：不注入示例对话', () => {
    setup([], 'always')
    const all = build(makePreset('off')).map((c) => c.content).join('\n')
    expect(all).not.toContain('对话示例')
  })

  it('预设未设置时回退全局 always：注入示例对话', () => {
    setup([], 'always')
    const all = build(makePreset(undefined)).map((c) => c.content).join('\n')
    expect(all).toContain('【对话示例】')
  })

  it('预设未设置且全局 off：不注入', () => {
    setup([], 'off')
    const all = build(makePreset(undefined)).map((c) => c.content).join('\n')
    expect(all).not.toContain('对话示例')
  })

  it('预设 first_turn 覆盖全局：首轮注入、多轮不注入', () => {
    const oneUserMsg: Message = {
      id: 'u1', role: 'user', content: '你好', images: [], timestamp: 1, sessionId: 's1', characterId: 'c1', isEditing: false,
    }
    setup([oneUserMsg], 'always')
    expect(build(makePreset('first_turn')).map((c) => c.content).join('\n')).toContain('【对话示例】')

    const manyMsgs: Message[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `内容${i}`, images: [], timestamp: i, sessionId: 's1', characterId: 'c1', isEditing: false,
    }) as Message)
    setup(manyMsgs, 'always')
    expect(build(makePreset('first_turn')).map((c) => c.content).join('\n')).not.toContain('【对话示例】')
  })
})
