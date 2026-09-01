import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { Lorebook, LoreEntry } from '../../../../shared/types'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { LorebookEntryTriggerTester } from '../LorebookEntryTriggerTester'

const entry: LoreEntry = {
  id: 'entry-1',
  keywords: ['王城'],
  secondaryKeywords: ['贵族'],
  selectiveLogic: 'and_any',
  content: '王城与贵族议会的设定',
  position: 'before_char',
  order: 1,
  probability: 100,
  enabled: true,
  matchMode: 'keyword',
  priority: 'conditional',
}

const lorebook: Lorebook = {
  id: 'book-1',
  name: '王国设定',
  description: '',
  enabled: true,
  scanDepth: 10,
  entries: [entry],
}

describe('LorebookEntryTriggerTester', () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: getDefaultSettings() })
  })

  it('在单条目沙盒中展示关键词和 secondary keys 命中结果', () => {
    render(<LorebookEntryTriggerTester lorebook={lorebook} entry={entry} />)
    fireEvent.click(screen.getByRole('button', { name: /测试此条目/ }))
    fireEvent.change(screen.getByLabelText('模拟对话文本'), { target: { value: '王城的贵族正在开会' } })
    fireEvent.click(screen.getByRole('button', { name: /运行测试/ }))

    expect(screen.getByText('测试通过：该条目会进入上下文')).toBeInTheDocument()
    expect(screen.getByText('王城 ×1')).toBeInTheDocument()
    expect(screen.getByText('贵族 ×1')).toBeInTheDocument()
  })

  it('明确展示二级关键词拦截原因', () => {
    render(<LorebookEntryTriggerTester lorebook={lorebook} entry={entry} />)
    fireEvent.click(screen.getByRole('button', { name: /测试此条目/ }))
    fireEvent.change(screen.getByLabelText('模拟对话文本'), { target: { value: '抵达王城' } })
    fireEvent.click(screen.getByRole('button', { name: /运行测试/ }))

    expect(screen.getByText('本次条件下未触发')).toBeInTheDocument()
    expect(screen.getByText('原因：二级关键词拦截')).toBeInTheDocument()
  })

  it('禁用条目不会被沙盒强制启用', () => {
    render(<LorebookEntryTriggerTester lorebook={lorebook} entry={{ ...entry, enabled: false }} />)
    fireEvent.click(screen.getByRole('button', { name: /测试此条目/ }))
    fireEvent.change(screen.getByLabelText('模拟对话文本'), { target: { value: '王城的贵族' } })
    fireEvent.click(screen.getByRole('button', { name: /运行测试/ }))

    expect(screen.getByText('无法测试：世界书或条目当前未启用')).toBeInTheDocument()
  })

  it('展示 outlet 在普通聊天协议中的 renderer 降级', () => {
    const outletEntry: LoreEntry = {
      ...entry,
      keywords: [],
      priority: 'always',
      position: 'at_end',
      runtime: {
        insertion: { kind: 'outlet', name: 'facts' },
        retrieval: 'keyword',
        adapterId: 'sillytavern.world-info',
      },
    }
    render(<LorebookEntryTriggerTester lorebook={{ ...lorebook, entries: [outletEntry] }} entry={outletEntry} />)
    fireEvent.click(screen.getByRole('button', { name: /测试此条目/ }))
    fireEvent.click(screen.getByRole('button', { name: /运行测试/ }))

    expect(screen.getByText('outlet:facts → prompt_end')).toBeInTheDocument()
    expect(screen.getByText(/渲染降级：当前聊天协议没有命名 outlet/)).toBeInTheDocument()
  })
})
