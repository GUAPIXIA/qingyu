import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/defaults'
import { GenerationPlanningSection } from '../GenerationPlanningSection'

describe('GenerationPlanningSection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('保留生成保护设置，将默认回复长度交给快捷设置', () => {
    const updateSettings = vi.fn()
    render(<GenerationPlanningSection settings={getDefaultSettings()} updateSettings={updateSettings} />)

    expect(screen.queryByRole('radiogroup', { name: '默认回复长度' })).toBeNull()
    expect(screen.getByText(/回复长度可在每个对话的快捷设置中随时调整/)).toBeTruthy()
    expect(screen.getByText('始终开启')).toBeTruthy()
    expect(screen.queryByRole('switch', { name: '连续性保护' })).toBeNull()

    fireEvent.click(screen.getByRole('switch', { name: '自动补全结尾' }))
    expect(updateSettings).toHaveBeenCalledWith({ autoTailRepairEnabled: false })
  })

  it('高级诊断只展示脱敏数值并可重置当前端点探测', async () => {
    const settings = getDefaultSettings()
    settings.connectionProfiles = [{
      id: 'p1', name: '主连接', provider: 'openai', baseUrl: 'https://user:pass@example.com/v1?key=secret',
      model: 'o3-mini', apiKey: 'sk-top-secret', maxContext: 0,
    }]
    settings.activeProfileId = 'p1'
    settings.activeModel = 'o3-mini'
    vi.mocked(window.api.ai.getGenerationDiagnostics).mockResolvedValueOnce({
      modelProfile: { outputLimit: 32768, contextLimit: 200000, reasoningMode: 'shared-unknown', source: 'exact', confidence: 'high' },
      gateProbe: { knob: 'reasoning-effort', knobAccepted: true, updatedAt: 1 },
      usageBuckets: [],
      lastRequest: {
        ts: 1, taskType: 'main', requestedMaxTokens: 4096,
        plannedBodyTokens: 846, plannedReasoningTokens: 3072,
        bodyVisibleChars: 500, completionTokens: 1100, reasoningTokens: 700,
        attempts: 1, downgradeRetry: false, earlyAbort: false,
        finishReason: 'stop', outcome: 'completed', durationMs: 1000,
      },
      observationStore: { loaded: true, keys: 1, scannedRecords: 2, skippedLines: 0 },
    })
    render(<GenerationPlanningSection settings={settings} updateSettings={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /高级能力与诊断/ }))

    await waitFor(() => expect(window.api.ai.getGenerationDiagnostics).toHaveBeenCalled())
    expect(screen.getByText('内置精确档案')).toBeTruthy()
    expect(screen.getByText('计划正文')).toBeTruthy()
    expect(screen.getByText('实际推理')).toBeTruthy()
    expect(screen.queryByText(/sk-top-secret|user:pass|example\.com|secret/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重置探测' }))
    await waitFor(() => expect(window.api.ai.resetGenerationGateProbe).toHaveBeenCalledWith({
      provider: 'openai', baseUrl: settings.connectionProfiles[0].baseUrl, model: 'o3-mini',
    }))
  })
})
