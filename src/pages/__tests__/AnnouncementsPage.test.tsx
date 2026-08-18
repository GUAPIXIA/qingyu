/**
 * AnnouncementsPage 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

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
    announcement: {
      list: vi.fn(async () => []),
    },
  },
})

import { AnnouncementsPage } from '../AnnouncementsPage'

describe('AnnouncementsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('渲染页面', () => {
    const { container } = render(<AnnouncementsPage />)
    expect(container).toBeDefined()
  })
})
