/**
 * S8-04 ServerTransport 单测：单飞刷新、非 retryable 不盲重试、取消。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ServerSyncTransport,
  createTokenRefresher,
} from '../../electron/domain/serverTransport.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('S8-04 token 单飞刷新', () => {
  it('并发调用共享同一刷新 Promise', async () => {
    let calls = 0
    const refresh = createTokenRefresher(async () => {
      calls++
      await new Promise((r) => setTimeout(r, 10))
      return `token-${calls}`
    })
    const [a, b, c] = await Promise.all([refresh(), refresh(), refresh()])
    expect(calls).toBe(1)
    expect(a).toBe('token-1')
    expect(b).toBe('token-1')
    expect(c).toBe('token-1')
  })
})

describe('S8-04 ServerSyncTransport', () => {
  it('未点击同步时不发请求；runSyncFlow 按 session→plan→push→pull→commit', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return jsonResponse(201, { sessionId: 's1', state: 'open', protocolVersion: 1, expiresAt: Date.now() + 1000 })
      }
      if (url.endsWith('/plan')) return jsonResponse(200, { upload: 0, download: 0, conflicts: 0, estimatedBytes: 0, items: [], quota: { usedEntities: 0, maxEntities: 1, usedCiphertextBytes: 0, maxCiphertextBytes: 1 } })
      if (url.endsWith('/push')) return jsonResponse(200, { batchId: 'b', accepted: 1, rejected: 0, cursor: '1' })
      if (url.endsWith('/pull')) {
        return jsonResponse(200, {
          batchId: 'p',
          envelopes: [{
            entityType: 'character', entityId: 'e1', parentId: null, schemaVersion: 1,
            version: { android_b: '1' }, versionHash: 'sha256:' + 'a'.repeat(64),
            dot: { deviceId: 'android_b', counter: '1' }, deleted: false, updatedAt: 1,
            keyEpoch: 1, cipherRevision: 1, cipherHash: 'sha256:' + 'b'.repeat(64),
            contentTag: 't', ciphertext: 'Y2lwaGVy', serverSeq: '1',
          }],
          nextCursor: '1',
          hasMore: false,
        })
      }
      if (url.endsWith('/commit')) {
        return jsonResponse(200, { sessionId: 's1', committedAt: 1, vector: { android_b: '1' }, serverSeq: '1' })
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const transport = new ServerSyncTransport({
      baseUrl: 'https://relay.example',
      getAccessToken: async () => 'tok',
      fetchImpl,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    const result = await transport.runSyncFlow({
      deviceId: 'android_b',
      collectUpload: async () => [{
        entityType: 'character', entityId: 'e0', parentId: null, schemaVersion: 1,
        version: { android_b: '1' }, versionHash: 'sha256:' + 'c'.repeat(64),
        dot: { deviceId: 'android_b', counter: '1' }, deleted: false, updatedAt: 1,
        keyEpoch: 1, cipherRevision: 1, cipherHash: 'sha256:' + 'd'.repeat(64),
        contentTag: 't', ciphertext: 'Y2lwaGVy',
      }],
      applyDownload: async () => ({ android_b: '1' }),
    })
    expect(result.uploaded).toBe(1)
    expect(result.downloaded).toBe(1)
    expect(calls[0]).toContain('POST')
    expect(calls.some((c) => c.includes('/commit'))).toBe(true)
  })

  it('非 retryable 错误不盲重试', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => {
      n++
      return jsonResponse(403, { error: { code: 'DEVICE_REVOKED', message: '设备已吊销', retryable: false, requestId: 'r1' } })
    }) as unknown as typeof fetch
    const transport = new ServerSyncTransport({
      baseUrl: 'https://relay.example',
      getAccessToken: async () => 'tok',
      fetchImpl,
      maxRetries: 3,
      retryBaseMs: 1,
    })
    await expect(transport.createSession({ deviceId: 'd' })).rejects.toMatchObject({
      code: 'DEVICE_REVOKED',
      retryable: false,
    })
    expect(n).toBe(1)
  })

  it('401 单飞刷新后重试一次', async () => {
    let n = 0
    let refreshed = 0
    const fetchImpl = vi.fn(async () => {
      n++
      if (n === 1) return jsonResponse(401, { error: { code: 'INVALID_TOKEN', message: 'expired', retryable: false, requestId: 'r' } })
      return jsonResponse(201, { sessionId: 's1', state: 'open', protocolVersion: 1, expiresAt: 1 })
    }) as unknown as typeof fetch
    const transport = new ServerSyncTransport({
      baseUrl: 'https://relay.example',
      getAccessToken: async () => `tok-${n}`,
      refreshAccessToken: async () => {
        refreshed++
        return 'tok-new'
      },
      fetchImpl,
      retryBaseMs: 1,
    })
    const session = await transport.createSession({ deviceId: 'd' })
    expect(session.sessionId).toBe('s1')
    expect(refreshed).toBe(1)
    expect(n).toBe(2)
  })

  it('cancel 后拒绝继续', async () => {
    const transport = new ServerSyncTransport({
      baseUrl: 'https://x',
      getAccessToken: async () => 't',
      fetchImpl: (async () => jsonResponse(200, {})) as unknown as typeof fetch,
    })
    transport.cancel()
    await expect(transport.createSession({ deviceId: 'd' })).rejects.toMatchObject({ code: 'CANCELLED' })
  })
})
