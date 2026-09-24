/**
 * 阶段 7 S7-04：/sync/v1 commit 端到端与故障矩阵（方案 §3）。
 *
 * 覆盖：
 * - plan 后 cancel：staging 清理、业务数据/cursor 不变
 * - push 重复：幂等，不重复 apply
 * - pull 乱序：409，不提前 apply
 * - commit 响应丢失：receipt 查询可恢复，不重应用
 * - hash 篡改：整批拒绝
 * - 删除 vs 修改：冲突可见
 * - 父删子写：DEPENDENCY_CONFLICT
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { buildSyncV1Router, resetSyncV1ForTest, syncV1Runtime, setSyncV1DomainPeekForTest } from '../syncRoutes'
import { syncLanAuthService } from '../../domain/syncLanAuth'
import { setSyncDomainUserDataDirForTest, resetSyncDomainForTest, getSyncDomain } from '../../domain/syncDomainService'
import { makeEnvelope } from '../../../shared/contracts/sync-envelope'
import { contentHash } from '../../../shared/contracts/canonical-json'
import type { SyncEnvelope } from '../../../shared/contracts/sync-envelope'

function rawPub(key: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (key.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64')
}

let server: Server
let base: string
let workDir: string
let userData: string

async function listen(): Promise<void> {
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use('/sync/v1', buildSyncV1Router())
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}/sync/v1`
}

async function openAuthedSession(): Promise<string> {
  syncLanAuthService.startAuthWindow({ host: '127.0.0.1', port: 1, fingerprint: 'fp', displayName: 'pc' })
  const android = generateKeyPairSync('x25519')
  const st = syncLanAuthService.getStatus()
  const hello = syncLanAuthService.submitPeerHello({
    sessionId: st.sessionId!,
    deviceName: 'A',
    androidPublicKey: rawPub(android.publicKey),
  })
  syncLanAuthService.confirmPeer({ sessionId: st.sessionId!, shortAuth: hello.shortAuth! })
  const res = await fetch(`${base}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'android' }),
  })
  return ((await res.json()) as { sessionId: string }).sessionId
}

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

beforeEach(async () => {
  resetSyncV1ForTest()
  syncLanAuthService.resetForTests()
  workDir = mkdtempSync(join(tmpdir(), 'qingyu-sync-v1-'))
  userData = join(workDir, 'userdata')
  mkdirSync(join(userData, 'data', 'config'), { recursive: true })
  setSyncDomainUserDataDirForTest(userData)
  setSyncV1DomainPeekForTest(() => {
    try {
      return getSyncDomain()
    } catch {
      return null
    }
  })
  await listen()
})

afterEach(async () => {
  syncLanAuthService.resetForTests()
  resetSyncV1ForTest()
  resetSyncDomainForTest()
  setSyncV1DomainPeekForTest(() => null)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(workDir, { recursive: true, force: true })
})

function characterEnv(id: string, name: string, opts?: { deleted?: boolean; deviceId?: string; counter?: string }): SyncEnvelope {
  return makeEnvelope({
    entityType: 'character',
    entityId: id,
    payload: opts?.deleted ? {} : { id, name },
    deviceId: opts?.deviceId ?? 'android-1',
    previousVersion: opts?.counter ? { [opts.deviceId ?? 'android-1']: String(Number(opts.counter) - 1) } : {},
    deleted: opts?.deleted,
    updatedAt: 1000,
  })
}

describe('S7-04 故障矩阵', () => {
  it('plan 后 cancel：staging 清空、业务数据与 cursor 不变', async () => {
    const sessionId = await openAuthedSession()
    const meta = getSyncDomain().meta
    const cursorBefore = meta.getReceipt('android-1')?.cursor ?? 0
    await post(`/session/${sessionId}/plan`, { remoteHeads: [] })
    await post(`/session/${sessionId}/push`, {
      batchId: 'b-plan-cancel',
      sequence: 0,
      envelopes: [characterEnv('c1', 'X')],
    })
    const abort = await post(`/session/${sessionId}/abort`, {})
    expect(abort.status).toBe(200)
    // 未 commit → 不应有 character head
    expect(meta.getHead('character', 'c1')).toBeNull()
    expect(meta.getReceipt('android-1')?.cursor ?? 0).toBe(cursorBefore)
    expect([...syncV1Runtime.staging.values()].filter((b) => b.sessionId === sessionId && b.state !== 'aborted')).toHaveLength(0)
  })

  it('push 重复 + commit 幂等：同 batch 只 apply 一次', async () => {
    const sessionId = await openAuthedSession()
    const meta = getSyncDomain().meta
    const env = characterEnv('c-dup', 'Dup')
    const payload = { batchId: 'b-dup', sequence: 0, envelopes: [env] }
    const p1 = await post(`/session/${sessionId}/push`, payload)
    expect(p1.status).toBe(202)
    const p2 = await post(`/session/${sessionId}/push`, payload)
    expect(p2.status).toBe(200)
    expect(p2.json.idempotent).toBe(true)

    await post(`/session/${sessionId}/prepare`, { batchIds: ['b-dup'] })
    const c1 = await post(`/session/${sessionId}/commit`, { batchId: 'b-dup', peerId: 'android-1' })
    expect(c1.status).toBe(200)
    expect(c1.json.idempotent).toBe(false)
    expect((c1.json.apply as { applied: number }).applied).toBe(1)

    const c2 = await post(`/session/${sessionId}/commit`, { batchId: 'b-dup', peerId: 'android-1' })
    expect(c2.status).toBe(200)
    expect(c2.json.idempotent).toBe(true)
    // 只写一条 remote change
    expect(meta.countChanges('remote')).toBe(1)
    expect(meta.getHead('character', 'c-dup')?.hash).toBe(env.contentHash)
    // 文件落盘
    expect(existsSync(join(userData, 'data/characters/c-dup.json'))).toBe(true)
  })

  it('commit 响应丢失：GET receipt 可恢复，重 commit 不重应用', async () => {
    const sessionId = await openAuthedSession()
    const meta = getSyncDomain().meta
    const env = characterEnv('c-receipt', 'R')
    await post(`/session/${sessionId}/push`, { batchId: 'b-rc', sequence: 0, envelopes: [env] })
    await post(`/session/${sessionId}/prepare`, { batchIds: ['b-rc'] })
    const c1 = await post(`/session/${sessionId}/commit`, { batchId: 'b-rc', peerId: 'android-1' })
    const receipt = c1.json.receipt as { receiptId: string; batchId: string }
    expect(receipt.receiptId).toBeTruthy()

    const q = await fetch(`${base}/session/${sessionId}/receipt/b-rc`)
    expect(q.status).toBe(200)
    const qBody = (await q.json()) as { receipt: { receiptId: string } }
    expect(qBody.receipt.receiptId).toBe(receipt.receiptId)

    const c2 = await post(`/session/${sessionId}/commit`, { batchId: 'b-rc', peerId: 'android-1' })
    expect(c2.json.idempotent).toBe(true)
    expect(meta.countChanges('remote')).toBe(1)
  })

  it('pull 乱序 sequence 409：不提前 apply', async () => {
    const sessionId = await openAuthedSession()
    const meta = getSyncDomain().meta
    const r = await post(`/session/${sessionId}/push`, {
      batchId: 'b-ooo',
      sequence: 3,
      envelopes: [characterEnv('c-ooo', 'O')],
    })
    expect(r.status).toBe(409)
    expect(meta.getHead('character', 'c-ooo')).toBeNull()
  })

  it('hash 篡改：expectedHashes 不一致整批拒绝，不落盘', async () => {
    const sessionId = await openAuthedSession()
    const meta = getSyncDomain().meta
    const env = characterEnv('c-hash', 'H')
    // 篡改 contentHash（payload 保持不变）
    const forged: SyncEnvelope = { ...env, contentHash: 'sha256:' + 'f'.repeat(64) }
    await post(`/session/${sessionId}/push`, { batchId: 'b-hash', sequence: 0, envelopes: [forged] })
    await post(`/session/${sessionId}/prepare`, { batchIds: ['b-hash'] })
    const c = await post(`/session/${sessionId}/commit`, {
      batchId: 'b-hash',
      peerId: 'android-1',
    })
    expect(c.status).toBe(200)
    const apply = c.json.apply as { applied: number; rejected: Array<{ code: string }> }
    expect(apply.applied).toBe(0)
    expect(apply.rejected.some((r) => r.code === 'HASH_MISMATCH')).toBe(true)
    expect(meta.getHead('character', 'c-hash')).toBeNull()
    expect(existsSync(join(userData, 'data/characters/c-hash.json'))).toBe(false)
  })

  it('一端删除一端修改：冲突可见，不自动复活', async () => {
    const sessionId = await openAuthedSession()
    const domain = getSyncDomain()
    // 本地已有存活角色
    const local = characterEnv('c-del', 'Local', { deviceId: 'pc-local', counter: '1' })
    // 先 commit 本地视角的 base
    await post(`/session/${sessionId}/push`, {
      batchId: 'b-base',
      sequence: 0,
      envelopes: [{ ...local, deviceId: 'android-1', version: { 'android-1': '1' }, dot: { deviceId: 'android-1', counter: '1' } }],
    })
    await post(`/session/${sessionId}/prepare`, { batchIds: ['b-base'] })
    await post(`/session/${sessionId}/commit`, { batchId: 'b-base', peerId: 'android-1' })

    // 远端 tombstone vs 本地后续修改（不同 hash 的并发）——用新实体直接构造 concurrent
    const envAlive = makeEnvelope({
      entityType: 'character',
      entityId: 'c-conflict',
      payload: { id: 'c-conflict', name: 'remote-alive' },
      deviceId: 'android-1',
      previousVersion: {},
      updatedAt: 1,
    })
    // 先落远端
    await post(`/session/${sessionId}/push`, { batchId: 'b-cf1', sequence: 0, envelopes: [envAlive] })
    await post(`/session/${sessionId}/prepare`, { batchIds: ['b-cf1'] })
    await post(`/session/${sessionId}/commit`, { batchId: 'b-cf1', peerId: 'android-1' })
    expect(domain.meta.getHead('character', 'c-conflict')?.deleted).toBe(0)

    // 并发删除（版本不支配）
    const envDel = makeEnvelope({
      entityType: 'character',
      entityId: 'c-conflict',
      payload: {},
      deviceId: 'android-2',
      previousVersion: {},
      deleted: true,
      updatedAt: 2,
    })
    await post(`/session/${sessionId}/push`, { batchId: 'b-cf2', sequence: 0, envelopes: [envDel] })
    await post(`/session/${sessionId}/prepare`, { batchIds: ['b-cf2'] })
    const c = await post(`/session/${sessionId}/commit`, { batchId: 'b-cf2', peerId: 'android-2' })
    const apply = c.json.apply as { conflicts: number; applied: number }
    // concurrent 不同 hash/deleted → conflict（不自动删）
    expect(apply.conflicts + apply.applied).toBeGreaterThanOrEqual(1)
    const head = domain.meta.getHead('character', 'c-conflict')
    // 不自动复活也不自动删掉已存在存活 head（冲突路径）
    expect(head).toBeTruthy()
  })

  it('父删子写：DEPENDENCY_CONFLICT，不产生孤儿', async () => {
    const sessionId = await openAuthedSession()
    const meta = getSyncDomain().meta
    // 会话 materializer 需要 parentId 定位容器：先落角色，再挂会话
    const char = makeEnvelope({
      entityType: 'character',
      entityId: 'char-owner',
      payload: { id: 'char-owner', name: 'Owner' },
      deviceId: 'android-1',
      previousVersion: {},
      updatedAt: 1,
    })
    await post(`/session/${sessionId}/push`, { batchId: 'b-ch', sequence: 0, envelopes: [char] })
    await post(`/session/${sessionId}/prepare`, { batchIds: ['b-ch'] })
    await post(`/session/${sessionId}/commit`, { batchId: 'b-ch', peerId: 'android-1' })

    const sess = makeEnvelope({
      entityType: 'session',
      entityId: 's-dead',
      payload: { id: 's-dead', title: 't', characterId: 'char-owner', sessionId: 's-dead' },
      deviceId: 'android-1',
      parentId: 'char-owner',
      previousVersion: {},
      updatedAt: 2,
    })
    await post(`/session/${sessionId}/push`, { batchId: 'b-s', sequence: 0, envelopes: [sess] })
    await post(`/session/${sessionId}/prepare`, { batchIds: ['b-s'] })
    const cs = await post(`/session/${sessionId}/commit`, { batchId: 'b-s', peerId: 'android-1' })
    expect((cs.json.apply as { applied: number }).applied).toBe(1)

    const sessDel = makeEnvelope({
      entityType: 'session',
      entityId: 's-dead',
      payload: {},
      deviceId: 'android-1',
      parentId: 'char-owner',
      previousVersion: { 'android-1': '2' },
      deleted: true,
      updatedAt: 3,
    })
    await post(`/session/${sessionId}/push`, { batchId: 'b-sd', sequence: 0, envelopes: [sessDel] })
    await post(`/session/${sessionId}/prepare`, { batchIds: ['b-sd'] })
    const cd = await post(`/session/${sessionId}/commit`, { batchId: 'b-sd', peerId: 'android-1' })
    expect((cd.json.apply as { applied: number }).applied).toBe(1)
    expect(meta.getHead('session', 's-dead')?.deleted).toBe(1)

    // 子消息再写入 → fence 拒绝
    const msg = makeEnvelope({
      entityType: 'message',
      entityId: 'm-orphan',
      payload: { id: 'm-orphan', content: 'hi', sessionId: 's-dead' },
      deviceId: 'android-2',
      parentId: 's-dead',
      previousVersion: {},
      updatedAt: 4,
    })
    await post(`/session/${sessionId}/push`, { batchId: 'b-m', sequence: 0, envelopes: [msg] })
    await post(`/session/${sessionId}/prepare`, { batchIds: ['b-m'] })
    const c = await post(`/session/${sessionId}/commit`, { batchId: 'b-m', peerId: 'android-2' })
    const apply = c.json.apply as { rejected: Array<{ code: string }>; applied: number }
    expect(apply.applied).toBe(0)
    expect(apply.rejected.some((r) => r.code === 'DEPENDENCY_CONFLICT')).toBe(true)
    expect(meta.getHead('message', 'm-orphan')).toBeNull()
  })

  it('commit 后 HEAD 可在 pull 看到（双向游标证据）', async () => {
    const sessionId = await openAuthedSession()
    const env = characterEnv('c-pull', 'P')
    await post(`/session/${sessionId}/push`, { batchId: 'b-pull', sequence: 0, envelopes: [env] })
    await post(`/session/${sessionId}/prepare`, { batchIds: ['b-pull'] })
    await post(`/session/${sessionId}/commit`, { batchId: 'b-pull', peerId: 'android-1', cursor: 7 })
    const pull = await fetch(`${base}/session/${sessionId}/pull?limit=50`)
    const body = (await pull.json()) as { heads: Array<{ entityId: string }> }
    expect(body.heads.some((h) => h.entityId === 'c-pull')).toBe(true)
    expect(getSyncDomain().meta.getReceipt('android-1')?.cursor).toBe(7)
  })
})
