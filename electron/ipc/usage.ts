/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Token 用量统计 IPC 接口
 *
 * - usage:record      追加一条用量记录
 * - usage:query       按条件查询用量
 * - usage:aggregate   按维度聚合用量
 * - usage:summary     全局汇总
 * - usage:clear       清空用量记录
 * - usage:calculateCost 计算单次调用费用（从 settings 读取 pricingRules）
 */

import type { IpcMain } from 'electron'
import { join } from 'node:path'
import {
  recordUsage,
  queryUsage,
  clearUsage,
  calculateCost,
  aggregateUsage,
  getSummary,
  type UsageGroupBy,
  type UsageFilter,
} from '../services/usage'
import { DIRS, readJson, getDefaultSettings } from '../services/storage'
import { createLogger } from '../services/logger'
import type { Settings, UsageRecord, PricingRule } from '../../shared/types'

const log = createLogger('usage-ipc')

const SETTINGS_FILE = () => join(DIRS.config(), 'settings.json')

/** 从 settings 读取定价规则 */
function loadPricingRules(): PricingRule[] {
  const settings = readJson<Settings>(SETTINGS_FILE()) ?? getDefaultSettings()
  return settings.pricingRules ?? []
}

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

  // 计算单次调用费用（从 settings 读取 pricingRules）
  ipcMain.handle(
    'usage:calculateCost',
    async (_e, model: string, promptTokens: number, completionTokens: number) => {
      const rules = loadPricingRules()
      return calculateCost(model, promptTokens, completionTokens, rules)
    },
  )

  log.info('用量统计 IPC 已注册')
}
