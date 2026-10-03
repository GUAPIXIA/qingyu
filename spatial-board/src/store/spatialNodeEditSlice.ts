/**
 * 画板 slice：地点/区域/内部画板的编辑意图（结构阶段 4C 自 spatialStore.ts 拆出）。
 *
 * 全部写入以 SpatialCommand 批经核心 runBatch 提交，禁止直接改 nodes 领域数组；
 * 排布类命令由共享助手 reflowRows 预演后一并下发。
 */
import type {
  ChildLayout,
  SpatialCommand,
  SpatialNode,
  SpatialNodePatch,
} from '@qingyu/spatial-core'
import {
  getNode,
  isPlaceSubstructure,
  OFFSTAGE_REGION_DESCRIPTION,
  OFFSTAGE_REGION_NAME,
  OFFSTAGE_REGION_SIZE,
  OFFSTAGE_REGION_TAG,
  runBatch,
} from '@qingyu/spatial-core'
import {
  collectNodeDragContents,
  dockedActorCountAt,
  inferParentNodeId,
  sortRowChildren,
} from '../canvas/adapter.ts'
import {
  defaultChildLayout,
  descendantIdsOf,
  inferChildLayoutFromDrop,
  MIN_REGION_SIZE,
  newId,
  now,
  reflowRows,
  roundCanvas,
  topPlaceRootId,
} from './spatialStoreHelpers.ts'
import type {
  SpatialStore,
  SpatialStoreGet,
  SpatialStoreSet,
} from './spatialStoreTypes.ts'

export type SpatialNodeEditActions = Pick<SpatialStore,
  | 'createRegionAt' | 'createOffstageRegionAt' | 'createPlaceAt' | 'addSubPlace'
  | 'updateNode' | 'deleteNode' | 'moveNode' | 'normalizeRows' | 'createInternalBoard'>

export function createSpatialNodeEditSlice(set: SpatialStoreSet, get: SpatialStoreGet): SpatialNodeEditActions {
  return {
    createRegionAt: (x, y, width, height, name, options) => {
      const { core, currentBoardId, idGen, history } = get()
      const offstage = options?.offstage === true
      const id = newId('region', idGen)
      const geo = {
        x: roundCanvas(x),
        y: roundCanvas(y),
        width: roundCanvas(Math.max(MIN_REGION_SIZE, width)),
        height: roundCanvas(Math.max(MIN_REGION_SIZE, height)),
      }

      const payload: SpatialNode = {
        id,
        boardId: currentBoardId,
        kind: 'region',
        name: name ?? (offstage ? OFFSTAGE_REGION_NAME : '新区域'),
        description: offstage ? OFFSTAGE_REGION_DESCRIPTION : '',
        tags: offstage ? [OFFSTAGE_REGION_TAG] : [],
        parentNodeId: null,
        childBoardId: null,
        createdAt: now(),
        updatedAt: now(),
        geometry: geo,
      }

      const cmd: SpatialCommand = { type: 'create_node', payload }
      const result = runBatch(
        core,
        history,
        { schemaVersion: 1, expectedRevision: core.runtime.revision, commands: [cmd] },
        { now: now(), source: 'user', idGen, label: 'create-region' }
      )
      if (!result.batch.ok) {
        set({ statusMessage: `创建区域失败：${result.batch.code}` })
        return null
      }
      set({
        core: result.batch.state,
        history: result.history,
        selection: { type: 'node', id },
        saveStatus: 'saving',
        statusMessage: offstage
          ? `已添加「${payload.name}」区域`
          : `已创建区域「${payload.name}」`,
      })
      return id
    },

    createOffstageRegionAt: (x, y, width, height) =>
      get().createRegionAt(
        x,
        y,
        width ?? OFFSTAGE_REGION_SIZE.width,
        height ?? OFFSTAGE_REGION_SIZE.height,
        OFFSTAGE_REGION_NAME,
        { offstage: true }
      ),

    createPlaceAt: (x, y, name) => {
      const { core, currentBoardId, idGen, history } = get()
      const id = newId('place', idGen)
      const px = roundCanvas(x)
      const py = roundCanvas(y)

      const payload: SpatialNode = {
        id,
        boardId: currentBoardId,
        kind: 'place',
        name: name ?? '新地点',
        description: '',
        tags: [],
        parentNodeId: null,
        childBoardId: null,
        createdAt: now(),
        updatedAt: now(),
        geometry: { x: px, y: py },
        iconKey: 'marker',
      }

      // 推断父区域
      const parentId = inferParentNodeId(core.world.nodes, currentBoardId, {
        id,
        x: px,
        y: py,
        width: 48,
        height: 48,
      })
      if (parentId) payload.parentNodeId = parentId

      const cmd: SpatialCommand = { type: 'create_node', payload }
      const result = runBatch(
        core,
        history,
        { schemaVersion: 1, expectedRevision: core.runtime.revision, commands: [cmd] },
        { now: now(), source: 'user', idGen, label: 'create-place' }
      )
      if (!result.batch.ok) {
        set({ statusMessage: `创建地点失败：${result.batch.code}` })
        return null
      }
      set({
        core: result.batch.state,
        history: result.history,
        selection: { type: 'node', id },
        saveStatus: 'saving',
        statusMessage: `已创建地点「${payload.name}」`,
      })
      return id
    },

    addSubPlace: (parentId, name) => {
      const { core, idGen, history } = get()
      const parent = getNode(core.world, parentId)
      if (!parent || parent.kind !== 'place') {
        set({ statusMessage: '父地点不存在' })
        return null
      }
      if (isPlaceSubstructure(core.world, parentId)) {
        set({ statusMessage: '子结构不能再次添加子结构' })
        return null
      }
      const siblings = sortRowChildren(
        core.world.nodes.filter(
          (n) => n.parentNodeId === parentId && n.kind === 'place'
        )
      )
      const id = newId('place', idGen)
      const label = '子结构'
      const fallbackName = `子结构 ${siblings.length + 1}`

      const effectiveLayout: ChildLayout =
        parent.childLayout ?? defaultChildLayout(core.world, parent)
      const shouldSyncAutomaticLayout = parent.childLayout === undefined
      const effectiveParent = shouldSyncAutomaticLayout
        ? { ...parent, childLayout: effectiveLayout }
        : parent

      const payload: SpatialNode = {
        id,
        boardId: parent.boardId,
        kind: 'place',
        name: (name ?? '').trim() || fallbackName,
        description: '',
        tags: [],
        parentNodeId: parentId,
        childBoardId: null,
        createdAt: now(),
        updatedAt: now(),
        // 占位：临时取极大坐标保证排在子项末尾（横向按 x、纵向按 y），实际位置由排布写入
        geometry:
          effectiveLayout === 'row'
            ? { x: Number.MAX_SAFE_INTEGER, y: parent.geometry.y }
            : { x: parent.geometry.x, y: Number.MAX_SAFE_INTEGER },
        iconKey: 'pin',
      }

      // 子地点横向成行：新条目落在行尾，并顺带对齐该行已有条目
      const { commands: rowCommands, targets } = reflowRows(
        core.world,
        (nodeId) => dockedActorCountAt(core.runtime.placements, nodeId),
        [topPlaceRootId(core.world, parentId) ?? parentId],
        {
          extraNodes: [effectiveParent, payload],
          skipNodeIds: new Set([id]),
        }
      )
      const target = targets.get(id)
      if (target) payload.geometry = { x: target.x, y: target.y }

      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: core.runtime.revision,
          commands: [
            { type: 'create_node', payload },
            ...(shouldSyncAutomaticLayout
              ? [
                  {
                    type: 'update_node' as const,
                    nodeId: parentId,
                    patch: { childLayout: effectiveLayout },
                  },
                ]
              : []),
            ...rowCommands,
          ],
        },
        { now: now(), source: 'user', idGen, label: 'add-sub-place' }
      )
      if (!result.batch.ok) {
        set({ statusMessage: `添加${label}失败：${result.batch.code}` })
        return null
      }
      set({
        core: result.batch.state,
        history: result.history,
        selection: { type: 'node', id },
        saveStatus: 'saving',
        statusMessage: `已添加${label}「${payload.name}」`,
      })
      return id
    },

    updateNode: (nodeId, patch) => {
      const { core, idGen, history } = get()
      const node = getNode(core.world, nodeId)
      const commands: SpatialCommand[] = [{ type: 'update_node', nodeId, patch }]
      // 地点改坐标或改子项方向后重新排布：x/y 决定顺序，另一轴由排布决定
      if (node?.kind === 'place' && (patch.geometry || patch.childLayout)) {
        commands.push(
          ...reflowRows(
            core.world,
            (id) => dockedActorCountAt(core.runtime.placements, id),
            [node.parentNodeId ?? node.id],
            {
              ...(patch.childLayout
                ? { extraNodes: [{ ...node, childLayout: patch.childLayout }] }
                : {}),
              ...(patch.geometry
                ? {
                    positionOverrides: new Map([
                      [
                        nodeId,
                        {
                          x: patch.geometry.x ?? node.geometry.x,
                          y: patch.geometry.y ?? node.geometry.y,
                        },
                      ],
                    ]),
                  }
                : {}),
            }
          ).commands
        )
      }
      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: core.runtime.revision,
          commands,
        },
        { now: now(), source: 'user', idGen, label: 'update-node' }
      )
      if (!result.batch.ok) {
        set({ statusMessage: `更新失败：${result.batch.code}` })
        return
      }
      set({
        core: result.batch.state,
        history: result.history,
        saveStatus: 'saving',
      })
    },

    deleteNode: (nodeId, cascade = false) => {
      const { core, idGen, history } = get()
      const node = getNode(core.world, nodeId)
      const exclude = new Set<string>([nodeId])
      if (cascade) {
        for (const id of descendantIdsOf(core.world.nodes, nodeId)) exclude.add(id)
      }
      const rowCommands = node?.parentNodeId
        ? reflowRows(
            core.world,
            (id) => dockedActorCountAt(core.runtime.placements, id),
            [topPlaceRootId(core.world, node.parentNodeId)].filter(
              (value): value is string => !!value
            ),
            { excludeNodeIds: exclude }
          ).commands
        : []
      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: core.runtime.revision,
          commands: [
            {
              type: 'delete_node',
              nodeId,
              strategy: cascade ? 'cascade' : 'reject-if-not-empty',
            },
            ...rowCommands,
          ],
        },
        { now: now(), source: 'user', idGen, label: 'delete-node' }
      )
      if (!result.batch.ok) {
        set({
          statusMessage:
            result.batch.code === 'node_not_empty'
              ? '节点非空：请确认级联删除，或先移除子项'
              : `删除失败：${result.batch.code}`,
        })
        return
      }
      set({
        core: result.batch.state,
        history: result.history,
        selection: { type: 'none', id: null },
        saveStatus: 'saving',
        statusMessage: '已删除',
      })
    },

    moveNode: (nodeId, x, y, width, height) => {
      const { core, currentBoardId, idGen, history } = get()
      const node = getNode(core.world, nodeId)
      if (!node) return
      const dragContents = collectNodeDragContents(
        core.world.nodes,
        core.runtime.placements,
        currentBoardId,
        nodeId
      )
      const childIds = dragContents.nodeIds
      const descendantIds = new Set(childIds)

      const nextRegionWidth =
        node.kind === 'region'
          ? roundCanvas(
              Math.max(
                MIN_REGION_SIZE,
                width === undefined
                  ? node.geometry.width
                  : width
              )
            )
          : 0
      const nextRegionHeight =
        node.kind === 'region'
          ? roundCanvas(
              Math.max(
                MIN_REGION_SIZE,
                height === undefined
                  ? node.geometry.height
                  : height
              )
            )
          : 0
      const nx = roundCanvas(x)
      const ny = roundCanvas(y)
      const patch: SpatialNodePatch = { geometry: { x: nx, y: ny } }
      if (width !== undefined && node.kind === 'region') {
        patch.geometry!.width = nextRegionWidth
      }
      if (height !== undefined && node.kind === 'region') {
        patch.geometry!.height = nextRegionHeight
      }

      // 重新推断父级（仅当前节点）；挂在地点下的楼层/房间保持父地点
      const w = node.kind === 'region' ? node.geometry.width : 48
      const h = node.kind === 'region' ? node.geometry.height : 48
      const prevParent = node.parentNodeId
        ? getNode(core.world, node.parentNodeId)
        : null
      const parentId =
        prevParent?.kind === 'place'
          ? prevParent.id
          : inferParentNodeId(
              core.world.nodes,
              currentBoardId,
              {
                id: nodeId,
                x: nx,
                y: ny,
                width: width ?? w,
                height: height ?? h,
              },
              descendantIds
            )
      patch.parentNodeId = parentId

      // 位移增量（画布坐标）
      const dx = nx - node.geometry.x
      const dy = ny - node.geometry.y

      const commands: SpatialCommand[] = [
        { type: 'update_node', nodeId, patch },
      ]

      const inferredParentLayout =
        node.kind === 'place' && prevParent?.kind === 'place'
          ? inferChildLayoutFromDrop(
              core.world,
              prevParent,
              nx,
              ny,
              (id) => dockedActorCountAt(core.runtime.placements, id)
            )
          : null
      const parentWithInferredLayout =
        inferredParentLayout && prevParent?.kind === 'place'
          ? { ...prevParent, childLayout: inferredParentLayout }
          : null
      if (
        parentWithInferredLayout &&
        prevParent?.kind === 'place' &&
        prevParent.childLayout !== inferredParentLayout
      ) {
        commands.push({
          type: 'update_node',
          nodeId: prevParent.id,
          patch: { childLayout: inferredParentLayout! },
        })
      }

      // 区域带动子孙节点与区内角色；地点带动直接锚定角色。
      if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
        for (const cid of childIds) {
          const child = getNode(core.world, cid)
          if (!child) continue
          commands.push({
            type: 'update_node',
            nodeId: cid,
            patch: {
              geometry: {
                x: roundCanvas(child.geometry.x + dx),
                y: roundCanvas(child.geometry.y + dy),
              },
            },
          })
        }

        const actorIds = new Set(dragContents.actorIds)
        for (const p of core.runtime.placements) {
          if (!actorIds.has(p.actorId)) continue

          commands.push({
            type: 'move_actor',
            actorId: p.actorId,
            to: {
              boardId: p.boardId,
              anchor: p.anchor,
              position: {
                x: roundCanvas(p.position.x + dx),
                y: roundCanvas(p.position.y + dy),
              },
              semanticPosition: {
                ...(p.semanticPosition.relativeToNodeId
                  ? { relativeToNodeId: p.semanticPosition.relativeToNodeId }
                  : {}),
                ...(p.semanticPosition.relativeDirection
                  ? { relativeDirection: p.semanticPosition.relativeDirection }
                  : {}),
                precision: p.semanticPosition.precision,
                ...(p.semanticPosition.note
                  ? { note: p.semanticPosition.note }
                  : {}),
              },
            },
            reason: 'region_drag',
          })
        }
      }

      // 地点移动后重排所在层级与其子项，保持自动贴合。
      commands.push(
        ...reflowRows(
          core.world,
          (id) => dockedActorCountAt(core.runtime.placements, id),
          [node.parentNodeId, parentId, nodeId].filter(
            (value): value is string => typeof value === 'string'
          ),
          {
            ...(parentWithInferredLayout
              ? { extraNodes: [parentWithInferredLayout] }
              : {}),
            positionOverrides: new Map([[nodeId, { x: nx, y: ny }]]),
          }
        ).commands
      )

      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: core.runtime.revision,
          commands,
        },
        { now: now(), source: 'user', idGen, label: 'move-node' }
      )
      if (!result.batch.ok) {
        set({ statusMessage: `移动失败：${result.batch.code}` })
        return
      }
      set({
        core: result.batch.state,
        history: result.history,
        saveStatus: 'saving',
        ...(parentWithInferredLayout &&
        prevParent?.kind === 'place' &&
        prevParent.childLayout !== inferredParentLayout
          ? { statusMessage: `已自动调整「${prevParent?.name}」的子项排列` }
          : {}),
      })
    },

    normalizeRows: () => {
      const { core, idGen, history } = get()
      const commands = reflowRows(
        core.world,
        (id) => dockedActorCountAt(core.runtime.placements, id),
        core.world.nodes.filter((n) => n.kind === 'place').map((n) => n.id)
      ).commands
      if (commands.length === 0) return
      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: core.runtime.revision,
          commands,
        },
        { now: now(), source: 'user', idGen, label: 'normalize-rows' }
      )
      if (!result.batch.ok) return
      set({
        core: result.batch.state,
        history: result.history,
        saveStatus: 'saving',
      })
    },

    createInternalBoard: (nodeId) => {
      const { core, idGen, history } = get()
      const node = getNode(core.world, nodeId)
      if (!node) {
        set({ statusMessage: '节点不存在 '})
        return null
      }
      if (isPlaceSubstructure(core.world, nodeId)) {
        set({ statusMessage: '子结构不能创建内部画板' })
        return null
      }
      if (node.childBoardId) {
        set({ statusMessage: '该节点已有内部画板 '})
        return node.childBoardId
      }
      const boardId = newId('board', idGen)
      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: core.runtime.revision,
          commands: [
            { type: 'update_node', nodeId, patch: { childBoardId: boardId } },
          ],
        },
        { now: now(), source: 'user', idGen, label: 'create-internal-board' }
      )
      if (!result.batch.ok) {
        set({ statusMessage: `创建内部画板失败：${result.batch.code}` })
        return null
      }
      set({
        core: result.batch.state,
        history: result.history,
        currentBoardId: boardId,
        selection: { type: 'none', id: null },
        saveStatus: 'saving',
        statusMessage: `已创建内部画板「${node.name}内部」`,
      })
      return boardId
    },
  }
}