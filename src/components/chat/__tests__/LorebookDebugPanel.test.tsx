import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { LorebookDiagnostics } from '../../../utils/lorebook'
import { LorebookDebugPanel } from '../LorebookDebugPanel'

function makeDiagnostics(mode: 'live' | 'preview', name: string): LorebookDiagnostics {
  return {
    mode,
    generationType: 'normal',
    createdAt: 1,
    summary: {
      activeBooks: 1,
      enabledEntries: 2,
      matchedEntries: 1,
      injectedEntries: 1,
      summaryEntries: 0,
      compressionEntries: 0,
      droppedEntries: 0,
      untriggeredEntries: 1,
      semanticDeadEntries: 1,
      budget: 1500,
      usedTokens: 214,
      ignoredBudgetTokens: 0,
      bookBudgetDropped: 0,
      globalBudgetDropped: 0,
    },
    semantic: { enabled: false, candidateCount: 0, source: 'current_cache' },
    retrieval: { lexicalProvider: 'local.lexical.unicode-bigram-v1', lexicalCandidateCount: 0, vectorCandidateCount: 0, embeddingsAvailable: false },
    scan: { rawText: '王城', cleanedText: '王城', messageCount: 1 },
    entries: [
      {
        key: `lb:hit-${mode}`,
        bookId: 'lb',
        bookName: '王国设定',
        entryId: `hit-${mode}`,
        name,
        outcome: 'injected',
        stage: 'injection',
        activationSource: 'keyword',
        score: 0.83,
        keywordHits: 0.42,
        semanticScore: 0.21,
        semanticSource: 'approx',
        entityHit: true,
        recencyHit: false,
        matchedKeywords: [{ keyword: '王城', count: 3, channel: 'primary' }],
        position: 'before_char',
        priority: 'conditional',
        scanText: '王城',
        originalTokens: 214,
        injectedTokens: 214,
        adapterId: 'sillytavern.world-info',
        retrievalMode: 'hybrid',
        renderStatus: 'exact',
        renderTarget: 'before_character',
      },
      {
        key: `lb:dead-${mode}`,
        bookId: 'lb',
        bookName: '王国设定',
        entryId: `dead-${mode}`,
        name: '纯语义条目',
        outcome: 'not_triggered',
        stage: 'matching',
        reason: 'semantic_unavailable',
        semanticSource: 'none',
        position: 'after_char',
        priority: 'conditional',
      },
    ],
  }
}

describe('LorebookDebugPanel', () => {
  it('默认展示上一轮实况，并可切换到稳定模拟结果', () => {
    render(
      <LorebookDebugPanel
        live={makeDiagnostics('live', '真实王城设定')}
        preview={makeDiagnostics('preview', '模拟王城设定')}
      />,
    )

    expect(screen.getByText('真实王城设定')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '当前模拟' }))
    expect(screen.getByText('模拟王城设定')).toBeInTheDocument()
    expect(screen.getByText(/使用稳定随机数/)).toBeInTheDocument()
  })

  it('展开条目可查看 adapter、retrieval 与 renderer 决策', () => {
    render(<LorebookDebugPanel live={makeDiagnostics('live', '真实王城设定')} preview={null} />)
    fireEvent.click(screen.getByRole('button', { name: /真实王城设定/ }))
    expect(screen.getByText('sillytavern.world-info')).toBeInTheDocument()
    expect(screen.getByText('hybrid')).toBeInTheDocument()
    expect(screen.getByText('before_character')).toBeInTheDocument()
    expect(screen.getByText('精确')).toBeInTheDocument()
  })

  it('可筛选未触发条目并展开查看原因', () => {
    render(<LorebookDebugPanel live={null} preview={makeDiagnostics('preview', '模拟王城设定')} />)
    fireEvent.click(screen.getByRole('button', { name: /未触发 1/ }))
    expect(screen.queryByText('模拟王城设定')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /纯语义条目/ }))
    expect(screen.getAllByText('仅依赖语义，但语义触发不可用').length).toBeGreaterThan(0)
  })

  it('词法兜底条目在列表行标注，展开可见通道与兜底原因（阶段4）', () => {
    const diagnostics = makeDiagnostics('live', '星陨峡谷设定')
    diagnostics.entries[0] = {
      ...diagnostics.entries[0],
      activationSource: 'lexical',
      lexicalRank: 1,
      lexicalScore: 0.312,
      fusionScore: 0.428,
      fallbackReason: 'lexical_fallback',
    }
    render(<LorebookDebugPanel live={diagnostics} preview={null} />)

    // 折叠行：标注「词法兜底」
    expect(screen.getAllByText(/词法兜底/).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /星陨峡谷设定/ }))
    expect(screen.getByText('词法')).toBeInTheDocument()
    expect(screen.getByText('本地词法兜底（embeddings 不可用）')).toBeInTheDocument()
    expect(screen.getByText('#1 · 0.312')).toBeInTheDocument()
    expect(screen.getByText('0.428')).toBeInTheDocument()
  })

  it('向量未召回由词法补位时展示 vector_miss_lexical_fallback 原因（阶段4）', () => {
    const diagnostics = makeDiagnostics('live', '星陨峡谷设定')
    diagnostics.entries[0] = {
      ...diagnostics.entries[0],
      activationSource: 'lexical',
      fallbackReason: 'vector_miss_lexical_fallback',
    }
    render(<LorebookDebugPanel live={diagnostics} preview={null} />)
    fireEvent.click(screen.getByRole('button', { name: /星陨峡谷设定/ }))
    expect(screen.getByText('本地词法兜底（向量未召回）')).toBeInTheDocument()
  })
})
