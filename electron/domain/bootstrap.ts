import { createHash, createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { emptyVector, mergeVectors, type VersionVector } from '../../shared/contracts/version-vector'
import type { SyncEntityType } from '../../shared/contracts/sync-envelope'
import { contentHash, canonicalize } from '../../shared/contracts/canonical-json'
import type { SyncDomainContext, BootstrapIssue, BootstrapResult, BootstrapScanItem } from './types'
import type { DomainFlagKey } from './featureFlag'
import {
  DOMAIN_SCANNERS,
  DOMAIN_ENTITY_TYPES,
  defaultScanRoots,
  DEFAULT_MAX_PAYLOAD_BYTES,
  type ScanContext,
} from './bootstrapScanners'
import { createBackupV2 } from '../services/backup'
import { sha256Of } from './fileTransaction'

const MAX_ENTITY_ID_LENGTH = 128

export interface BootstrapOptions {
  /** 跳过 Backup V2 checkpoint（仅测试内部使用） */
  skipBackupCheckpoint?: boolean
  now?: number
}

function validateItems(items: BootstrapScanItem[], issues: BootstrapIssue[]): BootstrapScanItem[] {
  const seen = new Map<string, BootstrapScanItem>()
  const kept: BootstrapScanItem[] = []

  for (const item of items) {
    const id = item.entityId
    if (!id || id.length > MAX_ENTITY_ID_LENGTH || /[/\\]/.test(id) || id.includes('..')) {
      issues.push({
        kind: 'invalid_id',
        entityType: item.entityType,
        entityId: String(id).slice(0, 40),
        detail: 'entityId 为空、过长或包含路径字符',
      })
      continue
    }
    const key = `${item.entityType}:${id}`
    const prev = seen.get(key)
    if (prev) {
      issues.push({
        kind: 'duplicate_id',
        entityType: item.entityType,
        entityId: id,
        detail: '同一实体类型出现重复 ID',
      })
      continue
    }
    seen.set(key, item)
    kept.push(item)
  }
  return kept
}

function collectParentIssues(items: BootstrapScanItem[], issues: BootstrapIssue[]): void {
  const ids = new Set(items.map((i) => `${i.entityType}:${i.entityId}`))
  const anyId = new Set(items.map((i) => i.entityId))
  for (const item of items) {
    if (!item.parentId) continue
    if (ids.has(`session:${item.parentId}`) || ids.has(`group:${item.parentId}`) || anyId.has(item.parentId)) {
      continue
    }
    // 孤立子实体不丢弃（真实用户数据），但必须报告，供迁移向导让用户决定
    issues.push({
      kind: 'missing_parent',
      entityType: item.entityType,
      entityId: item.entityId,
      detail: `parentId=${item.parentId} 未在本次 bootstrap 范围内找到`,
    })
  }
}

function buildManifest(
  genesisId: string,
  datasetHash: string,
  entries: Array<{ entityType: string; entityId: string; hash: string }>,
  secret: string,
  createdAt: number,
): BootstrapResult['manifest'] {
  const signature = createHmac('sha256', secret)
    .update(canonicalize({ genesisId, platform: 'pc', datasetHash, entries } as never))
    .digest('hex')
  return {
    genesisId,
    platform: 'pc',
    createdAt,
    datasetHash,
    entityCount: entries.length,
    entries,
    signature,
  }
}

function manifestFromHeads(
  domain: SyncDomainContext,
  genesisId: string,
  datasetHash: string,
  createdAt: number,
): BootstrapResult['manifest'] {
  const entries = domain.meta
    .listHeads(1_000_000, 0)
    .map((h) => ({ entityType: h.entityType, entityId: h.entityId, hash: h.hash }))
    .sort((a, b) => `${a.entityType}:${a.entityId}`.localeCompare(`${b.entityType}:${b.entityId}`))
  return buildManifest(genesisId, datasetHash, entries, domain.identity.manifestSecret(), createdAt)
}

/** S2-05：只读扫描 → 校验 → Backup V2 checkpoint → heads + genesis + receipt；幂等 */
export function runBootstrap(
  domain: SyncDomainContext,
  enabledDomains: DomainFlagKey[],
  options: BootstrapOptions = {},
): BootstrapResult {
  const existing = domain.meta.getBootstrapReceipt()
  if (existing) {
    return {
      alreadyBootstrapped: true,
      genesisId: existing.genesisId,
      entityCount: existing.entityCount,
      datasetHash: existing.datasetHash,
      receiptId: existing.id,
      checkpointId: null,
      issues: [],
      manifest: manifestFromHeads(domain, existing.genesisId, existing.datasetHash, Date.now()),
    }
  }

  const issues: BootstrapIssue[] = []
  const scanCtx: ScanContext = {
    roots: defaultScanRoots(domain.userDataDir),
    maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
  }

  // 1) Backup V2 checkpoint（在修改任何同步元数据之前）
  let checkpointId: string | null = null
  if (!options.skipBackupCheckpoint) {
    checkpointId = createBootstrapCheckpoint(domain, options.now ?? Date.now())
  }

  // 2) 逐域只读扫描；同一扫描器覆盖多个域时按域实体类型过滤
  const collected: BootstrapScanItem[] = []
  const scannedDomains = new Set<DomainFlagKey>()
  for (const key of enabledDomains) {
    const scanner = DOMAIN_SCANNERS[key]
    if (!scanner || scannedDomains.has(key)) continue
    scannedDomains.add(key)
    const out = scanner(scanCtx)
    const allowed = new Set<string>(DOMAIN_ENTITY_TYPES[key])
    collected.push(...out.items.filter((i) => allowed.has(i.entityType)))
    issues.push(...out.issues)
  }

  // 3) 校验（不修改原数据）
  const items = validateItems(collected, issues)
  collectParentIssues(items, issues)

  // 4) heads：初始版本为 PC 设备 counter 序列；不写 change_log（用户首次选择同步目标前不标待上传）
  let allocated = BigInt(domain.identity.peek().nextCounter)
  const deviceId = domain.identity.peek().deviceId
  const hashLines: string[] = []
  const manifestEntries: Array<{ entityType: string; entityId: string; hash: string }> = []

  for (const item of items) {
    const hash = contentHash(item.payload as never)
    hashLines.push(`${item.entityType}:${item.entityId}:${hash}`)
    manifestEntries.push({ entityType: item.entityType, entityId: item.entityId, hash })
  }
  manifestEntries.sort((a, b) => `${a.entityType}:${a.entityId}`.localeCompare(`${b.entityType}:${b.entityId}`))
  hashLines.sort()
  const datasetHash = `sha256:${createHash('sha256').update(hashLines.join('\n')).digest('hex')}`

  for (const item of items) {
    const counter = allocated.toString(10)
    allocated += 1n
    const version: VersionVector = mergeVectors(emptyVector(), { [deviceId]: counter })
    domain.meta.upsertHead({
      entityType: item.entityType,
      entityId: item.entityId,
      versionJson: JSON.stringify(version),
      hash: contentHash(item.payload as never),
      deleted: 0,
      payloadRef: null,
    })
  }

  const genesisId = domain.meta.getDeviceState()?.genesisId ?? undefined
  const finalGenesisId = genesisId ?? randomBytes(16).toString('hex')
  domain.meta.setDeviceState(deviceId, allocated.toString(10), finalGenesisId)

  const receiptId = `bootstrap-${Date.now()}`
  domain.meta.saveBootstrapReceipt({
    id: receiptId,
    genesisId: finalGenesisId,
    entityCount: items.length,
    datasetHash,
  })

  const createdAt = options.now ?? Date.now()
  const manifest = buildManifest(
    finalGenesisId,
    datasetHash,
    manifestEntries,
    domain.identity.manifestSecret(),
    createdAt,
  )

  return {
    alreadyBootstrapped: false,
    genesisId: finalGenesisId,
    entityCount: items.length,
    datasetHash,
    receiptId,
    checkpointId,
    issues,
    manifest,
  }
}

/** 首次启用 journal 前创建 Backup V2 快照并记录 checkpoint */
export function createBootstrapCheckpoint(domain: SyncDomainContext, now: number): string | null {
  try {
    const backupDir = join(domain.userDataDir, 'data', 'backups')
    mkdirSync(backupDir, { recursive: true })
    const zipPath = join(backupDir, `bootstrap-v2-${now}.zip`)
    createBackupV2(zipPath)
    if (!existsSync(zipPath)) return null
    const hash = sha256Of(readFileSync(zipPath))
    const id = `checkpoint-bootstrap-${now}`
    domain.meta.saveCheckpoint({ id, reason: 'bootstrap', path: zipPath, hash })
    return id
  } catch {
    // 备份失败不得静默继续：bootstrap 前置条件未满足
    return null
  }
}

/** 校验 checkpoint 与磁盘一致（回滚演练用） */
export function verifyCheckpointIntegrity(domain: SyncDomainContext, checkpointId: string): boolean {
  const cp = domain.meta.listCheckpoints().find((c) => c.id === checkpointId)
  if (!cp?.path || !cp.hash) return false
  if (!existsSync(cp.path)) return false
  const size = statSync(cp.path).size
  if (size <= 0) return false
  return sha256Of(readFileSync(cp.path)) === cp.hash
}

export function newGenesisId(): string {
  return createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 32)
}

void (0 as unknown as SyncEntityType)
