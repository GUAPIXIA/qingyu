/**
 * 阶段 7 S7-01：Sync Core 跨语言 golden 生成器与一致性守卫。
 *
 * oracle 是 `shared/sync-core/**`（TS 实现）。Kotlin `SyncCoreGoldenTest` 读取同一份
 * fixture 断言相等。默认只读校验；SYNC_CORE_UPDATE_FIXTURES=1 时重生成。
 *
 *   $env:SYNC_CORE_UPDATE_FIXTURES=1; pnpm exec vitest run shared/__tests__/syncCoreGolden.test.ts
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { buildSyncPlan, headsRootHash } from '../sync-core/plan'
import {
  sortBatch,
  batchPhaseOf,
  batchHash,
  receiptHash,
  idempotentKey,
  splitBatches,
} from '../sync-core/batch'
import { suggestConflictResolution, canBatchResolve, buildResolutionRecord } from '../sync-core/conflictSuggest'
import { canCompactTombstone, tombstoneDryRun } from '../sync-core/tombstone'
import { negotiateCapabilities, isProtocolCompatible } from '../sync-core/capability'
import { transitionSession, isTerminalSession, isReadOnlyPhase } from '../sync-core/sessionMachine'
import {
  assertSameGenesis,
  resolvePseudoOrConflict,
  checkBatchDependencies,
} from '../sync-core/dependency'
import {
  buildLanAuthTranscript,
  buildLanSyncQrPayload,
  deriveLanSessionKeys,
  deriveShortAuthString,
  lanAuthTranscriptHash,
  parseLanSyncQr,
} from '../sync-core/lanAuth'
import { makeEnvelope } from '../contracts/sync-envelope'
import { contentHash } from '../contracts/canonical-json'
import type { EntityHeadSummary } from '../sync-core/types'

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'cross-platform', 'sync-core')
const UPDATE = process.env.SYNC_CORE_UPDATE_FIXTURES === '1'

function assertJsonRoundTrippable(value: unknown, path: string, insideArray: boolean): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('fixture 不可往返：' + path + ' 是非有限数')
    }
    return
  }
  if (value === undefined) {
    if (insideArray) throw new Error('fixture 不可往返：' + path + ' 是数组中的 undefined')
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonRoundTrippable(item, path + '[' + index + ']', true))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertJsonRoundTrippable(item, path + '.' + key, false)
    }
  }
}

function writeOrCheck(name: string, data: unknown): void {
  assertJsonRoundTrippable(data, name, false)
  const file = join(FIXTURE_DIR, name)
  mkdirSync(dirname(file), { recursive: true })
  const text = JSON.stringify(data, null, 2) + '\n'
  if (UPDATE) {
    writeFileSync(file, text, 'utf8')
    return
  }
  if (!existsSync(file)) {
    throw new Error('缺少 golden：' + file + '。请设 SYNC_CORE_UPDATE_FIXTURES=1 生成。')
  }
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(text))
}

function head(partial: Partial<EntityHeadSummary> & { entityType: string; entityId: string }): EntityHeadSummary {
  return {
    version: {},
    contentHash: 'sha256:' + 'a'.repeat(64),
    deleted: false,
    parentId: null,
    schemaVersion: 1,
    updatedAt: 1000,
    ...partial,
  }
}

describe('sync-core golden', () => {
  it('plan.json — 双方 heads 分类', () => {
    const local: EntityHeadSummary[] = [
      head({ entityType: 'character', entityId: 'c1', version: { pc: '1' }, contentHash: contentHash({ name: 'A' }) }),
      head({ entityType: 'character', entityId: 'c2', version: { pc: '2' }, contentHash: contentHash({ name: 'B' }) }),
      head({ entityType: 'message', entityId: 'm1', version: { pc: '1' }, contentHash: contentHash({ text: 'hi' }), parentId: 's1' }),
      head({ entityType: 'message', entityId: 'm2', version: { pc: '3', and: '1' }, contentHash: contentHash({ text: 'local' }), parentId: 's1' }),
      head({ entityType: 'message', entityId: 'm3', version: { pc: '1' }, contentHash: contentHash({ text: 'same' }), parentId: 's1' }),
    ]
    const remote: EntityHeadSummary[] = [
      head({ entityType: 'character', entityId: 'c1', version: { pc: '1', and: '1' }, contentHash: contentHash({ name: 'A' }) }),
      head({ entityType: 'character', entityId: 'c3', version: { and: '1' }, contentHash: contentHash({ name: 'C' }) }),
      head({ entityType: 'message', entityId: 'm2', version: { pc: '1', and: '2' }, contentHash: contentHash({ text: 'remote' }), parentId: 's1' }),
      head({ entityType: 'message', entityId: 'm3', version: { pc: '1', and: '1' }, contentHash: contentHash({ text: 'same' }), parentId: 's1' }),
      head({ entityType: 'message', entityId: 'm4', version: { and: '1' }, contentHash: contentHash({ text: 'old' }), parentId: 's1', schemaVersion: 2 }),
    ]
    const negotiated = {
      protocolVersion: 1,
      features: ['lan'],
      schemaVersions: { character: 3, message: 1, session: 1, group: 1 },
      unsupportedEntityTypes: ['media_manifest'],
    }
    const plan = buildSyncPlan({
      localHeads: local,
      remoteHeads: remote,
      negotiated,
      localKnownOfRemote: { and: '1' },
      remoteKnownOfLocal: { pc: '1' },
      sizeOf: (h) => h.entityId.length * 10,
    })
    writeOrCheck('plan.json', {
      buckets: plan.items.map((i) => ({
        entityType: i.entityType,
        entityId: i.entityId,
        bucket: i.bucket,
        conflictKind: i.conflictKind ?? null,
        unknownSchemaReason: i.unknownSchemaReason ?? null,
      })),
      stats: plan.stats,
      // planId 含哈希，Kotlin 侧只要重算 planFingerprint 即可对齐
      planId: plan.planId,
      rootLocal: headsRootHash(local),
      rootRemote: headsRootHash(remote),
    })
  })

  it('batch.json — 排序/相位/哈希/切批/幂等 key', () => {
    const mk = (
      entityType: string,
      entityId: string,
      opts: { parentId?: string | null; deleted?: boolean; refs?: string[] },
    ) =>
      makeEnvelope({
        entityType: entityType as never,
        entityId,
        payload: { id: entityId },
        deviceId: 'pc_a',
        previousVersion: { pc_a: '0' },
        parentId: opts.parentId ?? null,
        deleted: opts.deleted ?? false,
        references: opts.refs,
        updatedAt: 1,
      })
    const envelopes = [
      mk('message', 'm-child', { parentId: 's1' }),
      mk('character', 'c-top', {}),
      mk('session', 's1', { parentId: 'c-top' }),
      mk('message', 'm-dead', { parentId: 's1', deleted: true }),
      mk('persona', 'p-ref', { refs: ['c-top'] }),
    ]
    const ordered = sortBatch(envelopes)
    const batches = splitBatches(ordered, {
      maxCount: 2,
      sizeOf: (_item) => 100,
    })
    writeOrCheck('batch.json', {
      order: ordered.map((o) => ({
        phase: o.phase,
        entityType: o.entityType,
        entityId: o.entityId,
      })),
      phases: envelopes.map((e) => batchPhaseOf(e)),
      batchHash: batchHash(ordered),
      receiptHash: receiptHash({
        batchHash: batchHash(ordered),
        localKnown: { pc_a: '1' },
        remoteKnown: { android_b: '1' },
        protocolVersion: 1,
      }),
      idempotentKey: idempotentKey('sess-1', 'batch-0'),
      batchSizes: batches.map((b) => b.length),
    })
  })

  it('conflict.json — UI 建议与批量规则', () => {
    writeOrCheck('conflict.json', {
      suggest: {
        version_concurrent: suggestConflictResolution('version_concurrent'),
        delete_vs_modify: suggestConflictResolution('delete_vs_modify'),
        dependency: suggestConflictResolution('dependency'),
      },
      canBatch: {
        empty: canBatchResolve([]),
        allConcurrent: canBatchResolve(['version_concurrent', 'version_concurrent']),
        mixed: canBatchResolve(['version_concurrent', 'delete_vs_modify']),
      },
      resolution: buildResolutionRecord({
        conflictId: 'c-1',
        choice: 'local',
        localHash: contentHash({ a: 1 }),
        remoteHash: contentHash({ a: 2 }),
        resolvedAt: 1700000000000,
      }),
    })
  })

  it('tombstone.json — 可压缩判断与 dry-run', () => {
    const t = {
      entityType: 'character',
      entityId: 'c1',
      deletedAt: 1000,
      version: { pc: '3' } as Record<string, string>,
    }
    const devices = [
      { deviceId: 'pc', known: { pc: '3' } as Record<string, string>, retired: false },
      { deviceId: 'and', known: { pc: '3', and: '1' } as Record<string, string>, retired: false },
      { deviceId: 'old', known: {} as Record<string, string>, retired: true },
    ]
    const policy = { retainDays: 180, now: 1000 + 181 * 86_400_000 }
    writeOrCheck('tombstone.json', {
      allAckedAndAged: canCompactTombstone(t, devices, policy),
      allAckedButWindow: canCompactTombstone(t, devices, { retainDays: 180, now: 1000 + 10 * 86_400_000 }),
      pendingDevice: canCompactTombstone(t, [...devices, { deviceId: 'lag', known: { lag: '1' } as Record<string, string>, retired: false }], policy),
      onlyRetired: canCompactTombstone(
        t,
        [{ deviceId: 'old', known: {} as Record<string, string>, retired: true }],
        { retainDays: 180, now: 1000 + 200 * 86_400_000 },
      ),
      dryRun: tombstoneDryRun(
        [t, { ...t, entityId: 'c2', version: { pc: '1' } as Record<string, string> }],
        [...devices, { deviceId: 'lag', known: { lag: '1' } as Record<string, string>, retired: false }],
        policy,
      ),
    })
  })

  it('capability.json — 协商', () => {
    const local = {
      protocolVersion: 1,
      features: ['lan', 'e2ee', 'blob_v1'],
      schemaVersions: { character: 3, message: 1, session: 1 },
    }
    const remote = {
      protocolVersion: 1,
      features: ['lan', 'blob_v1', 'future_x'],
      schemaVersions: { character: 2, message: 2, group: 1 },
    }
    writeOrCheck('capability.json', {
      negotiated: negotiateCapabilities(local, remote),
      protocolOk: isProtocolCompatible(1, 1),
      protocolOld: isProtocolCompatible(1, 0),
    })
  })

  it('session.json — 状态机', () => {
    const walk: Array<[string, string]> = [
      ['idle', 'start_scan'],
      ['scanning', 'plan_ready'],
      ['plan_ready', 'await_confirmation'],
      ['awaiting_confirmation', 'user_confirm'],
      ['transferring', 'validate'],
      ['validating', 'prepare'],
      ['prepared', 'commit'],
      ['committing', 'apply_local'],
      ['applying_local', 'mark_completed'],
      ['completed', 'start_scan'],
      ['idle', 'cancel'],
      ['scanning', 'cancel'],
      ['cancelling', 'cancel_done'],
      ['cancelled', 'start_scan'],
    ]
    writeOrCheck('session.json', {
      walk: walk.map(([from, ev]) => ({
        from,
        event: ev,
        result: transitionSession(from as never, ev as never),
      })),
      terminal: {
        completed: isTerminalSession('completed'),
        cancelled: isTerminalSession('cancelled'),
        failed: isTerminalSession('failed'),
      },
      readOnly: {
        scanning: isReadOnlyPhase('scanning'),
        plan_ready: isReadOnlyPhase('plan_ready'),
        transferring: isReadOnlyPhase('transferring'),
      },
    })
  })

  it('dependency.json — genesis / 伪冲突 / delete fence', () => {
    const localEnv = makeEnvelope({
      entityType: 'character',
      entityId: 'c1',
      payload: { name: 'X' },
      deviceId: 'pc_a',
      previousVersion: { pc_a: '1' },
      updatedAt: 5,
    })
    // 同 hash 并发
    const remoteSame = makeEnvelope({
      entityType: 'character',
      entityId: 'c1',
      payload: { name: 'X' },
      deviceId: 'android_b',
      previousVersion: { android_b: '1' },
      updatedAt: 6,
    })
    const remoteDiff = makeEnvelope({
      entityType: 'character',
      entityId: 'c1',
      payload: { name: 'Y' },
      deviceId: 'android_b',
      previousVersion: { android_b: '1' },
      updatedAt: 6,
    })
    const child = makeEnvelope({
      entityType: 'message',
      entityId: 'm1',
      payload: { text: 'hi' },
      deviceId: 'android_b',
      parentId: 's-dead',
      previousVersion: {},
      updatedAt: 1,
    })
    const fences = [
      {
        aggregateType: 'session',
        aggregateId: 's-dead',
        deletedAt: 1,
        fenceVersion: { pc: '9' },
      },
    ]
    writeOrCheck('dependency.json', {
      genesisSame: assertSameGenesis(
        { genesisId: 'g1', createdAt: 1, platform: 'pc', datasetHash: 'h1' },
        { genesisId: 'g1', createdAt: 1, platform: 'android', datasetHash: 'h1' },
      ),
      genesisDiff: assertSameGenesis(
        { genesisId: 'g1', createdAt: 1, platform: 'pc', datasetHash: 'h1' },
        { genesisId: 'g2', createdAt: 1, platform: 'android', datasetHash: 'h1' },
      ),
      pseudoSame: (() => {
        const r = resolvePseudoOrConflict({
          local: localEnv,
          remote: remoteSame,
          deviceId: 'pc_a',
          now: 99,
        })
        return {
          action: r.action,
          version: r.converged?.version ?? null,
          contentHash: r.converged?.contentHash ?? null,
        }
      })(),
      notPseudo: resolvePseudoOrConflict({
        local: localEnv,
        remote: remoteDiff,
        deviceId: 'pc_a',
        now: 99,
      }).action,
      fence: checkBatchDependencies([child], fences).map((r) => ({
        ok: r.ok,
        code: r.ok ? null : r.code,
        fenceAggregateId: r.ok ? null : r.fenceAggregateId,
      })),
    })
  })

  it('lanAuth.json — transcript / 短认证串 / HKDF / QR', () => {
    const NOW = 1_788_000_300_000
    const PC_PUB = Buffer.alloc(32, 0x11).toString('base64')
    const AND_PUB = Buffer.alloc(32, 0x22).toString('base64')
    const SECRET = Buffer.alloc(32, 0xab).toString('base64')
    const shared = Buffer.alloc(32, 0x55)
    const base = {
      sessionId: 'sess-lan-001',
      host: '192.168.1.8',
      port: 8321,
      fingerprint: 'fp-abc123',
      expiresAt: NOW + 5 * 60_000,
      secret: SECRET,
      pcPublicKey: PC_PUB,
      androidPublicKey: AND_PUB,
    }
    const transcript = buildLanAuthTranscript(base)
    const shortAuth = deriveShortAuthString(transcript)
    const keys = deriveLanSessionKeys({ sharedSecret: shared, transcript })
    const qr = buildLanSyncQrPayload({
      host: base.host,
      port: base.port,
      sessionId: base.sessionId,
      pcPublicKey: PC_PUB,
      secret: SECRET,
      expiresAt: base.expiresAt,
      fingerprint: base.fingerprint,
      displayName: '我的电脑',
    })
    writeOrCheck('lanAuth.json', {
      transcript,
      transcriptHash: lanAuthTranscriptHash(transcript),
      shortAuth,
      keys,
      qr,
      parseOk: parseLanSyncQr(JSON.stringify(qr), NOW),
      parseExpired: parseLanSyncQr(JSON.stringify({ ...qr, expiresAt: NOW }), NOW),
      shortAuthSessionB: deriveShortAuthString(buildLanAuthTranscript({ ...base, sessionId: 'sess-lan-002' })),
    })
  })
})
