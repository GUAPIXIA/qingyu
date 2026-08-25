import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MemoryPanel } from '../MemoryPanel'

function renderPanel(overrides: Partial<React.ComponentProps<typeof MemoryPanel>> = {}) {
  const props: React.ComponentProps<typeof MemoryPanel> = {
    open: true,
    onToggle: vi.fn(),
    sessions: [{
      id: 'session-1',
      memoryEnabled: true,
      memoryMode: 'auto',
      autoMemoryInterval: 10,
      memory: '用户正在寻找失落的钥匙。',
      memoryFacts: [],
      memoryFactHistory: [],
    }],
    currentSessionId: 'session-1',
    currentCharacterId: 'character-1',
    memoryInterval: 10,
    onMemoryIntervalChange: vi.fn(),
    onToggleMemory: vi.fn(),
    onSetMemoryMode: vi.fn(),
    onUpdateMemoryFacts: vi.fn().mockResolvedValue(undefined),
    onTriggerSummary: vi.fn(),
    isStreaming: false,
    memoryStats: { totalMessages: 12, totalChars: 3456, durationStr: '8分钟' },
    ...overrides,
  }
  render(<MemoryPanel {...props} />)
  return props
}

describe('MemoryPanel', () => {
  it('长记忆开启时用图标颜色表达状态，不显示常驻圆点', () => {
    renderPanel({ open: false })
    const trigger = screen.getByRole('button', { name: '长记忆设置' })

    expect(trigger.className.split(/\s+/)).toContain('text-tavern-accent')
    expect(trigger.querySelector('span')).toBeNull()
  })

  it('清楚展示当前状态、摘要和统计信息', () => {
    renderPanel()

    expect(screen.getByRole('dialog', { name: '长记忆设置' })).toBeTruthy()
    expect(screen.getByText('自动 · 每 10 条总结')).toBeTruthy()
    expect(screen.getByText('用户正在寻找失落的钥匙。')).toBeTruthy()
    expect(screen.getByText('3,456')).toBeTruthy()
  })

  it('可切换总开关和总结方式', () => {
    const props = renderPanel()

    fireEvent.click(screen.getByRole('switch', { name: '启用长记忆' }))
    expect(props.onToggleMemory).toHaveBeenCalledWith(false)

    fireEvent.click(screen.getByRole('button', { name: /手动/ }))
    expect(props.onSetMemoryMode).toHaveBeenCalledWith('manual', 10)
  })

  it('快捷间隔同时更新输入值和会话设置', () => {
    const props = renderPanel()

    fireEvent.click(screen.getByRole('button', { name: '20 条' }))
    expect(props.onMemoryIntervalChange).toHaveBeenCalledWith(20)
    expect(props.onSetMemoryMode).toHaveBeenCalledWith('auto', 20)
  })

  it('未启用长记忆或正在回复时不可立即总结', () => {
    const { rerender } = render(
      <MemoryPanel
        {...renderPanelDefaults}
        sessions={[{ id: 'session-1', memoryEnabled: false, memoryMode: 'manual' }]}
      />
    )

    expect(screen.getByRole('button', { name: '立即总结当前对话' })).toBeDisabled()

    rerender(<MemoryPanel {...renderPanelDefaults} isStreaming />)
    expect(screen.getByRole('button', { name: '回复完成后可总结' })).toBeDisabled()
  })

  it('可添加纯文本关键事实', async () => {
    const onUpdateMemoryFacts = vi.fn().mockResolvedValue(undefined)
    renderPanel({
      sessions: [{ id: 'session-1', memoryEnabled: true, memoryMode: 'manual', memoryFacts: ['已有事实'] }],
      onUpdateMemoryFacts,
    })

    fireEvent.click(screen.getByRole('button', { name: '添加关键事实' }))
    fireEvent.change(screen.getByRole('textbox', { name: '新增关键事实' }), {
      target: { value: '用户害怕密闭空间' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存事实' }))

    await waitFor(() => {
      expect(onUpdateMemoryFacts).toHaveBeenCalledWith(['已有事实', '用户害怕密闭空间'])
    })
  })

  it('编辑结构化事实时保留元数据', async () => {
    const onUpdateMemoryFacts = vi.fn().mockResolvedValue(undefined)
    const fact = {
      id: 'fact-1',
      subject: '用户',
      predicate: '目的地',
      value: '旧矿坑',
      status: 'active' as const,
      importance: 5 as const,
      confidence: 0.9,
      sourceMessageIds: ['message-1'],
      updatedAt: 1,
    }
    renderPanel({
      sessions: [{ id: 'session-1', memoryEnabled: true, memoryMode: 'manual', memoryFacts: [fact] }],
      onUpdateMemoryFacts,
    })

    fireEvent.click(screen.getByRole('button', { name: '编辑事实 1' }))
    fireEvent.change(screen.getByRole('textbox', { name: '事实内容' }), {
      target: { value: '雪山营地' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => {
      expect(onUpdateMemoryFacts).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'fact-1',
          subject: '用户',
          predicate: '目的地',
          value: '雪山营地',
          importance: 5,
          confidence: 0.9,
          sourceMessageIds: ['message-1'],
          updatedAt: expect.any(Number),
        }),
      ])
    })
  })
})

const renderPanelDefaults: React.ComponentProps<typeof MemoryPanel> = {
  open: true,
  onToggle: vi.fn(),
  sessions: [{ id: 'session-1', memoryEnabled: true, memoryMode: 'auto' }],
  currentSessionId: 'session-1',
  currentCharacterId: 'character-1',
  memoryInterval: 10,
  onMemoryIntervalChange: vi.fn(),
  onToggleMemory: vi.fn(),
  onSetMemoryMode: vi.fn(),
  onUpdateMemoryFacts: vi.fn().mockResolvedValue(undefined),
  onTriggerSummary: vi.fn(),
  isStreaming: false,
  memoryStats: null,
}
