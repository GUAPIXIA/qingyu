import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocket } from 'ws'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-bridge-security-test', getVersion: () => '0.11.28' },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('../../ipc/announcement', () => ({
  fetchAnnouncementList: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })),
  fetchVersionInfo: vi.fn(async () => null),
}))

import { DIRS } from '../../services/storage'
import { BridgeServer } from '../server'
import { registerDevice, revokeDevice, signToken, resetJwtSecretCache } from '../auth'

const ROOT = '/tmp/qingyu-bridge-security-test'

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
    socket.once('close', (code) => reject(new Error(`closed: ${code}`)))
  })
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once('close', resolve)
    socket.once('error', () => {})
  })
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  resetJwtSecretCache()
  mkdirSync(DIRS.characters(), { recursive: true })
  writeFileSync(join(DIRS.characters(), 'char-sec.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]))
})

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  resetJwtSecretCache()
})

describe('0.11.28 Bridge 安全回归', () => {
  it('静态媒体要求有效 Bearer，设备吊销后立即失效', async () => {
    const device = registerDevice('安全测试设备', 'fp-static')
    const token = signToken(device.deviceId)
    const bridge = new BridgeServer(() => {})
    const { port } = await bridge.start({ host: '127.0.0.1', port: 18421 })
    const url = `http://127.0.0.1:${port}/static/avatars/char-sec`
    try {
      expect((await fetch(url)).status).toBe(401)
      expect((await fetch(url, { headers: { Authorization: 'Bearer forged' } })).status).toBe(401)
      expect((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200)
      revokeDevice(device.deviceId)
      expect((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401)
    } finally {
      bridge.stop()
    }
  })

  it('WS 拒绝 query 长期令牌，只接受 Authorization Header，并响应吊销', async () => {
    const device = registerDevice('WS 测试设备', 'fp-ws')
    const token = signToken(device.deviceId)
    const bridge = new BridgeServer(() => {})
    const { port } = await bridge.start({ host: '127.0.0.1', port: 18431 })
    try {
      const querySocket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`)
      expect(await waitForClose(querySocket)).toBe(4001)

      const authorized = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      await waitForOpen(authorized)
      revokeDevice(device.deviceId)
      const disconnected = waitForClose(authorized)
      bridge.disconnectDevice(device.deviceId)
      expect(await disconnected).toBe(4001)
      const revoked = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(await waitForClose(revoked)).toBe(4001)
    } finally {
      bridge.stop()
    }
  })
})
