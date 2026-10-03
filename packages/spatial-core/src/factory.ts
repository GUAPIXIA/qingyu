/**
 * 空工厂：创建空世界与空运行状态，供命令构建。
 */
import type {
  RegionNode,
  SpatialBoard,
  SpatialRuntimeStateV1,
  SpatialWorldDocumentV1,
} from './model.ts'
import {
  OFFSTAGE_REGION_DESCRIPTION,
  OFFSTAGE_REGION_NAME,
  OFFSTAGE_REGION_SIZE,
  OFFSTAGE_REGION_TAG,
} from './model.ts'

export function createRootBoard(
  id: string,
  name: string,
  description = ''
): SpatialBoard {
  return {
    id,
    name,
    description,
    parentEntryNodeId: null,
    coordinateConvention: {
      north: 'up',
      origin: 'top-left',
      units: 'canvas',
    },
  }
}

export function createEmptyWorld(
  worldId: string,
  name: string,
  options: {
    now: number
    rootBoardId?: string
    description?: string
  }
): SpatialWorldDocumentV1 {
  const rootBoardId = options.rootBoardId ?? `${worldId}_root`
  return {
    schemaVersion: 1,
    id: worldId,
    name,
    description: options.description ?? '',
    rootBoardId,
    boards: [createRootBoard(rootBoardId, '世界', '根画板')],
    nodes: [],
    distances: [],
    actors: [],
    metadata: {
      createdAt: options.now,
      updatedAt: options.now,
      app: 'qingyu-spatial-board',
    },
  }
}

/** 应用层新世界：根画板自带“未参与对话”区域。 */
export function createWorldWithDefaults(
  worldId: string,
  name: string,
  options: {
    now: number
    rootBoardId?: string
    description?: string
  }
): SpatialWorldDocumentV1 {
  const world = createEmptyWorld(worldId, name, options)
  const offstage: RegionNode = {
    id: `${worldId}_offstage`,
    boardId: world.rootBoardId,
    kind: 'region',
    name: OFFSTAGE_REGION_NAME,
    description: OFFSTAGE_REGION_DESCRIPTION,
    tags: [OFFSTAGE_REGION_TAG],
    parentNodeId: null,
    childBoardId: null,
    createdAt: options.now,
    updatedAt: options.now,
    geometry: {
      x: -420,
      y: 40,
      width: OFFSTAGE_REGION_SIZE.width,
      height: OFFSTAGE_REGION_SIZE.height,
    },
  }
  world.nodes.push(offstage)
  return world
}

export function createEmptyRuntime(
  worldId: string,
  runtimeId: string,
  now: number
): SpatialRuntimeStateV1 {
  return {
    schemaVersion: 1,
    worldId,
    runtimeId,
    revision: 0,
    placements: [],
    events: [],
    updatedAt: now,
  }
}

/** 确定性 ID 生成器（测试用）；生产可注入 nanoid */
export function createSeqIdGen(prefix: string = 'id'): () => string {
  let n = 0
  return () => {
    n += 1
    return `${prefix}_${n}`
  }
}
