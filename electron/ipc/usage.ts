
/**
 * 字符用量统计 IPC 接口
 *
 * - usage:record      追加一条用量记录
 * - usage:query       按条件查询用量
 * - usage:aggregate   按维度聚合用量
 * - usage:summary     全局汇总
 * - usage:clear       清空用量记录
 */

import type { IpcMain } from 'electron'
import {
  recordUsage,
  queryUsage,
  clearUsage,
  aggregateUsage,
  getSummary,
  type UsageGroupBy,
  type UsageFilter,
} from '../services/usage'
import { createLogger } from '../services/logger'
import type { UsageRecord } from '../../shared/types'
import { app } from 'electron'
import { ensureSyncDomain, journalPutIfEnabled, getSyncDomain } from '../domain/syncDomainService'

const log = createLogger('usage-ipc')

/** 注册用量统计相关 IPC 处理器 */
export function registerUsageIPC(ipcMain: IpcMain): void {
  // 追加一条用量记录
  ipcMain.handle('usage:record', async (_e, record: Omit<UsageRecord, 'id'>) => {
    const full = await recordUsage(record)
    try {
      ensureSyncDomain(app.getPath('userData'))
      journalPutIfEnabled({
        domain: 'usage_record',
        entityType: 'usage_record',
        entityId: full.id,
        payload: {
          timestamp: full.timestamp,
          characterId: full.characterId,
          sessionId: full.sessionId,
          model: full.model,
          inputChars: full.inputChars,
          outputChars: full.outputChars,
          totalChars: full.totalChars,
        },
      })
    } catch (err) {
      log.warn('usage journal 失败', { err: String(err) })
    }
    return full
  })

  // 按条件查询用量
  ipcMain.handle('usage:query', async (_e, filter: UsageFilter) => {
    return queryUsage(filter ?? {})
  })

  // 按维度聚合用量
  ipcMain.handle('usage:aggregate', async (_e, filter: UsageFilter, groupBy: UsageGroupBy, timeZone?: string) => {
    const records = queryUsage(filter ?? {})
    return aggregateUsage(records, groupBy, timeZone)
  })

  // 全局汇总
  ipcMain.handle('usage:summary', async (_e, filter?: { startTs?: number; endTs?: number }) => {
    return getSummary(filter)
  })

  // 清空用量记录
  ipcMain.handle('usage:clear', async () => {
    clearUsage()
    try {
      ensureSyncDomain(app.getPath('userData'))
      const { meta, repo } = getSyncDomain()
      const deviceId = repo.deviceId()
      const next = BigInt(meta.getDeviceState()?.nextCounter ?? '1')
      const through: Record<string, string> = {
        [deviceId]: String(next > 0n ? next - 1n : 0n),
      }
      journalPutIfEnabled({
        domain: 'usage_record',
        entityType: 'usage_clear_marker',
        entityId: 'usage-clear-marker',
        payload: { clearedThrough: through },
      })
    } catch (err) {
      log.warn('usage clear marker journal 失败', { err: String(err) })
    }
  })

  log.info('用量统计 IPC 已注册')
}
