import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-taskroutes-test', getVersion: () => '0.12.0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))
const TEST_ROOT = '/tmp/qingyu-taskroutes-test'

import { BridgeServer } from '../server'
import { registerDevice, signToken, resetJwtSecretCache } from '../auth'

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  resetJwtSecretCache()
})
afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  resetJwtSecretCache()
})

describe('Bridge API v2', () => {
  it('Idempotency-Key 重放返回同一 taskId (202)', async () => {
    const device = registerDevice('dev', 'fp-v2')
    const token = signToken(device.deviceId)
    const bridge = new BridgeServer(() => {})
    const { port } = await bridge.start({ host: '127.0.0.1', port: 18451 })
    try {
      // 先创建一次会话（通过 chatData 直接落盘，避免依赖角色）
      const { chatData } = await import('../../ipc/chat')
      const { DIRS } = await import('../../services/storage')
      const { join } = await import('node:path')
      const { writeFileSync, mkdirSync } = await import('node:fs')
      mkdirSync(DIRS.characters(), { recursive: true })
      writeFileSync(join(DIRS.characters(), 'char-v2.json'), JSON.stringify({ id: 'char-v2', name: 'Test', description: '', personality: '', scenario: '', firstMessage: 'hi', exampleDialog: '', tags: [], lorebookId: null, creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [] }), 'utf-8')
      const session = await chatData.createSession('char-v2', 'v2-test')
      const url = `http://127.0.0.1:${port}/api/v2/sessions/${session.id}/tasks`
      const r1 = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': 'idem-1' },
        body: JSON.stringify({ type: 'send', content: 'hello' }),
      })
      if (r1.status !== 202) {
        const txt = await r1.text()
        console.log('r1 error', r1.status, txt)
      }
      expect(r1.status).toBe(202)
      const j1 = await r1.json() as { task: { taskId: string } }
      const r2 = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': 'idem-1' },
        body: JSON.stringify({ type: 'send', content: 'hello' }),
      })
      const j2 = await r2.json() as { task: { taskId: string } }
      expect(j2.task.taskId).toBe(j1.task.taskId)

      // 事件补拉
      const ev = await fetch(`http://127.0.0.1:${port}/api/v2/tasks/${j1.task.taskId}/events?afterSequence=0`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(ev.status).toBe(200)
      const ej = await ev.json() as { events: unknown[] }
      expect(Array.isArray(ej.events)).toBe(true)
    } finally {
      bridge.stop()
    }
  })
})
