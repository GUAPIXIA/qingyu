import { fireEvent, render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { DialogueDirectionCard } from '../DialogueDirectionCard'
import { shouldShowDialogueDirections } from '../dialogueDirectionView'
import { registerDraftBridge } from '../draftBridge'
import type { Character, DialogueDirection } from '../../../../shared/types'

const DIRECTIONS: DialogueDirection[] = [
  { id: 'safe', label: '追问封锁原因', content: '先不与守卫冲突，试着追问港口突然封锁的原因。', tendency: 'safe' },
  { id: 'explore', label: '寻找其他入口', content: '暂时离开正门，沿港口外围查看是否存在无人值守的通道。', tendency: 'explore' },
  { id: 'risky', label: '冒险直接闯关', content: '趁守卫注意力被分散时尝试突破封锁，承担立即暴露的风险。', tendency: 'risky' },
]

const character = { id: 'c1', name: '艾莉丝' } as Character

function setupDraft(initial = '') {
  let draft = initial
  const setDraft = vi.fn((value: string) => { draft = value })
  registerDraftBridge('single', { getText: () => draft, setDraft })
  return { setDraft, getDraft: () => draft }
}

describe('DialogueDirectionCard', () => {
  beforeEach(() => {
    registerDraftBridge('single', null)
  })

  it('点选后只回填输入框，不触发其他动作', () => {
    const { setDraft, getDraft } = setupDraft('')
    const { getByRole } = render(
      <DialogueDirectionCard directions={DIRECTIONS} canRegenerate onRegenerate={() => {}} />,
    )

    fireEvent.click(getByRole('button', { name: /追问封锁原因/ }))

    expect(setDraft).toHaveBeenCalledWith(DIRECTIONS[0].content)
    expect(getDraft()).toBe(DIRECTIONS[0].content)
  })

  it('使用不透明卡片和高对比度文字，避免背景图干扰阅读', () => {
    setupDraft('')
    const { getByTestId, getByText, getByRole } = render(
      <DialogueDirectionCard directions={DIRECTIONS} canRegenerate onRegenerate={() => {}} />,
    )

    const card = getByTestId('dialogue-direction-card')
    expect(card.className).toContain('bg-tavern-bg-card')
    expect(card.className).not.toContain('bg-tavern-bg-card/70')
    expect(getByText('选择下一步方向').className).toContain('text-tavern-text')
    expect(getByText(DIRECTIONS[0].content).className).toContain('text-tavern-text-soft')
    expect(getByRole('button', { name: /换一批/ }).className).toContain('text-tavern-text-soft')
  })

  it('将换一批按钮放在标题栏右侧，不再占用底部行', () => {
    setupDraft('')
    const { getByTestId, getByRole } = render(
      <DialogueDirectionCard directions={DIRECTIONS} canRegenerate onRegenerate={() => {}} />,
    )

    const header = getByTestId('dialogue-direction-header')
    expect(header).toContainElement(getByRole('button', { name: /换一批/ }))
    expect(header.className).toContain('justify-between')
  })

  it('草稿非空时先内联确认，取消不覆盖', () => {
    const { setDraft } = setupDraft('我正在写别的')
    const { getByRole, getByText } = render(
      <DialogueDirectionCard directions={DIRECTIONS} canRegenerate onRegenerate={() => {}} />,
    )

    fireEvent.click(getByRole('button', { name: /寻找其他入口/ }))
    expect(getByText('将覆盖当前草稿')).toBeTruthy()
    expect(setDraft).not.toHaveBeenCalled()

    fireEvent.click(getByRole('button', { name: '取消' }))
    expect(setDraft).not.toHaveBeenCalled()

    fireEvent.click(getByRole('button', { name: /寻找其他入口/ }))
    fireEvent.click(getByRole('button', { name: '替换' }))
    expect(setDraft).toHaveBeenCalledWith(DIRECTIONS[1].content)
  })

  it('换一批调用回调并清空选择态', async () => {
    const onRegenerate = vi.fn().mockResolvedValue(undefined)
    setupDraft('')
    const { getByRole } = render(
      <DialogueDirectionCard directions={DIRECTIONS} canRegenerate onRegenerate={onRegenerate} />,
    )

    fireEvent.click(getByRole('button', { name: /追问封锁原因/ }))
    expect(getByRole('button', { name: /追问封锁原因/ }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(getByRole('button', { name: /换一批/ }))
    await waitFor(() => expect(onRegenerate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(getByRole('button', { name: /追问封锁原因/ }).getAttribute('aria-pressed')).toBe('false'))
  })

  it('不可换一批时不显示换一批按钮', () => {
    setupDraft('')
    const { queryByRole } = render(
      <DialogueDirectionCard directions={DIRECTIONS} canRegenerate={false} onRegenerate={() => {}} />,
    )
    expect(queryByRole('button', { name: /换一批/ })).toBeNull()
  })
})

describe('shouldShowDialogueDirections', () => {
  const base = { role: 'assistant', content: '港口已经封锁。', dialogueDirections: DIRECTIONS }

  it('开启开关、非流式且方向存在时展示（含历史消息）', () => {
    expect(shouldShowDialogueDirections({ message: base, character, isStreaming: false, isSystem: false, enabled: true })).toBe(true)
  })

  it('开关关闭 / 流式中 / 无方向时不展示', () => {
    expect(shouldShowDialogueDirections({ message: base, character, isStreaming: false, isSystem: false, enabled: false })).toBe(false)
    expect(shouldShowDialogueDirections({ message: base, character, isStreaming: true, isSystem: false, enabled: true })).toBe(false)
    expect(shouldShowDialogueDirections({ message: { ...base, dialogueDirections: [] }, character, isStreaming: false, isSystem: false, enabled: true })).toBe(false)
  })

  it('用户消息与空正文不展示', () => {
    expect(shouldShowDialogueDirections({ message: { ...base, role: 'user' }, character, isStreaming: false, isSystem: false, enabled: true })).toBe(false)
    expect(shouldShowDialogueDirections({ message: { ...base, content: '' }, character, isStreaming: false, isSystem: false, enabled: true })).toBe(false)
  })
})
