/**
 * 作者注释（Author's Note）注入集成测试
 *
 * 验证角色卡 AN 的三档位置注入、变量替换与关闭行为。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../useChatStore'
import { useSettingsStore } from '../useSettingsStore'
import { getDefaultSettings } from '../../../shared/defaults'
import { lorebookCache } from '../../utils/lorebook'
import type { Character, Message, AuthorNoteConfig } from '../../../shared/types'

function makeCharacter(): Character {
  return {
    id: 'c1',
    name: '爱丽丝',
    avatar: '',
    description: '设定',
    personality: '',
    scenario: '',
    firstMessage: '你好',
    exampleDialog: '',
    tags: [],
    lorebookId: null,
    creator: '',
    createdAt: 0,
    updatedAt: 0,
    alternateGreetings: [],
  }
}

/** 构造 N 条交替历史消息 */
function makeMessages(n: number): Message[] {
  const msgs: Message[] = []
  for (let i = 0; i < n; i++) {
    msgs.push({
      id: `u${i}`,
      role: 'user',
      content: `用户消息${i}`,
      images: [],
      timestamp: i,
      sessionId: 's1',
      characterId: 'c1',
      isEditing: false,
    } as Message)
    msgs.push({
      id: `a${i}`,
      role: 'assistant',
      content: `助手回复${i}`,
      images: [],
      timestamp: i + 0.5,
      sessionId: 's1',
      characterId: 'c1',
      isEditing: false,
    } as Message)
  }
  return msgs
}

function setupSettings() {
  useSettingsStore.setState({
    settings: getDefaultSettings(),
  })
}

function makeCharacterWithAuthorNote(authorNote: AuthorNoteConfig): Character {
  return { ...makeCharacter(), authorNote }
}

describe('buildContext 作者注释注入', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      sessions: [],
      currentSessionId: null,
      activeLorebookIds: [],
    })
    lorebookCache.clear()
  })

  it('关闭时不注入 AN（enabled=false）', () => {
    setupSettings()
    useChatStore.setState({ messages: makeMessages(2) })

    const ctx = useChatStore.getState().buildContext(makeCharacterWithAuthorNote({ enabled: false, text: 'AN内容', position: 'middle', depth: 1 }), null).messages
    expect(ctx.filter(c => c.content === 'AN内容')).toHaveLength(0)
  })

  it('top 位置：AN 紧跟系统提示（context 第 2 条）', () => {
    setupSettings()
    useChatStore.setState({ messages: makeMessages(2) })

    const ctx = useChatStore.getState().buildContext(makeCharacterWithAuthorNote({ enabled: true, text: 'AN内容', position: 'top', depth: 1 }), null).messages
    expect(ctx[0].role).toBe('system')
    expect(ctx[1]).toMatchObject({ role: 'system', content: 'AN内容' })
  })

  it('bottom 位置：AN 在最新消息之后（对话末尾，ST 语义 depth 0）', () => {
    setupSettings()
    useChatStore.setState({ messages: makeMessages(2) })

    const ctx = useChatStore.getState().buildContext(makeCharacterWithAuthorNote({ enabled: true, text: 'AN内容', position: 'bottom', depth: 0 }), null).messages
    // 4 条历史 [u0,a0,u1,a1]，depth 0 → 插在 a1 之后（P-8 修复 off-by-one）
    const anIndex = ctx.findIndex(c => c.content === 'AN内容')
    expect(ctx[anIndex - 1].content).toBe('助手回复1')
    // 正文结构约束必须在全部历史注入之后再次固定，因此 AN 后仍有该 system 消息。
    expect(ctx[anIndex + 1].content).toContain('【正文结构】')
  })

  it('middle 位置 depth=1：AN 插在倒数第二条消息之后', () => {
    setupSettings()
    useChatStore.setState({ messages: makeMessages(3) })

    const ctx = useChatStore.getState().buildContext(makeCharacterWithAuthorNote({ enabled: true, text: 'AN内容', position: 'middle', depth: 1 }), null).messages
    // 历史 6 条 [u0,a0,u1,a1,u2,a2]，depth=1 → 倒数第二条（u2）之后
    // 结果：u0,a0,u1,a1,u2,AN,a2
    const anIndex = ctx.findIndex(c => c.content === 'AN内容')
    expect(ctx[anIndex - 1].content).toBe('用户消息2')
    expect(ctx[anIndex + 1].content).toBe('助手回复2')
  })

  it('middle 位置 depth=0：AN 在最新消息之后', () => {
    setupSettings()
    useChatStore.setState({ messages: makeMessages(2) })

    const ctx = useChatStore.getState().buildContext(makeCharacterWithAuthorNote({ enabled: true, text: 'AN内容', position: 'middle', depth: 0 }), null).messages
    // 4 条历史，depth 0 → 插在最后一条（a1）之后（P-8 修复 off-by-one）
    const anIndex = ctx.findIndex(c => c.content === 'AN内容')
    expect(ctx[anIndex - 1].content).toBe('助手回复1')
    expect(ctx[anIndex + 1].content).toContain('【正文结构】')
  })

  it('变量替换：{{char}} / {{user}}', () => {
    setupSettings()
    useSettingsStore.setState((s: any) => ({
      settings: { ...s.settings, userName: '小明' },
    }))
    useChatStore.setState({ messages: makeMessages(1) })

    const ctx = useChatStore.getState().buildContext(makeCharacterWithAuthorNote({ enabled: true, text: '{{char}}记住{{user}}的名字', position: 'top', depth: 1 }), null).messages
    expect(ctx[1].content).toBe('爱丽丝记住小明的名字')
  })

  it('没有角色级 AN 时不注入作者注释', () => {
    setupSettings()
    useChatStore.setState({ messages: makeMessages(1) })

    const ctx = useChatStore.getState().buildContext(makeCharacter(), null).messages
    expect(ctx.some(c => c.content === 'AN内容')).toBe(false)
  })

  it('角色级 AN 关闭时不注入', () => {
    setupSettings()
    const char = makeCharacterWithAuthorNote({ enabled: false, text: '角色AN', position: 'top', depth: 1 })
    useChatStore.setState({ messages: makeMessages(1) })

    const ctx = useChatStore.getState().buildContext(char, null).messages
    expect(ctx.filter(c => c.content === '角色AN')).toHaveLength(0)
  })
})
