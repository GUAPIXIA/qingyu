import { fireEvent, render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorldStatePanel } from '../WorldStatePanel'

describe('WorldStatePanel', () => {
  it('激活状态不显示边框或内描边', () => {
    const { getByRole } = render(
      <WorldStatePanel
        open
        onToggle={() => {}}
        session={{ id: 's1', memoryEnabled: true }}
        onSaveWorldState={() => {}}
        isStreaming={false}
      />,
    )

    const trigger = getByRole('button', { name: '世界状态' })
    expect(trigger.className).toContain('border-transparent')
    expect(trigger.className).not.toContain('ring-inset')
  })

  it('关闭状态使用不透明底色和清晰的次要文字色', () => {
    const { getByRole } = render(
      <WorldStatePanel
        open={false}
        onToggle={() => {}}
        session={{ id: 's1', memoryEnabled: true }}
        onSaveWorldState={() => {}}
        isStreaming={false}
      />,
    )

    const trigger = getByRole('button', { name: '世界状态' })
    expect(trigger.className).toContain('bg-tavern-bg-card')
    expect(trigger.className).not.toContain('bg-tavern-bg-card/70')
    expect(trigger.className).toContain('text-tavern-text-soft')
  })

  it('编辑并保存世界状态', async () => {
    const onSaveWorldState = vi.fn().mockResolvedValue(undefined)
    const { getByLabelText, getByRole } = render(
      <WorldStatePanel
        open
        onToggle={() => {}}
        session={{ id: 's1', memoryEnabled: true, memoryCurrentState: '旧局势' }}
        onSaveWorldState={onSaveWorldState}
        isStreaming={false}
      />,
    )

    fireEvent.change(getByLabelText('当前局势'), { target: { value: '新局势' } })
    fireEvent.click(getByRole('button', { name: '保存世界状态' }))
    await waitFor(() => expect(onSaveWorldState).toHaveBeenCalledWith('新局势'))
  })

  it('展示活跃事实，且不再提供游戏主持开关', () => {
    const { getByText, queryByRole } = render(
      <WorldStatePanel
        open
        onToggle={() => {}}
        session={{ id: 's1', memoryEnabled: true, memoryFacts: ['北门已经封锁'] }}
        onSaveWorldState={() => {}}
        isStreaming={false}
      />,
    )

    expect(getByText('北门已经封锁')).toBeTruthy()
    expect(queryByRole('switch', { name: '游戏主持格式' })).toBeNull()
  })
})
