import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useSpatialStore } from '../store/spatialStore.ts'
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  PLACE_NODE_SIZE,
  actorPlacementsToFlow,
  applyNodeDragPreview,
  collectNodeDragContents,
  domainDistancesToFlow,
  domainNodesToFlow,
  type SpatialFlowEdge,
  type SpatialFlowNode,
} from '../canvas/adapter.ts'
import { getNode, OFFSTAGE_REGION_TAG, summarizeActorsOnAncestors } from '@qingyu/spatial-core'
import { hitTestAnchor } from '../canvas/hitTestAnchor.ts'
import { RegionNode } from './RegionNode.tsx'
import { PlaceNode } from './PlaceNode.tsx'
import { ActorNode } from './ActorNode.tsx'
import { DistanceEdge } from './DistanceEdge.tsx'

const nodeTypes = { region: RegionNode, place: PlaceNode, actor: ActorNode }
const edgeTypes = { distance: DistanceEdge }

const toolGuides = {
  select: { title: '浏览画板', detail: '拖动画布浏览 · 点击对象编辑 · 滚轮缩放' },
  region: { title: '绘制区域', detail: '在画布拖出矩形；可从已有区域内部开始' },
  offstage: { title: '未参与对话区域', detail: '单击放置默认区域，或拖拽决定大小' },
  place: { title: '放置地点', detail: '点击空白处或区域内部，地点会居中落在点击位置' },
  distance: { title: '连接距离', detail: '依次点击两个同类节点；按 Esc 取消' },
} as const

function CanvasInner() {
  const embedded = new URLSearchParams(window.location.search).get('embedded') === '1'
  const assistantEnabled = useSpatialStore((s) => s.assistantEnabled)
  const core = useSpatialStore((s) => s.core)
  const activeActorIds = useSpatialStore((s) => s.activeActorIds)
  const visiblePlacements = useMemo(() => activeActorIds ? core.runtime.placements.filter(placement => activeActorIds.includes(placement.actorId)) : core.runtime.placements, [activeActorIds, core.runtime.placements])
  const currentBoardId = useSpatialStore((s) => s.currentBoardId)
  const tool = useSpatialStore((s) => s.tool)
  const setTool = useSpatialStore((s) => s.setTool)
  const select = useSpatialStore((s) => s.select)
  const createRegionAt = useSpatialStore((s) => s.createRegionAt)
  const createOffstageRegionAt = useSpatialStore((s) => s.createOffstageRegionAt)
  const createPlaceAt = useSpatialStore((s) => s.createPlaceAt)
  const moveNode = useSpatialStore((s) => s.moveNode)
  const startDistance = useSpatialStore((s) => s.startDistance)
  const completeDistance = useSpatialStore((s) => s.completeDistance)
  const cancelDistance = useSpatialStore((s) => s.cancelDistance)
  const distanceDraftSourceId = useSpatialStore((s) => s.distanceDraftSourceId)
  const moveActorTo = useSpatialStore((s) => s.moveActorTo)
  const placeActorAt = useSpatialStore((s) => s.placeActorAt)
  const undo = useSpatialStore((s) => s.undo)
  const redo = useSpatialStore((s) => s.redo)
  const fitViewRequest = useSpatialStore((s) => s.fitViewRequest)
  const boardName = core.world.boards.find((board) => board.id === currentBoardId)?.name ?? '当前画板'
  const hasVisibleContent = core.world.nodes.some((node) =>
    node.boardId === currentBoardId && !node.tags.includes(OFFSTAGE_REGION_TAG)
  )
  const canInitialize = core.world.boards.length === 1 && core.world.nodes.every(node => node.tags.includes(OFFSTAGE_REGION_TAG)) &&
    core.world.distances.length === 0 && core.runtime.placements.length === 0

  const reactFlow = useReactFlow()
  const { screenToFlowPosition } = reactFlow
  const registerCanvasControls = useSpatialStore((s) => s.registerCanvasControls)

  const fitContent = useCallback(
    (duration = 220) => {
      const contentNodes = reactFlow
        .getNodes()
        .filter((node) => !(node.data as { offstage?: boolean }).offstage)
      if (contentNodes.length === 0) {
        void reactFlow.setViewport({ x: 72, y: 72, zoom: 1 }, { duration })
        return
      }
      void reactFlow.fitView({
        nodes: contentNodes,
        padding: 0.18,
        minZoom: 0.35,
        maxZoom: 1.15,
        duration,
      })
    },
    [reactFlow]
  )

  // 把画布视口能力注册进 store：界面按钮与代码/脚本共用同一套功能
  useEffect(() => {
    registerCanvasControls({
      zoomIn: () => {
        void reactFlow.zoomIn()
      },
      zoomOut: () => {
        void reactFlow.zoomOut()
      },
      fitView: () => {
        fitContent()
      },
      getViewport: () => reactFlow.getViewport(),
      setViewport: (viewport) => {
        void reactFlow.setViewport(viewport)
      },
    })
    return () => registerCanvasControls(null)
  }, [fitContent, reactFlow, registerCanvasControls])

  // 新建、导入或切换层级后，等节点完成两帧渲染再适配。
  // 普通拖动/编辑不改 fitViewRequest，所以不会抢走用户当前视口。
  useEffect(() => {
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => fitContent())
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      if (secondFrame) cancelAnimationFrame(secondFrame)
    }
  }, [fitContent, fitViewRequest])
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const draggingRef = useRef(false)
  /** 轻微抖动不视为拖动，避免点选/改属性时节点被误移 */
  const DRAG_THRESHOLD = 4
  const nodeDragPreviewRef = useRef<{
    draggedNodeId: string
    followerNodeIds: Set<string>
    startPositions: Map<string, { x: number; y: number }>
    startClient: { x: number; y: number }
    active: boolean
  } | null>(null)

  // 本地 RF 状态：拖动期间实时预览，松手后一次写入领域历史。
  const [nodes, setNodes] = useState<SpatialFlowNode[]>([])
  const [edges, setEdges] = useState<SpatialFlowEdge[]>([])
  const [showMinimap, setShowMinimap] = useState(false)
  const [drawRect, setDrawRect] = useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)
  const [dropPreview, setDropPreview] = useState<{ x: number; y: number; label: string } | null>(null)
  const drawStart = useRef<{ sx: number; sy: number; fx: number; fy: number } | null>(
    null
  )

  const actorCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of summarizeActorsOnAncestors(core.world, { ...core.runtime, placements: visiblePlacements })) {
      map.set(s.nodeId, s.actorIds.length)
    }
    return map
  }, [core.world, core.runtime, visiblePlacements])

  // 领域 → RF 同步（拖动中跳过，避免回弹）
  useEffect(() => {
    if (draggingRef.current) return
    const spatial = domainNodesToFlow(
      core.world.nodes,
      visiblePlacements,
      currentBoardId
    ).map((n) => {
      const count = actorCounts.get(n.id) ?? 0
      return {
        ...n,
        data: { ...n.data, actorCount: count },
        selected: false,
      } as SpatialFlowNode
    })
    const actors = actorPlacementsToFlow(
      visiblePlacements,
      core.world.actors,
      core.world.nodes,
      currentBoardId
    )
    setNodes([...spatial, ...actors])
    setEdges(
      domainDistancesToFlow(core.world.distances, core.world.nodes, currentBoardId)
    )
  }, [
    core.world.nodes,
    core.world.distances,
    core.world.actors,
    visiblePlacements,
    currentBoardId,
    actorCounts,
  ])

  const onNodesChange = useCallback((changes: NodeChange<SpatialFlowNode>[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds))
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange<SpatialFlowEdge>[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds))
  }, [])

  const onNodeClick: NodeMouseHandler = useCallback(
    (event, node) => {
      if (tool === 'place') {
        if (node.type === 'region') {
          const pos = screenToFlowPosition({ x: event.clientX, y: event.clientY })
          if (createPlaceAt(pos.x - PLACE_NODE_SIZE / 2, pos.y - PLACE_NODE_SIZE / 2)) {
            setTool('select')
          }
        } else {
          useSpatialStore.setState({ statusMessage: '请点击画布空白处或区域内部来放置地点' })
        }
        return
      }
      if (tool === 'distance') {
        if (node.type === 'actor') {
          useSpatialStore.setState({ statusMessage: '距离只能连接两个区域或两个地点' })
          return
        }
        if (!distanceDraftSourceId) startDistance(node.id)
        else completeDistance(node.id)
        return
      }
      if (node.type === 'actor') {
        const actorId = String(
          (node.data as { domainId?: string })?.domainId ??
            node.id.replace(/^actor_/, '')
        )
        select({ type: 'actor', id: actorId })
        return
      }
      select({ type: 'node', id: node.id })
    },
    [tool, distanceDraftSourceId, startDistance, completeDistance, select, screenToFlowPosition, createPlaceAt, setTool]
  )

  const onEdgeClick = useCallback(
    (_e: React.MouseEvent, edge: Edge) => {
      if (tool === 'distance') return
      select({ type: 'distance', id: edge.id })
    },
    [tool, select]
  )

  const onNodeDragStart = useCallback((e: unknown, node: Node) => {
    draggingRef.current = true
    nodeDragPreviewRef.current = null
    const me = e as { clientX?: number; clientY?: number } | null
    const startClient = {
      x: me?.clientX ?? 0,
      y: me?.clientY ?? 0,
    }
    const startPositions = new Map<string, { x: number; y: number }>([
      [node.id, { ...node.position }],
    ])
    if (node.type === 'region' || node.type === 'place') {
      const contents = collectNodeDragContents(
        core.world.nodes,
        visiblePlacements,
        currentBoardId,
        node.id
      )
      const followerNodeIds = new Set([
        ...contents.nodeIds,
        ...contents.actorIds.map((actorId) => `actor_${actorId}`),
      ])
      const previewNodeIds = new Set([node.id, ...followerNodeIds])
      for (const item of nodes) {
        if (previewNodeIds.has(item.id)) {
          startPositions.set(item.id, { ...item.position })
        }
      }
      nodeDragPreviewRef.current = {
        draggedNodeId: node.id,
        followerNodeIds,
        startPositions,
        startClient,
        active: false,
      }
      return
    }
    nodeDragPreviewRef.current = {
      draggedNodeId: node.id,
      followerNodeIds: new Set(),
      startPositions,
      startClient,
      active: false,
    }
  }, [core.world.nodes, visiblePlacements, currentBoardId, nodes])

  const onNodeDrag = useCallback((e: unknown, node: Node) => {
    const preview = nodeDragPreviewRef.current
    if (!preview || preview.draggedNodeId !== node.id) return
    const me = e as { clientX?: number; clientY?: number } | null
    const dx = (me?.clientX ?? 0) - preview.startClient.x
    const dy = (me?.clientY ?? 0) - preview.startClient.y
    if (!preview.active) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      preview.active = true
    }
    if (node.type === 'actor') {
      const hit = hitTestAnchor(
        core.world.nodes,
        visiblePlacements,
        currentBoardId,
        node.position.x,
        node.position.y
      )
      const me = e as { clientX?: number; clientY?: number } | null
      const rect = wrapRef.current?.getBoundingClientRect()
      if (rect && me?.clientX !== undefined && me.clientY !== undefined) {
        setDropPreview({
          x: me.clientX - rect.left + 14,
          y: me.clientY - rect.top + 14,
          label: hit.anchor.kind === 'node'
            ? `放到「${core.world.nodes.find((item) => item.id === hit.anchor.nodeId)?.name ?? '节点'}」`
            : '放到画板空地',
        })
      }
    }
    setNodes((current) =>
      applyNodeDragPreview(
        current,
        preview.draggedNodeId,
        preview.followerNodeIds,
        preview.startPositions,
        node.position
      )
    )
  }, [core.world.nodes, visiblePlacements, currentBoardId])

  const onNodeDragStop = useCallback(
    (_e: unknown, node: Node) => {
      draggingRef.current = false
      setDropPreview(null)
      const preview = nodeDragPreviewRef.current
      nodeDragPreviewRef.current = null
      // 未超过阈值：视为点击，回弹到原位，不写入历史
      if (preview && !preview.active) {
        setNodes((current) =>
          current.map((item) => {
            const start = preview.startPositions.get(item.id)
            if (!start) return item
            return { ...item, position: start }
          })
        )
        return
      }
      if (node.type === 'actor') {
        const actorId = String(
          (node.data as { domainId?: string })?.domainId ??
            node.id.replace(/^actor_/, '')
        )
        const hit = hitTestAnchor(
          core.world.nodes,
          visiblePlacements,
          currentBoardId,
          node.position.x,
          node.position.y
        )
        moveActorTo(actorId, currentBoardId, node.position.x, node.position.y, hit.anchor, {
          precision: hit.precision,
          relativeDirection: hit.relativeDirection,
          note: hit.note,
        })
        return
      }
      const w =
        typeof node.style?.width === 'number'
          ? node.style.width
          : (node.measured?.width ?? undefined)
      const h =
        typeof node.style?.height === 'number'
          ? node.style.height
          : (node.measured?.height ?? undefined)
      moveNode(node.id, node.position.x, node.position.y, w, h)
    },
    [
      moveNode,
      moveActorTo,
      core.world.nodes,
      visiblePlacements,
      currentBoardId,
    ]
  )

  const onPaneClick = useCallback(() => {
    if (tool === 'distance' && distanceDraftSourceId) {
      cancelDistance()
      return
    }
    if (tool === 'select') select({ type: 'none', id: null })
  }, [tool, distanceDraftSourceId, cancelDistance, select])

  const onPaneMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (tool !== 'region' && tool !== 'offstage') return
      if (e.button !== 0 || !(e.target as HTMLElement).closest('.react-flow__pane, .react-flow__node-region')) return
      const rect = wrapRef.current?.getBoundingClientRect()
      const sx = e.clientX - (rect?.left ?? 0)
      const sy = e.clientY - (rect?.top ?? 0)
      const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      drawStart.current = { sx, sy, fx: flow.x, fy: flow.y }
      setDrawRect({ x: sx, y: sy, w: 0, h: 0 })
    },
    [tool, screenToFlowPosition]
  )

  const onPaneMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if ((tool !== 'region' && tool !== 'offstage') || !drawStart.current) return
      if (e.buttons === 0) {
        drawStart.current = null
        setDrawRect(null)
        return
      }
      const rect = wrapRef.current?.getBoundingClientRect()
      const sx = e.clientX - (rect?.left ?? 0)
      const sy = e.clientY - (rect?.top ?? 0)
      const start = drawStart.current
      setDrawRect({
        x: Math.min(start.sx, sx),
        y: Math.min(start.sy, sy),
        w: Math.abs(sx - start.sx),
        h: Math.abs(sy - start.sy),
      })
    },
    [tool]
  )

  const onPaneMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (
        (tool !== 'region' && tool !== 'offstage') ||
        !drawStart.current
      ) {
        drawStart.current = null
        setDrawRect(null)
        return
      }
      const offstage = tool === 'offstage'
      const start = drawStart.current
      const end = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const x = Math.min(start.fx, end.x)
      const y = Math.min(start.fy, end.y)
      const w = Math.abs(end.x - start.fx)
      const h = Math.abs(end.y - start.fy)
      drawStart.current = null
      setDrawRect(null)
      if (w < 24 || h < 24) {
        if (!offstage) {
          useSpatialStore.setState({ statusMessage: '区域太小，请拖出更大矩形' })
          return
        }
        // 单击（未拖出尺寸）：按默认尺寸直接添加「未参与对话」区域
        createOffstageRegionAt(start.fx, start.fy)
        useSpatialStore.getState().setTool('select')
        return
      }
      if (offstage) createOffstageRegionAt(x, y, w, h)
      else createRegionAt(x, y, w, h)
      useSpatialStore.getState().setTool('select')
    },
    [tool, createRegionAt, createOffstageRegionAt, screenToFlowPosition]
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
        return
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key.toLowerCase() === 'y' ||
          (e.shiftKey && e.key.toLowerCase() === 'z'))
      ) {
        e.preventDefault()
        redo()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const st = useSpatialStore.getState()
        if (st.selection.type === 'node' && st.selection.id) {
          e.preventDefault()
          const node = getNode(st.core.world, st.selection.id)
          const hasKids = st.core.world.nodes.some(
            (n) => n.parentNodeId === st.selection.id
          )
          if (hasKids || node?.childBoardId) {
            if (confirm('该节点包含子项，确认级联删除？')) {
              st.deleteNode(st.selection.id, true)
            }
          } else {
            st.deleteNode(st.selection.id, false)
          }
        } else if (st.selection.type === 'distance' && st.selection.id) {
          e.preventDefault()
          st.deleteDistance(st.selection.id)
        }
        return
      }
      const k = e.key.toLowerCase()
      if (k === 'v') useSpatialStore.getState().setTool('select')
      if (k === 'r') useSpatialStore.getState().setTool('region')
      if (k === 'o') useSpatialStore.getState().setTool('offstage')
      if (k === 'p') useSpatialStore.getState().setTool('place')
      if (k === 'd') useSpatialStore.getState().setTool('distance')
      if (e.key === 'Escape') {
        drawStart.current = null
        setDrawRect(null)
        setDropPreview(null)
        const st = useSpatialStore.getState()
        if (st.tool === 'distance') st.cancelDistance()
        st.setTool('select')
        st.select({ type: 'none', id: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  const onPaneClickCreatePlace = useCallback(
    (e: React.MouseEvent) => {
      if (tool !== 'place') return
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      if (createPlaceAt(pos.x - PLACE_NODE_SIZE / 2, pos.y - PLACE_NODE_SIZE / 2)) {
        setTool('select')
      }
    },
    [tool, screenToFlowPosition, createPlaceAt, setTool]
  )

  return (
    <div
      ref={wrapRef}
      className={`canvas-wrap tool-${tool}`}
      onMouseDown={onPaneMouseDown}
      onMouseMove={onPaneMouseMove}
      onMouseUp={onPaneMouseUp}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-spatial-actor')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          const rect = wrapRef.current?.getBoundingClientRect()
          if (rect) {
            const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
            const hit = hitTestAnchor(core.world.nodes, visiblePlacements, currentBoardId, pos.x - 24, pos.y - 24)
            setDropPreview({
              x: e.clientX - rect.left + 14,
              y: e.clientY - rect.top + 14,
              label: hit.anchor.kind === 'node'
                ? `放到「${core.world.nodes.find((node) => node.id === hit.anchor.nodeId)?.name ?? '节点'}」`
                : '放到画板空地',
            })
          }
        }
      }}
      onDragLeave={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as HTMLElement | null)) setDropPreview(null)
      }}
      onDrop={(e) => {
        setDropPreview(null)
        const actorId = e.dataTransfer.getData('application/x-spatial-actor')
        if (!actorId) return
        e.preventDefault()
        const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
        const hit = hitTestAnchor(
          core.world.nodes,
          visiblePlacements,
          currentBoardId,
          pos.x - 24,
          pos.y - 24
        )
        const exists = visiblePlacements.some((p) => p.actorId === actorId)
        const semantic = {
          precision: hit.precision,
          relativeDirection: hit.relativeDirection,
          note: hit.note,
        }
        if (exists) {
          moveActorTo(actorId, currentBoardId, pos.x - 24, pos.y - 24, hit.anchor, semantic)
        } else {
          placeActorAt(actorId, currentBoardId, pos.x - 24, pos.y - 24, hit.anchor, semantic)
        }
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onEdgeClick={onEdgeClick}
        onPaneClick={(e) => {
          onPaneClick()
          onPaneClickCreatePlace(e as unknown as React.MouseEvent)
        }}
        minZoom={0.25}
        maxZoom={2}
        nodeClickDistance={4}
        nodesDraggable={tool === 'select' || tool === 'distance'}
        snapToGrid={tool === 'select'}
        snapGrid={[8, 8]}
        nodesConnectable={false}
        elementsSelectable
        panOnDrag={tool === 'select' || tool === 'distance'}
        selectionOnDrag={false}
        onlyRenderVisibleElements
        elevateNodesOnSelect={false}
        elevateEdgesOnSelect={false}
        deleteKeyCode={null}
      >
        <Background gap={18} color="var(--tavern-border-soft)" />
        <Panel
          position="bottom-right"
          className={`minimap-toggle-panel ${showMinimap ? 'open' : ''}`}
        >
          <button
            type="button"
            className={showMinimap ? 'active' : ''}
            onClick={() => setShowMinimap((visible) => !visible)}
            aria-expanded={showMinimap}
            aria-label={showMinimap ? '收起小地图' : '展开小地图'}
          >
            {showMinimap ? '收起地图' : '小地图'}
          </button>
        </Panel>
        {showMinimap ? (
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) =>
              n.type === 'region'
                ? 'var(--tavern-assistant)'
                : n.type === 'actor'
                  ? 'var(--tavern-user)'
                  : 'var(--color-accent)'
            }
            maskColor="rgba(26, 22, 37, 0.65)"
          />
        ) : null}
      </ReactFlow>
      {(!embedded || tool !== 'select') && <div className={`canvas-mode${embedded ? ' compact' : ''}`} role="status" aria-live="polite">
        <span className={`canvas-mode-mark ${tool}`} aria-hidden="true" />
        <span className="canvas-mode-copy">
          <strong>{toolGuides[tool].title}</strong>
          <small>{embedded ? '' : `${boardName} · `}{toolGuides[tool].detail}</small>
        </span>
        {tool !== 'select' ? <kbd>Esc</kbd> : null}
      </div>}
      {!hasVisibleContent && tool === 'select' ? (
        <div className="canvas-empty" role="region" aria-labelledby="canvas-start-title">
          <div className="canvas-empty-symbol" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="canvas-empty-eyebrow">{embedded && assistantEnabled ? '当前会话的画板' : '开始构建空间'}</div>
          <h2 id="canvas-start-title">{embedded && assistantEnabled ? canInitialize ? '把故事放进地图' : '继续搭建这个空间' : '从一片区域开始'}</h2>
          <p>{embedded && assistantEnabled ? canInitialize ? '让 AI 根据角色设定和已有对话，整理地点与人物起点。生成后可预览、修改，再确认使用。' : '告诉 AI 想添加的地点或人物位置，也可以直接手动绘制。' : '先画出故事发生的范围，再把地点和角色放进来。'}</p>
          {embedded && assistantEnabled && <button type="button" className="canvas-start-ai" onClick={() => window.parent.postMessage({ type: 'qingyu:spatial:assistant' }, '*')}>
            <span aria-hidden="true">✧</span>{canInitialize ? 'AI 初始化' : 'AI 协助搭建'}
          </button>}
          <div className={`canvas-empty-actions ${embedded && assistantEnabled ? 'canvas-start-manual' : ''}`}>
            <button type="button" className={embedded && assistantEnabled ? '' : 'primary'} onClick={() => setTool('region')}>
              绘制区域 <span>R</span>
            </button>
            <button type="button" onClick={() => setTool('place')}>
              直接添加地点 <span>P</span>
            </button>
          </div>
        </div>
      ) : null}
      {drawRect && (
        <div
          style={{
            position: 'absolute',
            left: drawRect.x,
            top: drawRect.y,
            width: drawRect.w,
            height: drawRect.h,
            border: '1.5px dashed var(--color-accent)',
            background: 'var(--color-accent-soft)',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        />
      )}
      {dropPreview ? (
        <div className="canvas-drop-preview" style={{ left: dropPreview.x, top: dropPreview.y }}>
          {dropPreview.label}
        </div>
      ) : null}
    </div>
  )
}

export function BoardCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}

export const CANVAS_SIZE = { width: BOARD_WIDTH, height: BOARD_HEIGHT }
