
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

const log = createLogger('usage-ipc')

/** 注册用量统计相关 IPC 处理器 */
export function registerUsageIPC(ipcMain: IpcMain): void {
  // 追加一条用量记录
  ipcMain.handle('usage:record', async (_e, record: Omit<UsageRecord, 'id'>) => {
    return recordUsage(record)
  })

  // 按条件查询用量
  ipcMain.handle('usage:query', async (_e, filter: UsageFilter) => {
    return queryUsage(filter ?? {})
  })

  // 按维度聚合用量
  ipcMain.handle('usage:aggregate', async (_e, filter: UsageFilter, groupBy: UsageGroupBy) => {
    const records = queryUsage(filter ?? {})
    return aggregateUsage(records, groupBy)
  })

  // 全局汇总
  ipcMain.handle('usage:summary', async (_e, filter?: { startTs?: number; endTs?: number }) => {
    return getSummary(filter)
  })

  // 清空用量记录
  ipcMain.handle('usage:clear', async () => {
    clearUsage()
  })

  log.info('用量统计 IPC 已注册')
}
