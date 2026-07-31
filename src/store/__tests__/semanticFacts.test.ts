/**
 * 记忆事实语义检索注入（P0-2）集成测试
 *
 * 验证 buildContext 的事实注入：
 * - 无语义命中缓存 → 全量注入 memoryFacts
 * - 有语义命中缓存 → 仅注入命中的事实
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../useChatStore'
import { useSettingsStore } from '../useSettingsStore'
import { getDefaultSettings } from '../../../shared/defaults'
import { lorebookCache } from '../../utils/lorebook'
import type { Character, ChatSession } from '../../../shared/types'

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

function setup(memoryFacts: string[] | undefined, semanticFactsHits: string[]) {
  useChatStore.setState({
    messages: [],
    sessions: [{
      id: 's1',
      characterId: 'c1',
      title: '测试',
      createdAt: 0,
      updatedAt: 0,
      memoryEnabled: true,
      memoryMode: 'manual',
      autoMemoryInterval: 10,
      memory: '摘要内容',
      memoryUpdatedAt: 0,
      memoryFacts,
      messageCount: 0,
      lastMessage: '',
    } as ChatSession & { messageCount: number; lastMessage: string }],
    currentSessionId: 's1',
    activeLorebookIds: [],
    _semanticFactsHits: semanticFactsHits,
  })
  useSettingsStore.setState({
    settings: { ...getDefaultSettings() },
  })
}

function build() {
  return useChatStore.getState().buildContext(makeCharacter(), null)
}

describe('buildContext 记忆事实注入', () => {
  beforeEach(() => {
    lorebookCache.clear()
  })

  it('无语义命中时全量注入 memoryFacts', () => {
    setup(['事实A：主角叫小明', '事实B：目标是找妹妹'], [])
    const all = build().map((c) => c.content).join('\n')
    expect(all).toContain('事实A：主角叫小明')
    expect(all).toContain('事实B：目标是找妹妹')
  })

  it('有语义命中时仅注入命中的事实', () => {
    setup(['事实A：主角叫小明', '事实B：目标是找妹妹'], ['事实B：目标是找妹妹'])
    const all = build().map((c) => c.content).join('\n')
    expect(all).toContain('事实B：目标是找妹妹')
    expect(all).not.toContain('事实A：主角叫小明')
  })

  it('语义命中为空数组时回退全量', () => {
    setup(['事实A'], [])
    const all = build().map((c) => c.content).join('\n')
    expect(all).toContain('事实A')
  })

  it('无 memoryFacts 时不注入事实段', () => {
    setup(undefined, [])
    const all = build().map((c) => c.content).join('\n')
    expect(all).not.toContain('【关键事实】')
  })
})
