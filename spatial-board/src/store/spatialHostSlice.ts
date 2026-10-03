/**
 * 画板 slice：宿主提交/保存（结构阶段 4C 自 spatialStore.ts 拆出）。
 *
 * 覆盖世界新建与重命名、导入导出、载入与外部权威同步（PC 确认链路）。
 * 导入路径保持既有围栏顺序：迁移 → 子结构冲突清理 → 上限/引用防护 → 领域校验 → 载入。
 */
import type { SpatialCoreState } from '@qingyu/spatial-core'
import {
  createEmptyRuntime,
  createHistory,
  createWorldWithDefaults,
  exportRuntimeJson,
  exportWorldJson,
  guardRuntimeImport,
  guardWorldImport,
  IMPORT_LIMITS,
  migrateRuntimeState,
  migrateWorldDocument,
  removeNodeCategories,
  removeSubstructureConflicts,
  runBatch,
  validateAll,
} from '@qingyu/spatial-core'
import { keepValidSelection, now } from './spatialStoreHelpers.ts'
import type {
  SpatialStore,
  SpatialStoreGet,
  SpatialStoreSet,
} from './spatialStoreTypes.ts'

export type SpatialHostActions = Pick<SpatialStore,
  | 'newWorld' | 'setWorldName' | 'exportPackage' | 'importPackage' | 'loadWorld'
  | 'getCore' | 'syncAuthoritative'>

export function createSpatialHostSlice(set: SpatialStoreSet, get: SpatialStoreGet): SpatialHostActions {
  return {
    newWorld: (name = '新世界') => {
      const t = now()
      const world = createWorldWithDefaults('world_draft', name, { now: t })
      set({
        core: {
          world,
          runtime: createEmptyRuntime(world.id, 'runtime_draft', t),
        },
        history: createHistory(),
        currentBoardId: world.rootBoardId,
        selection: { type: 'none', id: null },
        tool: 'select',
        saveStatus: 'idle',
        statusMessage: '已新建世界',
        distanceDraftSourceId: null,
        fitViewRequest: get().fitViewRequest + 1,
      })
    },

    setWorldName: (name) => {
      const trimmed = name.trim()
      if (trimmed.length === 0) {
        set({ statusMessage: '世界名称不能为空' })
        return
      }
      const { core, idGen, history } = get()
      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: core.runtime.revision,
          commands: [{ type: 'update_world', patch: { name: trimmed } }],
        },
        { now: now(), source: 'user', idGen, label: 'update-world' }
      )
      if (!result.batch.ok) {
        set({ statusMessage: `重命名失败：${result.batch.code}` })
        return
      }
      set({
        core: result.batch.state,
        history: result.history,
        saveStatus: 'saving',
        statusMessage: `已重命名世界为「${trimmed}」`,
      })
    },

    exportPackage: () => {
      const { core } = get()
      return {
        world: exportWorldJson(core.world),
        runtime: exportRuntimeJson(core.runtime),
      }
    },

    importPackage: (payload) => {
      try {
        const worldMig = migrateWorldDocument(payload.world)
        if (!worldMig.ok) return { ok: false, message: worldMig.message }
        let world = worldMig.value

        let runtime = createEmptyRuntime(world.id, 'runtime_draft', now())
        if (payload.runtime) {
          const rtMig = migrateRuntimeState(payload.runtime)
          if (rtMig.ok) {
            runtime = {
              ...rtMig.value,
              events: rtMig.value.events.slice(-IMPORT_LIMITS.maxEvents),
            }
          }
          else return { ok: false, message: rtMig.message }
        }

        const cleaned = removeSubstructureConflicts({ world, runtime }, now())
        world = cleaned.state.world
        runtime = cleaned.state.runtime

        // 结构上限与引用防护
        const limitIssues = guardWorldImport(world)
        if (limitIssues.length > 0) {
          return {
            ok: false,
            message: `导入被拒：${limitIssues[0].code} ${limitIssues[0].message}`,
          }
        }
        const rtIssues = guardRuntimeImport(runtime, world)
        if (rtIssues.length > 0) {
          return {
            ok: false,
            message: `运行状态导入被拒：${rtIssues[0].code} ${rtIssues[0].message}`,
          }
        }

        // 领域校验
        const issues = validateAll(world, runtime)
        const err = issues.find((i) => i.severity === 'error')
        if (err) return { ok: false, message: `${err.code}: ${err.message}` }

        get().loadWorld(world, runtime)
        return { ok: true }
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },

    loadWorld: (world, runtime) => {
      const rt =
        runtime && typeof runtime === 'object' && 'placements' in (runtime as object)
          ? (runtime as ReturnType<typeof createEmptyRuntime>)
          : createEmptyRuntime(world.id, 'runtime_draft', now())
      const cleaned = removeSubstructureConflicts({ world: removeNodeCategories(world).world, runtime: rt }, now())
      set({
        core: cleaned.state,
        history: createHistory(),
        currentBoardId: world.rootBoardId,
        selection: { type: 'none', id: null },
        tool: 'select',
        saveStatus: 'saving',
        statusMessage: cleaned.changed ? '已载入世界并移除嵌套子结构冲突' : '已载入世界',
        fitViewRequest: get().fitViewRequest + 1,
      })
      // 载入后按层级自动匹配子项方向（旧草稿/导入数据同样适用）
      get().normalizeRows()
    },

    getCore: () => get().core,

    syncAuthoritative: (core: SpatialCoreState, resetHistory = false, initial = false) => {
      const issue = [...guardWorldImport(core.world), ...guardRuntimeImport(core.runtime, core.world),
        ...validateAll(core.world, core.runtime).filter((item) => item.severity === 'error')][0]
      if (issue) throw new Error(`权威画板数据无效：${issue.message}`)
      const state = get()
      set({
        core,
        history: resetHistory ? createHistory() : state.history,
        selection: keepValidSelection(core, state.selection),
        currentBoardId: core.world.boards.some((board) => board.id === state.currentBoardId) ? state.currentBoardId : core.world.rootBoardId,
        distanceDraftSourceId: state.distanceDraftSourceId && core.world.nodes.some((node) => node.id === state.distanceDraftSourceId)
          ? state.distanceDraftSourceId : null,
        fitViewRequest: initial ? state.fitViewRequest + 1 : state.fitViewRequest,
      })
    },
  }
}