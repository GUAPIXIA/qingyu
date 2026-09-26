import { describe, expect, it } from 'vitest'
import { buildFirstSyncPlan } from '../firstSyncPlan'

describe('S9-02 首次同步引导', () => {
  it('对端为空 → 以 PC 为初始资料', () => {
    const plan = buildFirstSyncPlan({
      localEntityCount: 10,
      remoteEntityCount: 0,
      localGenesisId: 'g1',
      remoteGenesisId: null,
      localDatasetHash: 'h',
      remoteDatasetHash: null,
      localKnown: {},
      remoteKnown: {},
    })
    expect(plan.initialSide).toBe('local_pc')
    expect(plan.items.some((i) => i.kind === 'initial_side' && i.message.includes('PC'))).toBe(true)
    expect(plan.allowFullReplaceWithConfirm).toBe(true)
  })

  it('同 genesis 且同 hash → 自动收敛提示', () => {
    const plan = buildFirstSyncPlan({
      localEntityCount: 5,
      remoteEntityCount: 5,
      localGenesisId: 'g1',
      remoteGenesisId: 'g1',
      localDatasetHash: 'sha256:abc',
      remoteDatasetHash: 'sha256:abc',
      localKnown: { pc: '3' },
      remoteKnown: { android: '1' },
    })
    expect(plan.items.some((i) => i.kind === 'genesis_match')).toBe(true)
    expect(plan.items.some((i) => i.kind === 'same_hash_converge')).toBe(true)
  })

  it('genesis 不一致 → 不得宣称迁移完整', () => {
    const plan = buildFirstSyncPlan({
      localEntityCount: 5,
      remoteEntityCount: 5,
      localGenesisId: 'g1',
      remoteGenesisId: 'g2',
      localDatasetHash: 'a',
      remoteDatasetHash: 'b',
      localKnown: {},
      remoteKnown: {},
    })
    expect(plan.items.some((i) => i.kind === 'genesis_mismatch' && i.severity === 'warn')).toBe(true)
  })

  it('缺一侧 genesis → warn 迁移不完整', () => {
    const plan = buildFirstSyncPlan({
      localEntityCount: 5,
      remoteEntityCount: 5,
      localGenesisId: 'g1',
      remoteGenesisId: null,
      localDatasetHash: 'a',
      remoteDatasetHash: 'b',
      localKnown: {},
      remoteKnown: {},
    })
    expect(plan.items.some((i) => i.message.includes('不得宣称迁移已完整'))).toBe(true)
  })

  it('双方都有数据 → 警告禁止一键覆盖', () => {
    const plan = buildFirstSyncPlan({
      localEntityCount: 3,
      remoteEntityCount: 9,
      localGenesisId: null,
      remoteGenesisId: null,
      localDatasetHash: null,
      remoteDatasetHash: null,
      localKnown: {},
      remoteKnown: {},
    })
    expect(plan.items.some((i) => i.kind === 'full_replace_warning')).toBe(true)
    expect(plan.initialSide).toBe('remote_peer')
  })
})
