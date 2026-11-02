import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Character, GroupChat, GroupSession } from '../../../shared/types'
import { getDefaultSettings } from '../../../shared/defaults'
import { useSettingsStore } from '../useSettingsStore'
import { useCharacterStore } from '../useCharacterStore'
import { useGroupChatStore } from '../useGroupChatStore'
import { buildGroupChatContext } from '../groupChatContext'

const baseGroup: GroupChat = {
  id: 'g1', name: '夜谈会', memberIds: ['c1', 'c2'], currentSpeakerIndex: 0, autoMode: false,
  chatMode: 'free', maxRounds: 1, speakerInterval: 1, presetId: null, lorebookIds: [],
  systemPrompt: 'SYS_MARK 用户手写规则', createdAt: 1, updatedAt: 1,
}
const baseSession: GroupSession = {
  id: 's1', groupId: 'g1', title: '会话', messageCount: 0, narrativeMode: 'immersive', createdAt: 1, updatedAt: 1,
}

function makeCharacters(): Character[] {
  return [
    {
      id: 'c1', name: '林雪', avatar: '', description: '港口守卫队长。',
      personality: '冷静', scenario: '旧起点在城外', firstMessage: '', exampleDialog: '', tags: [],
      lorebookId: null, creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
    },
    {
      id: 'c2', name: '阿远', avatar: '', description: '码头搬运工。',
      personality: '爽朗', scenario: '旧起点在码头', firstMessage: '', exampleDialog: '', tags: [],
      lorebookId: null, creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
    },
  ]
}

function buildSystemText(group: GroupChat = baseGroup, targetCharId?: string): string {
  useGroupChatStore.setState({ currentGroup: group, currentSessionId: 's1' })
  return buildGroupChatContext(useGroupChatStore.getState, targetCharId, null, { trackUsage: false })
    .messages.filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n')
}

describe('群聊共同场景上下文注入', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        userName: '林舟',
        activeProfileId: 'profile',
        activeModel: 'gpt-4o-mini',
        connectionProfiles: [{
          id: 'profile', name: '连接', provider: 'openai', model: 'gpt-4o-mini',
          apiKey: 'test-only', baseUrl: 'https://test.invalid', maxContext: 32768,
        }],
      },
      loaded: true,
    })
    useCharacterStore.setState({ characters: makeCharacters() })
    useGroupChatStore.setState({
      currentGroup: baseGroup,
      currentSessionId: 's1',
      sessions: [baseSession],
      messages: [],
      isStreaming: false,
      currentStreamingCharId: null,
      _semanticLoreHits: [],
      _semanticFactsHits: [],
    })
  })

  it('无 groupPreamble 时不注入共同场景块', () => {
    expect(buildSystemText()).not.toContain('群聊共同场景')
  })

  it('有 groupPreamble 时注入到成员卡之前，并声明优先级', () => {
    const preamble = '【时间】周末傍晚。\n【地点】旧书店二楼。\n【当前情境】两人因同一本书相遇。'
    const group: GroupChat = { ...baseGroup, groupPreamble: { text: preamble, memberIds: ['c1', 'c2'], updatedAt: 1 } }
    const text = buildSystemText(group)

    expect(text).toContain('【群聊共同场景（优先于角色卡中的场景设定）】')
    expect(text).toContain('【地点】旧书店二楼。')
    expect(text).toContain('以本共同场景为准')
    expect(text).toContain('以用户手写内容为准')
    const systemPromptIndex = text.indexOf('SYS_MARK')
    const preambleIndex = text.indexOf('【群聊共同场景')
    const memberCardsIndex = text.indexOf('以下是所有角色的完整设定：')
    expect(systemPromptIndex).toBeGreaterThanOrEqual(0)
    expect(preambleIndex).toBeGreaterThan(systemPromptIndex)
    expect(memberCardsIndex).toBeGreaterThan(preambleIndex)
  })

  it('注入文本走宏展开：{{user}} / {{group}} 可替换', () => {
    const group: GroupChat = {
      ...baseGroup,
      groupPreamble: { text: '{{user}} 在 {{group}} 里等待。', memberIds: ['c1'], updatedAt: 1 },
    }
    const text = buildSystemText(group)
    // 未配置人设时群聊上下文把用户名解析为“用户”（与用户人设块同口径）。
    expect(text).toContain('用户 在 夜谈会 里等待。')
    expect(text).not.toContain('{{user}}')
  })

  it('空白 text 视为已清除：不注入且输出与无字段一致', () => {
    const baseline = buildSystemText()
    const group: GroupChat = { ...baseGroup, groupPreamble: { text: '   \n  ', memberIds: ['c1'], updatedAt: 1 } }
    const text = buildSystemText(group)
    expect(text).not.toContain('群聊共同场景')
    expect(text).toBe(baseline)
  })

  it.each(['mention', 'polling', 'free'] as const)('%s 模式都注入共同场景', (chatMode) => {
    const group: GroupChat = {
      ...baseGroup,
      chatMode,
      groupPreamble: { text: '【地点】旧书店二楼。', memberIds: ['c1', 'c2'], updatedAt: 1 },
    }
    const target = chatMode === 'free' ? undefined : 'c1'
    expect(buildSystemText(group, target)).toContain('【地点】旧书店二楼。')
  })

  it('清空字段后输出恢复为无注入版本', () => {
    const withPreamble = buildSystemText({
      ...baseGroup,
      groupPreamble: { text: '【地点】旧书店二楼。', memberIds: ['c1'], updatedAt: 1 },
    })
    expect(withPreamble).toContain('群聊共同场景')
    const withoutPreamble = buildSystemText({ ...baseGroup, groupPreamble: undefined })
    expect(withoutPreamble).not.toContain('群聊共同场景')
    expect(withoutPreamble.length).toBeLessThan(withPreamble.length)
  })
})
