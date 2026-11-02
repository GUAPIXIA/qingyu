import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupChat, GroupSession } from '../../../shared/types'
import { getDefaultSettings } from '../../../shared/defaults'
import { useSettingsStore } from '../useSettingsStore'
import { useCharacterStore } from '../useCharacterStore'
import { useGroupChatStore } from '../useGroupChatStore'
import { buildGroupChatContext } from '../groupChatContext'

const group: GroupChat = {
  id: 'g1', name: '夜谈会', memberIds: ['c1'], currentSpeakerIndex: 0, autoMode: false,
  chatMode: 'free', maxRounds: 1, speakerInterval: 1, presetId: null, lorebookIds: [],
  systemPrompt: '', createdAt: 1, updatedAt: 1,
}
const session: GroupSession = {
  id: 's1', groupId: 'g1', title: '会话', messageCount: 0, narrativeMode: 'immersive', createdAt: 1, updatedAt: 1,
}

function seed() {
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
  useCharacterStore.setState({
    characters: [{
      id: 'c1', name: '林雪', avatar: '', description: '守卫队长。', personality: '冷静',
      scenario: '', firstMessage: '', exampleDialog: '', tags: [], lorebookId: null,
      creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
    }],
  })
  useGroupChatStore.setState({
    currentGroup: group,
    currentSessionId: 's1',
    sessions: [session],
    messages: [],
    isStreaming: false,
    currentStreamingCharId: null,
    _semanticLoreHits: [],
    _semanticFactsHits: [],
  })
}

describe('insertNarrationMessage（系统开场旁白）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seed()
  })

  it('插入 narrator 消息并持久化，不触发 AI', async () => {
    await useGroupChatStore.getState().insertNarrationMessage('  雨声落在旧书店的窗上。  ')

    const messages = useGroupChatStore.getState().messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      characterId: '__narrator__',
      speakerKind: 'narrator',
      generationKind: 'manual',
      contentRenderMode: 'markdown',
      content: '雨声落在旧书店的窗上。',
    })
    expect(window.api.group.saveMessage).toHaveBeenCalledWith('g1', 's1', expect.objectContaining({
      characterId: '__narrator__', speakerKind: 'narrator',
    }))
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })

  it('空内容不插入', async () => {
    await useGroupChatStore.getState().insertNarrationMessage('   ')
    expect(useGroupChatStore.getState().messages).toHaveLength(0)
    expect(window.api.group.saveMessage).not.toHaveBeenCalled()
  })

  it('旁白消息进入上下文历史（assistant 方向）且渲染身份保持 narrator', () => {
    useGroupChatStore.setState({
      messages: [{
        id: 'n1', groupId: 'g1', characterId: '__narrator__', content: '雨声落在旧书店的窗上。',
        images: [], timestamp: 1, round: 1, narrativeMode: 'immersive', speakerKind: 'narrator',
        generationKind: 'manual', contentRenderMode: 'markdown',
      }],
    })
    const built = buildGroupChatContext(useGroupChatStore.getState, undefined, null, { trackUsage: false })
    const history = built.messages.filter((message) => message.role === 'assistant')
    expect(history.some((message) => message.content.includes('雨声落在旧书店的窗上。'))).toBe(true)
  })
})
