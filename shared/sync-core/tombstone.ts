import type { VersionVector } from '../contracts/version-vector'
import { compareVectors } from '../contracts/version-vector'

export interface TombstoneRecord {
  entityType: string
  entityId: string
  deletedAt: number
  /** tombstone 的版本向量（用于 fence） */
  version: VersionVector
}

export interface DeviceAck {
  deviceId: string
  /** 该设备已确认看到的版本向量 */
  known: VersionVector
  /** 是否已退役 */
  retired: boolean
}

export interface TombstonePolicy {
  /** 默认 180 天（总方案 §6.4） */
  retainDays: number
  now: number
}

export interface TombstoneCompactionVerdict {
  compactible: boolean
  reason:
    | 'OK_ALL_ACKED'
    | 'OK_ALL_DEVICES_RETIRED'
    | 'BLOCKED_ACK_INCOMPLETE'
    | 'BLOCKED_RETAIN_WINDOW'
  /** 阻塞时尚未确认的设备 */
  pendingDevices: string[]
  ageDays: number
}

/**
 * tombstone 可压缩判断（总方案 §6.4）。
 *
 * 只有当所有未退役设备都确认看过该 tombstone，
 * 或用户显式退役长期离线设备后，才能压缩。
 * 服务端不得仅因数据保留期限删除尚未确认的 tombstone。
 */
export function canCompactTombstone(
  tombstone: TombstoneRecord,
  devices: readonly DeviceAck[],
  policy: TombstonePolicy,
): TombstoneCompactionVerdict {
  const ageMs = policy.now - tombstone.deletedAt
  const ageDays = Math.floor(ageMs / 86_400_000)
  const active = devices.filter((d) => !d.retired)
  const pending = active.filter(
    (d) => compareVectors(d.known, tombstone.version) !== 'dominates' && compareVectors(d.known, tombstone.version) !== 'equal',
  )
  // known 需至少覆盖 tombstone 版本（dominates 或 equal）
  const pendingDevices = pending.map((d) => d.deviceId)

  if (pendingDevices.length > 0) {
    return {
      compactible: false,
      reason: 'BLOCKED_ACK_INCOMPLETE',
      pendingDevices,
      ageDays,
    }
  }
  if (ageDays < policy.retainDays && active.length > 0) {
    // 全部已确认但仍在保留窗口内：仍可压缩（保留窗口是「未确认时」的底线）
    // 方案：180 天 + 全设备确认；两者都满足才安全。此处保守：窗口内即使全 ack 也不压。
    return {
      compactible: false,
      reason: 'BLOCKED_RETAIN_WINDOW',
      pendingDevices: [],
      ageDays,
    }
  }
  if (active.length === 0 && devices.some((d) => d.retired)) {
    return { compactible: true, reason: 'OK_ALL_DEVICES_RETIRED', pendingDevices: [], ageDays }
  }
  return { compactible: true, reason: 'OK_ALL_ACKED', pendingDevices: [], ageDays }
}

export interface TombstoneDryRunReport {
  total: number
  compactible: number
  blocked: number
  blockedReasons: Record<string, number>
  pendingDeviceIds: string[]
}

/** dry-run 清理报告（S7-08）：只统计，不实际压缩 */
export function tombstoneDryRun(
  tombstones: readonly TombstoneRecord[],
  devices: readonly DeviceAck[],
  policy: TombstonePolicy,
): TombstoneDryRunReport {
  const blockedReasons: Record<string, number> = {}
  const pending = new Set<string>()
  let compactible = 0
  let blocked = 0
  for (const t of tombstones) {
    const v = canCompactTombstone(t, devices, policy)
    if (v.compactible) compactible += 1
    else {
      blocked += 1
      blockedReasons[v.reason] = (blockedReasons[v.reason] ?? 0) + 1
      for (const d of v.pendingDevices) pending.add(d)
    }
  }
  return {
    total: tombstones.length,
    compactible,
    blocked,
    blockedReasons,
    pendingDeviceIds: [...pending].sort(),
  }
}
