/**
 * 阶段 2 S2-06：远端批次 staging 应用器。
 *
 * 时序：
 *   1. 整批预检：ID / schema / contentHash / 版本因果 / 引用与 delete fence
 *   2. 生成文件修改计划（materializer），记录 checkpoint（计划 + 涉及路径）
 *   3. 单个跨存储事务应用全部文件 + head + change_log（origin='remote'）
 *   4. 提交 receipt（对端游标 + 已知版本向量）
 *   5. 任一步失败：事务自动回滚磁盘与 journal，不推进游标，冲突/拒绝进报告
 *
 * 远端信封保留其自带 version/dot，不分配本机 counter，也不产生回传回声。
 */
import { createHash } from 'node:crypto'
import { compareVectors, mergeVectors, emptyVector, type VersionVector } from '../../shared/contracts/version-vector'
import type { SyncEnvelope } from '../../shared/contracts/sync-envelope'
import { contentHash, type CanonicalJsonValue } from '../../shared/contracts/canonical-json'
import { checkDependencyAgainstFences, type DeleteFence } from '../../shared/contracts/conflict'
import type { SyncMetaDb } from './syncMeta'
import { MATERIALIZERS } from './remoteMaterializers'
import { runFileTransaction } from './fileTransaction'
import type { DomainWriteFile } from './types'
import { safeId } from '../utils/pathGuard'

export interface ApplyRemoteOptions {
  /** 按 entityId 提供的密文/期望哈希；提供时必须与解密后的 contentHash 一致 */
  expectedHashesByEntityId?: Record<string, string>
  /** 显式 fence；未提供时由本地 tombstone head 自动推导 */
  fences?: DeleteFence[]
  /** 对端标识，用于写 receipt */
  peerId?: string
  /** 对端已提交游标 */
  cursor?: number
  /** 本次双方汇总的已知版本向量 */
  knownVector?: VersionVector
}

export type RejectCode =
  | 'INVALID_ENVELOPE'
  | 'UNKNOWN_ENTITY_TYPE'
  | 'HASH_MISMATCH'
  | 'DEPENDENCY_CONFLICT'
  | 'UNSUPPORTED_ENTITY'

export interface ApplyRemoteSummary {
  applied: number
  conflicts: number
  rejected: Array<{ entityId: string; code: RejectCode; message: string }>
  /** 未落盘但已记录的实体（如 usage_clear_marker） */
  journalOnly: string[]
  checkpointId: string | null
  txId: string | null
  receiptSaved: boolean
}

/** 由本地 tombstone head 推导 delete fence（父实体删除后禁止远端写入存活子实体） */
export function deriveFencesFromHeads(meta: SyncMetaDb): DeleteFence[] {
  const fences: DeleteFence[] = []
  for (const head of meta.listDeletedHeads()) {
    let version: VersionVector = emptyVector()
    try {
      version = JSON.parse(head.versionJson) as VersionVector
    } catch {
      /* 损坏版本向量按空处理，仍作为 fence 存在 */
    }
    fences.push({
      aggregateType: head.entityType,
      aggregateId: head.entityId,
      deletedAt: Date.now(),
      fenceVersion: version,
    })
  }
  return fences
}

export function applyRemoteBatch(
  meta: SyncMetaDb,
  userDataDir: string,
  batch: SyncEnvelope[],
  opts: ApplyRemoteOptions = {},
): ApplyRemoteSummary {
  const rejected: ApplyRemoteSummary['rejected'] = []
  let conflictCount = 0
  const journalOnly: string[] = []
  const fences = opts.fences ?? deriveFencesFromHeads(meta)

  // ---------- 1) 整批预检 ----------
  const accepted: SyncEnvelope[] = []
  for (const env of batch) {
    try {
      safeId(env.entityId)
    } catch {
      rejected.push({
        entityId: String(env.entityId).slice(0, 40),
        code: 'INVALID_ENVELOPE',
        message: '非法 entityId',
      })
      continue
    }
    if (!(env.entityType in MATERIALIZERS)) {
      rejected.push({ entityId: env.entityId, code: 'UNKNOWN_ENTITY_TYPE', message: `未知实体类型 ${env.entityType}` })
      continue
    }
    const expected = opts.expectedHashesByEntityId?.[env.entityId]
    if (expected && expected !== env.contentHash) {
      rejected.push({ entityId: env.entityId, code: 'HASH_MISMATCH', message: '与传输哈希不一致' })
      continue
    }
    const businessPayload = env.deleted ? {} : env.payload
    const computed = contentHash(businessPayload as CanonicalJsonValue)
    if (computed !== env.contentHash) {
      rejected.push({ entityId: env.entityId, code: 'HASH_MISMATCH', message: 'payload contentHash 不匹配' })
      continue
    }
    const dep = checkDependencyAgainstFences(env, fences)
    if (!dep.ok) {
      rejected.push({
        entityId: env.entityId,
        code: 'DEPENDENCY_CONFLICT',
        message: `父实体/引用已被删除：${dep.fence.aggregateType}:${dep.fence.aggregateId}`,
      })
      continue
    }
    accepted.push(env)
  }

  // ---------- 2) 版本因果分类 ----------
  const toApply: SyncEnvelope[] = []
  for (const env of accepted) {
    const head = meta.getHead(env.entityType, env.entityId)
    if (!head) {
      toApply.push(env)
      continue
    }
    const localVersion = JSON.parse(head.versionJson) as VersionVector
    const rel = compareVectors(localVersion, env.version)
    if (rel === 'equal' || rel === 'dominates') continue
    if (rel === 'dominated') {
      toApply.push(env)
      continue
    }
    // concurrent：业务哈希与删除位相同 → 伪冲突收敛，不打扰用户
    if (head.hash === env.contentHash && head.deleted === (env.deleted ? 1 : 0)) {
      const merged = mergeVectors(localVersion, env.version)
      meta.upsertHead({
        entityType: env.entityType,
        entityId: env.entityId,
        versionJson: JSON.stringify(merged),
        hash: env.contentHash,
        deleted: head.deleted,
        payloadRef: head.payloadRef,
      })
      continue
    }
    meta.insertConflict({
      id: `conflict-${env.entityType}-${env.entityId}-${Date.now()}`,
      entityType: env.entityType,
      entityId: env.entityId,
      localEnvelope: { versionJson: head.versionJson, hash: head.hash, deleted: head.deleted },
      remoteEnvelope: env,
    })
    conflictCount += 1
  }

  if (toApply.length === 0) {
    return {
      applied: 0,
      conflicts: conflictCount,
      rejected,
      journalOnly,
      checkpointId: null,
      txId: null,
      receiptSaved: false,
    }
  }

  // ---------- 3) 文件修改计划 ----------
  const byType = new Map<string, SyncEnvelope[]>()
  for (const env of toApply) {
    const list = byType.get(env.entityType) ?? []
    list.push(env)
    byType.set(env.entityType, list)
  }

  const files: DomainWriteFile[] = []
  const materialized: SyncEnvelope[] = []
  for (const [entityType, envelopes] of byType) {
    const materializer = MATERIALIZERS[entityType as SyncEnvelope['entityType']]
    const result = materializer({ userDataDir, envelopes })
    files.push(...result.files)
    const unsupportedIds = new Set(result.unsupported.map((u) => u.entityId))
    for (const u of result.unsupported) {
      rejected.push({ entityId: u.entityId, code: 'UNSUPPORTED_ENTITY', message: u.reason })
    }
    for (const env of envelopes) {
      if (unsupportedIds.has(env.entityId)) continue
      if (result.files.length === 0) {
        // 无需改文件的实体（如 usage_clear_marker）：仍记 head/journal，但明确归类
        journalOnly.push(env.entityId)
      }
      materialized.push(env)
    }
  }

  if (materialized.length === 0) {
    return {
      applied: 0,
      conflicts: conflictCount,
      rejected,
      journalOnly,
      checkpointId: null,
      txId: null,
      receiptSaved: false,
    }
  }

  // ---------- 4) checkpoint（应用前的计划证据） ----------
  const planHash = `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        entities: materialized.map((e) => `${e.entityType}:${e.entityId}:${e.contentHash}`).sort(),
        files: files.map((f) => f.path).sort(),
      }),
    )
    .digest('hex')}`
  const checkpointId = `checkpoint-remote-${Date.now()}`
  meta.saveCheckpoint({
    id: checkpointId,
    reason: 'remote_apply',
    path: files.map((f) => f.path).join(';').slice(0, 4000) || null,
    hash: planHash,
  })

  // ---------- 5) 单个跨存储事务应用 ----------
  // 同一实体类型可能对应完全相同的目标文件；去重避免同一文件被写入两次
  const dedupedFiles = [...new Map(files.map((f) => [f.path, f])).values()]
  const { txId } = applyThroughTransaction({ meta, userDataDir, envelopes: materialized, files: dedupedFiles })

  // ---------- 6) receipt ----------
  let receiptSaved = false
  const peerId = opts.peerId ?? 'remote'
  try {
    const knownVector = opts.knownVector ?? materialized.reduce<VersionVector>((acc, env) => mergeVectors(acc, env.version), emptyVector())
    meta.saveReceipt({ peerId, cursor: opts.cursor ?? 0, knownVector })
    receiptSaved = true
  } catch {
    receiptSaved = false
  }

  return {
    applied: materialized.length,
    conflicts: conflictCount,
    rejected,
    journalOnly,
    checkpointId,
    txId,
    receiptSaved,
  }
}

/**
 * 通过底层事务执行远端应用。失败时 fileTransaction 会回滚磁盘并标记 ABORTED，异常向上抛出。
 */
function applyThroughTransaction(input: {
  meta: SyncMetaDb
  userDataDir: string
  envelopes: SyncEnvelope[]
  files: DomainWriteFile[]
}): { txId: string } {
  const txId = `tx-remote-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  runFileTransaction({
    meta: input.meta,
    userDataDir: input.userDataDir,
    id: txId,
    kind: input.envelopes.some((e) => e.deleted) ? 'tombstone' : 'put',
    envelopes: input.envelopes,
    writes: input.files.map((f) => ({ path: f.path, content: f.content })),
    commitJournal: () => {
      for (const envelope of input.envelopes) {
        input.meta.upsertHead({
          entityType: envelope.entityType,
          entityId: envelope.entityId,
          versionJson: JSON.stringify(envelope.version),
          hash: envelope.contentHash,
          deleted: envelope.deleted ? 1 : 0,
          payloadRef: null,
        })
        input.meta.appendChange({
          dotDevice: envelope.dot.deviceId,
          dotCounter: envelope.dot.counter,
          entityType: envelope.entityType,
          entityId: envelope.entityId,
          envelope,
          origin: 'remote',
        })
      }
    },
  })
  return { txId }
}
