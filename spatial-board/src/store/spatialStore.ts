/**
 * 独立 Zustand store：UI 只发出意图，生成 SpatialCommand 进入核心。
 * 不直接改 nodes/edges 领域数组。
 *
 * 结构阶段 4C：状态与动作契约见 `spatialStoreTypes.ts`；
 * 动作实现按 命令/历史、选择/视口、编辑意图（节点/距离/角色）、宿主提交/保存、剧情建议
 * 拆分到同目录 slice 模块，本文件只保留初始状态与组合入口（页面消费路径不变）。
 */
import { create } from 'zustand'
import {
  createEmptyRuntime,
  createHistory,
  createSeqIdGen,
  createWorldWithDefaults,
  validateAll,
  type SpatialCoreState,
} from '@qingyu/spatial-core'
import type { SpatialStore } from './spatialStoreTypes.ts'
import { now } from './spatialStoreHelpers.ts'
import { createSpatialCoreSlice } from './spatialCoreSlice.ts'
import { createSpatialViewportSlice } from './spatialViewportSlice.ts'
import { createSpatialNodeEditSlice } from './spatialNodeEditSlice.ts'
import { createSpatialDistanceSlice } from './spatialDistanceSlice.ts'
import { createSpatialActorSlice } from './spatialActorSlice.ts'
import { createSpatialHostSlice } from './spatialHostSlice.ts'
import { createSpatialStorySlice } from './spatialStorySlice.ts'

export const useSpatialStore = create<SpatialStore>((set, get) => ({
  core: {
    world: createWorldWithDefaults('world_draft', '新世界', { now: now() }),
    runtime: createEmptyRuntime('world_draft', 'runtime_draft', now()),
  },
  history: createHistory(),
  tool: 'select',
  selection: { type: 'none', id: null },
  currentBoardId: 'world_draft_root',
  saveStatus: 'idle',
  statusMessage: '就绪',
  actorAvatarUrls: {},
  activeActorIds: null,
  assistantEnabled: true,
  distanceDraftSourceId: null,
  fitViewRequest: 0,
  idGen: createSeqIdGen('n'),
  autoMovePolicy: 'suggest',
  pendingSuggestions: [],

  // 阶段 4C：动作实现按业务拆分到 slice，此处仅组合注入
  ...createSpatialCoreSlice(set, get),
  ...createSpatialViewportSlice(set, get),
  ...createSpatialNodeEditSlice(set, get),
  ...createSpatialDistanceSlice(set, get),
  ...createSpatialActorSlice(set, get),
  ...createSpatialHostSlice(set, get),
  ...createSpatialStorySlice(set, get),
}))

/** 校验问题数（状态栏） */
export function countValidationIssues(core: SpatialCoreState): number {
  return validateAll(core.world, core.runtime).filter((i) => i.severity === 'error')
    .length
}