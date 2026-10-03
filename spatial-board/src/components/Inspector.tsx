import { useEffect, useState } from 'react'
import { useSpatialStore } from '../store/spatialStore.ts'
import { getNode, isPlaceSubstructure, isPlacementOffstage } from '@qingyu/spatial-core'
import type {
  SpatialNodePatch,
  DistanceRelationPatch,
} from '@qingyu/spatial-core'
import {
  ACTOR_KIND_LABELS,
  CERTAINTY_LABELS,
  DIRECTION_LABELS,
  DISTANCE_UNIT_LABELS,
  PRECISION_LABELS,
  SOURCE_LABELS,
  labelOf,
} from './labels.ts'

export function Inspector() {
  const selection = useSpatialStore((s) => s.selection)
  const core = useSpatialStore((s) => s.core)

  if (selection.type === 'node' && selection.id) {
    return <NodeInspector nodeId={selection.id} />
  }
  if (selection.type === 'distance' && selection.id) {
    return <DistanceInspector relationId={selection.id} />
  }
  if (selection.type === 'actor' && selection.id) {
    return <ActorInspector actorId={selection.id} />
  }
  return (
    <aside className="inspector">
      <h3>属性</h3>
      <div className="empty">
        选中画布上的区域、地点、距离或角色以编辑属性。
        <br />
        <br />
        当前世界：{core.world.name}
        <br />
        节点 {core.world.nodes.length} · 距离 {core.world.distances.length} · 角色{' '}
        {core.world.actors.length}
      </div>
      <h3 style={{ marginTop: 18 }}>移动历史</h3>
      <MoveHistory />
    </aside>
  )
}

function MoveHistory() {
  const core = useSpatialStore((s) => s.core)
  const world = core.world
  const events = [...core.runtime.events]
    .filter((e) => e.actorId && e.after !== undefined)
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
    .slice(0, 12)
  if (events.length === 0) {
    return <div className="empty">暂无位置变化</div>
  }
  return (
    <ul className="history-list" style={{ margin: 0, paddingLeft: 16 }}>
      {events.map((e) => {
        const actor = world.actors.find((a) => a.id === e.actorId)
        const where = e.after
          ? e.after.semanticPosition.containmentPath
              .map((id) => world.nodes.find((n) => n.id === id)?.name ?? id)
              .join(' > ')
          : '移出画板'
        return (
          <li key={e.id}>
            <strong>{actor?.displayName ?? e.actorId}</strong> → {where}
            <div style={{ opacity: 0.75 }}>
              {labelOf(SOURCE_LABELS, e.source)}
              {e.reason ? ` · ${e.reason}` : ''}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function ActorInspector({ actorId }: { actorId: string }) {
  const core = useSpatialStore((s) => s.core)
  const managedActors = useSpatialStore((s) => s.activeActorIds !== null)
  const updateActor = useSpatialStore((s) => s.updateActor)
  const deleteActor = useSpatialStore((s) => s.deleteActor)
  const removeActorFromBoard = useSpatialStore((s) => s.removeActorFromBoard)
  const moveActorTo = useSpatialStore((s) => s.moveActorTo)
  const actor = core.world.actors.find((a) => a.id === actorId)
  const placement = core.runtime.placements.find((p) => p.actorId === actorId)

  const [name, setName] = useState(actor?.displayName ?? '')
  const [note, setNote] = useState(placement?.semanticPosition.note ?? '')
  const [direction, setDirection] = useState(
    placement?.semanticPosition.relativeDirection ?? 'inside'
  )
  const [precision, setPrecision] = useState(
    placement?.semanticPosition.precision ?? 'approximate'
  )

  useEffect(() => {
    if (!actor) return
    setName(actor.displayName)
    setNote(placement?.semanticPosition.note ?? '')
    setDirection(placement?.semanticPosition.relativeDirection ?? 'inside')
    setPrecision(placement?.semanticPosition.precision ?? 'approximate')
  }, [actor?.id, actor?.displayName, placement?.updatedAt])

  if (!actor) {
    return (
      <aside className="inspector">
        <h3>角色</h3>
        <div className="empty">角色不存在</div>
      </aside>
    )
  }

  const pathNames = (placement?.semanticPosition.containmentPath ?? [])
    .map((id) => core.world.nodes.find((n) => n.id === id)?.name ?? id)
    .join(' > ')
  const offstage = placement
    ? isPlacementOffstage(core.world, placement)
    : false

  return (
    <aside className="inspector">
      <h3>{labelOf(ACTOR_KIND_LABELS, actor.kind, actor.kind === 'persona' ? '用户' : '角色')}</h3>
      <div className="field">
        <label>名称</label>
        <input
          value={name}
          readOnly={managedActors}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => { if (!managedActors) updateActor(actorId, { displayName: name.trim() || '未命名' }) }}
        />
      </div>
      <div className="field">
        <label>完整路径</label>
        <div className="empty" style={{ fontSize: 12 }}>
          {placement ? pathNames || '（画板）' : '未放置'}
        </div>
      </div>
      {placement && (
        <div className="field">
          <label>对话状态</label>
          <div className={`conversation-status ${offstage ? 'offstage' : 'active'}`}>
            {offstage ? '未参与对话' : '参与对话'}
          </div>
        </div>
      )}
      {placement && (
        <>
          <div className="field-row">
            <div className="field">
              <label>相对方位</label>
              <select
                value={direction}
                onChange={(e) => {
                  const v = e.target.value as typeof direction
                  setDirection(v)
                  moveActorTo(
                    actorId,
                    placement.boardId,
                    placement.position.x,
                    placement.position.y,
                    placement.anchor,
                    {
                      precision,
                      relativeDirection: v,
                      note,
                    }
                  )
                }}
              >
                {[
                  'inside',
                  'nearby',
                  'center',
                  'north',
                  'south',
                  'east',
                  'west',
                  'north-east',
                  'south-east',
                  'north-west',
                  'south-west',
                ].map((d) => (
                  <option key={d} value={d}>
                    {labelOf(DIRECTION_LABELS, d)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>精度</label>
              <select
                value={precision}
                onChange={(e) => {
                  const v = e.target.value as typeof precision
                  setPrecision(v)
                  moveActorTo(
                    actorId,
                    placement.boardId,
                    placement.position.x,
                    placement.position.y,
                    placement.anchor,
                    { precision: v, relativeDirection: direction, note }
                  )
                }}
              >
                <option value="exact">{labelOf(PRECISION_LABELS, 'exact')}</option>
                <option value="approximate">
                  {labelOf(PRECISION_LABELS, 'approximate')}
                </option>
                <option value="inside-only">
                  {labelOf(PRECISION_LABELS, 'inside-only')}
                </option>
                <option value="unknown">{labelOf(PRECISION_LABELS, 'unknown')}</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label>位置备注</label>
            <textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() =>
                moveActorTo(
                  actorId,
                  placement.boardId,
                  placement.position.x,
                  placement.position.y,
                  placement.anchor,
                  { precision, relativeDirection: direction, note }
                )
              }
            />
          </div>
          <div className="field">
            <label>最近来源</label>
            <div className="empty" style={{ fontSize: 12 }}>
              {labelOf(SOURCE_LABELS, placement.updatedBy)} · 版本 {placement.revision}
            </div>
          </div>
          <button
            type="button"
            style={{ width: '100%' }}
            onClick={() => removeActorFromBoard(actorId)}
          >
            移出画板
          </button>
        </>
      )}
      {!managedActors && <button
        type="button"
        className="danger"
        style={{ width: '100%', marginTop: 12 }}
        onClick={() => {
          if (confirm(`删除角色「${actor.displayName}」？`)) deleteActor(actorId)
        }}
      >
        删除角色定义
      </button>}
    </aside>
  )
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

function NodeInspector({ nodeId }: { nodeId: string }) {
  const core = useSpatialStore((s) => s.core)
  const updateNode = useSpatialStore((s) => s.updateNode)
  const deleteNode = useSpatialStore((s) => s.deleteNode)
  const addSubPlace = useSpatialStore((s) => s.addSubPlace)
  const node = getNode(core.world, nodeId)
  const parentNode = node?.parentNodeId
    ? getNode(core.world, node.parentNodeId)
    : undefined

  const [name, setName] = useState(node?.name ?? '')
  const [description, setDescription] = useState(node?.description ?? '')
  const [tags, setTags] = useState((node?.tags ?? []).join(', '))

  useEffect(() => {
    if (!node) return
    setName(node.name)
    setDescription(node.description)
    setTags(node.tags.join(', '))
  }, [node?.id, node?.updatedAt])

  if (!node) {
    return (
      <aside className="inspector">
        <h3>属性</h3>
        <div className="empty">节点不存在</div>
      </aside>
    )
  }

  function applyPatch(patch: SpatialNodePatch) {
    updateNode(nodeId, patch)
  }

  function onCommitName() {
    applyPatch({ name: name.trim() || '未命名' })
  }

  function onCommitDescription() {
    applyPatch({ description })
  }

  function onCommitTags() {
    const list = tags
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 32)
    applyPatch({ tags: list })
  }

  const hasKids = core.world.nodes.some((n) => n.parentNodeId === nodeId)
  const isSubstructure = isPlaceSubstructure(core.world, nodeId)

  return (
    <aside className="inspector">
      <h3>{node.kind === 'region' ? '区域' : isSubstructure ? '子结构' : '地点'}</h3>
      <div className="field">
        <label>名称（必填）</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={onCommitName}
        />
      </div>
      <div className="field">
        <label>描述</label>
        <textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={onCommitDescription}
        />
      </div>
      <div className="field">
        <label>标签（逗号分隔）</label>
        <input value={tags} onChange={(e) => setTags(e.target.value)} onBlur={onCommitTags} />
      </div>

      {node.kind === 'region' && (
        <div className="field-row">
          <div className="field">
            <label>X</label>
            <input
              type="number"
              step="0.1"
              value={round1(node.geometry.x)}
              onChange={(e) =>
                applyPatch({ geometry: { x: round1(Number(e.target.value)) } })
              }
            />
          </div>
          <div className="field">
            <label>Y</label>
            <input
              type="number"
              step="0.1"
              value={round1(node.geometry.y)}
              onChange={(e) =>
                applyPatch({ geometry: { y: round1(Number(e.target.value)) } })
              }
            />
          </div>
          <div className="field">
            <label>宽</label>
            <input
              type="number"
              step="0.1"
              min={1}
              value={round1(node.geometry.width)}
              onChange={(e) =>
                applyPatch({ geometry: { width: round1(Number(e.target.value)) } })
              }
            />
          </div>
          <div className="field">
            <label>高</label>
            <input
              type="number"
              step="0.1"
              min={1}
              value={round1(node.geometry.height)}
              onChange={(e) =>
                applyPatch({ geometry: { height: round1(Number(e.target.value)) } })
              }
            />
          </div>
        </div>
      )}
      {node.kind === 'place' && (
        <div className="field-row">
          <div className="field">
            <label>X</label>
            <input
              type="number"
              step="0.1"
              value={round1(node.geometry.x)}
              onChange={(e) =>
                applyPatch({ geometry: { x: round1(Number(e.target.value)) } })
              }
            />
          </div>
          <div className="field">
            <label>Y</label>
            <input
              type="number"
              step="0.1"
              value={round1(node.geometry.y)}
              onChange={(e) =>
                applyPatch({ geometry: { y: round1(Number(e.target.value)) } })
              }
            />
          </div>
        </div>
      )}

      <div className="field">
        <label>父节点</label>
        <input
          value={parentNode?.name ?? '当前画板（根）'}
          readOnly
          title={node.parentNodeId ?? '当前画板（根）'}
        />
      </div>

      {node.kind === 'place' && !isSubstructure && (
        <div className="field">
          <label>子结构</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              style={{ flex: 1 }}
              onClick={() => addSubPlace(nodeId)}
            >
              添加子结构
            </button>
          </div>
          {core.world.nodes.filter((n) => n.parentNodeId === nodeId).length > 0 && (
            <div className="empty" style={{ marginTop: 6, fontSize: 12 }}>
              {core.world.nodes
                .filter((n) => n.parentNodeId === nodeId)
                .map((n) => n.name)
                .join(' · ')}
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        className="danger"
        style={{ width: '100%', marginTop: 12 }}
        onClick={() => {
          if (hasKids || node.childBoardId) {
            if (confirm('该节点包含子项，确认级联删除？')) {
              deleteNode(nodeId, true)
            }
          } else if (confirm(`删除「${node.name}」？`)) {
            deleteNode(nodeId, false)
          }
        }}
      >
        删除节点
      </button>
    </aside>
  )
}

function DistanceInspector({ relationId }: { relationId: string }) {
  const core = useSpatialStore((s) => s.core)
  const updateDistance = useSpatialStore((s) => s.updateDistance)
  const deleteDistance = useSpatialStore((s) => s.deleteDistance)
  const rel = core.world.distances.find((d) => d.id === relationId)

  const [name, setName] = useState(rel?.name ?? '')
  const [description, setDescription] = useState(rel?.description ?? '')
  const [value, setValue] = useState(String(rel?.measurement.value ?? ''))
  const [unit, setUnit] = useState(rel?.measurement.unit ?? 'km')
  const [customUnit, setCustomUnit] = useState(rel?.measurement.customUnit ?? '')
  const [displayText, setDisplayText] = useState(rel?.measurement.displayText ?? '')
  const [certainty, setCertainty] = useState(rel?.measurement.certainty ?? 'unknown')
  const [travelNotes, setTravelNotes] = useState(rel?.travelNotes ?? '')

  useEffect(() => {
    if (!rel) return
    setName(rel.name)
    setDescription(rel.description)
    setValue(rel.measurement.value === null ? '' : String(rel.measurement.value))
    setUnit(rel.measurement.unit)
    setCustomUnit(rel.measurement.customUnit ?? '')
    setDisplayText(rel.measurement.displayText)
    setCertainty(rel.measurement.certainty)
    setTravelNotes(rel.travelNotes ?? '')
  }, [rel?.id, rel?.updatedAt])

  if (!rel) {
    return (
      <aside className="inspector">
        <h3>距离</h3>
        <div className="empty">关系不存在</div>
      </aside>
    )
  }

  function commit(patch: DistanceRelationPatch) {
    updateDistance(relationId, patch)
  }

  return (
    <aside className="inspector">
      <h3>距离</h3>
      <div className="field">
        <label>名称</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => commit({ name: name.trim() || '未命名' })}
        />
      </div>
      <div className="field">
        <label>描述</label>
        <textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => commit({ description })}
        />
      </div>
      <div className="field-row">
        <div className="field">
          <label>数值</label>
          <input
            type="number"
            min={0}
            step="0.1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() =>
              commit({
                measurement: {
                  value: value === '' ? null : Number(value),
                },
              })
            }
          />
        </div>
        <div className="field">
          <label>单位</label>
          <select
            value={unit}
            onChange={(e) => {
              setUnit(e.target.value as never)
              commit({ measurement: { unit: e.target.value as never } })
            }}
          >
            {(Object.keys(DISTANCE_UNIT_LABELS) as Array<keyof typeof DISTANCE_UNIT_LABELS>).map(
              (u) => (
                <option key={u} value={u}>
                  {DISTANCE_UNIT_LABELS[u]}
                </option>
              )
            )}
          </select>
        </div>
      </div>
      {unit === 'custom' && (
        <div className="field">
          <label>自定义单位</label>
          <input
            value={customUnit}
            onChange={(e) => setCustomUnit(e.target.value)}
            onBlur={() =>
              commit({ measurement: { customUnit: customUnit || null } })
            }
          />
        </div>
      )}
      <div className="field">
        <label>显示文本</label>
        <input
          value={displayText}
          onChange={(e) => setDisplayText(e.target.value)}
          onBlur={() => commit({ measurement: { displayText } })}
        />
      </div>
      <div className="field">
        <label>精度</label>
        <select
          value={certainty}
          onChange={(e) => {
            setCertainty(e.target.value as never)
            commit({ measurement: { certainty: e.target.value as never } })
          }}
        >
          <option value="exact">{labelOf(CERTAINTY_LABELS, 'exact')}</option>
          <option value="estimated">{labelOf(CERTAINTY_LABELS, 'estimated')}</option>
          <option value="unknown">{labelOf(CERTAINTY_LABELS, 'unknown')}</option>
        </select>
      </div>
      <div className="field">
        <label>旅行备注</label>
        <textarea
          rows={2}
          value={travelNotes}
          onChange={(e) => setTravelNotes(e.target.value)}
          onBlur={() =>
            commit({ travelNotes: travelNotes === '' ? null : travelNotes })
          }
        />
      </div>
      <div className="field">
        <label>两端</label>
        <div className="empty" style={{ fontSize: 12 }}>
          {getNode(core.world, rel.sourceNodeId)?.name ?? rel.sourceNodeId} ↔{' '}
          {getNode(core.world, rel.targetNodeId)?.name ?? rel.targetNodeId}
        </div>
      </div>
      <button
        type="button"
        className="danger"
        style={{ width: '100%', marginTop: 8 }}
        onClick={() => {
          if (confirm('删除该距离关系？')) deleteDistance(relationId)
        }}
      >
        删除距离
      </button>
    </aside>
  )
}
