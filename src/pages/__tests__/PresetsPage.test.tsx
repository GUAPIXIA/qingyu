/**
 * PresetsPage 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Preset } from '../../../shared/types'
import { useSettingsStore } from '../../store/useSettingsStore'
import { getDefaultSettings } from '../../../shared/defaults'
const defaultAI = window.api.ai

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
    ai: defaultAI,
    preset: {
      list: vi.fn(async () => []),
      save: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      importJson: vi.fn(async () => null),
      exportJson: vi.fn(async () => ({ ok: true })),
      getBuiltin: vi.fn(async () => []),
    },
  },
})

import { PresetsPage } from '../PresetsPage'

describe('PresetsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ settings: { ...getDefaultSettings(), activeProfileId: 'p1', connectionProfiles: [{ id: 'p1', name: 'test', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fixture', model: 'gpt-4o', maxContext: 8192 }] }, credentials: {} })
  })

  it.each(['编辑', '切换'])('预设生成期间%s，旧结果不覆盖当前预设', async action => {
    const preset = (id: string): Preset => ({ id, name: id, description: '', systemPrompt: '原提示', jailbreak: '', temperature: 0.8, topP: 0.95, maxTokens: 1024, maxContext: 8192, frequencyPenalty: 0, presencePenalty: 0, isBuiltin: false })
    vi.mocked(window.api.preset.list).mockResolvedValueOnce([preset('预设一'), preset('预设二')])
    let chunk: Parameters<typeof window.api.ai.onChunk>[0] = () => {}
    let done: Parameters<typeof window.api.ai.onComplete>[0] = () => {}
    vi.mocked(window.api.ai.onChunk).mockImplementation(cb => { chunk = cb; return vi.fn() })
    vi.mocked(window.api.ai.onComplete).mockImplementation(cb => { done = cb; return vi.fn() })
    render(<PresetsPage />)
    fireEvent.click(await screen.findByText('预设一'))
    fireEvent.click(screen.getByText('AI 生成预设'))
    fireEvent.change(screen.getByPlaceholderText(/描述你想要的预设风格/), { target: { value: '古风' } })
    fireEvent.click(screen.getByRole('button', { name: '生成预设' }))
    await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledOnce())
    const requestId = vi.mocked(window.api.ai.chat).mock.calls[0][0].requestId
    if (action === '编辑') fireEvent.change(screen.getByPlaceholderText('系统提示词...'), { target: { value: '用户新提示' } })
    else { fireEvent.click(screen.getAllByRole('button', { name: '关闭' })[0]); fireEvent.click(screen.getByText('预设二')) }
    await act(async () => { chunk({ requestId, text: '【SystemPrompt】\n旧提示建议' }); done({ requestId, finishReason: 'stop' }) })
    expect(screen.getByPlaceholderText('系统提示词...')).toHaveValue(action === '编辑' ? '用户新提示' : '原提示')
    if (action === '编辑') expect(screen.getByDisplayValue(/旧提示建议/)).toBeInTheDocument()
    else expect(window.api.ai.cancelChat).toHaveBeenCalledWith(requestId)
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

  it('导入标准格式后显示转换结果与未支持字段', async () => {
    vi.mocked(window.api.preset.importJson).mockResolvedValueOnce({
      sourceFormat: 'standard',
      unsupportedFields: ['top_k', 'min_p'],
      preset: {
        id: 'imported-1',
        name: 'Deepseek_V3_Preset_通用轻量版',
        description: '',
        systemPrompt: '提示词',
        jailbreak: '',
        maxContext: 0,
        temperature: 0.75,
        topP: 0.99,
        maxTokens: 1024,
        frequencyPenalty: 1.1,
        presencePenalty: 1.1,
        isBuiltin: false,
      },
    })

    render(<PresetsPage />)
    await waitFor(() => expect(window.api.preset.list).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: /导入/ })[0])

    const notice = await screen.findByRole('status')
    expect(notice.textContent).toContain('已转换标准格式')
    expect(notice.textContent).toContain('top_k、min_p')
  })
})
