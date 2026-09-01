import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LorebookImportResult } from '../../../../shared/ipc-api'
import { LorebookImportReportModal } from '../LorebookImportReportModal'

function result(): LorebookImportResult {
  return {
    lorebook: {
      id: 'book-1', name: '导入世界书', description: '', enabled: true, scanDepth: 4,
      entries: [{
        id: 'entry-1', keywords: ['王城'], content: '王城设定', position: 'at_end',
        order: 1, probability: 100, enabled: true,
      }],
    },
    detection: {
      adapterId: 'sillytavern.world-info', formatLabel: 'SillyTavern World Info',
      formatVersion: '2026-07', confidence: 97,
      reasons: ['entries 使用 ST 常见的 uid 键控对象'], conflicts: [],
    },
    report: {
      adapterId: 'sillytavern.world-info', formatLabel: 'SillyTavern World Info',
      formatVersion: '2026-07', status: 'approximated',
      issues: [{
        severity: 'warning', action: 'approximated', code: 'runtime_insertion_fallback',
        path: '$.entries[1].position', message: '插入原意已保留；当前兼容运行时暂时降级到 system 尾部',
      }],
      summary: { mapped: 0, preserved: 2, approximated: 1, dropped: 0, rejected: 0, warnings: 1, errors: 0 },
    },
  }
}

describe('LorebookImportReportModal', () => {
  it('展示格式、置信度、降级摘要和字段路径', () => {
    render(<LorebookImportReportModal result={result()} onClose={() => {}} />)
    expect(screen.getByText(/SillyTavern World Info/)).toBeInTheDocument()
    expect(screen.getByText(/置信度 97%/)).toBeInTheDocument()
    expect(screen.getByText('包含运行时近似')).toBeInTheDocument()
    expect(screen.getByText(/插入原意已保留/)).toBeInTheDocument()
    expect(screen.getByText('$.entries[1].position')).toBeInTheDocument()
  })

  it('完成按钮关闭报告', () => {
    const onClose = vi.fn()
    render(<LorebookImportReportModal result={result()} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
