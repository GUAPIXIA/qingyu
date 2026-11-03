import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LorebookFormatChoicePending } from '../../../../shared/ipc-api'
import { LorebookFormatChoiceModal } from '../LorebookFormatChoiceModal'

function choice(): LorebookFormatChoicePending {
  return {
    needsFormatChoice: true,
    pendingId: 'pending-qa-1',
    fileName: 'ambiguous-lorebook.json',
    candidates: [
      { adapterId: 'sillytavern.world-info', formatLabel: 'SillyTavern 世界书', confidence: 62 },
      { adapterId: 'generic.json', formatLabel: '通用 JSON（需映射向导）', confidence: 30 },
    ],
  }
}

describe('LorebookFormatChoiceModal', () => {
  it('浅色主题警示条使用可读的琥珀文字并提供暗色变体（回归 R-01）', () => {
    render(<LorebookFormatChoiceModal choice={choice()} onConfirm={() => {}} onCancel={() => {}} />)

    const banner = screen.getByText(/的特征同时接近多种世界书格式/).closest('div')
    expect(banner).not.toBeNull()
    expect(banner?.className).toContain('text-amber-700')
    expect(banner?.className).toContain('dark:text-amber-200')
    expect(banner?.className).not.toContain('text-amber-100')
  })

  it('默认选中第一个候选，切换候选后按所选格式导入', () => {
    const onConfirm = vi.fn()
    render(<LorebookFormatChoiceModal choice={choice()} onConfirm={onConfirm} onCancel={() => {}} />)

    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    expect((radios[0] as HTMLInputElement).checked).toBe(true)

    fireEvent.click(radios[1])
    expect((radios[1] as HTMLInputElement).checked).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    expect(onConfirm).toHaveBeenCalledWith('generic.json')
  })
})
