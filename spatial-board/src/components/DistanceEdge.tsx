import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from '@xyflow/react'
import type { DistanceEdgeData } from '../canvas/adapter.ts'

export function DistanceEdge(props: EdgeProps & { data?: DistanceEdgeData }) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
    selected,
  } = props

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: selected
            ? 'var(--color-accent)'
            : 'var(--tavern-warning)',
          strokeWidth: selected ? 2.5 : 1.75,
          strokeDasharray: '6 4',
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
            fontSize: 11,
            color: 'var(--tavern-warning)',
            background: 'var(--tavern-bg-card)',
            padding: '2px 8px',
            borderRadius: 6,
            border: '1px solid var(--tavern-border)',
            maxWidth: 160,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {data?.displayText ?? data?.name ?? '距离'}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
