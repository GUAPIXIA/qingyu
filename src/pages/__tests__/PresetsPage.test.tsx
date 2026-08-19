/**
 * PresetsPage 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

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
})
