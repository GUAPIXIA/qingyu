/**
 * S9-02：首次同步引导（只读计划）。
 *
 * - 明确标注「将以哪边为初始资料」；
 * - 若 PC 与 Android 来自同一旧 PC 数据集，验证 migrationGenesisId 与业务 hash；
 *   相同投影自动收敛，只有真实差异进入冲突中心；
 * - 不提供模糊的「一键覆盖全部」；全量覆盖必须二次确认并先备份。
 */
import type { VersionVector } from '../../shared/contracts/version-vector'

export type InitialSide = 'local_pc' | 'remote_peer' | 'undetermined'

export interface FirstSyncPlanInput {
  localEntityCount: number
  remoteEntityCount: number
  localGenesisId: string | null
  remoteGenesisId: string | null
  /** 本地已完成 bootstrap 的业务数据集哈希 */
  localDatasetHash: string | null
  remoteDatasetHash: string | null
  localKnown: VersionVector
  remoteKnown: VersionVector
}

export interface FirstSyncPlanItem {
  kind: 'initial_side' | 'genesis_match' | 'genesis_mismatch' | 'same_hash_converge' | 'true_conflict' | 'full_replace_warning'
  severity: 'info' | 'warn' | 'block'
  message: string
}

export interface FirstSyncPlan {
  initialSide: InitialSide
  items: FirstSyncPlanItem[]
  /** 相同投影可自动收敛条数（估计） */
  sameHashConvergeCount: number
  /** 需进冲突中心的条数（估计；由调用方注入后填充） */
  trueConflictHint: string
  /** 是否允许「全量覆盖」（需二次确认 + 先备份） */
  allowFullReplaceWithConfirm: boolean
}

function countKeys(v: VersionVector): number {
  return Object.keys(v ?? {}).length
}

/**
 * 生成首次同步 dry-run 引导。纯函数，不发起网络。
 */
export function buildFirstSyncPlan(input: FirstSyncPlanInput): FirstSyncPlan {
  const items: FirstSyncPlanItem[] = []
  let initialSide: InitialSide = 'undetermined'
  const localN = input.localEntityCount
  const remoteN = input.remoteEntityCount

  if (localN > 0 && remoteN === 0) {
    initialSide = 'local_pc'
    items.push({
      kind: 'initial_side',
      severity: 'info',
      message: '将以 PC 本地为初始资料导入对端（对端当前为空）',
    })
  } else if (remoteN > 0 && localN === 0) {
    initialSide = 'remote_peer'
    items.push({
      kind: 'initial_side',
      severity: 'info',
      message: '将以对端为初始资料导入本机（本机当前为空）',
    })
  } else if (localN > 0 && remoteN > 0) {
    initialSide = localN >= remoteN ? 'local_pc' : 'remote_peer'
    items.push({
      kind: 'initial_side',
      severity: 'info',
      message: `双方均有数据：本机 ${localN} 条、对端 ${remoteN} 条；不提供一键覆盖，并集 + 冲突中心`,
    })
    items.push({
      kind: 'full_replace_warning',
      severity: 'warn',
      message: '全量覆盖必须二次确认并先备份；不存在模糊的「一键覆盖全部」',
    })
  } else {
    items.push({
      kind: 'initial_side',
      severity: 'warn',
      message: '双方均无实体，首次同步无内容',
    })
  }

  const localGenesis = input.localGenesisId
  const remoteGenesis = input.remoteGenesisId
  if (localGenesis && remoteGenesis) {
    if (localGenesis === remoteGenesis) {
      items.push({
        kind: 'genesis_match',
        severity: 'info',
        message: 'migrationGenesisId 一致：同源旧 PC 数据集，相同内容投影将自动收敛',
      })
      if (input.localDatasetHash && input.remoteDatasetHash && input.localDatasetHash === input.remoteDatasetHash) {
        items.push({
          kind: 'same_hash_converge',
          severity: 'info',
          message: '业务数据集哈希相同：可整体收敛，不进入冲突中心',
        })
      }
    } else {
      items.push({
        kind: 'genesis_mismatch',
        severity: 'warn',
        message: 'migrationGenesisId 不一致：不是同一旧数据集，差异按并发冲突处理',
      })
    }
  } else if (localGenesis || remoteGenesis) {
    items.push({
      kind: 'genesis_mismatch',
      severity: 'warn',
      message: '缺少一侧 migrationGenesisId：不得宣称迁移已完整，缺失内容须在首次同步补齐或用户明确放弃',
    })
  }

  const localKeys = countKeys(input.localKnown)
  const remoteKeys = countKeys(input.remoteKnown)
  const trueConflictHint =
    localKeys === 0 && remoteKeys === 0
      ? '两端均无历史版本向量，首次同步以并集为主'
      : `已知版本向量：本机 ${localKeys} 设备 / 对端 ${remoteKeys} 设备；并发修改将进入冲突中心`

  return {
    initialSide,
    items,
    sameHashConvergeCount: 0,
    trueConflictHint,
    allowFullReplaceWithConfirm: true,
  }
}
