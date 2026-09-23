/**
 * McpPage 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

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
      removeServer: vi.fn(async () => ({})),
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

  it('UEX-P1-29：启动失败折叠态行头显示红色指示，展开后可见错误详情', async () => {
    vi.mocked(window.api.mcp.listServers).mockResolvedValue([{
      id: 's1', name: '测试服务', transport: 'stdio', command: 'node x.js', enabled: true, autoStart: false,
    }])
    vi.mocked(window.api.mcp.listServerStatuses).mockResolvedValue([{
      id: 's1', connected: false, toolCount: 0, lastError: 'spawn 失败：命令不存在',
    }])
    render(<McpPage />)

    expect(await screen.findByText('启动失败')).toBeInTheDocument()
    // 折叠态只显示指示，错误详情展开才可见
    expect(screen.queryByText('spawn 失败：命令不存在')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('测试服务'))
    expect(screen.getByText('spawn 失败：命令不存在')).toBeInTheDocument()
  })

  it('UEX-P1-29：删除走统一 ConfirmDialog 并保留影响说明', async () => {
    vi.mocked(window.api.mcp.listServers).mockResolvedValue([{
      id: 's1', name: '测试服务', transport: 'stdio', command: 'node x.js', enabled: true, autoStart: false,
    }])
    render(<McpPage />)
    await screen.findByText('测试服务')

    fireEvent.click(screen.getByTitle('删除'))
    const dialog = await screen.findByRole('dialog', { name: '删除 MCP 服务器' })
    expect(within(dialog).getByText(/删除后其工具将从会话中移除/)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(window.api.mcp.removeServer).toHaveBeenCalledWith('s1'))
  })
})
