import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Compass, Loader2 } from 'lucide-react'
import { SpatialAiPanel } from './SpatialAiPanel'
import type { SpatialAiProposal } from '../../../shared/spatial-ai'
import type { SpatialRuntimeStateV1, SpatialWorldDocumentV1 } from '@qingyu/spatial-core'
import { useGroupChatStore } from '../../store/useGroupChatStore'
import { useChatStore } from '../../store/useChatStore'
import { useCharacterStore } from '../../store/useCharacterStore'
import { usePersonaStore } from '../../store/usePersonaStore'
import { charAssetUrl } from '../../utils/asset'
import { Toggle } from '../common/SettingsShared'
import { registerSpatialFlush } from '../../lib/spatialFlush'
import type { SpatialEditorCommit, SpatialSnapshot, SpatialVersion } from '../../../shared/spatial'

type SpatialPackage = { world: SpatialWorldDocumentV1; runtime: SpatialRuntimeStateV1; version: SpatialVersion; activeActorIds?: string[] }
type SpatialBoardPaneProps = ({ characterId: string; groupId?: never } | { groupId: string; characterId?: never }) & {
  sessionId: string
  onClose: () => void
  registerClose: (handler: () => void) => void
  openAssistant?: boolean
}

export function SpatialBoardPane({ characterId, groupId, sessionId, onClose, registerClose, openAssistant = false }: SpatialBoardPaneProps) {
  const singleEnabled = useChatStore(state => state.sessions.find(session => session.id === sessionId && session.characterId === characterId)?.spatialBoardEnabled === true)
  const groupEnabled = useGroupChatStore(state => state.currentGroup?.id === groupId && state.sessions.find(session => session.id === sessionId)?.spatialBoardEnabled === true)
  const spatialEnabled = groupId ? groupEnabled : singleEnabled
  const [toggling, setToggling] = useState(false)
  const boardApi = useMemo(() => ({
    load: () => groupId ? window.api.spatial.loadGroupBound(groupId, sessionId) : window.api.spatial.loadBound(characterId!, sessionId),
    enable: (enabled: boolean) => groupId ? window.api.spatial.setGroupEnabled(groupId, sessionId, enabled) : window.api.spatial.setEnabled(characterId!, sessionId, enabled),
    ai: () => groupId ? window.api.spatial.getGroupAiSession(groupId, sessionId) : window.api.spatial.getAiSession(characterId!, sessionId),
    edit: (id: string, input: SpatialEditorCommit) => groupId ? window.api.spatial.editGroupDraft(groupId, sessionId, id, input) : window.api.spatial.editDraft(characterId!, sessionId, id, input),
    apply: (input: SpatialEditorCommit) => groupId ? window.api.spatial.applyGroupEditorBatch(groupId, sessionId, input) : window.api.spatial.applyEditorBatch(characterId!, sessionId, input),
  }), [characterId, groupId, sessionId])
  const patchBinding = useCallback((snapshot: SpatialSnapshot) => {
    const updates = { spatialWorldId: snapshot.version.worldId, spatialRuntimeId: snapshot.version.runtimeId }
    if (groupId) useGroupChatStore.setState(state => state.currentGroup?.id === groupId
      ? { sessions: state.sessions.map(session => session.id === sessionId ? { ...session, ...updates } : session) } : {})
    else useChatStore.getState().patchLocalSession(sessionId, updates)
  }, [groupId, sessionId])
  const [pkg, setPackage] = useState<SpatialPackage | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [assistantOpen, setAssistantOpen] = useState(openAssistant)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [bound, setBound] = useState(false)
  const previewRef = useRef<string | null>(null)
  const characters = useCharacterStore((s) => s.characters)
  const personas = usePersonaStore((s) => s.personas)
  const actorAvatarUrls = useMemo(() => Object.fromEntries(
    (pkg?.world.actors ?? []).flatMap((actor) => {
      if (actor.externalRef.type === 'qingyu-character') {
        const character = characters.find((item) => item.id === actor.externalRef.id)
        return [[actor.id, character?.avatar || charAssetUrl(actor.externalRef.id, 'avatar', character?.updatedAt)]]
      }
      if (actor.externalRef.type === 'qingyu-persona') {
        return [[actor.id, personas.find((item) => item.id === actor.externalRef.id)?.avatar || '']]
      }
      return []
    }),
  ), [pkg, characters, personas])
  const avatarUrlsRef = useRef(actorAvatarUrls)
  avatarUrlsRef.current = actorAvatarUrls
  const frameRef = useRef<HTMLIFrameElement>(null)
  const latestRef = useRef<SpatialPackage | null>(null)
  const savesRef = useRef<Promise<void>>(Promise.resolve())
  const submittingRef = useRef(new Set<string>())
  const generationRef = useRef(0)
  const refreshRef = useRef(0)
  const flushRef = useRef(new Map<string, { resolve: () => void; reject: (cause: Error) => void; timer: ReturnType<typeof setTimeout> }>())

  const currentTheme = useCallback(() => {
    const root = document.documentElement
    const style = getComputedStyle(root)
    return {
      theme: root.classList.contains('dark') ? 'dark' : 'light',
      palette: {
        accent: style.getPropertyValue('--color-accent').trim(),
        accentHover: style.getPropertyValue('--color-accent-hover').trim(),
        accentSoft: style.getPropertyValue('--color-accent-soft').trim(),
      },
    }
  }, [])

  const postInit = useCallback((current: SpatialPackage) => {
    const latest = latestRef.current ?? current
    frameRef.current?.contentWindow?.postMessage({
      type: 'qingyu:spatial:init',
      world: latest.world,
      runtime: latest.runtime,
      version: latest.version,
      actorAvatarUrls: avatarUrlsRef.current,
      assistantEnabled: true,
      activeActorIds: latest.activeActorIds,
      ...currentTheme(),
    }, '*')
  }, [currentTheme])

  useEffect(() => {
    if (!pkg) return
    frameRef.current?.contentWindow?.postMessage({ type: 'qingyu:spatial:avatars', actorAvatarUrls }, '*')
  }, [pkg, actorAvatarUrls])

  useEffect(() => {
    if (!pkg) return
    const observer = new MutationObserver(() => {
      frameRef.current?.contentWindow?.postMessage({ type: 'qingyu:spatial:theme', ...currentTheme() }, '*')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [pkg, currentTheme])

  useEffect(() => {
    let active = true
    generationRef.current += 1
    latestRef.current = null
    previewRef.current = null
    setPreviewId(null); setBound(false)
    setPackage(null)
    setLoading(spatialEnabled)
    setError(null)
    if (!spatialEnabled) setAssistantOpen(false)
    else void (async () => {
      try {
        const bound = await boardApi.load() ?? await boardApi.enable(true)
        if (!active) return
        if (bound) {
          setBound(true)
          latestRef.current = bound as SpatialPackage
          setPackage(bound as SpatialPackage)
          patchBinding(bound)
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (active) setLoading(false)
      }
    })()
    const flushes = flushRef.current
    return () => {
      active = false
      generationRef.current += 1
      for (const waiter of flushes.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('画板会话已关闭')) }
      flushes.clear()
    }
  }, [boardApi, spatialEnabled, patchBinding])

  const flush = useCallback(() => {
    if (!latestRef.current || !frameRef.current?.contentWindow) return savesRef.current
    const requestId = crypto.randomUUID()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { flushRef.current.delete(requestId); reject(new Error('画板保存确认超时，请重试')) }, 30000)
      flushRef.current.set(requestId, { resolve, reject, timer })
      frameRef.current?.contentWindow?.postMessage({ type: 'qingyu:spatial:flush', requestId }, '*')
    })
  }, [])

  const requestClose = useCallback(() => {
    void flush().then(onClose).catch((cause) => {
      setError('画板保存失败，请重试：' + (cause instanceof Error ? cause.message : String(cause)))
    })
  }, [flush, onClose])

  const toggleSpatial = useCallback(async (enabled: boolean) => {
    if (toggling || working) {
      frameRef.current?.contentWindow?.postMessage({ type: 'qingyu:spatial:feature-toggle-result' }, '*')
      return
    }
    setToggling(true); setError(null)
    try {
      // 先等待画布命令落盘，再停用编辑器和剧情任务。
      await flush()
      const snapshot = await boardApi.enable(enabled)
      if (groupId) useGroupChatStore.setState(state => state.currentGroup?.id === groupId
        ? { sessions: state.sessions.map(session => session.id === sessionId ? { ...session, spatialBoardEnabled: enabled,
          spatialContextEnabled: session.spatialContextEnabled ?? true, spatialNarrativeSyncPolicy: session.spatialNarrativeSyncPolicy ?? 'suggest' } : session) } : {})
      else useChatStore.setState(state => ({ sessions: state.sessions.map(session => session.id === sessionId && session.characterId === characterId
        ? { ...session, spatialBoardEnabled: enabled, spatialContextEnabled: session.spatialContextEnabled ?? true,
          spatialNarrativeSyncPolicy: session.spatialNarrativeSyncPolicy ?? 'suggest' } : session) }))
      if (snapshot) patchBinding(snapshot)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setToggling(false)
      frameRef.current?.contentWindow?.postMessage({ type: 'qingyu:spatial:feature-toggle-result' }, '*')
    }
  }, [flush, boardApi, characterId, groupId, sessionId, patchBinding, toggling, working])

  useEffect(() => registerSpatialFlush(async () => {
    try { await flush() } catch (cause) {
      setError('画板保存失败，请重试：' + (cause instanceof Error ? cause.message : String(cause)))
      throw cause
    }
  }), [flush])

  useEffect(() => { registerClose(requestClose) }, [registerClose, requestClose])

  useEffect(() => {
    if (!pkg) return
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      const sameOrigin = window.location.protocol === 'file:'
        ? event.origin === 'null' || event.origin === 'file://'
        : event.origin === window.location.origin
      if (!sameOrigin) return
      const data = event.data
      if (data?.type === 'qingyu:spatial:ready') {
        postInit(pkg)
      } else if (data?.type === 'qingyu:spatial:commands') {
        const input = data.request as SpatialEditorCommit
        if (!input || typeof input.commitId !== 'string') return
        const generation = generationRef.current
        submittingRef.current.add(input.commitId)
        const save = savesRef.current.catch(() => {}).then(async () => {
          try {
            const draftId = previewRef.current
            const result = draftId
              ? await boardApi.edit(draftId, input)
              : await boardApi.apply(input)
            if (generation !== generationRef.current) return
            if (result.ok) {
              latestRef.current = result.snapshot as SpatialPackage
              setPackage(result.snapshot as SpatialPackage)
            } else setError(result.message)
            frameRef.current?.contentWindow?.postMessage({ type: 'qingyu:spatial:commit-result', commitId: input.commitId, result }, '*')
          } catch (cause) {
            if (generation !== generationRef.current) return
            const message = '画板保存失败：' + (cause instanceof Error ? cause.message : String(cause))
            setError(message)
            frameRef.current?.contentWindow?.postMessage({ type: 'qingyu:spatial:commit-result', commitId: input.commitId,
              result: { ok: false, message } }, '*')
          } finally {
            submittingRef.current.delete(input.commitId)
          }
        })
        savesRef.current = save
      } else if (data?.type === 'qingyu:spatial:pending') {
        setError(typeof data.error === 'string' ? data.error : null)
      } else if (data?.type === 'qingyu:spatial:flushed' || data?.type === 'qingyu:spatial:flush-error') {
        const waiter = flushRef.current.get(data.requestId)
        if (!waiter) return
        clearTimeout(waiter.timer)
        flushRef.current.delete(data.requestId)
        if (data.type === 'qingyu:spatial:flushed') waiter.resolve()
        else waiter.reject(new Error(data.message || '存在尚未确认的画板操作'))
      } else if (data?.type === 'qingyu:spatial:error') {
        setError(data.message)
      } else if (data?.type === 'qingyu:spatial:save') {
        setError('画板保存协议已更新，请重新打开画板')
      } else if (data?.type === 'qingyu:spatial:close') {
        requestClose()
      } else if (data?.type === 'qingyu:spatial:set-enabled' && typeof data.enabled === 'boolean') {
        void toggleSpatial(data.enabled)
      } else if (data?.type === 'qingyu:spatial:assistant') {
        setAssistantOpen(open => !open)
      }
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [pkg, characterId, groupId, sessionId, postInit, requestClose, boardApi, toggleSpatial])

  useEffect(() => {
    if (!spatialEnabled) return
    const generation = generationRef.current
    return window.api.spatial.onUpdated((event) => {
      const ownScope = (groupId ? event.kind === 'group' && event.groupId === groupId : event.characterId === characterId && event.kind !== 'group') && event.sessionId === sessionId
      if ((!ownScope && event.worldId !== latestRef.current?.version.worldId) || submittingRef.current.has(event.commitId)) return
      if (previewRef.current) { setError('正式地图有更新；草稿仍保留，确认时将重新核对版本'); return }
      const refresh = ++refreshRef.current
      void boardApi.load().then((snapshot) => {
        if (generation !== generationRef.current || refresh !== refreshRef.current || !snapshot) return
        latestRef.current = snapshot as SpatialPackage
        setPackage(snapshot as SpatialPackage)
        setBound(true)
        patchBinding(snapshot)
        frameRef.current?.contentWindow?.postMessage({ type: 'qingyu:spatial:external', snapshot }, '*')
      }).catch((cause) => {
        if (generation === generationRef.current) setError('画板同步失败：' + String(cause))
      })
    })
  }, [spatialEnabled, characterId, groupId, sessionId, boardApi, patchBinding])

  const reload = async () => {
    if (!window.confirm('将放弃尚未提交的本地修改并载入最新画板，是否继续？')) return
    setWorking(true)
    frameRef.current?.contentWindow?.postMessage({ type: 'qingyu:spatial:pause' }, '*')
    try {
      await savesRef.current
      const snapshot: SpatialSnapshot | null = previewRef.current
        ? (await boardApi.ai()).proposals.find(proposal => proposal.id === previewRef.current)?.preview ?? null
        : await boardApi.load()
      if (!snapshot) throw new Error('当前会话没有绑定画板')
      latestRef.current = snapshot as SpatialPackage
      setPackage(snapshot as SpatialPackage)
      frameRef.current?.contentWindow?.postMessage({ type: 'qingyu:spatial:reload', snapshot }, '*')
      setError(null)
    } catch (cause) {
      setError('载入失败：' + String(cause))
    } finally { setWorking(false) }
  }

  const showPreview = (proposal: SpatialAiProposal) => {
    const generation = generationRef.current
    void boardApi.ai().then(state => {
      const latest = state.proposals.find(item => item.id === proposal.id)
      if (generation !== generationRef.current || latest?.status !== 'pending' || !latest.preview) return
      previewRef.current = proposal.id; setPreviewId(proposal.id)
      latestRef.current = latest.preview as SpatialPackage; setPackage(latest.preview as SpatialPackage); setError(null)
    }).catch(cause => setError(String(cause)))
  }
  const applied = (snapshot: SpatialSnapshot) => {
    previewRef.current = null; setPreviewId(null); setBound(true); setError(null)
    latestRef.current = snapshot as SpatialPackage; setPackage(snapshot as SpatialPackage)
    patchBinding(snapshot)
    frameRef.current?.contentWindow?.postMessage({ type: 'qingyu:spatial:reload', snapshot }, '*')
  }
  const discarded = async (id: string) => {
    if (previewRef.current !== id) return
    const generation = generationRef.current
    const snapshot = await boardApi.load()
    if (generation !== generationRef.current) return
    previewRef.current = null; setPreviewId(null); setError(null)
    latestRef.current = snapshot as SpatialPackage | null; setPackage(snapshot as SpatialPackage | null)
  }

  return (
    <section className="relative z-10 flex min-h-0 flex-1 flex-col bg-tavern-bg" aria-label="空间画板">
      {spatialEnabled && <SpatialAiPanel groupId={groupId} characterId={characterId} sessionId={sessionId} open={assistantOpen} bound={bound} previewId={previewId} onClose={() => setAssistantOpen(false)} flush={flush} onPreview={showPreview} onApplied={applied} onDiscard={discarded} />}
      {(!spatialEnabled || !pkg) && <div className="flex h-10 shrink-0 items-center gap-2 border-b border-tavern-border-soft bg-tavern-bg-card/95 px-3">
        <button type="button" onClick={requestClose} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-tavern-text-soft transition-colors hover:bg-tavern-bg-hover hover:text-tavern-text">
          <ArrowLeft className="h-4 w-4" />返回对话
        </button>
        <span className="h-4 w-px bg-tavern-border-soft" aria-hidden="true" />
        <span className="text-xs font-medium text-tavern-text">空间画板</span>
        <div className="ml-auto flex items-center gap-2" title="仅控制当前会话的画布、位置读取与剧情同步">
          <span className="text-xs text-tavern-text-soft">启用空间画布</span>
          <Toggle label="启用空间画布" checked={spatialEnabled} disabled={toggling || working || loading} onChange={enabled => { void toggleSpatial(enabled) }} />
        </div>
      </div>}

      {error && <div role="alert" className="shrink-0 border-b border-tavern-danger/20 bg-tavern-danger/10 px-4 py-2 text-xs text-tavern-danger">
        {error}
        {pkg && <span className="ml-3 inline-flex gap-3">
          <button type="button" disabled={working} className="underline" onClick={() => frameRef.current?.contentWindow?.postMessage({ type: 'qingyu:spatial:retry' }, '*')}>重试保存</button>
          <button type="button" disabled={working} className="underline" onClick={() => { void reload() }}>载入最新画板</button>
        </span>}
      </div>}

      {!spatialEnabled ? (
        <div role="status" className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
          <Compass className="h-8 w-8 text-tavern-text-muted" />
          <p className="text-sm font-medium text-tavern-text">空间画布已关闭</p>
          <p className="max-w-sm text-xs leading-relaxed text-tavern-text-muted">默认关闭。开启后自动为当前会话创建画板，不影响其他对话；关闭后保留已有画板。</p>
        </div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-tavern-text-muted"><Loader2 className="h-4 w-4 animate-spin" />正在加载画板…</div>
      ) : pkg ? (
        <>
        {previewId && <div className="absolute left-1/2 top-12 z-10 -translate-x-1/2 rounded-lg border border-tavern-accent/30 bg-tavern-bg-card/95 px-3 py-2 text-xs text-tavern-text-soft shadow-sm">场景草稿 · 可直接修改<button type="button" onClick={() => setAssistantOpen(true)} className="ml-3 text-tavern-accent">核对并确认</button></div>}
        <iframe
          key={`${pkg.version.worldId}:${pkg.version.bindingEpoch}`}
          ref={frameRef}
          title="当前会话空间画板"
          src="./spatial-board/index.html?embedded=1"
          onLoad={() => postInit(pkg)}
          className="min-h-0 w-full flex-1 border-0 bg-tavern-bg"
        />
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <button type="button" disabled={toggling} onClick={() => { void toggleSpatial(true) }} className="rounded-lg bg-tavern-accent px-4 py-2 text-sm text-white">重新加载画板</button>
        </div>
      )}
    </section>
  )
}
