import { useState } from 'react'
import type { SpatialAiProposal, SpatialTarget } from '../../../shared/spatial-ai'

interface Props {
  proposal: SpatialAiProposal
  targets: SpatialTarget[]
  busy: boolean
  onReview: (targets: Record<string, string>) => void
  onCreate: (name: string, parentId: string | null) => void
}

export function SpatialDialogueReview({ proposal, targets, busy, onReview, onCreate }: Props) {
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const unresolved = proposal.dialogueCandidates?.filter(candidate => !candidate.targetNodeId || !targets.some(target => target.id === candidate.targetNodeId)) ?? []
  return <div className="mt-2 space-y-2 text-xs text-tavern-text-soft">
    {proposal.comparisons?.map((item, index) => <p key={index}>{item.actorName}：<span className="text-tavern-text-muted">{item.currentPath}</span> → {item.targetPath}</p>)}
    {unresolved.map(candidate => <div key={candidate.id} className="space-y-1">
      <p>“{candidate.targetText}” · {candidate.reason}</p>
      {candidate.eligible ? <select aria-label={`选择已有地点：${candidate.targetText}`} disabled={busy} value={selected[candidate.id] ?? ''}
        onChange={event => setSelected(old => ({ ...old, [candidate.id]: event.target.value }))} className="w-full rounded border border-tavern-border bg-tavern-bg px-2 py-1.5">
        <option value="">选择已有地点</option>{targets.map(target => <option key={target.id} value={target.id}>{target.path}</option>)}
      </select> : <p className="text-[11px] text-tavern-text-muted">此动作不能应用；请在对话中明确完成行动。</p>}
    </div>)}
    {(proposal.status === 'stale' || unresolved.some(candidate => candidate.eligible)) && <div className="flex gap-3">
      <button type="button" disabled={busy || (!proposal.commands.length && !Object.values(selected).some(Boolean))} onClick={() => onReview(Object.fromEntries(Object.entries(selected).filter(([,value]) => !!value)))} className="text-tavern-accent disabled:opacity-40">重新核对</button>
      {unresolved.some(candidate => candidate.eligible) && <button type="button" disabled={busy} onClick={() => { setCreating(!creating); setName(unresolved.find(candidate => candidate.eligible)?.targetText ?? '') }} className="text-tavern-accent">创建地点</button>}
    </div>}
    {creating && <div className="space-y-2 rounded-lg border border-tavern-border-soft p-2">
      <input aria-label="新地点名称" value={name} onChange={event => setName(event.target.value)} maxLength={128} className="w-full rounded border border-tavern-border bg-tavern-bg px-2 py-1" />
      <select aria-label="新地点上级" value={parent} onChange={event => setParent(event.target.value)} className="w-full rounded border border-tavern-border bg-tavern-bg px-2 py-1"><option value="">世界根画板</option>{targets.filter(target => target.canContain).map(target => <option key={target.id} value={target.id}>{target.path}</option>)}</select>
      <p className="text-[11px] text-tavern-text-muted">先确认创建地点，再选择它并重新核对移动。</p>
      <button type="button" disabled={busy || !name.trim()} onClick={() => onCreate(name, parent || null)} className="text-tavern-accent disabled:opacity-40">预览地点创建</button>
    </div>}
    {proposal.reviewedFromId && <p className="text-[11px] text-tavern-text-muted">已核对当前修订 {proposal.baseVersion?.runtimeRevision}；请再次确认移动。</p>}
  </div>
}
