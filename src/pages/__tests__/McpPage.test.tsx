/**
 * McpPage 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('react-router-dom', () => ({
  useNavigate: vi.fn(() => vi.fn()),
}))

vi.mock('../../lib/logger', () => ({
  logError: vi.fn(),
}))

vi.mock('../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

// Mock window.api
Object.defineProperty(window, 'api', {
  value: {
    mcp: {
      listServers: vi.fn(async () => []),
      listServerStatuses: vi.fn(async () => []),
      listTools: vi.fn(async () => []),
      startServer: vi.fn(async () => ({})),
      stopServer: vi.fn(async () => ({})),
    },
  },
})

import { McpPage } from '../McpPage'

describe('McpPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('渲染页面标题', async () => {
    render(<McpPage />)
    await waitFor(() => expect(window.api.mcp.listServers).toHaveBeenCalled())
    expect(screen.getByText('MCP 工具')).toBeInTheDocument()
  })

  it('显示添加按钮', async () => {
    render(<McpPage />)
    await waitFor(() => expect(window.api.mcp.listServers).toHaveBeenCalled())
    expect(screen.getByText('添加')).toBeInTheDocument()
  })
})
