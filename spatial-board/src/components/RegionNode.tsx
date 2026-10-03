import { memo, useCallback } from 'react'
import {
  Handle,
  NodeResizeControl,
  Position,
  type NodeProps,
  type ResizeParams,
} from '@xyflow/react'
import type { RegionNodeData } from '../canvas/adapter.ts'
import { MIN_REGION_SIZE, useSpatialStore } from '../store/spatialStore.ts'

function RegionNodeComponent({
  id,
  data,
  selected,
}: NodeProps & { data: RegionNodeData & { actorCount?: number } }) {
  const moveNode = useSpatialStore((s) => s.moveNode)
  // 与节点可拖动保持一致：绘制/连线模式下不显示缩放抓手
  const canResize = useSpatialStore(
    (s) => s.tool === 'select' || s.tool === 'distance'
  )

  const onResizeEnd = useCallback(
    (_event: unknown, params: ResizeParams) => {
      moveNode(id, params.x, params.y, params.width, params.height)
    },
    [id, moveNode]
  )

  return (
    <>
      <div
        className={`rf-region ${data.offstage ? 'offstage' : ''} ${selected ? 'selected' : ''}`}
      >
        <DistanceHandles />
        {data.actorCount && data.actorCount > 0 ? (
          <div
            className="ancestor-badge"
            title={`此区域内有 ${data.actorCount} 名角色`}
          >
            <span className="dot" aria-hidden />
            {data.actorCount} 人
          </div>
        ) : null}
        <div className="rf-title">{data.name}</div>
        {data.offstage ? (
          <div className="offstage-label">在此区域的角色不参与对话</div>
        ) : null}
      </div>
      {canResize ? (
        <NodeResizeControl
          position="bottom-right"
          className="region-resize"
          minWidth={MIN_REGION_SIZE}
          minHeight={MIN_REGION_SIZE}
          onResizeEnd={onResizeEnd}
        />
      ) : null}
    </>
  )
}

function DistanceHandles() {
  return (
    <>
      <Handle id="target-top" type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle id="target-right" type="target" position={Position.Right} style={{ opacity: 0 }} />
      <Handle id="target-bottom" type="target" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle id="target-left" type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle id="source-top" type="source" position={Position.Top} style={{ opacity: 0 }} />
      <Handle id="source-right" type="source" position={Position.Right} style={{ opacity: 0 }} />
      <Handle id="source-bottom" type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle id="source-left" type="source" position={Position.Left} style={{ opacity: 0 }} />
    </>
  )
}

export const RegionNode = memo(RegionNodeComponent)
