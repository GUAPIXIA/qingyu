import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * PCE-01：同步健康标记。
 *
 * 总方案 §3.4：已启用同步后若 journal 不可用，PC 可继续本地工作，但必须先持久化
 * `needsFullRescan` 恢复标记并暂停同步；禁止静默回退成「继续直写且仍显示可同步」。
 *
 * 标记落在独立文件（不进 sync-meta.db）：元数据库本身损坏时仍能写入。
 * 恢复后必须全量重建 heads（bootstrap），不得用旧 cursor 做增量同步。
 */
export interface SyncHealthState {
  needsFullRescan: boolean
  reason: string | null
  updatedAt: number | null
}

const EMPTY: SyncHealthState = { needsFullRescan: false, reason: null, updatedAt: null }

export function defaultSyncHealthPath(userDataDir: string): string {
  return `${userDataDir.replace(/[\\/]+$/, '')}/data/config/sync-health.json`
}

export class SyncHealthStore {
  constructor(private readonly filePath: string) {}

  read(): SyncHealthState {
    if (!existsSync(this.filePath)) return { ...EMPTY }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<SyncHealthState>
      return {
        needsFullRescan: parsed.needsFullRescan === true,
        reason: typeof parsed.reason === 'string' ? parsed.reason : null,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null,
      }
    } catch {
      // 文件损坏视为需要全量重扫（宁可暂停同步，也不假装可增量）
      return { needsFullRescan: true, reason: 'sync-health.json 损坏', updatedAt: Date.now() }
    }
  }

  markNeedsFullRescan(reason: string): SyncHealthState {
    const next: SyncHealthState = {
      needsFullRescan: true,
      reason,
      updatedAt: Date.now(),
    }
    this.persist(next)
    return next
  }

  /** 仅在全量 bootstrap 重建 heads 成功后调用 */
  clearAfterFullRescan(): SyncHealthState {
    const next: SyncHealthState = { needsFullRescan: false, reason: null, updatedAt: Date.now() }
    this.persist(next)
    return next
  }

  /** 备份恢复等场景：清空标记（随后走 resetSyncState + 重新 bootstrap） */
  reset(): void {
    try {
      if (existsSync(this.filePath)) unlinkSync(this.filePath)
    } catch {
      /* ignore */
    }
  }

  /**
   * 同步是否可安全运行。
   * needsFullRescan 时必须暂停同步：不得推进 cursor、不得显示「可同步」。
   */
  isSyncReady(): boolean {
    return this.read().needsFullRescan === false
  }

  private persist(state: SyncHealthState): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf8')
  }
}
