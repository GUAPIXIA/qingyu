/**
 * 阶段 2 S2-01：repository 契约套件。
 *
 * 同一份语言无关行为表（shared/contracts/fixtures/repository/behavior-table.json）
 * 分别跑在「进程内内存实现」与「PC 文件实现」上，两者必须一致通过。
 * 阶段 3 的 Room 实现按同一张表实现等价 runner。
 */
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeviceIdentityStore } from '../deviceIdentity'
import { SyncMetaDb } from '../syncMeta'
import { PcDomainRepository } from '../pcRepository'
import { applyRemoteBatch } from '../remoteApply'
import { contentHash } from '../../../shared/contracts/canonical-json'
import { runRepositoryContract, type ContractRepositoryAdapter } from '../../../shared/contracts/repositoryContract'
import type { VersionVector } from '../../../shared/contracts/version-vector'

const table = JSON.parse(
  readFileSync(join(__dirname, '../../../shared/contracts/fixtures/repository/behavior-table.json'), 'utf8'),
) as Parameters<typeof runRepositoryContract>[0]

/** 进程内内存实现：只用于验证契约本身可满足，不涉及文件系统 */
class InMemoryAdapter implements ContractRepositoryAdapter {
  private heads = new Map<string, { version: VersionVector; hash: string; deleted: boolean }>()
  private log: Array<{ seq: number; origin: string }> = []
  private entities = new Map<string, Record<string, unknown>>()
  private counter = 0

  private key(type: string, id: string): string {
    return `${type}:${id}`
  }

  put(input: { entityType: string; entityId: string; payload: Record<string, unknown> }): void {
    if (/[/\\]/.test(input.entityId) || input.entityId.includes('..')) throw new Error('非法 entityId')
    const key = this.key(input.entityType, input.entityId)
    const prev = this.heads.get(key)?.version ?? {}
    const next = { ...prev, 'mem-dev': String(BigInt(prev['mem-dev'] ?? '0') + 1n) }
    this.heads.set(key, { version: next, hash: contentHash(input.payload as never), deleted: false })
    this.entities.set(key, { id: input.entityId, ...input.payload })
    this.log.push({ seq: ++this.counter, origin: 'local' })
  }

  tombstone(input: { entityType: string; entityId: string }): void {
    const key = this.key(input.entityType, input.entityId)
    const prev = this.heads.get(key)?.version ?? {}
    const next = { ...prev, 'mem-dev': String(BigInt(prev['mem-dev'] ?? '0') + 1n) }
    this.heads.set(key, { version: next, hash: contentHash({} as never), deleted: true })
    this.entities.delete(key)
    this.log.push({ seq: ++this.counter, origin: 'local' })
  }

  applyRemote(input: {
    entityType: string
    entityId: string
    payload: Record<string, unknown>
    deviceId: string
    counter: string
  }): void {
    const key = this.key(input.entityType, input.entityId)
    this.heads.set(key, {
      version: { [input.deviceId]: input.counter },
      hash: contentHash(input.payload as never),
      deleted: false,
    })
    this.entities.set(key, { id: input.entityId, ...input.payload })
    this.log.push({ seq: ++this.counter, origin: 'remote' })
  }

  getHead(entityType: string, entityId: string) {
    return this.heads.get(this.key(entityType, entityId)) ?? null
  }

  changesAfter(cursor: number, limit: number) {
    const rows = this.log.filter((r) => r.seq > cursor).slice(0, limit)
    return { rows, nextCursor: rows.length ? rows[rows.length - 1].seq : cursor }
  }

  readEntity(entityType: string, entityId: string) {
    return this.entities.get(this.key(entityType, entityId)) ?? null
  }

  reset(): void {
    this.heads.clear()
    this.log = []
    this.entities.clear()
    this.counter = 0
  }
}

describe('phase2 S2-01 repository 契约套件', () => {
  let dir: string
  let userData: string
  let meta: SyncMetaDb
  let repo: PcDomainRepository

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qingyu-contract-'))
    userData = join(dir, 'userdata')
    const identity = new DeviceIdentityStore(join(userData, 'data/config/sync-device-identity.json'))
    identity.loadOrCreate()
    meta = new SyncMetaDb(join(userData, 'data/config/sync-meta.db'))
    repo = new PcDomainRepository({ meta, identity, userDataDir: userData })
  })

  afterEach(() => {
    meta.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** PC 文件实现适配器：把契约操作映射到真实文件 + journal */
  function pcAdapter(): ContractRepositoryAdapter {
    const pathFor = (entityType: string, entityId: string): string => {
      if (entityType === 'character') return join(userData, 'data/characters', `${entityId}.json`)
      return join(userData, 'data/personas', `${entityId}.json`)
    }
    return {
      put: ({ entityType, entityId, payload }) => {
        repo.putWithJournal({
          entityType: entityType as never,
          entityId,
          payload,
          files: [{ path: pathFor(entityType, entityId), content: JSON.stringify({ id: entityId, ...payload }, null, 2) }],
        })
      },
      tombstone: ({ entityType, entityId }) => {
        repo.tombstoneWithJournal({
          entityType: entityType as never,
          entityId,
          files: [{ path: pathFor(entityType, entityId), content: null }],
        })
      },
      applyRemote: ({ entityType, entityId, payload, deviceId, counter }) => {
        const env = {
          contractVersion: 1,
          entityType: entityType as never,
          entityId,
          parentId: null,
          schemaVersion: 1,
          version: { [deviceId]: counter },
          dot: { deviceId, counter },
          deleted: false,
          updatedAt: Date.now(),
          contentHash: contentHash(payload as never),
          payload: payload as never,
        }
        applyRemoteBatch(meta, userData, [env])
      },
      getHead: (entityType, entityId) => {
        const head = meta.getHead(entityType, entityId)
        if (!head) return null
        return { version: JSON.parse(head.versionJson) as VersionVector, hash: head.hash, deleted: head.deleted === 1 }
      },
      changesAfter: (cursor, limit) => {
        const page = meta.changesAfter(cursor, limit)
        return { rows: page.rows.map((r) => ({ seq: r.seq, origin: r.origin })), nextCursor: page.nextCursor }
      },
      readEntity: (entityType, entityId) => {
        const raw = repo.readJsonFile<Record<string, unknown>>(pathFor(entityType, entityId))
        return raw ?? null
      },
      reset: () => {
        meta.clearSyncState()
      },
    }
  }

  it('内存实现满足行为表', () => {
    const failures = runRepositoryContract(table, new InMemoryAdapter(), (p) => contentHash(p as never))
    expect(failures).toEqual([])
  })

  it('PC 文件实现满足同一张行为表', () => {
    const failures = runRepositoryContract(table, pcAdapter(), (p) => contentHash(p as never))
    expect(failures).toEqual([])
  })

  it('行为表覆盖了方案要求的关键语义', () => {
    const ids = table.cases.map((c) => c.id)
    expect(ids).toContain('put-creates-readable-entity-and-one-local-change')
    expect(ids).toContain('second-put-strictly-increases-counter')
    expect(ids).toContain('tombstone-marks-deleted-and-records-change')
    expect(ids).toContain('changesAfter-pages-without-gap-or-overlap')
    expect(ids).toContain('invalid-entity-id-is-rejected')
    expect(ids).toContain('content-hash-is-canonical-not-field-order-dependent')
    expect(ids).toContain('remote-origin-does-not-echo-as-local')
  })
})
