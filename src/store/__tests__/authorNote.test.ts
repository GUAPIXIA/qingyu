/**
 * 作者注释（Author's Note）注入集成测试
 *
 * 验证 buildContext 中 AN 的三档位置注入 + 角色级覆盖 + 关闭行为。
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

function setupSettings(an: AuthorNoteConfig | undefined) {
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      authorNote: an,
    },
  })
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
    setupSettings({ enabled: false, text: 'AN内容', position: 'middle', depth: 1 })
    useChatStore.setState({ messages: makeMessages(2) })

    const ctx = useChatStore.getState().buildContext(makeCharacter(), null)
    expect(ctx.filter(c => c.content === 'AN内容')).toHaveLength(0)
  })

  it('top 位置：AN 紧跟系统提示（context 第 2 条）', () => {
    setupSettings({ enabled: true, text: 'AN内容', position: 'top', depth: 1 })
    useChatStore.setState({ messages: makeMessages(2) })

    const ctx = useChatStore.getState().buildContext(makeCharacter(), null)
    expect(ctx[0].role).toBe('system')
    expect(ctx[1]).toMatchObject({ role: 'system', content: 'AN内容' })
  })

  it('bottom 位置：AN 在最新消息之后（对话末尾，ST 语义 depth 0）', () => {
    setupSettings({ enabled: true, text: 'AN内容', position: 'bottom', depth: 0 })
    useChatStore.setState({ messages: makeMessages(2) })

    const ctx = useChatStore.getState().buildContext(makeCharacter(), null)
    // 4 条历史 [u0,a0,u1,a1]，depth 0 → 插在 a1 之后（P-8 修复 off-by-one）
    const anIndex = ctx.findIndex(c => c.content === 'AN内容')
    expect(ctx[anIndex - 1].content).toBe('助手回复1')
    expect(anIndex).toBe(ctx.length - 1)
  })

  it('middle 位置 depth=1：AN 插在倒数第二条消息之后', () => {
    setupSettings({ enabled: true, text: 'AN内容', position: 'middle', depth: 1 })
    useChatStore.setState({ messages: makeMessages(3) })

    const ctx = useChatStore.getState().buildContext(makeCharacter(), null)
    // 历史 6 条 [u0,a0,u1,a1,u2,a2]，depth=1 → 倒数第二条（u2）之后
    // 结果：u0,a0,u1,a1,u2,AN,a2
    const anIndex = ctx.findIndex(c => c.content === 'AN内容')
    expect(ctx[anIndex - 1].content).toBe('用户消息2')
    expect(ctx[anIndex + 1].content).toBe('助手回复2')
  })

  it('middle 位置 depth=0：AN 在最新消息之后', () => {
    setupSettings({ enabled: true, text: 'AN内容', position: 'middle', depth: 0 })
    useChatStore.setState({ messages: makeMessages(2) })

    const ctx = useChatStore.getState().buildContext(makeCharacter(), null)
    // 4 条历史，depth 0 → 插在最后一条（a1）之后（P-8 修复 off-by-one）
    const anIndex = ctx.findIndex(c => c.content === 'AN内容')
    expect(ctx[anIndex - 1].content).toBe('助手回复1')
    expect(anIndex).toBe(ctx.length - 1)
  })

  it('变量替换：{{char}} / {{user}}', () => {
    setupSettings({ enabled: true, text: '{{char}}记住{{user}}的名字', position: 'top', depth: 1 })
    useSettingsStore.setState((s: any) => ({
      settings: { ...s.settings, userName: '小明' },
    }))
    useChatStore.setState({ messages: makeMessages(1) })

    const ctx = useChatStore.getState().buildContext(makeCharacter(), null)
    expect(ctx[1].content).toBe('爱丽丝记住小明的名字')
  })

  it('角色级 AN 覆盖全局 AN', () => {
    setupSettings({ enabled: true, text: '全局AN', position: 'top', depth: 1 })
    const char = makeCharacter()
    char.authorNote = { enabled: true, text: '角色AN', position: 'top', depth: 1 }
    useChatStore.setState({ messages: makeMessages(1) })

    const ctx = useChatStore.getState().buildContext(char, null)
    expect(ctx[1].content).toBe('角色AN')
    expect(ctx.filter(c => c.content === '全局AN')).toHaveLength(0)
  })

  it('角色级 AN 关闭（enabled=false）时全局 AN 也被禁用', () => {
    setupSettings({ enabled: true, text: '全局AN', position: 'top', depth: 1 })
    const char = makeCharacter()
    char.authorNote = { enabled: false, text: '', position: 'top', depth: 1 }
    useChatStore.setState({ messages: makeMessages(1) })

    const ctx = useChatStore.getState().buildContext(char, null)
    expect(ctx.filter(c => c.content === '全局AN')).toHaveLength(0)
  })
})
