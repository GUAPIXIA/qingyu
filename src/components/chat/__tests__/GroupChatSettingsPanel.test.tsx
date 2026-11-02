import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GroupChatSettingsPanel } from '../GroupChatSettingsPanel'
import { useGroupChatStore } from '../../../store/useGroupChatStore'
import { useToastStore } from '../../../store/useToastStore'
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
      onOpenInit={vi.fn()}
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

describe('GroupChatSettingsPanel 群聊前置设定', () => {
  const baseGroup: GroupChat = {
    id: 'g1', name: '夜谈会', memberIds: ['c1', 'c2'], currentSpeakerIndex: 0,
    autoMode: false, chatMode: 'polling', maxRounds: 1, speakerInterval: 2000,
    lorebookIds: [], presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
  }
  const existingPreamble = {
    text: '黄昏的旧城区，雨刚停。',
    memberIds: ['c1', 'c2'],
    updatedAt: 100,
  }

  interface RenderOverrides {
    group?: Partial<GroupChat>
    onOpenInit?: () => void
    onOpenSystemOpening?: () => void
  }

  function renderPanel({
    group: groupOverrides,
    onOpenInit = vi.fn(),
    onOpenSystemOpening,
  }: RenderOverrides = {}) {
    const onSave = vi.fn()
    const group: GroupChat = { ...baseGroup, ...groupOverrides }
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
      onOpenInit={onOpenInit}
      onOpenSystemOpening={onOpenSystemOpening}
    />)
    return { onSave, onOpenInit }
  }

  beforeEach(() => {
    useToastStore.setState({ toasts: [] })
    useGroupChatStore.setState({ isStreaming: false })
  })

  afterEach(() => {
    useGroupChatStore.setState({ isStreaming: false })
  })

  it('失焦保存前置设定：trim 正文并写入当前成员快照与时间戳', () => {
    const { onSave } = renderPanel()
    const textarea = screen.getByLabelText('群聊前置设定')

    fireEvent.change(textarea, { target: { value: '  黄昏的旧城区，雨刚停。  ' } })
    fireEvent.blur(textarea)

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      groupPreamble: {
        text: '黄昏的旧城区，雨刚停。',
        memberIds: ['c1', 'c2'],
        updatedAt: expect.any(Number),
      },
    }))
  })

  it('清空正文后失焦删除前置设定字段', () => {
    const { onSave } = renderPanel({ group: { groupPreamble: existingPreamble } })
    const textarea = screen.getByLabelText('群聊前置设定')
    expect(textarea).toHaveValue(existingPreamble.text)

    fireEvent.change(textarea, { target: { value: '   ' } })
    fireEvent.blur(textarea)

    const saved = onSave.mock.calls[0]?.[0] as GroupChat
    expect(saved.groupPreamble).toBeUndefined()
    expect(saved.memberIds).toEqual(['c1', 'c2'])
  })

  it('「清除」按钮删除前置设定字段并 toast 提示', () => {
    const { onSave } = renderPanel({ group: { groupPreamble: existingPreamble } })

    fireEvent.click(screen.getByRole('button', { name: '清除' }))

    const saved = onSave.mock.calls[0]?.[0] as GroupChat
    expect(saved.groupPreamble).toBeUndefined()
    expect(useToastStore.getState().toasts.some((toast) => toast.title === '已清除群聊前置设定')).toBe(true)
  })

  it('成员快照与当前成员不一致时提示重新生成', () => {
    renderPanel({ group: { groupPreamble: { ...existingPreamble, memberIds: ['c1'] } } })
    expect(screen.getByText('成员已变化，建议重新生成')).toBeTruthy()
  })

  it('成员集合一致（仅顺序不同）不提示重新生成', () => {
    renderPanel({ group: { groupPreamble: { ...existingPreamble, memberIds: ['c2', 'c1'] } } })
    expect(screen.queryByText('成员已变化，建议重新生成')).toBeNull()
  })

  it('「AI 生成」与「用系统开场开始」分别回调页面入口', () => {
    const onOpenInit = vi.fn()
    const onOpenSystemOpening = vi.fn()
    renderPanel({ onOpenInit, onOpenSystemOpening })

    fireEvent.click(screen.getByRole('button', { name: 'AI 生成' }))
    expect(onOpenInit).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '用系统开场开始' }))
    expect(onOpenSystemOpening).toHaveBeenCalledTimes(1)
  })

  it('已有前置设定时显示「重新生成」，未传系统开场回调时不显示该入口', () => {
    renderPanel({ group: { groupPreamble: existingPreamble } })

    expect(screen.getByRole('button', { name: '重新生成' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '用系统开场开始' })).toBeNull()
  })

  it('生成中禁用前置设定编辑与清除', () => {
    useGroupChatStore.setState({ isStreaming: true })
    renderPanel({ group: { groupPreamble: existingPreamble } })

    expect(screen.getByLabelText('群聊前置设定')).toBeDisabled()
    expect(screen.getByRole('button', { name: '清除' })).toBeDisabled()
  })
})
