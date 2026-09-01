import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { Character, GroupChat } from '../../../../shared/types'
import { useCharacterStore } from '../../../store/useCharacterStore'
import { useGroupChatStore } from '../../../store/useGroupChatStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { GroupChatInput } from '../GroupChatInput'

const character: Character = {
  id: 'c1', name: '爱丽丝', avatar: '', description: '', personality: '', scenario: '',
  firstMessage: '', exampleDialog: '', tags: [], lorebookId: null, creator: '',
  createdAt: 0, updatedAt: 0, alternateGreetings: [],
}

const group: GroupChat = {
  id: 'g1', name: '测试群', memberIds: ['c1'], currentSpeakerIndex: 0,
  autoMode: false, chatMode: 'polling', maxRounds: 1, speakerInterval: 2000,
  lorebookIds: [], presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
}

describe('GroupChatInput', () => {
  const triggerCharacterReply = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    useCharacterStore.setState({ characters: [character] })
    useGroupChatStore.setState({ isStreaming: false, currentGroup: group, triggerCharacterReply } as never)
    useSettingsStore.setState({
      settings: { ...getDefaultSettings(), userName: '林舟' },
      credentials: {}, loaded: true, _saveTimer: null,
    })
  })

  it('用单行控制器区分发送后规则与立即接话', () => {
    render(<GroupChatInput group={group} />)

    expect(screen.queryByText('发言方式')).toBeNull()
    expect(screen.getByText('发送后')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '发送后回复规则' })).toHaveValue('polling')
    expect(screen.getByText('立即接话')).toBeTruthy()
    expect(screen.getByRole('button', { name: '让 爱丽丝立即接话' })).toBeTruthy()
    expect(screen.getByPlaceholderText('输入消息…')).toBeTruthy()
  })

  it('点击角色后直接触发一次上下文回复', async () => {
    render(<GroupChatInput group={group} />)

    fireEvent.click(screen.getByRole('button', { name: '让 爱丽丝立即接话' }))

    await waitFor(() => expect(triggerCharacterReply).toHaveBeenCalledWith('c1'))
  })
})
