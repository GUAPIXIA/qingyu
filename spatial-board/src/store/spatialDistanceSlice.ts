/**
 * 画板 slice：距离关系的草稿与增删改（结构阶段 4C 自 spatialStore.ts 拆出）。
 *
 * 距离创建遵守核心的同类/同画板/重复校验；写入一律经 runBatch 提交。
 */
import type { DistanceRelation, DistanceRelationPatch } from '@qingyu/spatial-core'
import { getNode, runBatch } from '@qingyu/spatial-core'
import { newId, now } from './spatialStoreHelpers.ts'
import type {
  SpatialStore,
  SpatialStoreGet,
  SpatialStoreSet,
} from './spatialStoreTypes.ts'

export type SpatialDistanceActions = Pick<SpatialStore,
  | 'startDistance' | 'cancelDistance' | 'completeDistance'
  | 'createDistanceBetween' | 'updateDistance' | 'deleteDistance'>

export function createSpatialDistanceSlice(set: SpatialStoreSet, get: SpatialStoreGet): SpatialDistanceActions {
  return {
    startDistance: (sourceNodeId) => {
      set({
        distanceDraftSourceId: sourceNodeId,
        tool: 'distance',
        statusMessage: '已选起点，请点击同类终点',
      })
    },

    cancelDistance: () => {
      set({ distanceDraftSourceId: null, statusMessage: '已取消距离创建 '})
    },

    completeDistance: (targetNodeId) => {
      const source = get().distanceDraftSourceId
      if (!source) return null
      const id = get().createDistanceBetween(source, targetNodeId)
      set({ distanceDraftSourceId: null, tool: 'select' })
      return id
    },

    createDistanceBetween: (sourceId, targetId, partial) => {
      const { core, currentBoardId, idGen, history } = get()
      const src = getNode(core.world, sourceId)
      const tgt = getNode(core.world, targetId)
      if (!src || !tgt) {
        set({ statusMessage: '端点不存在 '})
        return null
      }
      if (src.kind !== tgt.kind) {
        set({ statusMessage: '只能连接同类节点（区域↔区域 / 地点↔地点）' })
        return null
      }
      if (sourceId === targetId) {
        set({ statusMessage: '不能连接自身' })
        return null
      }

      const id = newId('dist', idGen)
      const payload: DistanceRelation = {
        id,
        kind: 'distance',
        boardId: currentBoardId,
        sourceNodeId: sourceId,
        targetNodeId: targetId,
        name: partial?.name ?? `${src.name} ↔ ${tgt.name}`,
        description: '',
        measurement: {
          value: partial?.value ?? null,
          unit: partial?.unit ?? 'km',
          ...(partial?.customUnit ? { customUnit: partial.customUnit } : {}),
          displayText: partial?.displayText ?? '未知距离',
          certainty: partial?.certainty ?? 'unknown',
        },
        createdAt: now(),
        updatedAt: now(),
      }

      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: core.runtime.revision,
          commands: [{ type: 'create_distance', payload }],
        },
        { now: now(), source: 'user', idGen, label: 'create-distance' }
      )
      if (!result.batch.ok) {
        set({
          statusMessage:
            result.batch.code === 'duplicate_distance'
              ? '两点之间已存在距离关系'
              : result.batch.code === 'cross_kind_distance'
                ? '跨类型距离被拒绝'
                : result.batch.code === 'cross_board_distance'
                  ? '跨画板距离被拒绝'
                  : `创建距离失败：${result.batch.code}`,
        })
        return null
      }
      set({
        core: result.batch.state,
        history: result.history,
        selection: { type: 'distance', id },
        saveStatus: 'saving',
        statusMessage: '已创建距离',
      })
      return id
    },

    updateDistance: (relationId, patch: DistanceRelationPatch) => {
      const { core, idGen, history } = get()
      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: core.runtime.revision,
          commands: [{ type: 'update_distance', relationId, patch }],
        },
        { now: now(), source: 'user', idGen, label: 'update-distance' }
      )
      if (!result.batch.ok) {
        set({ statusMessage: `更新距离失败：${result.batch.code}` })
        return
      }
      set({
        core: result.batch.state,
        history: result.history,
        saveStatus: 'saving',
      })
    },

    deleteDistance: (relationId) => {
      const { core, idGen, history } = get()
      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: core.runtime.revision,
          commands: [{ type: 'delete_distance', relationId }],
        },
        { now: now(), source: 'user', idGen, label: 'delete-distance' }
      )
      if (!result.batch.ok) {
        set({ statusMessage: `删除距离失败：${result.batch.code}` })
        return
      }
      set({
        core: result.batch.state,
        history: result.history,
        selection: { type: 'none', id: null },
        saveStatus: 'saving',
        statusMessage: '已删除距离',
      })
    },
  }
}