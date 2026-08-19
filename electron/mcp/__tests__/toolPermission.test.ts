import { beforeEach, describe, expect, it, vi } from 'vitest'

const showMessageBox = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-test' },
  dialog: { showMessageBox },
}))

import { classifyToolRisk, requestToolPermission } from '../toolPermission'

describe('MCP 工具权限门', () => {
  beforeEach(() => showMessageBox.mockReset())

  it('仅明确无副作用的时间/计算工具自动允许', async () => {
    expect(classifyToolRisk('get_time')).toBe('L0')
    expect(await requestToolPermission({ serverName: 'safe', toolName: 'get_time', args: {} })).toBe(true)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('敏感读取和外部写入必须逐次确认', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    const read = { serverName: 'files', toolName: 'read_database', args: { path: 'private.db' } }
    const write = { serverName: 'mail', toolName: 'send_message', args: { to: 'user@example.com' } }
    expect(await requestToolPermission(read)).toBe(false)
    expect(await requestToolPermission(write)).toBe(true)
    expect(showMessageBox).toHaveBeenCalledTimes(2)
  })

  it('Shell/文件变更归类为最高风险', () => {
    expect(classifyToolRisk('run_shell')).toBe('L3')
    expect(classifyToolRisk('write_file')).toBe('L3')
  })
})
