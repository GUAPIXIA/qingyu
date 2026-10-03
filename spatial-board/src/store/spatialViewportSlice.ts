/**
 * 画板 slice：视口、工具、选择与画板导航（结构阶段 4C 自 spatialStore.ts 拆出）。
 *
 * 持有画布视口控制器引用（由 BoardCanvas 挂载时注册、卸载时清空），
 * 其余动作只读写 store 状态，不直接修改领域数组。
 */
import { getNode } from '@qingyu/spatial-core'
import type {
  CanvasViewportControls,
  SpatialStore,
  SpatialStoreGet,
  SpatialStoreSet,
} from './spatialStoreTypes.ts'

export type SpatialViewportActions = Pick<SpatialStore,
  | 'registerCanvasControls' | 'zoomIn' | 'zoomOut' | 'fitView' | 'getViewport'
  | 'setViewport' | 'setTool' | 'select' | 'enterBoard' | 'enterChildBoard'
  | 'goRootBoard' | 'breadcrumb'>

/** 视口控制器由画布挂载时注册，卸载时清空 */
let canvasControls: CanvasViewportControls | null = null

export function createSpatialViewportSlice(set: SpatialStoreSet, get: SpatialStoreGet): SpatialViewportActions {
  return {
    registerCanvasControls: (controls) => {
      canvasControls = controls
    },

    zoomIn: () => {
      canvasControls?.zoomIn()
    },

    zoomOut: () => {
      canvasControls?.zoomOut()
    },

    fitView: () => {
      canvasControls?.fitView()
    },

    getViewport: () => canvasControls?.getViewport() ?? null,

    setViewport: (viewport) => {
      canvasControls?.setViewport(viewport)
    },

    setTool: (tool) => {
      set({
        tool,
        distanceDraftSourceId: tool === 'distance' ? get().distanceDraftSourceId : null,
        statusMessage:
          tool === 'region'
            ? '拖拽绘制矩形区域'
            : tool === 'place'
              ? '单击画布创建地点'
              : tool === 'distance'
                ? '依次点击两个同类节点创建距离'
                : tool === 'offstage'
                  ? '单击或拖拽添加「未参与对话」区域'
                  : '选择模式',
      })
    },

    select: (selection) => set({ selection }),

    enterBoard: (boardId) => {
      set((state) => ({
        currentBoardId: boardId,
        selection: { type: 'none', id: null },
        fitViewRequest: state.fitViewRequest + 1,
      }))
    },

    enterChildBoard: (nodeId) => {
      const node = getNode(get().core.world, nodeId)
      if (node?.childBoardId) {
        get().enterBoard(node.childBoardId)
      }
    },

    goRootBoard: () => {
      set((state) => ({
        currentBoardId: get().core.world.rootBoardId,
        selection: { type: 'none', id: null },
        fitViewRequest: state.fitViewRequest + 1,
      }))
    },

    breadcrumb: () => {
      const { core, currentBoardId } = get()
      const world = core.world
      const chain: Array<{ id: string; name: string }> = []
      const visited = new Set<string>()
      let bid: string | null = currentBoardId
      while (bid && !visited.has(bid)) {
        visited.add(bid)
        const board = world.boards.find((b) => b.id === bid)
        if (!board) break
        chain.unshift({ id: board.id, name: board.name })
        bid = board.parentEntryNodeId
          ? (getNode(world, board.parentEntryNodeId)?.boardId ?? null)
          : null
      }
      return chain
    },
  }
}