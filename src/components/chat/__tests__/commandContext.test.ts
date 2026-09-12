import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Character, Message } from '../../../../shared/types'
import { getDefaultSettings } from '../../../../shared/defaults'
import { useChatStore } from '../../../store/useChatStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { createCommandContext } from '../commandContext'

const character: Character = {
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
}

function message(overrides: Partial<Message>): Message {
  return {
    id: crypto.randomUUID(),
    sessionId: 'session-1',
    characterId: character.id,
    role: 'assistant',
    content: '',
    images: [],
    isEditing: false,
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('生图命令上下文', () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: { ...getDefaultSettings(), userName: '用户' } } as any)
    useChatStore.setState({
      currentSessionId: 'session-1',
      messages: [
        message({ role: 'user', content: '角色刚刚冲进雨中的车站。' }),
        message({ role: 'assistant', content: '<thought>复述角色卡初始设定</thought>她浑身湿透，扶着站台长椅喘气。' }),
        message({ role: 'system', content: 'old portrait prompt', images: ['data:image/png;base64,OLD'] }),
      ],
    } as any)
  })

  it('只返回可见的真实对话，不让思考或历史生图提示词占用场景上下文', () => {
    const context = createCommandContext({
      character,
      loadActivePresetLorebook: vi.fn().mockResolvedValue([null, []]),
      showNotification: vi.fn(),
      callAiHelper: vi.fn().mockResolvedValue(''),
    })

    expect(context.getRecentMessages(8)).toEqual([
      { role: 'user', content: '角色刚刚冲进雨中的车站。', name: '用户' },
      { role: 'assistant', content: '她浑身湿透，扶着站台长椅喘气。', name: 'Alice' },
    ])
  })
})
