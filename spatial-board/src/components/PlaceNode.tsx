import { memo, useEffect, useRef } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { PlaceNodeData } from '../canvas/adapter.ts'
import { useSpatialStore } from '../store/spatialStore.ts'
import { PlaceIcon } from './PlaceIcon.tsx'
import { isPlaceSubstructure } from '@qingyu/spatial-core'

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

function PlaceNodeComponent({
  data,
  selected,
}: NodeProps & { data: PlaceNodeData & { actorCount?: number } }) {
  const addSubPlace = useSpatialStore((s) => s.addSubPlace)
  const canAddSub = useSpatialStore(s => !isPlaceSubstructure(s.core.world, data.domainId))
  const plusRef = useRef<HTMLButtonElement | null>(null)

  // React Flow 会拦截节点上的合成事件，加号用原生监听
  useEffect(() => {
    const btn = plusRef.current
    if (!btn || !canAddSub) return
    const onDown = (e: PointerEvent) => {
      e.stopPropagation()
      e.preventDefault()
      addSubPlace(data.domainId)
    }
    btn.addEventListener('pointerdown', onDown)
    return () => btn.removeEventListener('pointerdown', onDown)
  }, [addSubPlace, canAddSub, data.domainId])

  // 子结构：紧凑条目，不再显示添加入口。
  if (data.variant === 'chip') {
    const dockedCount = Math.min(data.dockedActorCount ?? 0, 3)
    const chipDocked = dockedCount > 0
    const chipDockWidth = chipDocked ? 3 + dockedCount * 20 : 0
    return (
      <div
        className={`rf-place chip ${chipDocked ? 'with-actors' : ''} ${data.joinLeft ? 'join-left' : ''} ${data.joinRight ? 'join-right' : ''} ${data.joinTop ? 'join-top' : ''} ${data.joinBottom ? 'join-bottom' : ''} ${selected ? 'selected' : ''}`}
      >
        <DistanceHandles />
        <div className="chip-icon">
          <PlaceIcon iconKey={data.iconKey} />
        </div>
        <div className="chip-label">{data.name}</div>
        {chipDocked ? (
          <div className="chip-dock-well" aria-hidden style={{ width: chipDockWidth }} />
        ) : null}
      </div>
    )
  }

  const hasDockedActors = (data.dockedActorCount ?? 0) > 0
  return (
    <div
      className={`rf-place ${hasDockedActors ? 'with-actors' : ''} ${data.dockRight ? 'dock-right' : ''} ${data.dockRightTop ? 'dock-right-top' : ''} ${data.dockRightBottom ? 'dock-right-bottom' : ''} ${data.joinLeft ? 'join-left' : ''} ${data.joinRight ? 'join-right' : ''} ${data.joinTop ? 'join-top' : ''} ${data.joinBottom ? 'join-bottom' : ''} ${selected ? 'selected' : ''}`}
    >
      <DistanceHandles />
      <div className="place-main">
        {data.actorCount && data.actorCount > 0 ? (
          <div
            className="ancestor-badge"
            title={`此处（含子空间）有 ${data.actorCount} 名角色`}
          >
            <span className="dot" aria-hidden />
            {data.actorCount} 人
          </div>
        ) : null}
        <div className="icon">
          <PlaceIcon iconKey={data.iconKey} />
        </div>
        <div className="label">{data.name}</div>
      </div>
      {hasDockedActors ? <div className="actor-dock-well" aria-hidden /> : null}
      {canAddSub && <div className="place-add-wrap nodrag nopan">
        <button
          ref={plusRef}
          type="button"
          className="place-add-btn"
          title="添加子结构"
          aria-label="添加子结构"
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              event.stopPropagation()
              addSubPlace(data.domainId)
            }
          }}
        >
          +
        </button>
      </div>}
    </div>
  )
}

export const PlaceNode = memo(PlaceNodeComponent)
