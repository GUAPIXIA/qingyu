import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Loader2, Send, Sparkles, X } from 'lucide-react'
import type { SpatialAiProposal, SpatialAiRequest, SpatialAiSession, SpatialGroupAiSession, SpatialInitializationSources, SpatialTarget } from '../../../shared/spatial-ai'
import type { SpatialSnapshot } from '../../../shared/spatial'
import { useChatStore } from '../../store/useChatStore'
import { useGroupChatStore } from '../../store/useGroupChatStore'
import { SpatialDialogueReview } from './SpatialDialogueReview'

interface Props {
  characterId?: string; groupId?: string; sessionId: string; open: boolean; bound: boolean
  previewId: string | null; onClose: () => void; flush: () => Promise<void>
  onPreview: (proposal: SpatialAiProposal) => void
  onApplied: (snapshot: SpatialSnapshot) => void
  onDiscard: (id: string) => Promise<void>
}

export function SpatialAiPanel({ characterId, groupId, sessionId, open, bound, previewId, onClose, flush, onPreview, onApplied, onDiscard }: Props) {
  const api = useMemo(() => ({
    get: () => groupId ? window.api.spatial.getGroupAiSession(groupId, sessionId) : window.api.spatial.getAiSession(characterId!, sessionId),
    sources: () => groupId ? window.api.spatial.groupInitializationSources(groupId, sessionId) : window.api.spatial.initializationSources(characterId!, sessionId),
    targets: () => groupId ? window.api.spatial.groupProposalTargets(groupId, sessionId) : window.api.spatial.proposalTargets(characterId!, sessionId),
    ask: (input: SpatialAiRequest) => groupId ? window.api.spatial.askGroupAi(groupId, sessionId, input) : window.api.spatial.askAi(characterId!, sessionId, input),
    apply: (id: string, acknowledged: boolean) => groupId ? window.api.spatial.applyGroupProposal(groupId, sessionId, id, acknowledged) : window.api.spatial.applyProposal(characterId!, sessionId, id, acknowledged),
    discard: (id: string) => groupId ? window.api.spatial.discardGroupProposal(groupId, sessionId, id) : window.api.spatial.discardProposal(characterId!, sessionId, id),
    cancel: () => groupId ? window.api.spatial.cancelGroupAi(groupId, sessionId) : window.api.spatial.cancelAi(characterId!, sessionId),
  }), [characterId, groupId, sessionId])
  const [state, setState] = useState<SpatialAiSession | SpatialGroupAiSession | null>(null)
  const [memberIds, setMemberIds] = useState<string[] | null>(null)
  const [sources, setSources] = useState<SpatialInitializationSources | null>(null)
  const [text, setText] = useState('')
  const [loreIds, setLoreIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({})
  const [targets, setTargets] = useState<SpatialTarget[]>([])
  const [undoId, setUndoId] = useState<string | null>(null)
  const scopeRef = useRef(`${groupId ? `group:${groupId}` : `single:${characterId}`}:${sessionId}`)
  const refreshSequence = useRef(0)
  scopeRef.current = `${groupId ? `group:${groupId}` : `single:${characterId}`}:${sessionId}`
  const singleSession = useChatStore(s => s.sessions.find(item => item.id === sessionId))
  const groupSession = useGroupChatStore(s => s.currentGroup?.id === groupId ? s.sessions.find(item => item.id === sessionId) : undefined)
  const session = groupId ? groupSession : singleSession
  const narrativePolicy = groupId ? groupSession?.spatialNarrativeSyncPolicy : singleSession?.spatialNarrativeSyncPolicy
  const automaticDialogue = (proposal: SpatialAiProposal) => !groupId && proposal.mode === 'dialogue_sync' &&
    (narrativePolicy === 'auto' || (proposal.automatic && !proposal.reviewedFromId))
  const running = state?.tasks.find(task => task.state === 'running')
  const active = busy || !!running || !!state?.proposals.some(proposal => proposal.automatic?.status === 'applying')
  const pending = state?.proposals.filter(proposal => proposal.status === 'pending') ?? []
  const visible = state?.proposals.filter(proposal => proposal.status === 'pending' || (proposal.status === 'stale' && !proposal.replacedById && (proposal.mode !== 'dialogue_sync' || proposal.canReview))) ?? []
  const results = state?.proposals.filter(proposal => proposal.mode === 'dialogue_sync' && (['applied','undone'].includes(proposal.status) || proposal.automatic?.status === 'skipped')) ?? []
  const latestResult = results.at(-1)
  const olderResults = results.slice(0, -1)
  const latestMessage = state?.messages.at(-1)
  const currentReply = latestMessage?.role === 'assistant' && !latestMessage.proposalId && latestMessage.mode !== 'dialogue_sync' ? latestMessage : null
  const failedTasks = state?.tasks.filter((task, index, tasks) => {
    if (!['failed','cancelled','interrupted'].includes(task.state)) return false
    // 手动请求只显示最新一轮的失败；剧情重试只取代对应轮次，保留其他待处理失败。
    return !tasks.slice(index + 1).some(next => task.mode === 'dialogue_sync'
      ? !!task.dialogueId && next.mode === 'dialogue_sync' && next.dialogueId === task.dialogueId
      : next.mode !== 'dialogue_sync')
  }) ?? []
  const refresh = useCallback(async () => {
    const scope = `${groupId ? `group:${groupId}` : `single:${characterId}`}:${sessionId}`
    const request = ++refreshSequence.current
    const [next, materials, places] = await Promise.all([api.get(), api.sources(), api.targets()])
    if (scopeRef.current === scope && request === refreshSequence.current) {
      setState(next); setSources(materials); setTargets(places)
      setMemberIds(old => old === null ? null : old.filter(id => materials.members?.some(member => member.id === id)))
      setLoreIds(old => old.filter(id => materials.loreEntries.some(entry => entry.id === id)))
    }
  }, [characterId, groupId, sessionId, api])
  useEffect(() => {
    setMemberIds(null); setState(null); setSources(null); setText(''); setLoreIds([]); setError(null); setBusy(false); setTargets([]); setAcknowledged({}); setUndoId(null)
  }, [characterId, groupId, sessionId, api])
  useEffect(() => {
    if (!open) return
    let active = true
    const reload = () => { void refresh().catch(cause => { if (active) setError(String(cause)) }) }
    reload()
    const unsubscribe = window.api.spatial.onAiUpdated(event => {
      if ((groupId ? event.kind === 'group' && event.groupId === groupId : event.kind !== 'group' && event.characterId === characterId) && event.sessionId === sessionId) reload()
    })
    return () => { active = false; unsubscribe() }
  }, [open, refresh, characterId, groupId, sessionId])
  useEffect(() => {
    if (!open) return
    let active = true
    const unsubscribe = window.api.spatial.onUpdated(event => {
      if (event.worldId === session?.spatialWorldId || ((groupId ? event.kind === 'group' && event.groupId === groupId : event.kind !== 'group' && event.characterId === characterId) && event.sessionId === sessionId)) void refresh().catch(cause => { if (active) setError(String(cause)) })
    })
    return () => { active = false; unsubscribe() }
  }, [open, refresh, characterId, groupId, sessionId, session?.spatialWorldId])
  const perform = async (action: () => Promise<void>) => {
    const scope = scopeRef.current
    setBusy(true); setError(null)
    try { await action() } catch (cause) { if (scopeRef.current === scope) { setError(cause instanceof Error ? cause.message : String(cause)); await refresh().catch(() => {}) } }
    finally { if (scopeRef.current === scope) setBusy(false) }
  }
  const ask = (mode: SpatialAiRequest['mode']) => perform(async () => {
    const scope = scopeRef.current
    await flush()
    if (scopeRef.current !== scope) return
    const next = await api.ask({ requestId: crypto.randomUUID(), mode, text, loreEntryIds: mode === 'instruction' ? [] : loreIds, ...(groupId ? { memberIds: memberIds ?? sources?.members?.map(member => member.id) ?? [] } : {}) })
    if (scopeRef.current !== scope) return
    const current = await api.get()
    if (scopeRef.current !== scope) return
    if (current.id !== next.id) { setState(current); throw new Error('画板绑定已改变，旧请求保留在原助手记录中，请重新请求') }
    setState(next)
    const proposal = next.proposals.filter(item => item.status === 'pending' && item.mode === mode).at(-1)
    if (mode === 'initialize' && proposal?.preview) onPreview(proposal)
    const task = next.tasks.at(-1)
    if (task?.state === 'completed') setText('')
  })
  const apply = (proposal: SpatialAiProposal) => perform(async () => {
    const scope = scopeRef.current
    await flush()
    if (scopeRef.current !== scope) return
    const result = await api.apply(proposal.id, !!acknowledged[proposal.id])
    if (scopeRef.current !== scope) return
    setState(result.state); onApplied(result.snapshot); await refresh()
  })
  const discard = (proposal: SpatialAiProposal) => perform(async () => {
    const scope = scopeRef.current
    await flush()
    if (scopeRef.current !== scope) return
    const next = await api.discard(proposal.id)
    if (scopeRef.current !== scope) return
    setState(next); await onDiscard(proposal.id)
  })
  const review = (proposal: SpatialAiProposal, selection: Record<string, string>) => perform(async () => {
    const scope = scopeRef.current
    await flush(); if (scopeRef.current !== scope) return
    const next = groupId ? await window.api.spatial.reviewGroupProposal(groupId, sessionId, proposal.id, {targets:selection}) : await window.api.spatial.reviewProposal(characterId!, sessionId, proposal.id, { targets: selection })
    if (scopeRef.current === scope) { setState(next); await refresh() }
  })
  const createPlace = (proposal: SpatialAiProposal, name: string, parentId: string | null) => perform(async () => {
    const scope = scopeRef.current
    await flush(); if (scopeRef.current !== scope) return
    const next = groupId ? await window.api.spatial.prepareGroupPlace(groupId, sessionId, proposal.id, name, parentId) : await window.api.spatial.preparePlace(characterId!, sessionId, proposal.id, name, parentId)
    if (scopeRef.current === scope) { setState(next); await refresh() }
  })
  const undo = (proposal: SpatialAiProposal) => perform(async () => {
    const scope = scopeRef.current
    await flush(); if (scopeRef.current !== scope) return
    const result = groupId ? await window.api.spatial.undoGroupProposal(groupId, sessionId, proposal.id) : await window.api.spatial.undoProposal(characterId!, sessionId, proposal.id)
    if (scopeRef.current === scope) { setState(result.state); onApplied(result.snapshot); setUndoId(null); await refresh() }
  })

  const renderSources = () => {
    return sources && <details className="rounded-lg border border-tavern-border-soft px-3 py-2 text-xs text-tavern-text-muted"><summary className="cursor-pointer">初始化来源 · {sources.sources.length} 项</summary>
      <p className="mt-2">{groupId ? '使用选定成员的空间设定、群聊公共设定与最近保存正文。个人住所不会自动合并；未知起点保留未放置。' : '使用当前角色设定、已选中的开场与最近保存的正文。未知起点保留未放置。'}</p>
      {sources.members?.map(member => <label key={member.id} className="mt-2 flex gap-2"><input type="checkbox" checked={(memberIds ?? sources.members!.map(item => item.id)).includes(member.id)} disabled={active} onChange={event => setMemberIds(old => { const ids = old ?? sources.members!.map(item => item.id); return event.target.checked ? [...ids, member.id] : ids.filter(id => id !== member.id) })} />{member.name} · 成员设定</label>)}
      {sources.sources.map(source => <div key={source.id} className="mt-2"><span className="font-medium text-tavern-text-soft">{source.label}</span><p className="mt-0.5 line-clamp-2 whitespace-pre-wrap">{source.text}</p></div>)}
      {sources.loreEntries.map(entry => <label key={entry.id} className="mt-2 flex gap-2"><input type="checkbox" checked={loreIds.includes(entry.id)} disabled={active} onChange={event => setLoreIds(old => event.target.checked ? [...old, entry.id] : old.filter(id => id !== entry.id))} />{entry.label}</label>)}
      {sources.sharedSessions > 1 && <p className="mt-2 text-tavern-accent">此地图被 {sources.sharedSessions} 个会话共用；地点修改会影响其他会话。</p>}
    </details>
  }
  const renderResult = (proposal: SpatialAiProposal) => <div key={proposal.id} className="rounded-lg border border-tavern-border-soft px-3 py-2 text-xs text-tavern-text-muted">
    <p>{proposal.automatic?.status === 'skipped' ? '已自动跳过' : proposal.status === 'undone' ? '已撤销' : proposal.automatic?.status === 'applied' ? '已自动应用' : '已应用'}：{proposal.automatic?.status === 'skipped' ? proposal.automatic.reason : proposal.summary.join('；')}</p>
    {proposal.automatic && proposal.unresolved.length > 0 && <details className="mt-1"><summary className="cursor-pointer">跳过详情 · {proposal.unresolved.length} 项</summary><p className="mt-1">{[...new Set(proposal.unresolved)].join('；')}</p></details>}
    {proposal.status === 'applied' && <div className="mt-2 flex gap-3"><button type="button" disabled={active || !!previewId} className="text-tavern-accent disabled:opacity-40" onClick={() => { if (undoId === proposal.id) void undo(proposal); else setUndoId(proposal.id) }}>{undoId === proposal.id ? '确认撤销此次更新' : '撤销此次剧情更新'}</button>{undoId === proposal.id && <button type="button" onClick={() => setUndoId(null)}>取消</button>}</div>}
  </div>

  return <aside hidden={!open} aria-label="画板助手" className={`${open ? 'flex' : 'hidden'} absolute inset-y-0 right-0 z-20 w-[340px] max-w-[90%] flex-col border-l border-tavern-border bg-tavern-bg-card shadow-xl`}>
    <header className="flex shrink-0 items-center gap-2 border-b border-tavern-border-soft px-4 py-3">
      <Sparkles className="h-4 w-4 text-tavern-accent" /><div className="flex-1"><h3 className="text-sm font-medium text-tavern-text">{sources?.canInitialize ? 'AI 初始化' : '画板助手'}</h3></div>
      <button type="button" aria-label="关闭画板助手" onClick={onClose} className="rounded p-1 text-tavern-text-muted hover:bg-tavern-bg-hover"><X className="h-4 w-4" /></button>
    </header>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
      {sources?.canInitialize && <p className="text-xs leading-relaxed text-tavern-text-soft">结合角色设定和对话生成场景，预览后使用。</p>}
      <details className="group rounded-lg border border-tavern-border-soft px-3 py-2 text-xs text-tavern-text-muted">
        <summary className="flex cursor-pointer items-center justify-between gap-2"><span className="text-tavern-text-soft">同步设置</span><span>{session?.spatialContextEnabled === false ? '已暂停' : narrativePolicy === 'auto' ? '自动同步' : narrativePolicy === 'off' || (groupId && !narrativePolicy) ? '已关闭' : '需确认'}</span><ChevronDown className="h-3 w-3 shrink-0 transition-transform group-open:rotate-180" /></summary>
        <div className="mt-3 space-y-3">
          <label className="flex items-center justify-between gap-3 text-xs text-tavern-text-soft">对话读取位置<input type="checkbox" checked={session?.spatialContextEnabled !== false} disabled={busy} onChange={event => { const enabled = event.target.checked; void perform(async () => { await flush(); if (groupId) { await window.api.group.updateSession(groupId, sessionId, { spatialContextEnabled: enabled }); useGroupChatStore.setState(state => state.currentGroup?.id === groupId ? { sessions: state.sessions.map(item => item.id === sessionId ? { ...item, spatialContextEnabled: enabled } : item) } : {}) } else { await window.api.chat.updateSession(characterId!, sessionId, { spatialContextEnabled: enabled }); useChatStore.getState().patchLocalSession(sessionId, { spatialContextEnabled: enabled }) } }) }} /></label>
          {groupId && <label className="flex items-center justify-between gap-3 text-xs text-tavern-text-soft">剧情同步<select aria-label="剧情同步策略" value={narrativePolicy ?? 'off'} disabled={busy || !bound} onChange={event => { const policy = event.target.value as 'off' | 'suggest'; void perform(async () => { await window.api.group.updateSession(groupId, sessionId, { spatialNarrativeSyncPolicy: policy }); useGroupChatStore.setState(state => state.currentGroup?.id === groupId ? { sessions: state.sessions.map(item => item.id === sessionId ? { ...item, spatialNarrativeSyncPolicy: policy } : item) } : {}); await refresh() }) }} className="rounded border border-tavern-border bg-tavern-bg px-2 py-1 text-xs"><option value="off">关闭</option><option value="suggest">需确认</option></select></label>}
          {groupId && narrativePolicy === 'suggest' && <p className="text-[11px] text-tavern-text-muted">完整正文保存后提取；轮询交还用户时统一处理，位置需确认后生效。</p>}
          {groupId && session?.spatialContextEnabled === false && <p className="text-[11px] text-tavern-text-muted">对话位置读取已关闭，剧情同步暂停。</p>}
          {!groupId && <label className="flex items-center justify-between gap-3 text-xs text-tavern-text-soft">剧情同步<select aria-label="剧情同步策略" value={narrativePolicy ?? 'suggest'} disabled={busy || !bound} onChange={event => { const policy = event.target.value as 'off' | 'suggest' | 'auto'; void perform(async () => { await window.api.chat.updateSession(characterId!, sessionId, { spatialNarrativeSyncPolicy: policy }); useChatStore.getState().patchLocalSession(sessionId, { spatialNarrativeSyncPolicy: policy }); await refresh() }) }} className="rounded border border-tavern-border bg-tavern-bg px-2 py-1 text-xs"><option value="off">关闭</option><option value="suggest">需确认</option><option value="auto">自动</option></select></label>}
          {!groupId && (session?.spatialContextEnabled === false ? <p className="text-[11px] text-tavern-text-muted">对话位置读取已关闭，剧情同步暂停。</p> : narrativePolicy === 'auto' && <p className="text-[11px] leading-relaxed text-tavern-text-muted">按剧情自动同步角色和用户位置，明确的新地点自动添加；不确定或未完成的动作自动跳过。</p>)}
          {!sources?.canInitialize && renderSources()}
        </div>
      </details>
      {sources?.canInitialize && renderSources()}
      {!state && !error && <p className="flex items-center gap-2 text-xs text-tavern-text-muted"><Loader2 className="h-3 w-3 animate-spin" />读取助手记录…</p>}
      {currentReply && <div className="rounded-lg bg-tavern-bg-soft px-3 py-2 text-xs leading-relaxed text-tavern-text-soft"><p className="whitespace-pre-wrap">{currentReply.content}</p></div>}
      {visible.map(proposal => <section key={proposal.id} className="rounded-xl border border-tavern-accent/30 bg-tavern-accent-soft/40 p-3">
        <h4 className="text-xs font-medium text-tavern-text">{proposal.mode === 'initialize' ? '场景草稿' : proposal.mode === 'positions' ? '人物起点' : proposal.mode === 'dialogue_sync' ? automaticDialogue(proposal) ? '剧情位置同步' : '剧情位置建议' : '待确认调整'}</h4>
        {(!proposal.comparisons?.length || automaticDialogue(proposal)) && <ul className="mt-2 space-y-1 text-xs text-tavern-text-soft">{[...new Set(proposal.summary)].map((item,index) => <li key={index}>{item}</li>)}</ul>}
        {proposal.status === 'stale' && <p className="mt-2 text-xs text-tavern-text-muted">{proposal.staleReason}</p>}
        {proposal.automatic && (proposal.automatic.status === 'applying' || proposal.automatic.reason !== proposal.staleReason) && <p className="mt-2 text-[11px] text-tavern-text-muted">{proposal.automatic.status === 'applying' ? '正在自动同步位置…' : proposal.automatic.reason}</p>}
        {proposal.mode === 'dialogue_sync' && !automaticDialogue(proposal) && <SpatialDialogueReview proposal={proposal} targets={targets} busy={active || !!previewId} onReview={selection => { void review(proposal, selection) }} onCreate={(name, parentId) => { void createPlace(proposal, name, parentId) }} />}
        {proposal.unresolved.length > 0 && !automaticDialogue(proposal) && <div className="mt-2 text-xs text-tavern-text-muted">
          <details><summary className="cursor-pointer">未明确项 · {proposal.unresolved.length} 项</summary><p className="mt-1">{[...new Set(proposal.unresolved)].join('；')}</p></details>
          <label className="mt-1.5 flex gap-2"><input type="checkbox" checked={!!acknowledged[proposal.id]} onChange={event => setAcknowledged(old => ({ ...old, [proposal.id]: event.target.checked }))} />已核对，保留这些未明确项</label>
        </div>}
        <details className="mt-2 text-[11px] text-tavern-text-muted"><summary className="cursor-pointer">依据与版本</summary><p>修订 {proposal.baseVersion?.runtimeRevision ?? '未绑定草稿'}</p>{proposal.evidence.map((item,index) => <p key={index}>{proposal.sources.find(source => source.id === item.sourceId)?.label}：“{item.quote}”</p>)}</details>
        {!automaticDialogue(proposal) && <div className="mt-3 flex gap-3 text-xs">
          {proposal.preview && <button type="button" disabled={active || proposal.status !== 'pending'} onClick={() => { void perform(async () => { await flush(); onPreview(proposal) }) }} className="text-tavern-accent hover:underline">{previewId === proposal.id ? '正在预览' : '预览并修改'}</button>}
          <button type="button" disabled={active || proposal.status !== 'pending' || (proposal.mode === 'dialogue_sync' && !proposal.commands.length) || (previewId !== null && previewId !== proposal.id) || (proposal.unresolved.length > 0 && !acknowledged[proposal.id])} onClick={() => { void apply(proposal) }} className="font-medium text-tavern-accent disabled:opacity-40">{proposal.mode === 'initialize' ? '确认场景' : proposal.reviewedFromId ? '确认移动' : '应用'}</button>
          <button type="button" disabled={active} onClick={() => { void discard(proposal) }} className="text-tavern-text-muted">忽略</button>
        </div>}
      </section>)}
      {state?.proposals.filter(proposal => (proposal.mode === 'dialogue_sync' && proposal.status === 'stale' && !proposal.replacedById && !proposal.canReview) || proposal.sourceChanged).slice(-1).map(proposal => <p key={proposal.id} className="text-[11px] text-tavern-text-muted">{proposal.sourceChanged ? '已应用位置的来源已变化，当前位置保持不变' : '剧情建议已失效'}：{proposal.staleReason}</p>)}
      {latestResult && renderResult(latestResult)}
      {failedTasks.slice(-1).map(task => <p key={task.id} role="alert" className="text-xs text-tavern-danger">{task.error ?? '画板请求已停止'}{task.mode === 'dialogue_sync' ? groupId && task.state === 'cancelled' ? '；本轮提取已取消。' : '；可重新提取本轮剧情。' : '；可修改输入后重新发送。'}</p>)}
      {failedTasks.filter(task => task.mode === 'dialogue_sync' && ['failed','interrupted'].includes(task.state)).slice(-1).map(task => <button key={task.id} type="button" disabled={active} className="text-xs text-tavern-accent disabled:opacity-40" onClick={() => { void perform(async () => { if (groupId) await window.api.spatial.retryGroupDialogue(groupId, sessionId, task.id); else await window.api.spatial.retryDialogue(characterId!, sessionId, task.id); await refresh() }) }}>重新提取本轮剧情</button>)}
      {error && <p role="alert" className="text-xs text-tavern-danger">{error}</p>}
      {state && (state.messages.length > 0 || olderResults.length > 0 || state.tasks.length > 0) && <details className="rounded-lg border border-tavern-border-soft px-3 py-2 text-xs text-tavern-text-muted">
        <summary className="cursor-pointer">历史与详情</summary>
        <div className="mt-3 space-y-2">
          {state.historyTrimmed && <p className="text-[11px]">较早的助手消息已裁剪，地图仍保留完整状态。</p>}
          {olderResults.map(renderResult)}
          {state.messages.filter(message => message.id !== currentReply?.id).map(message => <div key={message.id} className="border-l-2 border-tavern-border-soft pl-2 text-[11px] leading-relaxed">
            <p className="mb-0.5 text-tavern-text-muted">{message.role === 'user' ? '你' : message.role === 'system' ? '提交结果' : '画板助手'}</p><p className="whitespace-pre-wrap text-tavern-text-soft">{message.content}</p>
          </div>)}
          {state.tasks.at(-1) && <p className="text-[10px]">{state.tasks.at(-1)?.model ?? '当前聊天模型'} · 输入 {state.tasks.at(-1)?.inputTokens ?? '—'} / 输出 {state.tasks.at(-1)?.outputTokens ?? '—'} tokens</p>}
        </div>
      </details>}
    </div>
    <footer className="shrink-0 space-y-2 border-t border-tavern-border-soft p-3">
      {state?.tasks.some(task => task.state === 'queued') && <p className="text-[10px] text-tavern-text-muted">剧情提取已排队 · 可先发送画板指令</p>}
      {running ? <div className="flex items-center justify-between text-xs text-tavern-text-muted"><span className="flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" />正在处理画板请求…</span><button type="button" onClick={() => { const scope = scopeRef.current; void api.cancel().then(next => { if (scopeRef.current === scope) setState(next) }).catch(cause => { if (scopeRef.current === scope) setError(String(cause)) }) }} className="text-tavern-accent">停止</button></div> : null}
      <textarea aria-label="画板助手输入" value={text} onChange={event => setText(event.target.value)} maxLength={12000} rows={2} placeholder={sources?.canInitialize ? '可选：补充故事发生的地点和人物起点' : bound ? '例如：把角色移到厨房' : '可补充场景说明，然后生成草稿'} className="w-full resize-none rounded-lg border border-tavern-border bg-tavern-bg px-3 py-2 text-xs text-tavern-text outline-none focus:border-tavern-accent" />
      <div className="flex items-center gap-2 text-xs">
        {sources?.canInitialize ? <button type="button" disabled={active || pending.some(proposal => proposal.mode === 'initialize')} onClick={() => { void ask('initialize') }} className="rounded-lg bg-tavern-accent px-3 py-2 font-medium text-white disabled:opacity-40">生成场景</button> : <button type="button" disabled={active || !bound || !!previewId} onClick={() => { void ask('positions') }} className="rounded-lg border border-tavern-border px-3 py-2 text-tavern-text-soft disabled:opacity-40">建议人物起点</button>}
        {bound && !sources?.canInitialize && <button type="button" disabled={active || !text.trim() || !!previewId} onClick={() => { void ask('instruction') }} className="ml-auto flex items-center gap-1 rounded-lg bg-tavern-accent px-3 py-2 font-medium text-white disabled:opacity-40"><Send className="h-3 w-3" />发送</button>}
      </div>
    </footer>
  </aside>
}
