/**
 * 阶段 7 S7-04：PC `/sync/v1` 独立路由（方案 §S7-04）。
 *
 * 约束：
 * - 严格匹配方法与路径；独立限流 / body 上限 / 并发 / 超时；
 * - 鉴权：LAN 一次性授权会话（scope=sync），**不复用** Bridge JWT / Relay allowlist；
 * - 默认休眠：无已确认 sync 会话时鉴权前快速 401/503，不扫 payload、不开 checkpoint；
 * - 所有 push 先进 staging，经 prepare → commit 才走 Sync Application Service / Repository；
 * - 路由不得调用旧文件直写函数；
 * - 请求日志只记 requestId、批次大小、状态与耗时（不记正文/URL 凭据）。
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { rateLimit } from 'express-rate-limit'
import { createHash, randomUUID } from 'node:crypto'
import { syncLanAuthService } from '../domain/syncLanAuth'
import { applyRemoteBatch } from '../domain/remoteApply'
import {
  getSyncHealth,
  isSyncReady,
  type SyncDomainContext,
} from '../domain/syncDomainService'
import { buildSyncPlan, planFingerprint } from '../../shared/sync-core/plan'
import { batchHash, idempotentKey, sortBatch } from '../../shared/sync-core/batch'
import { negotiateCapabilities, SUPPORTED_PROTOCOL_VERSION } from '../../shared/sync-core/capability'
import { transitionSession, isTerminalSession } from '../../shared/sync-core/sessionMachine'
import type {
  EntityHeadSummary,
  NegotiatedCapabilities,
  SyncPlan,
  SyncSessionState,
} from '../../shared/sync-core/types'
import type { SyncEnvelope } from '../../shared/contracts/sync-envelope'
import type { VersionVector } from '../../shared/contracts/version-vector'
import { createLogger } from '../services/logger'

const log = createLogger('sync-v1')

/** 默认批次上限（方案 §4）：条数与字节先到为准 */
export const SYNC_BATCH_MAX_ITEMS = 500
export const SYNC_BATCH_MAX_BYTES = 4 * 1024 * 1024
/** 独立 body 上限（含 envelope 包装） */
const BODY_LIMIT = '5mb'
/** 独立并发：单 session 同时只允许一个 apply；只读 plan 限量 */
const MAX_PLAN_CONCURRENCY = 4
const REQUEST_TIMEOUT_MS = 30_000

type SessionRole = 'pc' | 'android'

interface SyncSessionRecord {
  sessionId: string
  state: SyncSessionState
  role: SessionRole
  peerId: string
  negotiated: NegotiatedCapabilities | null
  createdAt: number
  updatedAt: number
  lastError?: string
}

interface StagedBatch {
  batchId: string
  sequence: number
  sessionId: string
  itemHash: string
  byteSize: number
  envelopes: SyncEnvelope[]
  stagedAt: number
  state: 'staged' | 'prepared' | 'committed' | 'aborted'
}

interface CommitReceipt {
  receiptId: string
  sessionId: string
  batchId: string
  sequence: number
  batchHash: string
  committedAt: number
  applied: number
  conflicts: number
  rejected: number
}

/** 内存 staging + 会话表（S7-04 首版；持久化 prepared 批次放后续工作包） */
class SyncV1Runtime {
  readonly sessions = new Map<string, SyncSessionRecord>()
  readonly staging = new Map<string, StagedBatch>()
  readonly receipts = new Map<string, CommitReceipt>()
  /** sessionId → 并发 plan 计数 */
  private planInflight = new Map<string, number>()
  private applyInflight = new Set<string>()

  createSession(role: SessionRole, peerId: string, now = Date.now()): SyncSessionRecord {
    const sessionId = randomUUID()
    const rec: SyncSessionRecord = {
      sessionId,
      state: 'idle',
      role,
      peerId,
      negotiated: null,
      createdAt: now,
      updatedAt: now,
    }
    this.sessions.set(sessionId, rec)
    return rec
  }

  get(sessionId: string): SyncSessionRecord | null {
    return this.sessions.get(sessionId) ?? null
  }

  transition(sessionId: string, event: Parameters<typeof transitionSession>[1]): { ok: boolean; state: SyncSessionState; reason?: string } {
    const rec = this.sessions.get(sessionId)
    if (!rec) return { ok: false, state: 'failed', reason: 'session_not_found' }
    const r = transitionSession(rec.state, event)
    if (r.ok) {
      rec.state = r.next
      rec.updatedAt = Date.now()
    }
    return { ok: r.ok, state: rec.state, ...(r.reason ? { reason: r.reason } : {}) }
  }

  stage(sessionId: string, batch: Omit<StagedBatch, 'stagedAt' | 'state'>): StagedBatch {
    const rec: StagedBatch = { ...batch, sessionId, stagedAt: Date.now(), state: 'staged' }
    this.staging.set(batch.batchId, rec)
    return rec
  }

  tryBeginApply(sessionId: string): boolean {
    if (this.applyInflight.has(sessionId)) return false
    this.applyInflight.add(sessionId)
    return true
  }

  endApply(sessionId: string): void {
    this.applyInflight.delete(sessionId)
  }

  tryBeginPlan(sessionId: string): boolean {
    const n = this.planInflight.get(sessionId) ?? 0
    if (n >= MAX_PLAN_CONCURRENCY) return false
    this.planInflight.set(sessionId, n + 1)
    return true
  }

  endPlan(sessionId: string): void {
    const n = this.planInflight.get(sessionId) ?? 0
    if (n <= 1) this.planInflight.delete(sessionId)
    else this.planInflight.set(sessionId, n - 1)
  }

  resetForTests(): void {
    this.sessions.clear()
    this.staging.clear()
    this.receipts.clear()
    this.planInflight.clear()
    this.applyInflight.clear()
  }
}

export const syncV1Runtime = new SyncV1Runtime()

function reqId(req: Request): string {
  const raw = req.headers['x-request-id']
  return typeof raw === 'string' && raw ? raw.slice(0, 64) : randomUUID().slice(0, 16)
}

function logSync(req: Request, res: Response, meta: { requestId: string; batchSize?: number; status: number; startedAt: number }): void {
  // 只记 requestId、批次大小、状态、耗时（方案 §S7-04）
  log.info('sync-v1', {
    requestId: meta.requestId,
    method: req.method,
    path: req.path,
    batchSize: meta.batchSize ?? 0,
    status: meta.status,
    durationMs: Date.now() - meta.startedAt,
  })
  void res
}

/** 默认休眠：无已确认 LAN sync 会话时快速拒绝（鉴权前），不扫业务数据 */
function requireSyncSession(req: Request, res: Response, next: NextFunction): void {
  if (!syncLanAuthService.hasActiveSyncSession()) {
    res.status(503).json({ error: 'sync_dormant', message: '未开启局域网同步授权' })
    return
  }
  next()
}

/** 授权窗内允许（open / awaiting_confirm / confirmed）；用于 hello/status，不扫业务数据 */
function requireAuthWindow(req: Request, res: Response, next: NextFunction): void {
  const phase = syncLanAuthService.getStatus().phase
  if (phase !== 'open' && phase !== 'awaiting_confirm' && phase !== 'confirmed') {
    res.status(503).json({ error: 'sync_dormant', message: '未开启局域网同步授权' })
    return
  }
  next()
}

function withTimeout(handler: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const startedAt = Date.now()
    const requestId = reqId(req)
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({ error: 'timeout', requestId })
        logSync(req, res, { requestId, status: 504, startedAt })
      }
    }, REQUEST_TIMEOUT_MS)
    try {
      await handler(req, res)
      if (!res.headersSent) {
        logSync(req, res, { requestId, status: res.statusCode, startedAt })
      }
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal', requestId })
        logSync(req, res, { requestId, status: 500, startedAt })
      }
      next(err)
    } finally {
      clearTimeout(timer)
    }
  }
}

function domainOrNull(): SyncDomainContext | null {
  return peekSyncDomain()
}

/** 仅供路由内部：不导出到业务层 */
let peekSyncDomain: () => SyncDomainContext | null = () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 惰性加载以避免循环依赖
    const mod = require('../domain/syncDomainService') as {
      getSyncDomain?: () => SyncDomainContext
    }
    return mod.getSyncDomain?.() ?? null
  } catch {
    return null
  }
}

export function setSyncV1DomainPeekForTest(fn: () => SyncDomainContext | null): void {
  peekSyncDomain = fn
}

function mapHead(row: {
  entityType: string
  entityId: string
  versionJson: string
  hash: string
  deleted: number
}): EntityHeadSummary {
  return {
    entityType: row.entityType,
    entityId: row.entityId,
    version: JSON.parse(row.versionJson) as VersionVector,
    contentHash: row.hash,
    deleted: row.deleted === 1,
    parentId: null,
    schemaVersion: 1,
    updatedAt: 0,
  }
}

const DEFAULT_CAPS = {
  protocolVersion: SUPPORTED_PROTOCOL_VERSION,
  features: [] as string[],
  schemaVersions: {
    character: 1,
    session: 1,
    message: 1,
    group_session: 1,
    group_message: 1,
    lorebook: 1,
    preset: 1,
    persona: 1,
    regex_rule: 1,
    quick_reply_set: 1,
    usage_record: 1,
    settings_public: 1,
  } as Record<string, number>,
}

/**
 * 构建 `/sync/v1` 路由（挂载前缀 `/sync/v1`）。
 * 严格方法+路径：router 只声明方案列出的端点，其余由 Express 404。
 */
export function buildSyncV1Router(): Router {
  const router = Router()

  // 独立限流（与 /api/v1、模型请求隔离）
  router.use(
    rateLimit({
      windowMs: 60_000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'rate_limited' },
    }),
  )

  // 休眠门：无授权会话时全部快速拒绝（auth/* 例外，见下）
  router.use((req, res, next) => {
    if (req.path === '/auth/hello' || req.path === '/auth/status') {
      requireAuthWindow(req, res, next)
      return
    }
    requireSyncSession(req, res, next)
  })

  // ---------- S7-05：授权窗内 hello / status（对端登记临时公钥，PC 核对短认证串） ----------
  router.post(
    '/auth/hello',
    withTimeout((req, res) => {
      const body = (req.body ?? {}) as {
        sessionId?: string
        deviceName?: string
        androidPublicKey?: string
      }
      const sessionId = String(body.sessionId ?? '')
      const deviceName = String(body.deviceName ?? '未知设备')
      const androidPublicKey = String(body.androidPublicKey ?? '')
      if (!sessionId || !androidPublicKey) {
        res.status(400).json({ error: 'missing_fields' })
        return
      }
      const st = syncLanAuthService.submitPeerHello({ sessionId, deviceName, androidPublicKey })
      if (st.phase !== 'awaiting_confirm' && st.phase !== 'confirmed') {
        res.status(409).json({ error: 'hello_rejected', phase: st.phase })
        return
      }
      // 回传短认证串供对端展示（与 PC 显示同源）；不回传 secret/私钥
      res.json({
        phase: st.phase,
        shortAuth: st.shortAuth,
        peerDeviceName: st.peerDeviceName,
        expiresAt: st.expiresAt,
      })
    }),
  )

  router.get(
    '/auth/status',
    withTimeout((_req, res) => {
      const st = syncLanAuthService.getStatus()
      res.json({
        phase: st.phase,
        shortAuth: st.shortAuth,
        peerDeviceName: st.peerDeviceName,
        expiresAt: st.expiresAt,
        confirmed: st.phase === 'confirmed',
      })
    }),
  )

  // ---------- session 生命周期 ----------
  router.post(
    '/session',
    withTimeout((req, res) => {
      const body = (req.body ?? {}) as { role?: SessionRole; capabilities?: Partial<typeof DEFAULT_CAPS> }
      const role: SessionRole = body.role === 'pc' ? 'pc' : 'android'
      const rec = syncV1Runtime.createSession(role, 'lan-peer')
      syncV1Runtime.transition(rec.sessionId, 'start_scan')
      const remote = {
        protocolVersion: body.capabilities?.protocolVersion ?? SUPPORTED_PROTOCOL_VERSION,
        features: body.capabilities?.features ?? [],
        schemaVersions: body.capabilities?.schemaVersions ?? {},
      }
      const negotiated = negotiateCapabilities(DEFAULT_CAPS, remote)
      rec.negotiated = negotiated
      res.status(201).json({
        sessionId: rec.sessionId,
        state: rec.state,
        negotiated,
        limits: {
          maxBatchItems: SYNC_BATCH_MAX_ITEMS,
          maxBatchBytes: SYNC_BATCH_MAX_BYTES,
          bodyLimitBytes: 5 * 1024 * 1024,
        },
      })
    }),
  )

  router.get(
    '/session/:sessionId',
    withTimeout((req, res) => {
      const rec = syncV1Runtime.get(req.params.sessionId as string)
      if (!rec) {
        res.status(404).json({ error: 'session_not_found' })
        return
      }
      res.json({
        sessionId: rec.sessionId,
        state: rec.state,
        role: rec.role,
        negotiated: rec.negotiated,
        updatedAt: rec.updatedAt,
        health: getSyncHealth(),
        syncReady: isSyncReady(),
      })
    }),
  )

  router.post(
    '/session/:sessionId/abort',
    withTimeout((req, res) => {
      const sessionId = req.params.sessionId as string
      // abort 任意非终态 → cancelling → cancelled
      const s1 = syncV1Runtime.transition(sessionId, 'cancel')
      if (!s1.ok && !isTerminalSession(s1.state)) {
        res.status(409).json({ error: 'invalid_transition', state: s1.state, reason: s1.reason })
        return
      }
      if (!isTerminalSession(s1.state)) {
        syncV1Runtime.transition(sessionId, 'cancel_done')
      }
      // 清理该会话未提交 staging
      for (const [id, b] of syncV1Runtime.staging) {
        if (b.sessionId === sessionId && b.state !== 'committed') {
          b.state = 'aborted'
          syncV1Runtime.staging.delete(id)
        }
      }
      const rec = syncV1Runtime.get(sessionId)
      res.json({ sessionId, state: rec?.state ?? 'cancelled' })
    }),
  )

  // ---------- plan（只读 dry-run） ----------
  router.post(
    '/session/:sessionId/plan',
    withTimeout((req, res) => {
      const sessionId = req.params.sessionId as string
      const rec = syncV1Runtime.get(sessionId)
      if (!rec) {
        res.status(404).json({ error: 'session_not_found' })
        return
      }
      if (!syncV1Runtime.tryBeginPlan(sessionId)) {
        res.status(429).json({ error: 'plan_concurrency' })
        return
      }
      try {
        const body = (req.body ?? {}) as {
          remoteHeads?: EntityHeadSummary[]
          remoteKnownOfLocal?: VersionVector
          localKnownOfRemote?: VersionVector
        }
        const domain = domainOrNull()
        const localHeads: EntityHeadSummary[] = domain
          ? domain.meta.listHeads(50_000, 0).map(mapHead)
          : []
        const negotiated = rec.negotiated ?? {
          protocolVersion: SUPPORTED_PROTOCOL_VERSION,
          features: [],
          schemaVersions: DEFAULT_CAPS.schemaVersions,
          unsupportedEntityTypes: [],
        }
        const plan: SyncPlan = buildSyncPlan({
          localHeads,
          remoteHeads: body.remoteHeads ?? [],
          localKnownOfRemote: body.localKnownOfRemote,
          remoteKnownOfLocal: body.remoteKnownOfLocal,
          negotiated,
        })
        syncV1Runtime.transition(sessionId, 'plan_ready')
        const rec2 = syncV1Runtime.get(sessionId)
        res.json({
          sessionId,
          state: rec2?.state,
          planId: plan.planId,
          stats: plan.stats,
          itemCount: plan.items.length,
          fingerprint: planFingerprint({
            localKnownOfRemote: body.localKnownOfRemote ?? {},
            remoteKnownOfLocal: body.remoteKnownOfLocal ?? {},
            stats: plan.stats,
          }),
          // 默认不回传明细，除非 ?detail=1（UI 展开冲突时）
          items: req.query.detail === '1' ? plan.items : undefined,
        })
      } finally {
        syncV1Runtime.endPlan(sessionId)
      }
    }),
  )

  // ---------- push：staging only ----------
  router.post(
    '/session/:sessionId/push',
    withTimeout((req, res) => {
      const requestId = reqId(req)
      const sessionId = req.params.sessionId as string
      const rec = syncV1Runtime.get(sessionId)
      if (!rec) {
        res.status(404).json({ error: 'session_not_found' })
        return
      }
      const body = (req.body ?? {}) as {
        batchId?: string
        sequence?: number
        envelopes?: SyncEnvelope[]
      }
      const envelopes = Array.isArray(body.envelopes) ? body.envelopes : []
      const sequence = Number.isFinite(body.sequence) ? Number(body.sequence) : 0
      const batchId = body.batchId || `batch-${requestId}`

      if (envelopes.length > SYNC_BATCH_MAX_ITEMS) {
        res.status(413).json({ error: 'batch_too_many', maxItems: SYNC_BATCH_MAX_ITEMS })
        return
      }
      let byteSize = 0
      for (const env of envelopes) {
        byteSize += JSON.stringify(env).length
      }
      if (byteSize > SYNC_BATCH_MAX_BYTES) {
        res.status(413).json({ error: 'batch_too_large', maxBytes: SYNC_BATCH_MAX_BYTES })
        return
      }

      // 乱序：sequence 必须从 0 递增；未来 sequence 先 409（不提前 apply）
      const expectedSeq = [...syncV1Runtime.staging.values()]
        .filter((b) => b.sessionId === sessionId && b.state === 'staged')
        .length
      if (sequence > expectedSeq) {
        res.status(409).json({ error: 'out_of_order', expectedSeq })
        return
      }

      // 幂等：同 batchId + 同 hash 重放直接 200
      const ordered = sortBatch(envelopes)
      const itemHash = batchHash(ordered)
      for (const b of syncV1Runtime.staging.values()) {
        if (b.batchId === batchId && b.itemHash === itemHash && b.state !== 'aborted') {
          res.status(200).json({ batchId, itemHash, idempotent: true, state: b.state, accepted: b.envelopes.length })
          return
        }
      }

      const staged = syncV1Runtime.stage(sessionId, {
        sessionId,
        batchId,
        sequence,
        itemHash,
        byteSize,
        envelopes: ordered.map((o) => o.envelope),
      })
      // transfer 开始
      if (rec.state === 'awaiting_confirmation' || rec.state === 'plan_ready') {
        syncV1Runtime.transition(sessionId, 'user_confirm')
      }
      res.status(202).json({
        requestId,
        batchId,
        itemHash,
        accepted: staged.envelopes.length,
        state: staged.state,
        idempotent: false,
      })
    }),
  )

  // ---------- prepare：staging → validated/prepared（仍不写业务） ----------
  router.post(
    '/session/:sessionId/prepare',
    withTimeout((req, res) => {
      const sessionId = req.params.sessionId as string
      const rec = syncV1Runtime.get(sessionId)
      if (!rec) {
        res.status(404).json({ error: 'session_not_found' })
        return
      }
      const body = (req.body ?? {}) as { batchIds?: string[] }
      const ids = body.batchIds ?? [...syncV1Runtime.staging.values()].filter((b) => b.sessionId === sessionId).map((b) => b.batchId)
      const prepared: string[] = []
      for (const id of ids) {
        const b = syncV1Runtime.staging.get(id)
        if (!b || b.sessionId !== sessionId || b.state === 'aborted' || b.state === 'committed') continue
        b.state = 'prepared'
        prepared.push(id)
      }
      syncV1Runtime.transition(sessionId, 'validate')
      syncV1Runtime.transition(sessionId, 'prepare')
      res.json({ sessionId, state: syncV1Runtime.get(sessionId)?.state, prepared })
    }),
  )

  // ---------- commit：幂等；响应丢失可重放同一 receipt ----------
  router.post(
    '/session/:sessionId/commit',
    withTimeout((req, res) => {
      const requestId = reqId(req)
      const sessionId = req.params.sessionId as string
      const rec = syncV1Runtime.get(sessionId)
      if (!rec) {
        res.status(404).json({ error: 'session_not_found' })
        return
      }
      const body = (req.body ?? {}) as {
        batchId?: string
        peerId?: string
        cursor?: number
        knownVector?: VersionVector
      }
      const batchId = body.batchId
      if (!batchId) {
        res.status(400).json({ error: 'missing_batchId' })
        return
      }

      // commit 响应丢失恢复：已存在 receipt 则原样返回，不重应用
      for (const r of syncV1Runtime.receipts.values()) {
        if (r.sessionId === sessionId && r.batchId === batchId) {
          res.status(200).json({ receipt: r, idempotent: true })
          return
        }
      }

      const staged = syncV1Runtime.staging.get(batchId)
      if (!staged || staged.sessionId !== sessionId) {
        res.status(404).json({ error: 'batch_not_staged' })
        return
      }
      if (staged.state === 'committed') {
        // 防御：staging 已提交但 receipt 丢失
        res.status(200).json({ receipt: null, idempotent: true, state: 'committed' })
        return
      }
      if (staged.state !== 'prepared' && staged.state !== 'staged') {
        res.status(409).json({ error: 'invalid_batch_state', state: staged.state })
        return
      }

      if (!syncV1Runtime.tryBeginApply(sessionId)) {
        res.status(429).json({ error: 'apply_inflight' })
        return
      }
      try {
        syncV1Runtime.transition(sessionId, 'commit')
        const domain = domainOrNull()
        if (!domain) {
          syncV1Runtime.transition(sessionId, 'fail_non_retryable')
          res.status(503).json({ error: 'sync_domain_unavailable' })
          return
        }
        const summary = applyRemoteBatch(domain.meta, domain.userDataDir, staged.envelopes, {
          peerId: body.peerId ?? rec.peerId,
          cursor: body.cursor ?? 0,
          knownVector: body.knownVector,
          expectedHashesByEntityId: Object.fromEntries(staged.envelopes.map((e) => [e.entityId, e.contentHash])),
        })
        const receipt: CommitReceipt = {
          receiptId: `receipt-${createHash('sha256').update(idempotentKey(batchId, staged.itemHash)).digest('hex').slice(0, 16)}`,
          sessionId,
          batchId,
          sequence: staged.sequence,
          batchHash: staged.itemHash,
          committedAt: Date.now(),
          applied: summary.applied,
          conflicts: summary.conflicts,
          rejected: summary.rejected.length,
        }
        syncV1Runtime.receipts.set(receipt.receiptId, receipt)
        staged.state = 'committed'
        syncV1Runtime.transition(sessionId, 'apply_local')
        syncV1Runtime.transition(sessionId, 'mark_completed')
        res.json({
          requestId,
          receipt,
          idempotent: false,
          state: syncV1Runtime.get(sessionId)?.state,
          apply: {
            applied: summary.applied,
            conflicts: summary.conflicts,
            rejected: summary.rejected.map((r) => ({ entityId: r.entityId, code: r.code })),
            checkpointId: summary.checkpointId,
            receiptSaved: summary.receiptSaved,
          },
        })
      } finally {
        syncV1Runtime.endApply(sessionId)
      }
    }),
  )

  // ---------- receipt 查询（响应丢失恢复） ----------
  router.get(
    '/session/:sessionId/receipt/:batchId',
    withTimeout((req, res) => {
      const sessionId = req.params.sessionId as string
      const batchId = req.params.batchId as string
      for (const r of syncV1Runtime.receipts.values()) {
        if (r.sessionId === sessionId && r.batchId === batchId) {
          res.json({ receipt: r })
          return
        }
      }
      res.status(404).json({ error: 'receipt_not_found' })
    }),
  )

  // ---------- pull：下载本端变更（分页 heads） ----------
  router.get(
    '/session/:sessionId/pull',
    withTimeout((req, res) => {
      const sessionId = req.params.sessionId as string
      const rec = syncV1Runtime.get(sessionId)
      if (!rec) {
        res.status(404).json({ error: 'session_not_found' })
        return
      }
      const domain = domainOrNull()
        const offset = Number(req.query.offset ?? 0) || 0
        const limit = Math.min(Number(req.query.limit ?? 200) || 200, SYNC_BATCH_MAX_ITEMS)
        const heads = domain ? domain.meta.listHeads(limit, offset).map(mapHead) : []
        res.json({
          sessionId,
          offset,
          limit,
          count: heads.length,
          hasMore: heads.length === limit,
          heads,
        })
    }),
  )

  // ---------- blob 占位（阶段 7 blob 通道后续） ----------
  router.put(
    '/session/:sessionId/blob/:blobId',
    withTimeout((req, res) => {
      res.status(501).json({ error: 'blob_not_implemented', note: 'media_manifest/blob 通道见后续工作包' })
    }),
  )

  return router
}

/** 挂载到 Bridge express app（server.ts 调用） */
export function mountSyncV1(app: { use: (path: string, router: Router) => void }, opts?: { bodyLimit?: string }): void {
  // body 解析在 server 层统一 json({limit}); 此处仅文档化独立上限常量
  void opts
  void BODY_LIMIT
  app.use('/sync/v1', buildSyncV1Router())
}

/** 测试钩子 */
export function resetSyncV1ForTest(): void {
  syncV1Runtime.resetForTests()
}
