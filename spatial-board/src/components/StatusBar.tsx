import { useSpatialStore, countValidationIssues } from '../store/spatialStore.ts'

export function StatusBar() {
  const saveStatus = useSpatialStore((s) => s.saveStatus)
  const statusMessage = useSpatialStore((s) => s.statusMessage)
  const core = useSpatialStore((s) => s.core)
  const currentBoardId = useSpatialStore((s) => s.currentBoardId)
  const selection = useSpatialStore((s) => s.selection)

  const board = core.world.boards.find((b) => b.id === currentBoardId)
  const issues = countValidationIssues(core)
  const selectedName = selection.type === 'node'
    ? core.world.nodes.find((node) => node.id === selection.id)?.name
    : selection.type === 'actor'
      ? core.world.actors.find((actor) => actor.id === selection.id)?.displayName
      : selection.type === 'distance'
        ? core.world.distances.find((distance) => distance.id === selection.id)?.name
        : null

  const saveLabel =
    saveStatus === 'saved'
      ? '已保存'
      : saveStatus === 'saving'
        ? '保存中'
        : saveStatus === 'error'
          ? '保存失败'
          : '未保存'

  return (
    <footer className="status-bar">
      <span className={`save-indicator ${saveStatus === 'error' ? 'err' : saveStatus === 'saved' ? 'ok' : ''}`}>
        <span className="save-dot" aria-hidden="true" />
        {saveLabel}
      </span>
      <span className="status-context">画板 <strong>{board?.name ?? currentBoardId}</strong></span>
      <span className="status-context">选中 <strong>{selectedName ?? '无'}</strong></span>
      {issues > 0 ? <span className="status-issues">{issues} 个校验问题</span> : null}
      <span className="status-message" role="status">{statusMessage}</span>
    </footer>
  )
}
