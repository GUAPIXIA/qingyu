import type { SyncMetaDb } from './syncMeta'
import {
  classifyTransactionOnDisk,
  cleanupStaging,
  parseIntent,
  rollbackFileTransaction,
  type FileTransactionFacts,
} from './fileTransaction'
import { createLogger } from '../services/logger'

const log = createLogger('sync-recovery')

export type RecoveryAction =
  | 'ROLL_FORWARD'
  | 'ROLL_BACK'
  | 'DISCARD_PREPARED'
  | 'BLOCKED_UNPARSEABLE'

export interface RecoveryOutcome {
  scanned: number
  committed: number
  aborted: number
  blocked: number
  details: Array<{ id: string; from: string; action: RecoveryAction; states?: string[] }>
}

/**
 * 启动恢复：处理未完成的 file_transactions。
 *
 * 判定完全基于 intent（operations_json）与磁盘实际 hash：
 * - 全部命中 newHash → 前滚：补写 entity_heads + change_log（同 dot 已存在则跳过，保证幂等）
 * - 全部命中 oldHash → 回滚：仅清理 staging
 * - 混合状态 / intent 不可解析 / 无 envelope → 回滚到旧内容并标记 ABORTED 供诊断
 *
 * 不通过「重建 journal」猜测权威侧（方案 §2 S2-03 / §12.1）。
 */
export function recoverIncompleteFileTransactions(meta: SyncMetaDb, userDataDir: string): RecoveryOutcome {
  const incomplete = meta.listIncompleteFileTransactionsDetailed()
  const details: RecoveryOutcome['details'] = []
  let committed = 0
  let aborted = 0
  let blocked = 0

  for (const tx of incomplete) {
    const intent = parseIntent(tx.operationsJson)
    if (!intent) {
      // 无法理解的事务：不回滚业务内容（可能已替换），仅标记并清理 staging
      meta.markFileTransaction(tx.id, 'ABORTED')
      cleanupStaging(userDataDir, tx.id)
      blocked += 1
      details.push({ id: tx.id, from: tx.state, action: 'BLOCKED_UNPARSEABLE' })
      log.error('file_transaction intent 不可解析，已标记 ABORTED', { id: tx.id, state: tx.state })
      continue
    }

    const facts: FileTransactionFacts = { id: tx.id, state: tx.state, ...intent }
    const { states, verdict } = classifyTransactionOnDisk(userDataDir, facts)

    if (verdict === 'all_new' && intent.envelopes.length > 0) {
      // 前滚：写 head + journal（按 dot 幂等；同一事务内的实体逐个补写）
      let rolled = 0
      for (const env of intent.envelopes) {
        const existing = meta.findChangeByDot(env.dot.deviceId, env.dot.counter)
        if (existing) continue
        meta.upsertHead({
          entityType: env.entityType,
          entityId: env.entityId,
          versionJson: JSON.stringify(env.version),
          hash: env.contentHash,
          deleted: env.deleted ? 1 : 0,
          payloadRef: null,
        })
        meta.appendChange({
          dotDevice: env.dot.deviceId,
          dotCounter: env.dot.counter,
          entityType: env.entityType,
          entityId: env.entityId,
          envelope: env,
          origin: 'local',
        })
        rolled += 1
      }
      meta.markFileTransaction(tx.id, 'JOURNAL_COMMITTED')
      cleanupStaging(userDataDir, tx.id)
      committed += 1
      details.push({ id: tx.id, from: tx.state, action: 'ROLL_FORWARD', states })
      log.info('启动恢复前滚事务', {
        id: tx.id,
        from: tx.state,
        entities: intent.envelopes.length,
        appended: rolled,
      })
      continue
    }

    if (verdict === 'all_old') {
      meta.markFileTransaction(tx.id, 'ABORTED')
      cleanupStaging(userDataDir, tx.id)
      aborted += 1
      details.push({
        id: tx.id,
        from: tx.state,
        action: tx.state === 'PREPARED' ? 'DISCARD_PREPARED' : 'ROLL_BACK',
        states,
      })
      continue
    }

    // mixed 或 all_new 但缺 envelope：回滚到旧内容，保证与 journal 一致
    const result = rollbackFileTransaction(userDataDir, facts)
    meta.markFileTransaction(tx.id, 'ABORTED')
    aborted += 1
    details.push({ id: tx.id, from: tx.state, action: 'ROLL_BACK', states })
    log.warn('启动恢复回滚事务', {
      id: tx.id,
      from: tx.state,
      states: states.join(','),
      restored: result.restored,
      removed: result.removed,
    })
  }

  if (details.length) {
    meta.saveCheckpoint({
      id: `recovery-${Date.now()}`,
      reason: 'startup_recovery',
      path: null,
      hash: `scanned=${incomplete.length};committed=${committed};aborted=${aborted};blocked=${blocked}`,
    })
    log.info('file_transactions 启动恢复完成', {
      scanned: incomplete.length,
      committed,
      aborted,
      blocked,
    })
  }

  return { scanned: incomplete.length, committed, aborted, blocked, details }
}
