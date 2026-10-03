import { useEffect, useRef, useState } from 'react'
import { useSpatialStore } from '../store/spatialStore.ts'
import type { Tool } from '../canvas/adapter.ts'
import { isPlacementOffstage } from '@qingyu/spatial-core'
import { COMMAND_TYPE_LABELS, labelOf } from './labels.ts'
import { ActorAvatar } from './ActorAvatar.tsx'

const TOOLS: Array<{ id: Tool; label: string; hint: string }> = [
  { id: 'select', label: '选择', hint: 'V' },
  { id: 'region', label: '矩形区域', hint: 'R' },
  { id: 'offstage', label: '未参与对话', hint: 'O' },
  { id: 'place', label: '地点', hint: 'P' },
  { id: 'distance', label: '距离模式', hint: 'D' },
]

export function Toolbar({
  actorTrayOpen,
  onToggleActorTray,
  onCloseActorTray,
  storyOpen,
  onToggleStory,
}: {
  actorTrayOpen: boolean
  onToggleActorTray: () => void
  onCloseActorTray: () => void
  storyOpen: boolean
  onToggleStory: () => void
}) {
  const dockRef = useRef<HTMLDivElement | null>(null)
  const embedded = new URLSearchParams(window.location.search).get('embedded') === '1'
  const tool = useSpatialStore((s) => s.tool)
  const setTool = useSpatialStore((s) => s.setTool)
  const cancelDistance = useSpatialStore((s) => s.cancelDistance)
  const allActors = useSpatialStore((s) => s.core.world.actors)
  const activeActorIds = useSpatialStore((s) => s.activeActorIds)
  const assistantEnabled = useSpatialStore((s) => s.assistantEnabled)
  const actors = activeActorIds ? allActors.filter(actor => activeActorIds.includes(actor.id)) : allActors
  const placements = useSpatialStore((s) => s.core.runtime.placements)
  const selection = useSpatialStore((s) => s.selection)
  const createActor = useSpatialStore((s) => s.createActor)
  const select = useSpatialStore((s) => s.select)
  const placeActorOnBoard = useSpatialStore((s) => s.placeActorOnBoard)
  const currentBoardId = useSpatialStore((s) => s.currentBoardId)
  const world = useSpatialStore((s) => s.core.world)
  const fitView = useSpatialStore((s) => s.fitView)
  const zoomIn = useSpatialStore((s) => s.zoomIn)
  const zoomOut = useSpatialStore((s) => s.zoomOut)
  const undo = useSpatialStore((s) => s.undo)
  const redo = useSpatialStore((s) => s.redo)
  const undoDepth = useSpatialStore((s) => s.history.undoStack.length)
  const redoDepth = useSpatialStore((s) => s.history.redoStack.length)
  const [newName, setNewName] = useState('')
  const events = useSpatialStore((s) => s.core.runtime.events)
  const recent = [...events]
    .filter((event) => event.actorId && (!activeActorIds || activeActorIds.includes(event.actorId)))
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
    .slice(0, 8)

  useEffect(() => {
    if (!actorTrayOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!dockRef.current?.contains(event.target as HTMLElement)) onCloseActorTray()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseActorTray()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [actorTrayOpen, onCloseActorTray])

  return (
    <div className="toolbar" ref={dockRef}>
      <nav className="tool-dock" aria-label="画布工具">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`tool-btn ${tool === t.id ? 'active' : ''}`}
          aria-label={t.label}
          aria-pressed={tool === t.id}
          title={`${t.label} (${t.hint})`}
          onClick={() => {
            if (tool === 'distance' && t.id !== 'distance') cancelDistance()
            setTool(t.id)
          }}
        >
          {t.id === 'place' ? (
            <svg className="tool-glyph place" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 10c0 5.25-8 11-8 11S4 15.25 4 10a8 8 0 1 1 16 0Z" />
              <circle cx="12" cy="10" r="2.5" />
            </svg>
          ) : (
            <span className={`tool-glyph ${t.id}`} aria-hidden="true" />
          )}
          <span className="tool-label">{t.label}</span>
          <span className="hint">{t.hint}</span>
        </button>
      ))}
      <span className="dock-divider" aria-hidden="true" />
      <button type="button" className={`dock-action dock-actors ${actorTrayOpen ? 'active' : ''}`} onClick={onToggleActorTray} aria-label="角色托盘" aria-expanded={actorTrayOpen} title="角色托盘">
        <span aria-hidden="true">☷</span>
      </button>
      {assistantEnabled && <button type="button" className={`dock-action dock-story ${storyOpen ? 'active' : ''}`} onClick={onToggleStory} aria-label={embedded ? '打开画板助手' : '切换剧情模拟面板'} aria-pressed={storyOpen} title={embedded ? '画板助手' : '剧情模拟'}>
        <span aria-hidden="true">✧</span>
      </button>}
      <span className="dock-divider" aria-hidden="true" />
      <button type="button" className="dock-action dock-fit" onClick={fitView} aria-label="适配画板" title="适配画板"><span aria-hidden="true">⌗</span></button>
      <button type="button" className="dock-action dock-zoom-in" onClick={zoomIn} aria-label="放大画布" title="放大画布"><span aria-hidden="true">+</span></button>
      <button type="button" className="dock-action dock-zoom-out" onClick={zoomOut} aria-label="缩小画布" title="缩小画布"><span aria-hidden="true">−</span></button>
      <button type="button" className="dock-action dock-undo" onClick={undo} disabled={undoDepth === 0} aria-label="撤销" title="撤销 (Ctrl+Z)"><span aria-hidden="true">↶</span></button>
      <button type="button" className="dock-action dock-redo" onClick={redo} disabled={redoDepth === 0} aria-label="重做" title="重做 (Ctrl+Y)"><span aria-hidden="true">↷</span></button>
      </nav>
      {actorTrayOpen ? <aside className="actor-tray">
      <div className="tray-heading"><h3>角色托盘</h3><button type="button" onClick={onCloseActorTray} aria-label="收起角色托盘">×</button></div>
      {actors.length === 0 && (
        <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '0 0 8px' }}>
          暂无角色。添加后可拖到画布。
        </p>
      )}
      {actors.map((a) => {
        const placement = placements.find((p) => p.actorId === a.id)
        const placed = Boolean(placement)
        const offstage = placement
          ? isPlacementOffstage(world, placement)
          : false
        return (
          <div
            key={a.id}
            className={`tray-item ${selection.type === 'actor' && selection.id === a.id ? 'selected' : ''}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-spatial-actor', a.id)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            onClick={() => select({ type: 'actor', id: a.id })}
            title={placed ? '已在画板中，拖动画布头像可移动' : '拖到画布放置'}
          >
            <div className="mini"><ActorAvatar actorId={a.id} displayName={a.displayName} kind={a.kind} assetRef={a.avatarAssetRef} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {a.displayName}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                {a.kind === 'persona' ? '用户' : '角色'}
                {offstage
                  ? ' · 未参与对话'
                  : placed
                    ? ' · 参与对话'
                    : ' · 未放置'}
              </div>
            </div>
          </div>
        )
      })}

      {activeActorIds === null && <><div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input
          placeholder="新角色名"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newName.trim()) {
              createActor(newName.trim(), 'character')
              setNewName('')
            }
          }}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          disabled={!newName.trim()}
          onClick={() => {
            createActor(newName.trim(), 'character')
            setNewName('')
          }}
        >
          加
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button
          type="button"
          style={{ width: '100%' }}
          onClick={() => createActor('用户', 'persona')}
        >
          + 用户身份
        </button>
      </div>
      </>}
      <p style={{ marginTop: 8, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
        未放置的角色可点「放到当前画板」，或拖到画布落点。
      </p>
      {actors
        .filter((a) => !placements.some((p) => p.actorId === a.id))
        .map((a) => (
          <button
            key={`put-${a.id}`}
            type="button"
            style={{ width: '100%', marginBottom: 4, fontSize: 12 }}
            onClick={() => placeActorOnBoard(a.id, currentBoardId)}
          >
            放到当前画板：{a.displayName}
          </button>
        ))}

      <details className="toolbar-help toolbar-history">
        <summary>移动历史{recent.length > 0 ? ` · ${recent.length}` : ''}</summary>
        {recent.length === 0 ? (
          <p>暂无位置变化</p>
        ) : (
          <ul className="history-list">
            {recent.map((event) => (
              <li key={event.id}>
                {world.actors.find((actor) => actor.id === event.actorId)?.displayName ??
                  event.actorId}{' '}
                · {labelOf(COMMAND_TYPE_LABELS, event.commandType, event.commandType)}
              </li>
            ))}
          </ul>
        )}
      </details>

      <details className="toolbar-help">
        <summary>操作提示</summary>
        <p>
          区域：拖拽绘制 · 地点：单击
          <br />
          未参与对话：单击添加 / 拖拽定尺寸
          <br />
          地点右上角 + 可添加子结构
          <br />
          距离：点两个同类节点
          <br />
          点击节点查看属性
          <br />
          Delete 删除 · Ctrl+Z 撤销
        </p>
      </details>
      </aside> : null}
    </div>
  )
}
