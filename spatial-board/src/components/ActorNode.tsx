import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { ActorNodeData } from '../canvas/adapter.ts'
import { ActorAvatar } from './ActorAvatar.tsx'

function ActorNodeComponent({ data, selected }: NodeProps & { data: ActorNodeData }) {
  const anchorDescription = data.anchorName
    ? data.displayMode === 'docked'
      ? `停靠在「${data.anchorName}」`
      : `位于「${data.anchorName}」`
    : ''
  const overflowDescription = data.overflowNames?.length
    ? `；另有 ${data.overflowNames.join('、')}`
    : ''
  const conversationDescription = data.offstage ? ' · 未参与对话' : ''
  return (
    <div
      className={`rf-actor ${data.displayMode} ${data.onChip ? 'on-chip' : ''} ${data.offstage ? 'offstage' : ''} ${selected ? 'selected' : ''}`}
      title={`${data.displayName}${conversationDescription}${anchorDescription ? ` · ${anchorDescription}` : ''}${data.note ? `：${data.note}` : ''}${overflowDescription}`}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="avatar">
        <ActorAvatar actorId={data.domainId} displayName={data.displayName} kind={data.actorKind} assetRef={data.avatarAssetRef} />
        {data.overflowCount ? (
          <span className="overflow-count">+{data.overflowCount}</span>
        ) : null}
      </div>
      <div className="label">{data.displayName}</div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  )
}

export const ActorNode = memo(ActorNodeComponent)
