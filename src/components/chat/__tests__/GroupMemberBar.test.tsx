import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { GroupMemberBar } from '../GroupMemberBar'
import { useCharacterStore } from '../../../store/useCharacterStore'
import type { Character } from '../../../../shared/types'

// UEX-P1-12：群调度条——生成中显示/说话者与 x/N/停剩余

function createCharacter(id: string, name: string): Character {
  return {
    id,
    name,
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
}

describe('GroupMemberBar（UEX-P1-12 群调度条）', () => {
  const onStopRemaining = vi.fn()

  beforeEach(() => {
    useCharacterStore.setState({
      characters: [
        createCharacter('c1', '爱丽丝'),
        createCharacter('c2', '布洛妮娅'),
        createCharacter('c3', '德丽莎'),
      ],
    })
    vi.clearAllMocks()
  })

  it('仅生成中显示：非生成中整条收起，避免常态噪声', () => {
    const { container, rerender } = render(
      <GroupMemberBar
        memberIds={['c1', 'c2', 'c3']}
        currentStreamingCharId={null}
        isStreaming={false}
        onStopRemaining={onStopRemaining}
      />,
    )
    expect(container.querySelector('[data-testid="group-member-bar"]')).toBeNull()

    rerender(
      <GroupMemberBar
        memberIds={['c1', 'c2', 'c3']}
        currentStreamingCharId="c1"
        isStreaming
        onStopRemaining={onStopRemaining}
      />,
    )
    expect(screen.getByTestId('group-member-bar')).toBeTruthy()
  })

  it('生成中显示当前说话者与接力进度 x/N（成员序号口径）', () => {
    render(
      <GroupMemberBar
        memberIds={['c1', 'c2', 'c3']}
        currentStreamingCharId="c2"
        isStreaming
        onStopRemaining={onStopRemaining}
      />,
    )
    expect(screen.getByTestId('group-member-bar-speaker').textContent).toBe('当前说话者 布洛妮娅')
    expect(screen.getByTestId('group-member-bar-progress').textContent).toBe('2/3')
  })

  it('当前说话者在成员接力队列中高亮，其余成员不高亮', () => {
    render(
      <GroupMemberBar
        memberIds={['c1', 'c2', 'c3']}
        currentStreamingCharId="c3"
        isStreaming
        onStopRemaining={onStopRemaining}
      />,
    )
    const chips = screen.getAllByTestId('group-member-bar-member')
    expect(chips.map((chip) => chip.getAttribute('data-current'))).toEqual(['false', 'false', 'true'])
    // 序号圆点与 x/N 同口径（1 起）
    expect(chips[2].textContent).toContain('3')
    expect(chips[2].textContent).toContain('德丽莎')
    expect(screen.getByTestId('group-member-bar-progress').textContent).toBe('3/3')
  })

  it('接力间隙（无当前说话者）显示等待文案，进度回落 0/N', () => {
    render(
      <GroupMemberBar
        memberIds={['c1', 'c2', 'c3']}
        currentStreamingCharId={null}
        isStreaming
        onStopRemaining={onStopRemaining}
      />,
    )
    expect(screen.getByTestId('group-member-bar-speaker').textContent).toBe('等待下一位发言')
    expect(screen.getByTestId('group-member-bar-progress').textContent).toBe('0/3')
  })

  it('「停剩余」点击调用停止动作，title 注明保留已生成内容', () => {
    render(
      <GroupMemberBar
        memberIds={['c1', 'c2']}
        currentStreamingCharId="c1"
        isStreaming
        onStopRemaining={onStopRemaining}
      />,
    )
    const button = screen.getByRole('button', { name: '停剩余' })
    expect(button.getAttribute('title')).toBe('停止后续成员接力，保留已生成内容')
    fireEvent.click(button)
    expect(onStopRemaining).toHaveBeenCalledTimes(1)
  })
})
