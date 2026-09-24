/**
 * S8-04：PC/Android 共用行为的服务器 Sync Transport（TypeScript 参考实现）。
 *
 * 约束：
 * - 用户点击后才刷新 token、建 session、plan、push、pull、commit；
 * - 未点击不预连、不刷 token、不建 session；
 * - 加密在进入 transport 前完成；解密只在本地 staging；
 * - access token 单飞刷新；非 retryable 不盲重试；
 * - 不使用业务 WebSocket。
 */

/** 与 relay-server/src/sync/types.ts 对齐的线格式（避免跨包类型依赖） */
export interface WireEntity {
  entityType: string
  entityId: string
  parentId: string | null
  schemaVersion: number
  version: Record<string, string>
  versionHash: string
  dot: { deviceId: string; counter: string }
  deleted: boolean
  updatedAt: number
  keyEpoch: number
  cipherRevision: number
  cipherHash: string
  contentTag: string
  ciphertext?: string
  blobManifestId?: string
}

export interface SessionResponse {
  sessionId: string
  state: string
  protocolVersion: number
  expiresAt: number
}

export interface PlanResponse {
  upload: number
  download: number
  conflicts: number
  estimatedBytes: number
  items: Array<{ entityType: string; entityId: string; direction: string }>
  quota: {
    usedEntities: number
    maxEntities: number
    usedCiphertextBytes: number
    maxCiphertextBytes: number
  }
}

export interface PushRequestBody {
  batchId: string
  envelopes: WireEntity[]
  dominatedProofs?: Array<{ entityType: string; entityId: string; versionHash: string }>
  reencrypt?: { fromKeyEpoch: number; toKeyEpoch: number }
}

export interface CommitReceipt {
  sessionId: string
  committedAt: number
  vector: Record<string, string>
  serverSeq: string
}

export interface ServerTransportConfig {
  baseUrl: string
  getAccessToken: () => Promise<string>
  /** 单飞刷新：并发调用共享同一刷新 Promise */
  refreshAccessToken?: () => Promise<string>
  fetchImpl?: typeof fetch
  /** 指数退避基数 ms */
  retryBaseMs?: number
  maxRetries?: number
}

export interface SyncProgress {
  phase: 'idle' | 'session' | 'plan' | 'push' | 'pull' | 'validate' | 'commit' | 'done' | 'failed'
  sent?: number
  received?: number
  message?: string
}

export type ServerTransportErrorCode =
  | 'NETWORK'
  | 'UNAUTHORIZED'
  | 'QUOTA_EXCEEDED'
  | 'SESSION_EXPIRED'
  | 'DEVICE_REVOKED'
  | 'BATCH_REPLAY_MISMATCH'
  | 'HASH_MISMATCH'
  | 'BAD_ENVELOPE'
  | 'NON_RETRYABLE'
  | 'CANCELLED'

export class ServerTransportError extends Error {
  constructor(
    readonly code: ServerTransportErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'ServerTransportError'
  }
}

/** access token 单飞刷新 */
export function createTokenRefresher(refresh: () => Promise<string>): () => Promise<string> {
  let inflight: Promise<string> | null = null
  return () => {
    if (!inflight) {
      inflight = refresh().finally(() => {
        inflight = null
      })
    }
    return inflight
  }
}

export class ServerSyncTransport {
  private readonly fetchImpl: typeof fetch
  private readonly retryBaseMs: number
  private readonly maxRetries: number
  private readonly refreshOnce: (() => Promise<string>) | null
  private aborted = false

  constructor(private readonly config: ServerTransportConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch
    this.retryBaseMs = config.retryBaseMs ?? 200
    this.maxRetries = config.maxRetries ?? 4
    this.refreshOnce = config.refreshAccessToken
      ? createTokenRefresher(config.refreshAccessToken)
      : null
  }

  cancel(): void {
    this.aborted = true
  }

  private assertNotCancelled(): void {
    if (this.aborted) throw new ServerTransportError('CANCELLED', '已取消', false)
  }

  private async authHeaders(): Promise<Record<string, string>> {
    let token = await this.config.getAccessToken()
    return {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { retried?: boolean } = {},
  ): Promise<T> {
    this.assertNotCancelled()
    const headers = await this.authHeaders()
    const url = `${this.config.baseUrl.replace(/\/$/, '')}${path}`
    let lastError: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.assertNotCancelled()
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        })
        if (res.status === 401 && this.refreshOnce && !opts.retried) {
          await this.refreshOnce()
          return this.request<T>(method, path, body, { retried: true })
        }
        const text = await res.text()
        const json = text ? JSON.parse(text) : {}
        if (!res.ok) {
          const err = (json as { error?: { code?: string; message?: string; retryable?: boolean; requestId?: string } }).error
          const rawCode = err?.code ?? 'NON_RETRYABLE'
          const retryable = err?.retryable ?? false
          const mapped: ServerTransportErrorCode =
            rawCode === 'QUOTA_EXCEEDED' ? 'QUOTA_EXCEEDED' :
            rawCode === 'SESSION_EXPIRED' ? 'SESSION_EXPIRED' :
            rawCode === 'DEVICE_REVOKED' ? 'DEVICE_REVOKED' :
            rawCode === 'BATCH_REPLAY_MISMATCH' ? 'BATCH_REPLAY_MISMATCH' :
            rawCode === 'HASH_MISMATCH' ? 'HASH_MISMATCH' :
            rawCode === 'INVALID_TOKEN' ? 'UNAUTHORIZED' :
            rawCode === 'BAD_ENVELOPE' ? 'BAD_ENVELOPE' :
            'NON_RETRYABLE'
          const error = new ServerTransportError(mapped, err?.message ?? res.statusText, retryable, err?.requestId)
          if (!retryable) throw error
          lastError = error
        } else {
          return json as T
        }
      } catch (e) {
        if (e instanceof ServerTransportError) {
          if (!e.retryable) throw e
          lastError = e
        } else {
          lastError = new ServerTransportError('NETWORK', '网络错误', true)
        }
      }
      if (attempt < this.maxRetries) {
        const delay = this.retryBaseMs * 2 ** attempt
        await new Promise((r) => setTimeout(r, delay))
      }
    }
    throw lastError instanceof ServerTransportError
      ? lastError
      : new ServerTransportError('NETWORK', '重试耗尽', true)
  }

  createSession(input: { deviceId: string; knownVersions?: Record<string, string> }): Promise<SessionResponse> {
    return this.request('POST', '/sync/v1/sessions', {
      protocolVersion: 1,
      deviceId: input.deviceId,
      ...(input.knownVersions ? { knownVersions: input.knownVersions } : {}),
    })
  }

  getSession(sessionId: string): Promise<SessionResponse> {
    return this.request('GET', `/sync/v1/sessions/${sessionId}`)
  }

  plan(sessionId: string, knownVersions?: Record<string, string>): Promise<PlanResponse> {
    return this.request('POST', `/sync/v1/sessions/${sessionId}/plan`, {
      ...(knownVersions ? { knownVersions } : {}),
    })
  }

  push(sessionId: string, body: PushRequestBody): Promise<{ batchId: string; accepted: number; rejected: number; cursor: string }> {
    return this.request('POST', `/sync/v1/sessions/${sessionId}/push`, body)
  }

  pull(sessionId: string, body: { cursor?: string; limit?: number }): Promise<{
    batchId: string
    envelopes: Array<WireEntity & { serverSeq: string }>
    nextCursor: string
    hasMore: boolean
  }> {
    return this.request('POST', `/sync/v1/sessions/${sessionId}/pull`, body)
  }

  commit(sessionId: string, vector: Record<string, string>): Promise<CommitReceipt> {
    return this.request('POST', `/sync/v1/sessions/${sessionId}/commit`, { vector })
  }

  abort(sessionId: string): Promise<void> {
    return this.request('DELETE', `/sync/v1/sessions/${sessionId}`)
  }

  /**
   * 完整服务器同步流（用户确认后调用）。
   * encrypt/decrypt 由调用方注入——transport 不碰明文。
   */
  async runSyncFlow(input: {
    deviceId: string
    knownVersions?: Record<string, string>
    /** 将本地变更加密为 wire entities（已在本地完成） */
    collectUpload: () => Promise<WireEntity[]>
    /** 校验并解密下载的 wire entities（本地 staging） */
    applyDownload: (envelopes: Array<WireEntity & { serverSeq: string }>) => Promise<Record<string, string>>
    onProgress?: (p: SyncProgress) => void
    batchSize?: number
  }): Promise<{ receipt: CommitReceipt; uploaded: number; downloaded: number }> {
    const progress = (p: SyncProgress) => input.onProgress?.(p)
    try {
      progress({ phase: 'session' })
      const session = await this.createSession({
        deviceId: input.deviceId,
        ...(input.knownVersions ? { knownVersions: input.knownVersions } : {}),
      })
      progress({ phase: 'plan' })
      await this.plan(session.sessionId, input.knownVersions)
      const upload = await input.collectUpload()
      const batchSize = input.batchSize ?? 200
      let sent = 0
      for (let i = 0; i < upload.length; i += batchSize) {
        this.assertNotCancelled()
        const slice = upload.slice(i, i + batchSize)
        progress({ phase: 'push', sent, received: 0 })
        await this.push(session.sessionId, {
          batchId: `up-${session.sessionId}-${i / batchSize}`,
          envelopes: slice,
        })
        sent += slice.length
      }
      let cursor: string | undefined
      let downloaded = 0
      const all: Array<WireEntity & { serverSeq: string }> = []
      for (;;) {
        this.assertNotCancelled()
        const page = await this.pull(session.sessionId, {
          ...(cursor ? { cursor } : {}),
          limit: 200,
        })
        all.push(...page.envelopes)
        downloaded += page.envelopes.length
        progress({ phase: 'pull', sent, received: downloaded })
        cursor = page.nextCursor
        if (!page.hasMore) break
      }
      progress({ phase: 'validate' })
      const vector = await input.applyDownload(all)
      progress({ phase: 'commit' })
      const receipt = await this.commit(session.sessionId, vector)
      progress({ phase: 'done' })
      return { receipt, uploaded: sent, downloaded }
    } catch (e) {
      progress({ phase: 'failed', message: e instanceof Error ? e.message : String(e) })
      throw e
    }
  }
}
