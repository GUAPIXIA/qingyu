/**
 * MCP server 配置安全校验单元测试
 * N2 修复：mcp:addServer / mcp:updateServer 曾接受任意 command/args/env 直接 spawn，
 * 恶意配置可执行任意命令（RCE 桥）。此测试覆盖解释器黑名单、内联执行参数、
 * 相对路径、危险环境变量与长度限制。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// electron 运行时依赖 mock（storage.ts 使用 app.getPath）
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-test' },
}))

import { McpManager, validateServerConfig } from '../manager'

describe('validateServerConfig', () => {
  it('接受合法 stdio 配置', () => {
    expect(() =>
      validateServerConfig({
        name: 'test',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        enabled: true,
        autoStart: false,
      }),
    ).not.toThrow()
  })

  it('接受无路径分隔符的可执行命令', () => {
    expect(() => validateServerConfig({ command: 'my-server' })).not.toThrow()
  })

  it('接受绝对路径命令', () => {
    expect(() => validateServerConfig({ command: 'C:\\tools\\my-server.exe' })).not.toThrow()
    expect(() => validateServerConfig({ command: '/usr/local/bin/my-server' })).not.toThrow()
  })

  it('拒绝解释器命令', () => {
    expect(() => validateServerConfig({ command: 'bash' })).toThrow()
    expect(() => validateServerConfig({ command: 'sh' })).toThrow()
    expect(() => validateServerConfig({ command: 'node' })).toThrow()
    expect(() => validateServerConfig({ command: 'node.exe' })).toThrow()
    expect(() => validateServerConfig({ command: 'python3' })).toThrow()
    expect(() => validateServerConfig({ command: 'python3.11.exe' })).toThrow()
    expect(() => validateServerConfig({ command: 'C:\\Windows\\System32\\cmd.exe' })).toThrow()
    expect(() => validateServerConfig({ command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' })).toThrow()
  })

  it('拒绝相对路径命令', () => {
    expect(() => validateServerConfig({ command: './evil.sh' })).toThrow()
    expect(() => validateServerConfig({ command: '..\\evil.exe' })).toThrow()
    expect(() => validateServerConfig({ command: 'sub\\dir\\tool' })).toThrow()
  })

  it('拒绝内联执行参数', () => {
    expect(() => validateServerConfig({ command: 'npx', args: ['-c', 'rm -rf /'] })).toThrow()
    expect(() => validateServerConfig({ command: 'npx', args: ['/c', 'dir'] })).toThrow()
    expect(() => validateServerConfig({ command: 'tool', args: ['-e', 'print(1)'] })).toThrow()
  })

  it('拒绝危险环境变量', () => {
    expect(() => validateServerConfig({ env: { NODE_OPTIONS: '--require evil' } })).toThrow()
    expect(() => validateServerConfig({ env: { LD_PRELOAD: '/tmp/x.so' } })).toThrow()
    expect(() => validateServerConfig({ env: { BASH_ENV: '/tmp/evil' } })).toThrow()
  })

  it('拒绝超长或非字符串参数', () => {
    expect(() => validateServerConfig({ args: ['x'.repeat(2000)] })).toThrow()
    expect(() => validateServerConfig({ args: [123 as unknown as string] })).toThrow()
    expect(() => validateServerConfig({ args: 'not-array' as unknown as string[] })).toThrow()
  })

  it('拒绝超长命令与空命令', () => {
    expect(() => validateServerConfig({ command: '' })).toThrow()
    expect(() => validateServerConfig({ command: 'x'.repeat(600) })).toThrow()
  })

  it('updateServer 部分 patch 同样校验', () => {
    expect(() => validateServerConfig({ command: 'powershell' })).toThrow()
    expect(() => validateServerConfig({ name: 'ok' })).not.toThrow()
    expect(() => validateServerConfig({ transport: 'sse', url: 'https://example.com/mcp' })).not.toThrow()
    expect(() => validateServerConfig({ url: 'file:///etc/passwd' })).toThrow()
  })

  it('启动前重新校验被离线篡改的持久化配置', async () => {
    const root = '/tmp/qingyu-test/data/config'
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'mcp-servers.json'), JSON.stringify([{
      id: 'tampered', name: '篡改配置', transport: 'stdio', command: 'powershell',
      args: ['-Command', 'whoami'], enabled: true, autoStart: true,
    }]))
    const manager = new McpManager()
    await expect(manager.startServer('tampered')).rejects.toThrow('不允许使用解释器')
    rmSync('/tmp/qingyu-test/data', { recursive: true, force: true })
  })
})
