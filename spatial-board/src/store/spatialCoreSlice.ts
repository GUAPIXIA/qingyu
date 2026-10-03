/**
 * 画板 slice：通用指令入口与撤销/重做（结构阶段 4C 自 spatialStore.ts 拆出）。
 *
 * 所有领域写入的唯一通道：命令批经核心 runBatch 应用，成功后整体替换 core/history。
 */
import {
  canRedo,
  canUndo,
  redo as redoHistory,
  runBatch,
  undo as undoHistory,
} from '@qingyu/spatial-core'
import { keepValidSelection, now } from './spatialStoreHelpers.ts'
import type {
  SpatialStore,
  SpatialStoreGet,
  SpatialStoreSet,
} from './spatialStoreTypes.ts'

export type SpatialCoreActions = Pick<SpatialStore,
  'applyCommands' | 'undo' | 'redo' | 'canUndo' | 'canRedo'>

export function createSpatialCoreSlice(set: SpatialStoreSet, get: SpatialStoreGet): SpatialCoreActions {
  return {
    applyCommands: (commands, label) => {
      if (commands.length === 0) return { ok: false, message: '命令为空' }
      const { core, idGen, history } = get()
      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: core.runtime.revision,
          commands,
        },
        { now: now(), source: 'user', idGen, label: label ?? 'apply-commands' }
      )
      if (!result.batch.ok) {
        set({ statusMessage: `指令失败：${result.batch.code}` })
        return { ok: false, message: result.batch.message }
      }
      set({
        core: result.batch.state,
        history: result.history,
        saveStatus: 'saving',
        statusMessage: `已执行 ${commands.length} 条指令`,
      })
      return { ok: true }
    },

    undo: () => {
      const { core, history, idGen, selection } = get()
      const result = undoHistory(core, history, { now: now(), idGen })
      if (!result.batch.ok) {
        set({ statusMessage: result.batch.message })
        return
      }
      set({
        core: result.batch.state,
        history: result.history,
        selection: keepValidSelection(result.batch.state, selection),
        saveStatus: 'saving',
        statusMessage: '已撤销',
      })
    },

    redo: () => {
      const { core, history, idGen, selection } = get()
      const result = redoHistory(core, history, { now: now(), idGen })
      if (!result.batch.ok) {
        set({ statusMessage: result.batch.message })
        return
      }
      set({
        core: result.batch.state,
        history: result.history,
        selection: keepValidSelection(result.batch.state, selection),
        saveStatus: 'saving',
        statusMessage: '已重做',
      })
    },

    canUndo: () => canUndo(get().history),
    canRedo: () => canRedo(get().history),
  }
}