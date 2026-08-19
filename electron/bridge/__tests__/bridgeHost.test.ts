import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-bridge-host-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}))

import { resolveBridgeHost } from '../index'

const candidates = [
  { ip: '192.168.10.3', name: 'WLAN' },
  { ip: '10.0.0.8', name: 'Ethernet' },
]

describe('resolveBridgeHost', () => {
  it('保留仍属于本机网卡的已配置地址', () => {
    expect(resolveBridgeHost('10.0.0.8', candidates)).toBe('10.0.0.8')
  })

  it('换网后将失效地址切换到当前局域网地址', () => {
    expect(resolveBridgeHost('192.168.10.15', candidates)).toBe('192.168.10.3')
  })

  it('没有可用局域网地址时回退到回环地址', () => {
    expect(resolveBridgeHost('192.168.10.15', [])).toBe('127.0.0.1')
  })
})
