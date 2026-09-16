import { join } from 'node:path'
import { DeviceIdentityStore, defaultIdentityPath } from './deviceIdentity'
import { SyncMetaDb } from './syncMeta'
import { PcDomainRepository, defaultSyncMetaPath } from './pcRepository'
import { RepoFeatureFlags, defaultFlagsPath, type DomainFlagKey } from './featureFlag'

export type { DomainFlagKey }
import { recoverIncompleteFileTransactions } from './recovery'
import { applyRemoteBatch } from './remoteApply'
import { collectSyncDiagnostics } from './metrics'
import { bootstrapHeads, scanPersonaDir } from './bootstrap'
import type { SyncEnvelope } from '../../shared/contracts/sync-envelope'

export interface SyncDomainContext {
  repo: PcDomainRepository
  flags: RepoFeatureFlags
  meta: SyncMetaDb
  identity: DeviceIdentityStore
}

let ctx: SyncDomainContext | null = null

/** 集成测试/非 Electron 环境注入 userData 根目录 */
export function setSyncDomainUserDataDirForTest(userDataDir: string): void {
  ctx = null
  ensureSyncDomain(userDataDir)
}

export function ensureSyncDomain(userDataDir: string): SyncDomainContext {
  if (ctx) return ctx
  const identity = new DeviceIdentityStore(defaultIdentityPath(userDataDir))
  identity.loadOrCreate()
  const meta = new SyncMetaDb(defaultSyncMetaPath(userDataDir))
  const repo = new PcDomainRepository({ meta, identity, userDataDir })
  const flags = new RepoFeatureFlags(defaultFlagsPath(userDataDir))
  ctx = { repo, flags, meta, identity }
  // 启动恢复未完成 file_transactions
  recoverIncompleteFileTransactions(meta)
  return ctx
}

export function getSyncDomain(): SyncDomainContext {
  if (!ctx) {
    throw new Error('SyncDomain 未初始化（需先 ensureSyncDomain）')
  }
  return ctx
}

export function resetSyncDomainForTest(): void {
  try {
    ctx?.meta.close()
  } catch {
    /* ignore */
  }
  ctx = null
}

export function isDomainEnabled(domain: DomainFlagKey): boolean {
  try {
    return getSyncDomain().flags.isEnabled(domain)
  } catch {
    return false
  }
}

/** flag 开启时对 put 做 journal；调用方仍负责业务文件写入顺序 */
export function journalPutIfEnabled(input: {
  domain: DomainFlagKey
  entityType: SyncEnvelope['entityType']
  entityId: string
  payload: Record<string, unknown>
  writeBusiness?: () => void
}): boolean {
  if (!isDomainEnabled(input.domain)) return false
  const { repo } = getSyncDomain()
  repo.putWithJournal({
    entityType: input.entityType,
    entityId: input.entityId,
    payload: input.payload,
    writeBusiness: () => input.writeBusiness?.(),
  })
  return true
}

export function journalDeleteIfEnabled(input: {
  domain: DomainFlagKey
  entityType: SyncEnvelope['entityType']
  entityId: string
  deleteBusiness?: () => void
}): boolean {
  if (!isDomainEnabled(input.domain)) return false
  const { repo } = getSyncDomain()
  repo.tombstoneWithJournal({
    entityType: input.entityType,
    entityId: input.entityId,
    deleteBusiness: () => input.deleteBusiness?.(),
  })
  return true
}

export function runBootstrapIfEnabled(userDataDir: string): ReturnType<typeof bootstrapHeads> | null {
  const domain = ensureSyncDomain(userDataDir)
  if (!domain.flags.isEnabled('persona') && !domain.flags.isEnabled('settings_public')) {
    return null
  }
  const personaFile = join(userDataDir, 'data', 'config', 'personas.json')
  return bootstrapHeads(domain.meta, domain.identity, () => scanPersonaDir(personaFile))
}

export { applyRemoteBatch, collectSyncDiagnostics, recoverIncompleteFileTransactions }
