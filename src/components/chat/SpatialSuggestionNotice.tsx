import { useEffect, useRef, useState } from 'react'
import { MapPin } from 'lucide-react'
import type { SpatialAiProposal, SpatialAiSession, SpatialGroupAiSession } from '../../../shared/spatial-ai'
import { useChatStore } from '../../store/useChatStore'

interface Props {
  characterId?: string
  groupId?: string
  sessionId: string
  worldId?: string | null
  enabled: boolean
  onOpen: () => void
  canSend?: boolean
  onApplyAndSend?: (proposal: SpatialAiProposal) => Promise<void>
}

/** 简短入口只显示当前聊天作用域的建议；主消息历史仍只包含对话正文。 */
export function SpatialSuggestionNotice({ characterId, groupId, sessionId, worldId, enabled, onOpen, canSend = false, onApplyAndSend }: Props) {
  const automaticPolicy = useChatStore(store => !groupId && store.sessions.find(session => session.id === sessionId)?.spatialNarrativeSyncPolicy === 'auto')
  const [state, setState] = useState<SpatialAiSession | SpatialGroupAiSession | null>(null)
  const [error, setError] = useState(false)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [syncNotice, setSyncNotice] = useState<string | null>(null)
  const notified = useRef(new Set<string>())
  const scopeRef = useRef(`${groupId ? `group:${groupId}` : `single:${characterId}`}:${sessionId}`)
  scopeRef.current = `${groupId ? `group:${groupId}` : `single:${characterId}`}:${sessionId}`
  useEffect(() => {
    setState(null); setError(false); setApplyError(null); setApplying(false)
    if (!worldId || !enabled) return
    let disposed = false, sequence = 0
    const refresh = async () => {
      const request = ++sequence
      try {
        const next = groupId ? await window.api.spatial.getGroupAiSession(groupId, sessionId) : await window.api.spatial.getAiSession(characterId!, sessionId)
        if (!disposed && request === sequence) { setState(next); setError(false) }
      } catch { if (!disposed && request === sequence) setError(true) }
    }
    void refresh()
    const stopAi = window.api.spatial.onAiUpdated(event => { if ((groupId ? event.kind === 'group' && event.groupId === groupId : event.kind !== 'group' && event.characterId === characterId) && event.sessionId === sessionId) void refresh() })
    const stopBoard = window.api.spatial.onUpdated(event => { if (event.worldId === worldId || ((groupId ? event.kind === 'group' && event.groupId === groupId : event.kind !== 'group' && event.characterId === characterId) && event.sessionId === sessionId)) void refresh() })
    return () => { disposed = true; stopAi(); stopBoard() }
  }, [characterId, groupId, sessionId, worldId, enabled])
  const matches = state && (groupId ? 'kind' in state.scope && state.scope.kind === 'group' && state.scope.groupId === groupId : 'characterId' in state.scope && state.scope.characterId === characterId) && state.scope.sessionId === sessionId
  const current = matches ? state : null
  const suggestions = current?.proposals.filter(proposal => proposal.mode === 'dialogue_sync' && (!automaticPolicy || proposal.automatic?.status === 'applying') && (proposal.status === 'pending' || (proposal.status === 'stale' && proposal.canReview && !proposal.replacedById))) ?? []
  const failed = current?.tasks.at(-1)?.mode === 'dialogue_sync' && ['failed','interrupted'].includes(current.tasks.at(-1)!.state)
  const synchronizing = suggestions.some(proposal => proposal.automatic?.status === 'applying')
  const ready = !synchronizing && !suggestions.some(proposal => proposal.automatic) && suggestions.length === 1 && suggestions[0].status === 'pending' && suggestions[0].commands.length > 0 && suggestions[0].unresolved.length === 0 ? suggestions[0] : null
  const latest = current?.proposals.filter(proposal => proposal.mode === 'dialogue_sync').at(-1)
  const autoApplied = latest?.status === 'applied' && latest.automatic?.status === 'applied' && !latest.sourceChanged && current?.tasks.at(-1)?.dialogueId === latest.dialogueId
  const groupLatest = groupId ? current?.proposals.filter(proposal => proposal.mode === 'dialogue_sync' && ['pending','stale','applied'].includes(proposal.status) && !proposal.replacedById).at(-1) : null
  const changed = groupLatest?.sourceChanged && groupLatest.status === 'applied'
  const expired = groupLatest?.status === 'stale' && !groupLatest.replacedById && !groupLatest.canReview
  const groupApplied = groupLatest?.status === 'applied'
  const extracting = groupId && current?.tasks.some(task => task.mode === 'dialogue_sync' && ['queued','running'].includes(task.state))
  const noticeKey = autoApplied && latest && current && worldId ? `${scopeRef.current}:${worldId}:${current.id}:${latest.id}` : null
  useEffect(() => {
    if (!enabled || !noticeKey) { setSyncNotice(null); return }
    if (notified.current.has(noticeKey)) return
    notified.current.add(noticeKey)
    setSyncNotice(noticeKey)
    const timer = window.setTimeout(() => setSyncNotice(null), 2000)
    return () => window.clearTimeout(timer)
  }, [noticeKey, enabled])
  if (autoApplied && !suggestions.length && !failed && !error) {
    if (!enabled || syncNotice !== noticeKey) return null
    return <div role="status" aria-live="polite" aria-atomic="true" className="flex items-center gap-2 rounded-lg bg-tavern-accent-soft px-3 py-1.5 text-[11px] text-tavern-text-muted">
      <MapPin className="h-3 w-3 shrink-0 text-tavern-accent" /><span>本轮位置已自动同步</span>
    </div>
  }
  if (!worldId || !enabled || (!suggestions.length && !failed && !error && !autoApplied && !changed && !expired && !groupApplied && !extracting)) return null
  return <div role="status" className="flex flex-wrap items-center gap-2 py-1.5 text-[11px] text-tavern-text-muted">
    <MapPin className="h-3 w-3 shrink-0 text-tavern-accent" />
    <span className="min-w-0 flex-1 truncate">{synchronizing ? '正在自动同步位置 · 对话仍使用已确认位置' : suggestions.length ? `${suggestions.length} 条位置建议待核对 · 继续发送将使用已确认位置` : failed || error ? '位置提取未完成 · 对话仍使用已确认位置' : changed ? '已应用位置的来源已变化 · 当前位置保持不变' : expired ? '位置建议已失效 · 当前已确认位置保持不变' : extracting ? '正在提取本轮位置 · 对话仍使用已确认位置' : groupApplied ? '本轮位置已确认 · 可查看或撤销' : '本轮位置已自动同步'}</span>
    <button type="button" onClick={onOpen} className="shrink-0 text-tavern-accent hover:underline">{!suggestions.length && !failed && !error && (autoApplied || groupApplied) ? '查看或撤销' : '查看画板建议'}</button>
    {!groupId && ready && onApplyAndSend && <button type="button" disabled={!canSend || applying} title={ready.summary.join('；')} onClick={() => {
      setApplying(true); setApplyError(null)
      const scope = scopeRef.current
      void onApplyAndSend(ready).catch(cause => { if (scopeRef.current === scope) setApplyError(cause instanceof Error ? cause.message : String(cause)) }).finally(() => { if (scopeRef.current === scope) setApplying(false) })
    }} className="shrink-0 text-tavern-accent disabled:opacity-40">{applying ? '正在应用…' : '应用并发送'}</button>}
    {applyError && <p role="alert" className="w-full text-tavern-danger">{applyError}</p>}
  </div>
}
