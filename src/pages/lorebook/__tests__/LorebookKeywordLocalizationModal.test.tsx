import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import type { Lorebook } from '../../../../shared/types'
import type { ActiveProfile } from '../../../store/useSettingsStore'
import { appendLocalizedKeywords } from '../../../utils/lorebookLocalization'
import { LorebookKeywordLocalizationModal } from '../LorebookKeywordLocalizationModal'

const lorebook: Lorebook = {
  id: 'book-1',
  name: 'Kingdom Lore',
  description: '',
  enabled: true,
  scanDepth: 4,
  entries: [{
    id: 'entry-1',
    keywords: ['royal palace'],
    content: 'The royal palace stands in the capital.',
    position: 'before_char',
    order: 100,
    probability: 100,
    enabled: true,
    matchMode: 'keyword',
  }],
}

const profile: ActiveProfile = {
  name: 'Test',
  provider: 'openai',
  apiKey: 'sk-test',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-4o',
  maxContext: 8192,
}

describe('LorebookKeywordLocalizationModal', () => {
  beforeEach(() => {
    vi.mocked(window.api.ai.localizeLorebookKeywords).mockReset()
    vi.mocked(window.api.ai.localizeLorebookKeywords).mockResolvedValue({
      suggestions: [{ entryId: 'entry-1', aliases: ['王宫', '皇宫'] }],
    })
  })

  it('自动生成预览，确认后只提交选中的中文触发词', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined)
    render(
      <LorebookKeywordLocalizationModal
        lorebook={lorebook}
        profile={profile}
        model="gpt-4o"
        onApply={onApply}
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText('+ 王宫')).toBeInTheDocument()
    expect(screen.getByText('+ 皇宫')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '追加 2 个触发词' }))

    await waitFor(() => expect(onApply).toHaveBeenCalledWith([
      { entryId: 'entry-1', aliases: ['王宫', '皇宫'] },
    ]))
  })

  it('React 严格模式下仍会完成首次生成', async () => {
    render(
      <StrictMode>
        <LorebookKeywordLocalizationModal
          lorebook={lorebook}
          profile={profile}
          model="gpt-4o"
          onApply={vi.fn()}
          onClose={vi.fn()}
        />
      </StrictMode>,
    )

    expect(await screen.findByText('+ 王宫')).toBeInTheDocument()
    expect(window.api.ai.localizeLorebookKeywords).toHaveBeenCalledTimes(1)
  })

  it('大型世界书最多并行两批，任一批完成就立即更新进度', async () => {
    const largeLorebook: Lorebook = {
      ...lorebook,
      entries: Array.from({ length: 21 }, (_, index) => ({
        ...lorebook.entries[0],
        id: `entry-${index}`,
        keywords: [`english keyword ${index}`],
      })),
    }
    const resolvers: Array<(value: { suggestions: [] }) => void> = []
    vi.mocked(window.api.ai.localizeLorebookKeywords).mockImplementation(() => new Promise((resolve) => {
      resolvers.push(resolve)
    }))

    render(
      <LorebookKeywordLocalizationModal
        lorebook={largeLorebook}
        profile={profile}
        model="gpt-4o"
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => expect(window.api.ai.localizeLorebookKeywords).toHaveBeenCalledTimes(2))
    await act(async () => resolvers[0]({ suggestions: [] }))
    await waitFor(() => expect(window.api.ai.localizeLorebookKeywords).toHaveBeenCalledTimes(3))
    expect(screen.getByText('10 / 21')).toBeInTheDocument()
  })

  it('没有聊天连接时明确说明不需要语义索引', async () => {
    render(
      <LorebookKeywordLocalizationModal
        lorebook={lorebook}
        profile={null}
        model=""
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText(/使用普通聊天模型，不需要语义索引/)).toBeInTheDocument()
    expect(window.api.ai.localizeLorebookKeywords).not.toHaveBeenCalled()
  })

  it('enrich 模式处理全部条目（含纯中文）并以 mode=enrich 调用（阶段4 enrichment 管线）', async () => {
    vi.mocked(window.api.ai.localizeLorebookKeywords).mockResolvedValue({
      suggestions: [{
        entryId: 'entry-1',
        aliases: ['星陨神社', 'Starfall Shrine'],
        source: { provider: 'openai', model: 'gpt-4o', generatedAt: 1770000000000, mode: 'enrich' },
      }],
    })
    const chineseLorebook: Lorebook = {
      ...lorebook,
      entries: [{
        id: 'entry-1',
        keywords: ['神社'],
        content: '北境的古老神社与陨星传说。',
        position: 'before_char',
        order: 100,
        probability: 100,
        enabled: true,
        matchMode: 'keyword',
      }],
    }

    render(
      <LorebookKeywordLocalizationModal
        lorebook={chineseLorebook}
        profile={profile}
        model="gpt-4o"
        mode="enrich"
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText('+ 星陨神社')).toBeInTheDocument()
    expect(screen.getByText('+ Starfall Shrine')).toBeInTheDocument()
    // 生成来源展示
    expect(screen.getByText(/由 gpt-4o 生成/)).toBeInTheDocument()
    expect(window.api.ai.localizeLorebookKeywords).toHaveBeenCalledWith(expect.objectContaining({ mode: 'enrich' }))
  })
})

describe('appendLocalizedKeywords', () => {
  it('保留英文原词并去重追加中文别名', () => {
    const updated = appendLocalizedKeywords(lorebook, [{
      entryId: 'entry-1',
      aliases: ['王宫', '王宫', '皇宫'],
    }])

    expect(updated[0].keywords).toEqual(['royal palace', '王宫', '皇宫'])
  })

  it('携带来源元数据时为追加的别名写入 keywordProvenance（方案 7.5）', () => {
    const updated = appendLocalizedKeywords(lorebook, [{
      entryId: 'entry-1',
      aliases: ['王宫', '皇宫'],
      source: { provider: 'openai', model: 'gpt-4o', generatedAt: 1770000000000, mode: 'localize' },
    }])

    expect(updated[0].keywordProvenance).toEqual({
      王宫: { provider: 'openai', model: 'gpt-4o', generatedAt: 1770000000000, mode: 'localize' },
      皇宫: { provider: 'openai', model: 'gpt-4o', generatedAt: 1770000000000, mode: 'localize' },
    })
  })

  it('无来源元数据时不写入 keywordProvenance（旧行为兼容）', () => {
    const updated = appendLocalizedKeywords(lorebook, [{
      entryId: 'entry-1',
      aliases: ['王宫'],
    }])

    expect(updated[0].keywords).toEqual(['royal palace', '王宫'])
    expect(updated[0].keywordProvenance).toBeUndefined()
  })
})
