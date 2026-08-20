 
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-taskroutes-cov2-test', getVersion: () => '0.12.0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))
const TEST_ROOT = '/tmp/qingyu-taskroutes-cov2-test'
import { BridgeServer } from '../server'
import { registerDevice, signToken, resetJwtSecretCache } from '../auth'
beforeEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); resetJwtSecretCache() })
afterEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); resetJwtSecretCache() })

describe('taskRoutes coverage2', () => {
  it('404 分支全覆盖', async () => {
    const device = registerDevice('dev2', 'fp-cov2')
    const token = signToken(device.deviceId)
    const bridge = new BridgeServer(() => {})
    const { port } = await bridge.start({ host: '127.0.0.1', port: 18462 })
    try {
      const nf1 = await fetch(`http://127.0.0.1:${port}/api/v2/tasks/not-exist`, { headers: { Authorization: `Bearer ${token}` } })
      expect(nf1.status).toBe(404)
      const nf2 = await fetch(`http://127.0.0.1:${port}/api/v2/tasks/not-exist/events?afterSequence=0`, { headers: { Authorization: `Bearer ${token}` } })
      expect(nf2.status).toBe(404)
      const nf3 = await fetch(`http://127.0.0.1:${port}/api/v2/tasks/not-exist/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      expect(nf3.status).toBe(404)
      const nf4 = await fetch(`http://127.0.0.1:${port}/api/v2/tasks/not-exist/retry`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      expect(nf4.status).toBe(404)
      // 无效 sessionId 触发 500 或 404
      const bad = await fetch(`http://127.0.0.1:${port}/api/v2/sessions/invalid!@#/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': 'bad-1' }, body: JSON.stringify({ type: 'send', content: 'hi' }) })
      expect([400, 404, 500].includes(bad.status)).toBe(true)
    } finally { bridge.stop() }
  })
})
