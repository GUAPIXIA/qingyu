import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mergeVectors, emptyVector, type VersionVector } from '../../shared/contracts/version-vector'
import type { SyncEnvelope, SyncEntityType } from '../../shared/contracts/sync-envelope'
import { contentHash } from '../../shared/contracts/canonical-json'
import type { SyncMetaDb } from './syncMeta'
import type { DeviceIdentityStore } from './deviceIdentity'

export interface BootstrapScanItem {
  entityType: SyncEntityType
  entityId: string
  payload: Record<string, unknown>
  schemaVersion?: number
}

export interface BootstrapResult {
  alreadyBootstrapped: boolean
  genesisId: string
  entityCount: number
  datasetHash: string
  receiptId: string
}

/**
 * 首次启用 journal：只读扫描 → 校验 → 写 heads + genesis + receipt。
 * 不把全部实体标成待上传；幂等。
 */
export function bootstrapHeads(
  meta: SyncMetaDb,
  identity: DeviceIdentityStore,
  scan: () => BootstrapScanItem[],
): BootstrapResult {
  const existingReceipt = meta.getBootstrapReceipt()
  if (existingReceipt) {
    return {
      alreadyBootstrapped: true,
      genesisId: existingReceipt.genesisId,
      entityCount: existingReceipt.entityCount,
      datasetHash: existingReceipt.datasetHash,
      receiptId: existingReceipt.id,
    }
  }

  const items = scan()
  const device = identity.peek()
  const deviceId = device.deviceId

  // 规范内容哈希：按 (type,id,hash) 排序连接后 sha256
  const hashLines: string[] = []
  let allocated = BigInt(identity.peek().nextCounter)

  for (const item of items) {
    if (!item.entityId || /[/\\]/.test(item.entityId)) {
      throw new Error(`非法 entityId: ${String(item.entityId).slice(0, 40)}`)
    }
    const hash = contentHash(item.payload as never)
    hashLines.push(`${item.entityType}:${item.entityId}:${hash}`)
  }
  hashLines.sort()
  const datasetHash = `sha256:${createHash('sha256').update(hashLines.join('\n')).digest('hex')}`

  const genesisId = randomBytes(16).toString('hex')

  // 写 heads：初始版本用 bootstrap 序列分配的 counter（每个实体 bump）
  for (const item of items) {
    const counter = allocated.toString(10)
    allocated += 1n
    const version: VersionVector = mergeVectors(emptyVector(), { [deviceId]: counter })
    meta.upsertHead({
      entityType: item.entityType,
      entityId: item.entityId,
      versionJson: JSON.stringify(version),
      hash: contentHash(item.payload as never),
      deleted: 0,
      payloadRef: null,
    })
    // bootstrap 不写 change_log 待上传；仅建立 head
  }

  // 持久化 counter
  const next = allocated.toString(10)
  meta.setDeviceState(deviceId, next, genesisId)

  const receiptId = `bootstrap-${Date.now()}`
  meta.saveBootstrapReceipt({
    id: receiptId,
    genesisId,
    entityCount: items.length,
    datasetHash,
  })

  return {
    alreadyBootstrapped: false,
    genesisId,
    entityCount: items.length,
    datasetHash,
    receiptId,
  }
}

/** 典型扫描器：从现有文件目录只读枚举（角色/世界书等）。此处提供 persona 示例扫描。 */
export function scanPersonaDir(personaFile: string): BootstrapScanItem[] {
  if (!existsSync(personaFile)) return []
  try {
    const parsed = JSON.parse(readFileSync(personaFile, 'utf8')) as Array<Record<string, unknown>>
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((p) => typeof p.id === 'string' && p.id)
      .map((p) => ({
        entityType: 'persona' as const,
        entityId: String(p.id),
        payload: {
          name: typeof p.name === 'string' ? p.name : '',
          description: typeof p.description === 'string' ? p.description : '',
          persona: typeof p.persona === 'string' ? p.persona : '',
        },
        schemaVersion: 1,
      }))
  } catch {
    return []
  }
}

export function newGenesisId(): string {
  return randomBytes(16).toString('hex')
}

void (0 as unknown as SyncEnvelope)
