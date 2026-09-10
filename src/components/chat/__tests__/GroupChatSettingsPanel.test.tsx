import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { GroupChatSettingsPanel } from '../GroupChatSettingsPanel'
import type { GroupChat } from '../../../../shared/types'

describe('GroupChatSettingsPanel narrative defaults', () => {
  const group: GroupChat = {
    id: 'g1', name: '夜谈会', memberIds: [], currentSpeakerIndex: 0,
    autoMode: false, chatMode: 'polling', maxRounds: 1, speakerInterval: 2000,
    lorebookIds: [], presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
  }

  it('单独保存新会话叙事默认值而不改变发言模式', () => {
    const onSave = vi.fn()
    render(<GroupChatSettingsPanel
      group={group}
      characters={[]}
      lorebooks={[]}
      presets={[]}
      onClose={vi.fn()}
      onSave={onSave}
      onDelete={vi.fn()}
      onAddMember={vi.fn()}
      onRemoveMember={vi.fn()}
      onMoveMember={vi.fn()}
      onToggleLorebook={vi.fn()}
      onExport={vi.fn()}
    />)

    fireEvent.change(screen.getByLabelText('群聊新会话叙事模式'), {
      target: { value: 'omniscient' },
    })

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      defaultNarrativeMode: 'omniscient',
      chatMode: 'polling',
    }))
  })
})
