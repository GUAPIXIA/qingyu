/**
 * PresetsPage 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Preset } from '../../../shared/types'

vi.mock('react-router-dom', () => ({
  useNavigate: vi.fn(() => vi.fn()),
}))

vi.mock('../../lib/logger', () => ({
  logError: vi.fn(),
}))

vi.mock('../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

Object.defineProperty(window, 'api', {
  value: {
    preset: {
      list: vi.fn(async () => []),
      save: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      getBuiltin: vi.fn(async () => []),
    },
  },
})

import { PresetsPage } from '../PresetsPage'

describe('PresetsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('渲染页面', async () => {
    const { container } = render(<PresetsPage />)
    await waitFor(() => expect(window.api.preset.list).toHaveBeenCalled())
    expect(container).toBeDefined()
  })

  it('不同 group 的预设显示在同一个列表，编辑表单不再提供分组字段', async () => {
    const makePreset = (id: string, name: string, group: string): Preset => ({
      id,
      name,
      group,
      description: `${name}描述`,
      systemPrompt: '',
      jailbreak: '',
      maxContext: 0,
      temperature: 0.8,
      topP: 0.95,
      maxTokens: 1024,
      frequencyPenalty: 0,
      presencePenalty: 0,
      isBuiltin: false,
    })
    vi.mocked(window.api.preset.list).mockResolvedValueOnce([
      makePreset('preset-1', '预设一', '通用'),
      makePreset('preset-2', '预设二', '风格特化'),
    ])

    render(<PresetsPage />)
    const firstPreset = await screen.findByText('预设一')
    expect(screen.getByText('预设二')).toBeTruthy()
    expect(screen.queryByText('通用')).toBeNull()
    expect(screen.queryByText('风格特化')).toBeNull()

    fireEvent.click(firstPreset)
    expect(screen.queryByText('分组')).toBeNull()
  })
})
