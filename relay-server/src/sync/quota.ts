/**
 * S8-05：空间配额检查（纯逻辑）。
 * plan 显示所需/剩余；push 原子拒绝超额批次，不接受一半。
 */

export interface QuotaSnapshot {
  usedEntities: number
  maxEntities: number
  usedCiphertextBytes: number
  maxCiphertextBytes: number
  maxBlobBytes: number
  maxDevices: number
  usedDevices: number
}

export interface QuotaDelta {
  /** 新增实体数（同 ID 覆盖不重复计） */
  newEntities: number
  /** 新增密文字节（同版本替换按差额，此处按新增估算） */
  newCiphertextBytes: number
  newDevices?: number
  newBlobBytes?: number
}

export type QuotaCheck =
  | { ok: true; remainingEntities: number; remainingCiphertextBytes: number }
  | {
      ok: false
      code: 'QUOTA_EXCEEDED'
      reason: 'entities' | 'ciphertext_bytes' | 'blob_bytes' | 'devices'
      required: number
      remaining: number
    }

export function checkQuota(snapshot: QuotaSnapshot, delta: QuotaDelta): QuotaCheck {
  const remainingEntities = snapshot.maxEntities - snapshot.usedEntities
  const remainingCiphertextBytes = snapshot.maxCiphertextBytes - snapshot.usedCiphertextBytes

  if (delta.newEntities > remainingEntities) {
    return {
      ok: false,
      code: 'QUOTA_EXCEEDED',
      reason: 'entities',
      required: delta.newEntities,
      remaining: Math.max(0, remainingEntities),
    }
  }
  if (delta.newCiphertextBytes > remainingCiphertextBytes) {
    return {
      ok: false,
      code: 'QUOTA_EXCEEDED',
      reason: 'ciphertext_bytes',
      required: delta.newCiphertextBytes,
      remaining: Math.max(0, remainingCiphertextBytes),
    }
  }
  if (delta.newBlobBytes !== undefined && delta.newBlobBytes > snapshot.maxBlobBytes) {
    return {
      ok: false,
      code: 'QUOTA_EXCEEDED',
      reason: 'blob_bytes',
      required: delta.newBlobBytes,
      remaining: snapshot.maxBlobBytes,
    }
  }
  if (delta.newDevices !== undefined && snapshot.usedDevices + delta.newDevices > snapshot.maxDevices) {
    return {
      ok: false,
      code: 'QUOTA_EXCEEDED',
      reason: 'devices',
      required: snapshot.usedDevices + delta.newDevices,
      remaining: Math.max(0, snapshot.maxDevices - snapshot.usedDevices),
    }
  }
  return {
    ok: true,
    remainingEntities: remainingEntities - delta.newEntities,
    remainingCiphertextBytes: remainingCiphertextBytes - delta.newCiphertextBytes,
  }
}

/** 默认配额（决策冻结表） */
export const DEFAULT_QUOTA = {
  maxEntities: 100_000,
  maxCiphertextBytes: 524_288_000,
  maxBlobBytes: 67_108_864,
  maxDevices: 10,
  batchMaxItems: 200,
  batchMaxBytes: 4 * 1024 * 1024,
} as const

export function quotaSnapshotFromDefaults(used?: Partial<Pick<QuotaSnapshot, 'usedEntities' | 'usedCiphertextBytes' | 'usedDevices'>>): QuotaSnapshot {
  return {
    usedEntities: used?.usedEntities ?? 0,
    maxEntities: DEFAULT_QUOTA.maxEntities,
    usedCiphertextBytes: used?.usedCiphertextBytes ?? 0,
    maxCiphertextBytes: DEFAULT_QUOTA.maxCiphertextBytes,
    maxBlobBytes: DEFAULT_QUOTA.maxBlobBytes,
    maxDevices: DEFAULT_QUOTA.maxDevices,
    usedDevices: used?.usedDevices ?? 0,
  }
}
