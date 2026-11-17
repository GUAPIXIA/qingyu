/**
 * 会话级世界状态变更后的方向刷新（单聊 / 群聊）。
 *
 * 世界状态（memoryCurrentState）既是方向生成的输入，也随自动长记忆在回复后改写。
 * 它不再参与「方向是否可见」的判定，因此必须显式触发一次静默换一批：
 * 旧方向在新结果到达前保持可见，失败不清空、不闪空。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { refreshSingleMock, refreshGroupMock } = vi.hoisted(() => ({
  refreshSingleMock: vi.fn(async () => undefined),
  refreshGroupMock: vi.fn(async () => undefined),
}))

vi.mock('../dialogueDirectionRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dialogueDirectionRunner')>()
  return {
    ...actual,
    refreshSingleDialogueDirections: refreshSingleMock,
    refreshGroupDialogueDirections: refreshGroupMock,
  }
})

import { useChatStore } from '../useChatStore'
import { useGroupChatStore } from '../useGroupChatStore'
import { useCharacterStore } from '../useCharacterStore'

beforeEach(() => {
  vi.clearAllMocks()
  useCharacterStore.setState({ characters: [{ id: 'c1', name: 'Alice' } as never] })
})

describe('单聊 updateSessionField', () => {
  function seed(memoryCurrentState: string) {
    useChatStore.setState({
      currentSessionId: 's1',
      messages: [],
      sessions: [{ id: 's1', characterId: 'c1', memoryCurrentState } as never],
    })
  }

  it('世界状态变化：触发静默换一批', async () => {
    seed('旧局势')
    await useChatStore.getState().updateSessionField('c1', 's1', 'memoryCurrentState', '新局势')
    expect(refreshSingleMock).toHaveBeenCalledTimes(1)
  })

  it('世界状态写成同值：不重复请求', async () => {
    seed('旧局势')
    await useChatStore.getState().updateSessionField('c1', 's1', 'memoryCurrentState', '旧局势')
    expect(refreshSingleMock).not.toHaveBeenCalled()
  })

  it('与方向无关的字段不触发刷新', async () => {
    seed('旧局势')
    await useChatStore.getState().updateSessionField('c1', 's1', 'spatialContextEnabled', true)
    expect(refreshSingleMock).not.toHaveBeenCalled()
  })
})

describe('群聊 updateNarrativeSession', () => {
  function seed(memoryCurrentState: string) {
    useGroupChatStore.setState({
      currentGroup: { id: 'g1', memberIds: ['c1'], chatMode: 'mention' } as never,
      currentSessionId: 'gs1',
      messages: [],
      isStreaming: false,
      sessions: [{ id: 'gs1', memoryCurrentState } as never],
    })
  }

  it('世界状态变化：触发静默换一批', async () => {
    seed('旧局势')
    await useGroupChatStore.getState().updateNarrativeSession({ memoryCurrentState: '新局势' })
    expect(refreshGroupMock).toHaveBeenCalledTimes(1)
  })

  it('世界状态写成同值：不重复请求', async () => {
    seed('旧局势')
    await useGroupChatStore.getState().updateNarrativeSession({ memoryCurrentState: '旧局势' })
    expect(refreshGroupMock).not.toHaveBeenCalled()
  })
})
