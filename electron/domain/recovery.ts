import type { SyncMetaDb } from './syncMeta'
import { createLogger } from '../services/logger'

const log = createLogger('sync-recovery')

export interface RecoveryOutcome {
  scanned: number
  committed: number
  aborted: number
  details: Array<{ id: string; from: string; action: string }>
}

/**
 * 启动恢复：处理未完成的 file_transactions。
 * - PREPARED：业务文件尚未替换 → 安全 ABORT（不回滚业务）
 * - FILES_APPLIED：业务文件可能已替换但 journal 未提交 → 无法在无哈希校验时自动前滚；
 *   记录为 blocked 并 ABORT 到可诊断状态（阶段 2 不静默重建 journal）。
 *
 * 后续增强：operations_json 中带 path+newHash，恢复时比对磁盘 hash 决定前滚/回滚。
 */
export function recoverIncompleteFileTransactions(meta: SyncMetaDb): RecoveryOutcome {
  const incomplete = meta.listIncompleteFileTransactions()
  const details: RecoveryOutcome['details'] = []
  let committed = 0
  let aborted = 0

  for (const tx of incomplete) {
    if (tx.state === 'PREPARED') {
      meta.markFileTransaction(tx.id, 'ABORTED')
      aborted += 1
      details.push({ id: tx.id, from: 'PREPARED', action: 'ABORT' })
      continue
    }
    if (tx.state === 'FILES_APPLIED') {
      // 无完整 hash 清单时不猜测权威侧；标记 ABORTED 供诊断，业务文件保持现状
      meta.markFileTransaction(tx.id, 'ABORTED')
      aborted += 1
      details.push({ id: tx.id, from: 'FILES_APPLIED', action: 'ABORT_PENDING_HASH_RECOVERY' })
      log.warn('发现 FILES_APPLIED 未提交事务，已标记 ABORTED 待增强哈希恢复', { id: tx.id })
      continue
    }
  }

  if (details.length) {
    log.info('file_transactions 启动恢复完成', { scanned: incomplete.length, aborted })
  }

  return { scanned: incomplete.length, committed, aborted, details }
}
