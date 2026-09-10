import { fireEvent, render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorldStatePanel } from '../WorldStatePanel'

describe('WorldStatePanel', () => {
  it('编辑并保存世界状态', async () => {
    const onSaveWorldState = vi.fn().mockResolvedValue(undefined)
    const { getByLabelText, getByRole } = render(
      <WorldStatePanel
        open
        onToggle={() => {}}
        session={{ id: 's1', memoryEnabled: true, memoryCurrentState: '旧局势' }}
        onSaveWorldState={onSaveWorldState}
        onSetGameMasterMode={() => {}}
        isStreaming={false}
      />,
    )

    fireEvent.change(getByLabelText('当前局势'), { target: { value: '新局势' } })
    fireEvent.click(getByRole('button', { name: '保存世界状态' }))
    await waitFor(() => expect(onSaveWorldState).toHaveBeenCalledWith('新局势'))
  })

  it('可独立开启游戏主持格式并展示活跃事实', () => {
    const onSetGameMasterMode = vi.fn()
    const { getByRole, getByText } = render(
      <WorldStatePanel
        open
        onToggle={() => {}}
        session={{ id: 's1', memoryEnabled: true, memoryFacts: ['北门已经封锁'] }}
        onSaveWorldState={() => {}}
        onSetGameMasterMode={onSetGameMasterMode}
        isStreaming={false}
      />,
    )

    fireEvent.click(getByRole('switch', { name: '游戏主持格式' }))
    expect(onSetGameMasterMode).toHaveBeenCalledWith(true)
    expect(getByText('北门已经封锁')).toBeTruthy()
  })
})
