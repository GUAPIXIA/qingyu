 
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-taskroutes-cov-test', getVersion: () => '0.12.0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))
const TEST_ROOT = '/tmp/qingyu-taskroutes-cov-test'

import { BridgeServer } from '../server'
import { registerDevice, signToken, resetJwtSecretCache } from '../auth'

beforeEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); resetJwtSecretCache() })
afterEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); resetJwtSecretCache() })

describe('taskRoutes coverage', () => {
  it('list/cancel/retry/events 分支', async () => {
    const { nanoid } = await import('nanoid')
    const mockedNanoid = vi.mocked(nanoid)
    // 让两次任务创建返回不同 ID，避免 mock-id 碰撞导致 taskId 重复
    mockedNanoid.mockReturnValueOnce('mock-id-1').mockReturnValueOnce('mock-id-2').mockReturnValue('mock-id')
    const device = registerDevice('dev', 'fp-cov')
    const token = signToken(device.deviceId)
    const bridge = new BridgeServer(() => {})
    const { port } = await bridge.start({ host: '127.0.0.1', port: 18461 })
    try {
      const { chatData } = await import('../../ipc/chat')
      const { DIRS } = await import('../../services/storage')
      mkdirSync(DIRS.characters(), { recursive: true })
      writeFileSync(join(DIRS.characters(), 'char-cov.json'), JSON.stringify({ id: 'char-cov', name: 'Test', description: '', personality: '', scenario: '', firstMessage: 'hi', exampleDialog: '', tags: [], lorebookId: null, creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [] }), 'utf-8')
      const session = await chatData.createSession('char-cov', 'cov-test')
      const url = `http://127.0.0.1:${port}/api/v2/sessions/${session.id}/tasks`
      const r1 = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': 'cov-1' }, body: JSON.stringify({ type: 'send', content: 'hello' }) })
      expect(r1.status).toBe(202)
      const j1 = await r1.json() as { task: { taskId: string } }
      // list
      const l = await fetch(`http://127.0.0.1:${port}/api/v2/sessions/${session.id}/tasks?state=completed`, { headers: { Authorization: `Bearer ${token}` } })
      expect(l.status).toBe(200)
      // events
      const ev = await fetch(`http://127.0.0.1:${port}/api/v2/tasks/${j1.task.taskId}/events?afterSequence=0`, { headers: { Authorization: `Bearer ${token}` } })
      expect(ev.status).toBe(200)
      // cancel (completed -> 幂等)
      const c = await fetch(`http://127.0.0.1:${port}/api/v2/tasks/${j1.task.taskId}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      expect([200, 404].includes(c.status)).toBe(true)
      // 等待原任务完全释放锁
      await new Promise((r) => setTimeout(r, 20))
      // retry
      const rt = await fetch(`http://127.0.0.1:${port}/api/v2/tasks/${j1.task.taskId}/retry`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      if (rt.status !== 202) {
        const txt = await rt.text()
        console.log('retry error', rt.status, txt)
      }
      expect(rt.status).toBe(202)
      // 404 分支
      const nf = await fetch(`http://127.0.0.1:${port}/api/v2/tasks/not-exist`, { headers: { Authorization: `Bearer ${token}` } })
      expect(nf.status).toBe(404)
    } finally { bridge.stop() }
  })
})
