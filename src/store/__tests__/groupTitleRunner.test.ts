import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AIDonePayload } from '../../../shared/ipc-api'
import type { GroupChat, GroupSession, GroupMessage } from '../../../shared/types'
import { getDefaultSettings } from '../../../shared/defaults'
import { useCharacterStore } from '../useCharacterStore'
import { useGroupChatStore } from '../useGroupChatStore'
import { usePersonaStore } from '../usePersonaStore'
import { useSettingsStore } from '../useSettingsStore'
import { maybeAutoGroupTitle } from '../../features/group-chat/groupTitleRunner'

const group: GroupChat = {
  id: 'g1', name: '夜谈会', memberIds: ['c1', 'c2'], currentSpeakerIndex: 0, autoMode: false,
  chatMode: 'free', maxRounds: 1, speakerInterval: 1, presetId: null, lorebookIds: [],
  systemPrompt: '', createdAt: 1, updatedAt: 1,
}

function makeSession(patch: Partial<GroupSession> = {}): GroupSession {
  return {
    id: 's1', groupId: 'g1', title: '默认会话', messageCount: 0,
    createdAt: 1, updatedAt: 1, narrativeMode: 'immersive',
    ...patch,
  } as GroupSession
}

/** 交替构造用户/角色消息；userCount 条用户消息。 */
function makeMessages(userCount: number, tag = ''): GroupMessage[] {
  const messages: GroupMessage[] = []
  for (let index = 0; index < userCount; index++) {
    messages.push({
      id: `u-${tag}-${index}`, groupId: 'g1', characterId: '__user__', content: `用户第 ${index + 1} 轮发言`,
      images: [], timestamp: index * 2 + 1, round: index + 1,
    })
    messages.push({
      id: `a-${tag}-${index}`, groupId: 'g1', characterId: 'c1', content: `Aiko 第 ${index + 1} 轮回应`,
      images: [], timestamp: index * 2 + 2, round: index + 1, speakerKind: 'character', generationKind: 'assistant_reply',
    })
  }
  return messages
}

let chunkCb: ((data: { requestId: string; text: string }) => void) | undefined
let completeCb: ((payload: AIDonePayload) => void) | undefined

function stubAiText(text: string, finishReason: AIDonePayload['finishReason'] = 'stop') {
  vi.mocked(window.api.ai.onChunk).mockImplementation((callback) => { chunkCb = callback; return vi.fn() })
  vi.mocked(window.api.ai.onComplete).mockImplementation((callback) => { completeCb = callback; return vi.fn() })
  vi.mocked(window.api.ai.onError).mockReturnValue(vi.fn())
  vi.mocked(window.api.ai.chat).mockImplementation(async (params) => {
    queueMicrotask(() => {
      chunkCb?.({ requestId: params.requestId, text })
      completeCb?.({ requestId: params.requestId, finishReason } as AIDonePayload)
    })
  })
}

async function waitFor(predicate: () => void, label: string) {
  let lastError: unknown
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      predicate()
      return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw lastError instanceof Error ? lastError : new Error(`等待超时：${label}`)
}

function seed(userCount: number, sessionPatch: Partial<GroupSession> = {}, tag = 'a') {
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      userName: '大本',
      autoTitle: true,
      activeProfileId: 'profile',
      activeModel: 'test-model',
      connectionProfiles: [{
        id: 'profile', name: '连接', provider: 'openai', model: 'test-model',
        apiKey: 'test-only', baseUrl: 'https://test.invalid', maxContext: 32768,
      }],
    },
    loaded: true,
  })
  useCharacterStore.setState({
    characters: [
      { ...useCharacterStore.getState().createCharacter(), id: 'c1', name: 'Aiko' },
      { ...useCharacterStore.getState().createCharacter(), id: 'c2', name: 'Eve' },
    ],
  })
  usePersonaStore.setState({ personas: [], loaded: true })
  useGroupChatStore.setState({
    currentGroup: group,
    currentSessionId: 's1',
    sessions: [makeSession(sessionPatch)],
    messages: makeMessages(userCount, tag),
    isStreaming: false,
    currentStreamingCharId: null,
  })
}

describe('maybeAutoGroupTitle（群聊自动标题）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chunkCb = undefined
    completeCb = undefined
  })

  it('用户消息不足 4 条不生成', async () => {
    seed(3)
    await maybeAutoGroupTitle(useGroupChatStore.setState, useGroupChatStore.getState)
    expect(window.api.ai.chat).not.toHaveBeenCalled()
    expect(window.api.group.commitFeatureResult).not.toHaveBeenCalled()
  })

  it('默认标题 + 4 条用户消息：生成并提交 title，本地会话同步更新', async () => {
    seed(4, {}, 'b')
    stubAiText('雨夜旧书店')
    await maybeAutoGroupTitle(useGroupChatStore.setState, useGroupChatStore.getState)
    await waitFor(() => expect(window.api.group.commitFeatureResult).toHaveBeenCalledTimes(1), '标题提交')
    expect(vi.mocked(window.api.group.commitFeatureResult).mock.calls[0][2]).toMatchObject({
      feature: 'title', expectedTitle: '默认会话', text: '雨夜旧书店',
    })
    await waitFor(() => expect(useGroupChatStore.getState().sessions[0].title).toBe('雨夜旧书店'), '会话标题更新')
    expect(useGroupChatStore.getState().sessions[0].titleGenerated).toBe(true)
  })

  it('「新对话 N」默认标题同样可生成；已生成或用户改名的标题跳过', async () => {
    seed(4, { title: '新对话 2' }, 'c')
    stubAiText('新对话标题')
    await maybeAutoGroupTitle(useGroupChatStore.setState, useGroupChatStore.getState)
    await waitFor(() => expect(window.api.group.commitFeatureResult).toHaveBeenCalledTimes(1), '新对话标题提交')

    vi.clearAllMocks()
    seed(4, { title: '我改的标题' }, 'd')
    await maybeAutoGroupTitle(useGroupChatStore.setState, useGroupChatStore.getState)
    expect(window.api.ai.chat).not.toHaveBeenCalled()

    vi.clearAllMocks()
    seed(4, { title: '默认会话', titleGenerated: true }, 'e')
    await maybeAutoGroupTitle(useGroupChatStore.setState, useGroupChatStore.getState)
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })

  it('关闭自动标题设置时不生成', async () => {
    seed(4, {}, 'f')
    useSettingsStore.setState((state) => ({ settings: { ...state.settings, autoTitle: false } }))
    await maybeAutoGroupTitle(useGroupChatStore.setState, useGroupChatStore.getState)
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })

  it('模型完成但 finishReason=length 时不提交', async () => {
    seed(4, {}, 'g')
    stubAiText('半截标题', 'length')
    await maybeAutoGroupTitle(useGroupChatStore.setState, useGroupChatStore.getState)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(window.api.group.commitFeatureResult).not.toHaveBeenCalled()
  })
})
