import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
}))

import { authorizeTool } from '../toolGate'
import * as perm from '../../mcp/toolPermission'
import type { TaskSnapshot } from '../../../shared/chat-core/events'

function snap(): TaskSnapshot {
  return {
    schemaVersion: 1,
    taskId: 't1',
    requestId: 'r1',
    type: 'send',
    state: 'streaming',
    sessionId: 's1',
    characterId: 'c1',
    client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
    accumulatedText: '',
    lastSequence: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('ToolGate', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('L0 自动允许', async () => {
    const d = await authorizeTool({ serverName: 's', toolName: 'get_time', args: {} }, snap())
    expect(d).toBe('allow')
  })

  it('L1 敏感读取需确认（mock 允许 -> allow）', async () => {
    vi.spyOn(perm, 'requestToolPermission').mockResolvedValue(true)
    const d = await authorizeTool({ serverName: 'files', toolName: 'read_database', args: { path: '/a' } }, snap())
    expect(d).toBe('allow')
  })

  it('L1 拒绝 -> deny', async () => {
    vi.spyOn(perm, 'requestToolPermission').mockResolvedValue(false)
    const d = await authorizeTool({ serverName: 'files', toolName: 'read_database', args: {} }, snap())
    expect(d).toBe('deny')
  })

  it('超时默认拒绝', async () => {
    vi.spyOn(perm, 'requestToolPermission').mockImplementation(() => new Promise(() => {})) // 永不 resolve
    const d = await authorizeTool({ serverName: 's', toolName: 'write_file', args: {} }, snap(), 20)
    expect(d).toBe('deny')
  })
})
