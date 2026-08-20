/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-taskroutes-cov3-test', getVersion: () => '0.12.0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))
const TEST_ROOT = '/tmp/qingyu-taskroutes-cov3-test'
import { BridgeServer } from '../server'
import { registerDevice, signToken, resetJwtSecretCache } from '../auth'
import { sessionLock } from '../../chat/sessionLock'

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  resetJwtSecretCache()
  sessionLock.clear()
})
afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  resetJwtSecretCache()
  sessionLock.clear()
})

describe('taskRoutes coverage3 - 冲突与500分支', () => {
  it('TASK_CONFLICT 409 分支', async () => {
    const { nanoid } = await import('nanoid')
    const mocked = vi.mocked(nanoid)
    mocked.mockReturnValue('mock-conflict')
    const device = registerDevice('dev', 'fp-conflict3')
    const token = signToken(device.deviceId)
    const bridge = new BridgeServer(() => {})
    const { port } = await bridge.start({ host: '127.0.0.1', port: 18471 })
    try {
      const { chatData } = await import('../../ipc/chat')
      const { DIRS } = await import('../../services/storage')
      mkdirSync(DIRS.characters(), { recursive: true })
      writeFileSync(
        join(DIRS.characters(), 'char-conflict3.json'),
        JSON.stringify({ id: 'char-conflict3', name: 'Test', description: '', personality: '', scenario: '', firstMessage: 'hi', exampleDialog: '', tags: [], lorebookId: null, creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [] }),
        'utf-8',
      )
      const session = await chatData.createSession('char-conflict3', 'conflict3')
      // 占住锁，触发 TASK_CONFLICT
      sessionLock.tryAcquire(session.id, 'holder')
      const url = `http://127.0.0.1:${port}/api/v2/sessions/${session.id}/tasks`
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': 'conflict-409' },
        body: JSON.stringify({ type: 'send', content: 'hello' }),
      })
      expect(r.status).toBe(409)
      const j = await r.json()
      expect(j.error.code).toBe('TASK_CONFLICT')
    } finally {
      bridge.stop()
    }
  })

  it('cancel 404 与错误 500 分支', async () => {
    const device = registerDevice('dev2', 'fp-cover3-2')
    const token = signToken(device.deviceId)
    const bridge = new BridgeServer(() => {})
    const { port } = await bridge.start({ host: '127.0.0.1', port: 18472 })
    try {
      const r404 = await fetch(`http://127.0.0.1:${port}/api/v2/tasks/not-exist-404/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(r404.status).toBe(404)
    } finally {
      bridge.stop()
    }
  })

  it('events 404 分支', async () => {
    const device = registerDevice('dev3', 'fp-cover3-3')
    const token = signToken(device.deviceId)
    const bridge = new BridgeServer(() => {})
    const { port } = await bridge.start({ host: '127.0.0.1', port: 18473 })
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v2/tasks/not-exist-xyz/events?afterSequence=0`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(r.status).toBe(404)
    } finally {
      bridge.stop()
    }
  })
})
