/**
 * 阶段 7 S7-06/S7-07：同步中心 IPC——冲突列表/解决 + 授权状态汇总。
 *
 * 隐私：冲突列表只回传 entityType/entityId/hash/建议，不回传正文 payload。
 */
import type { IpcMain } from 'electron'
import { getSyncDomain, getSyncHealth, isSyncReady, markNeedsFullRescan } from '../domain/syncDomainService'
import { syncLanAuthService } from '../domain/syncLanAuth'
import { suggestConflictResolution } from '../../shared/sync-core/conflictSuggest'
import {
  tombstoneDryRun,
  type DeviceAck,
  type TombstoneRecord,
} from '../../shared/sync-core/tombstone'
import type { VersionVector } from '../../shared/contracts/version-vector'
import { createLogger } from '../services/logger'

const log = createLogger('sync-center')

export interface SyncConflictItem {
  id: string
  entityType: string
  entityId: string
  localHash: string
  remoteHash: string
  localDeleted: boolean
  remoteDeleted: boolean
  status: string
  suggestion: string
}

export interface SyncCenterStatus {
  syncReady: boolean
  needsFullRescan: boolean
  healthReason: string | null
  openConflicts: number
  journalBacklog: number
  heads: number
  lanAuthPhase: string
  lanSessionId: string | null
  lanShortAuth: string | null
  lanPeerDeviceName: string | null
  lanExpiresAt: number | null
  qrJson: string | null
}

function parseEnvelope(raw: string): { hash?: string; deleted?: boolean } {
  try {
    const o = JSON.parse(raw) as { hash?: string; deleted?: boolean; contentHash?: string }
    return { hash: o.hash ?? o.contentHash, deleted: o.deleted }
  } catch {
    return {}
  }
}

function listConflictItems(status?: string): SyncConflictItem[] {
  try {
    const domain = getSyncDomain()
    return domain.meta.listConflicts(status).map((c) => {
      const local = parseEnvelope(c.localEnvelope)
      const remote = parseEnvelope(c.remoteEnvelope)
      const localDeleted = local.deleted === true
      const remoteDeleted = remote.deleted === true
      const kind =
        localDeleted !== remoteDeleted
          ? 'delete_vs_modify'
          : 'version_concurrent'
      return {
        id: c.id,
        entityType: c.entityType,
        entityId: c.entityId,
        localHash: local.hash ?? '',
        remoteHash: remote.hash ?? '',
        localDeleted,
        remoteDeleted,
        status: c.status,
        suggestion: suggestConflictResolution(kind as 'delete_vs_modify' | 'version_concurrent'),
      }
    })
  } catch {
    return []
  }
}

function centerStatus(): SyncCenterStatus {
  const lan = syncLanAuthService.getStatus()
  let openConflicts = 0
  let journalBacklog = 0
  let heads = 0
  try {
    const m = getSyncDomain().meta.metrics()
    openConflicts = m.openConflicts
    journalBacklog = m.journalBacklog
    heads = m.heads
  } catch {
    /* domain 未初始化 */
  }
  const health = getSyncHealth()
  return {
    syncReady: isSyncReady(),
    needsFullRescan: health.needsFullRescan === true,
    healthReason: (health as { reason?: string }).reason ?? null,
    openConflicts,
    journalBacklog,
    heads,
    lanAuthPhase: lan.phase,
    lanSessionId: lan.sessionId,
    lanShortAuth: lan.shortAuth,
    lanPeerDeviceName: lan.peerDeviceName,
    lanExpiresAt: lan.expiresAt,
    qrJson: lan.qrJson,
  }
}

export function registerSyncCenterIPC(ipcMain: IpcMain): void {
  ipcMain.handle('syncCenter:status', () => centerStatus())

  ipcMain.handle(
    'syncCenter:startLanAuth',
    (_e, input: { host: string; port: number; fingerprint: string; displayName: string }) => {
      syncLanAuthService.startAuthWindow(input)
      return centerStatus()
    },
  )

  ipcMain.handle('syncCenter:confirmPeer', (_e, input: { sessionId: string; shortAuth: string }) => {
    const r = syncLanAuthService.confirmPeer(input)
    return { ok: r.ok, error: r.error, status: centerStatus() }
  })

  ipcMain.handle('syncCenter:revokeLanAuth', () => {
    syncLanAuthService.revoke('user')
    return centerStatus()
  })

  ipcMain.handle('syncCenter:listConflicts', (_e, status?: string) => listConflictItems(status))

  ipcMain.handle(
    'syncCenter:resolveConflict',
    (_e, input: { id: string; choice: 'local' | 'remote' | 'copy' | 'manual' }) => {
      try {
        const domain = getSyncDomain()
        const map = {
          local: 'resolved_local',
          remote: 'resolved_remote',
          copy: 'resolved_copy',
          manual: 'resolved_manual',
        } as const
        const ok = domain.meta.resolveConflict(input.id, map[input.choice] ?? 'resolved_manual')
        return { ok, status: centerStatus() }
      } catch (e) {
        log.warn('resolveConflict 失败', { error: (e as Error).message })
        return { ok: false, status: centerStatus() }
      }
    },
  )

  ipcMain.handle('syncCenter:markFullRescan', (_e, reason: string) => {
    markNeedsFullRescan(reason || 'user')
    return centerStatus()
  })

  // ---------- S7-08：设备管理与 tombstone ----------
  ipcMain.handle('syncCenter:listDevices', () => {
    try {
      const meta = getSyncDomain().meta
      const receipts = meta.listReceipts()
      const states = meta.listPeerDeviceStates()
      const byId = new Map<string, {
        deviceId: string
        displayName: string | null
        retired: boolean
        retiredAt: number | null
        lastSeenAt: number | null
        cursor: number
        knownDevices: number
      }>()
      for (const s of states) {
        byId.set(s.peerId, {
          deviceId: s.peerId,
          displayName: s.displayName,
          retired: s.retired,
          retiredAt: s.retiredAt,
          lastSeenAt: null,
          cursor: 0,
          knownDevices: 0,
        })
      }
      for (const r of receipts) {
        let known: VersionVector = {}
        try {
          known = JSON.parse(r.knownVector) as VersionVector
        } catch {
          known = {}
        }
        const prev = byId.get(r.peerId)
        const item = prev ?? {
          deviceId: r.peerId,
          displayName: null,
          retired: false,
          retiredAt: null,
          lastSeenAt: null,
          cursor: 0,
          knownDevices: 0,
        }
        item.lastSeenAt = r.committedAt
        item.cursor = r.cursor
        item.knownDevices = Object.keys(known).length
        byId.set(r.peerId, item)
      }
      return [...byId.values()].sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
    } catch {
      return []
    }
  })

  ipcMain.handle('syncCenter:retireDevice', (_e, deviceId: string) => {
    try {
      const meta = getSyncDomain().meta
      // 退役设备重新出现必须当新设备：删除 receipt + 标记 retired（旧计数器不得继续写）
      const ok = meta.retirePeerDevice(String(deviceId))
      log.info('设备已退役', { deviceId })
      return { ok, status: centerStatus() }
    } catch (e) {
      log.warn('retireDevice 失败', { error: (e as Error).message })
      return { ok: false, status: centerStatus() }
    }
  })

  ipcMain.handle('syncCenter:tombstoneDryRun', (_e, opts?: { retainDays?: number; now?: number }) => {
    try {
      const meta = getSyncDomain().meta
      const deleted = meta.listDeletedHeads(20_000)
      const tombstones: TombstoneRecord[] = deleted.map((h) => {
        let version: VersionVector = {}
        try {
          version = JSON.parse(h.versionJson) as VersionVector
        } catch {
          version = {}
        }
        return {
          entityType: h.entityType,
          entityId: h.entityId,
          deletedAt: h.updatedAt ?? 0,
          version,
        }
      })
      const receipts = meta.listReceipts()
      const devices: DeviceAck[] = []
      const seen = new Set<string>()
      for (const r of receipts) {
        let known: VersionVector = {}
        try {
          known = JSON.parse(r.knownVector) as VersionVector
        } catch {
          known = {}
        }
        devices.push({
          deviceId: r.peerId,
          known,
          retired: meta.isPeerDeviceRetired(r.peerId),
        })
        seen.add(r.peerId)
      }
      // 已退役但无 receipt 的设备也要进清单（影响清理判定）
      for (const s of meta.listPeerDeviceStates()) {
        if (seen.has(s.peerId)) continue
        devices.push({ deviceId: s.peerId, known: {}, retired: s.retired })
      }
      const report = tombstoneDryRun(tombstones, devices, {
        retainDays: opts?.retainDays ?? 180,
        now: opts?.now ?? Date.now(),
      })
      return {
        ...report,
        deviceCount: devices.filter((d) => !d.retired).length,
        retiredCount: devices.filter((d) => d.retired).length,
      }
    } catch (e) {
      log.warn('tombstoneDryRun 失败', { error: (e as Error).message })
      return {
        total: 0,
        compactible: 0,
        blocked: 0,
        blockedReasons: {},
        pendingDeviceIds: [],
        deviceCount: 0,
        retiredCount: 0,
      }
    }
  })
}
