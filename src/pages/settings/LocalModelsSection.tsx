import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArchiveRestore, Box, CheckCircle2, Download, HardDrive, Loader2, Pause, Play, ShieldCheck, Trash2, Upload } from 'lucide-react'
import type { LocalModelCatalogItem, InstalledLocalModel, LocalModelStorageUsage, LocalModelTaskSnapshot, LocalModelUninstallImpact } from '../../../shared/localModels'
import type { Settings } from '../../../shared/types'
import { SectionCard } from '../../components/common/SettingsShared'
import { whenIdle } from '../../lib/localModelUpdates'
import { cn } from '../../lib/utils'

interface Props {
  settings: Settings
  updateSettings: (partial: Partial<Settings>) => void
  /** 由“语义检索”统一设置承载时，不再渲染第二层 SectionCard。 */
  embedded?: boolean
}

function LocalModelsShell({ embedded, children }: { embedded: boolean; children: React.ReactNode }) {
  if (embedded) return <>{children}</>
  return <SectionCard title="本地向量模型" icon={<Box className="w-4 h-4" />} storageKey="local-models">{children}</SectionCard>
}

const terminalStates = new Set(['ready', 'not_installed', 'failed', 'corrupted', 'incompatible', 'uninstall_pending'])

function bytes(value = 0): string {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function stateLabel(state: string): string {
  return ({
    not_installed: '未安装', queued: '排队中', downloading: '下载中', paused: '已暂停', verifying: '校验中', installing: '安装中', testing: '自检中',
    ready: '已就绪', update_available: '有更新', in_use: '当前默认', uninstalling: '卸载中', uninstall_pending: '等待重试卸载', failed: '失败', corrupted: '安全校验失败', incompatible: '不兼容',
  } as Record<string, string>)[state] ?? state
}

function taskLabel(task: LocalModelTaskSnapshot): string {
  if (task.kind === 'index') {
    return ({ installing: '索引中', queued: '索引排队', paused: '索引已暂停', ready: '索引完成', failed: '索引失败' } as Record<string, string>)[task.state] ?? stateLabel(task.state)
  }
  return stateLabel(task.state)
}

export function LocalModelsSection({ settings, updateSettings, embedded = false }: Props) {
  const [catalog, setCatalog] = useState<LocalModelCatalogItem[]>([])
  const [installed, setInstalled] = useState<InstalledLocalModel[]>([])
  const [tasks, setTasks] = useState<LocalModelTaskSnapshot[]>([])
  const [usage, setUsage] = useState<LocalModelStorageUsage>({ modelBytes: 0, indexBytes: 0, stagingBytes: 0, totalBytes: 0 })
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [uninstalling, setUninstalling] = useState<InstalledLocalModel | null>(null)
  const [installingCandidate, setInstallingCandidate] = useState<LocalModelCatalogItem | null>(null)
  const [removeIndexes, setRemoveIndexes] = useState(true)
  const [uninstallImpact, setUninstallImpact] = useState<LocalModelUninstallImpact | null>(null)
  const preferences = settings.localModels ?? { retrievalMode: 'auto' as const, autoIndex: true, updatePolicy: 'notify' as const, idleOnly: true, batchSize: 8 }
  const updatePreferences = (patch: Partial<typeof preferences>) => updateSettings({ localModels: { ...preferences, ...patch } })

  const refresh = useCallback(async () => {
    const [nextCatalog, nextInstalled, nextTasks, nextUsage] = await Promise.all([
      window.api.localModel.catalog(), window.api.localModel.installed(), window.api.localModel.tasks(), window.api.localModel.storageUsage(),
    ])
    setCatalog(nextCatalog); setInstalled(nextInstalled); setTasks(nextTasks); setUsage(nextUsage)
  }, [])

  useEffect(() => {
    void refresh().catch((error) => setMessage({ ok: false, text: error instanceof Error ? error.message : '读取本地模型失败' }))
    return window.api.localModel.onProgress(({ task }) => {
      setTasks((current) => [task, ...current.filter((item) => item.taskId !== task.taskId)])
      if (terminalStates.has(task.state)) void refresh()
    })
  }, [refresh])

  const cards = useMemo(() => {
    const map = new Map(catalog.map((item) => [`${item.manifest.id}@${item.manifest.version}`, item]))
    for (const item of installed) {
      const key = `${item.manifest.id}@${item.manifest.version}`
      if (!map.has(key)) map.set(key, { manifest: item.manifest, state: item.state, active: item.active, installedVersion: item.manifest.version })
    }
    return [...map.values()]
  }, [catalog, installed])

  const act = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key); setMessage(null)
    try { await fn(); setMessage({ ok: true, text: success }); await refresh() }
    catch (error) { setMessage({ ok: false, text: error instanceof Error ? error.message : '操作失败' }) }
    finally { setBusy(null) }
  }

  const activate = (item: LocalModelCatalogItem) => act(`activate:${item.manifest.id}`, async () => {
    const result = await window.api.localModel.activate(item.manifest.id, item.manifest.version)
    if (!result.ok) throw new Error(result.error ?? '启用失败')
    updateSettings({
      semanticTrigger: {
        ...(settings.semanticTrigger ?? { enabled: true, threshold: 0.3, maxResults: 3, provider: 'local', baseUrl: '', apiKey: '', model: '' }),
        enabled: true, provider: 'local', baseUrl: '', apiKey: '', profileId: null,
        model: `${item.manifest.id}@${item.manifest.version}`,
      },
      localModels: {
        ...preferences,
        retrievalMode: preferences.retrievalMode === 'auto' ? 'auto' : 'local',
      },
    })
    if (preferences.autoIndex) {
      const rebuild = () => { void window.api.localModel.rebuildIndexes() }
      if (preferences.idleOnly) whenIdle(rebuild)
      else rebuild()
    }
  }, '已设为默认本地模型；尚未生成的世界书索引会继续使用词法检索。')

  const prepareUninstall = async (record: InstalledLocalModel) => {
    setBusy(`impact:${record.manifest.id}`)
    try {
      setUninstallImpact(await window.api.localModel.uninstallImpact(record.manifest.id, record.manifest.version))
      setRemoveIndexes(true)
      setUninstalling(record)
    } catch (error) { setMessage({ ok: false, text: error instanceof Error ? error.message : '无法计算卸载影响' }) }
    finally { setBusy(null) }
  }

  const confirmUninstall = () => {
    const target = uninstalling
    const wasActive = !!uninstallImpact?.active
    if (!target) return
    setUninstalling(null)
    void act(`uninstall:${target.manifest.id}`, async () => {
      await window.api.localModel.uninstall({ modelId: target.manifest.id, version: target.manifest.version, removeIndexes })
      // 卸载的是默认模型时，同步停用指向它的语义触发配置，避免设置页残留失效模型
      if (wasActive) {
        const trigger = settings.semanticTrigger
        if (trigger?.enabled && trigger.provider === 'local' && trigger.model?.startsWith(`${target.manifest.id}@`)) {
          updateSettings({
            semanticTrigger: { ...trigger, enabled: false },
            localModels: {
              ...preferences,
              retrievalMode: preferences.retrievalMode === 'local' ? 'auto' : preferences.retrievalMode,
            },
          })
        }
      }
    }, wasActive ? '卸载任务已创建；聊天自动回退到关键词与词法检索。' : '卸载任务已创建。')
  }

  return (
    <LocalModelsShell embedded={embedded}>
      <div className="mt-3 space-y-4">
        <div className="rounded-lg border border-tavern-border-soft bg-tavern-bg-hover/60 p-3 text-xs text-tavern-text-muted space-y-1">
          <p className="flex items-center gap-1.5 text-tavern-text"><ShieldCheck className="w-4 h-4 text-tavern-success" />模型只在本机 CPU worker 中运行，聊天 API 不需要支持 embeddings。</p>
          <p>未安装、模型异常或索引未完成时，聊天自动使用关键词与 BM25，不会等待模型下载或建库。</p>
          <div className="space-y-1"><p><HardDrive className="inline w-3.5 h-3.5 mr-1" />模型 {bytes(usage.modelBytes)} · 索引 {bytes(usage.indexBytes)} · 临时文件 {bytes(usage.stagingBytes)}</p>{usage.modelRoot && <p className="break-all">模型位置：{usage.modelRoot}</p>}{usage.indexRoot && <p className="break-all">索引位置：{usage.indexRoot}</p>}</div>
        </div>

        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <label>模型更新<select className="input text-sm mt-1" value={preferences.updatePolicy} onChange={(event) => updatePreferences({ updatePolicy: event.target.value as typeof preferences.updatePolicy })}><option value="notify">仅提醒（推荐）</option><option value="download">自动下载但不切换</option><option value="auto">自动更新</option></select></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={preferences.autoIndex} onChange={(event) => updatePreferences({ autoIndex: event.target.checked })} />后台自动建立索引</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={preferences.idleOnly} onChange={(event) => updatePreferences({ idleOnly: event.target.checked })} />仅空闲时运行后台索引</label>
        </div>

        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" disabled={busy !== null} onClick={() => act('import', async () => { await window.api.localModel.importPackage() }, '离线包任务已创建，可关闭此页面继续执行。')}>
            {busy === 'import' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}导入 .qymodel
          </button>
          <button className="btn-secondary" disabled={busy !== null} onClick={() => act('cleanup', async () => { const result = await window.api.localModel.cleanup(); if (!result.ok) throw new Error(result.error); return result }, '无效临时文件已清理。')}>
            <Trash2 className="w-4 h-4" />清理临时文件
          </button>
          <button className="btn-secondary" disabled={busy !== null || !installed.some((item) => item.active)} onClick={() => act('index', () => window.api.localModel.rebuildIndexes(), '后台索引任务已创建。')}>
            <HardDrive className="w-4 h-4" />重建全部索引
          </button>
        </div>

        {cards.length === 0 && (
          <div className="rounded-lg border border-dashed border-tavern-border p-4 text-sm text-tavern-text-muted">
            官方在线目录当前没有已通过许可证与召回评测的模型包。可导入由轻语发布密钥签名的 <code>.qymodel</code>；不会接受任意 ONNX 文件。
          </div>
        )}

        {cards.map((item) => {
          const m = item.manifest
          const task = tasks.find((candidate) => candidate.modelId === m.id && candidate.version === m.version && (!terminalStates.has(candidate.state) || candidate.resumable)) ?? item.task
          const installedRecord = installed.find((candidate) => candidate.manifest.id === m.id && candidate.manifest.version === m.version)
          const state = task?.state ?? item.state
          const resumableFailure = state === 'failed' && task?.resumable
          const progress = task?.totalBytes ? Math.min(100, Math.round(task.downloadedBytes / task.totalBytes * 100)) : 0
          return <article key={`${m.id}@${m.version}`} className="rounded-lg border border-tavern-border-soft p-3 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div><h3 className="font-medium text-sm">{m.displayName}</h3><p className="text-xs text-tavern-text-muted mt-1">{m.description}</p></div>
              <span className={cn('text-xs rounded-full px-2 py-0.5', item.active ? 'bg-tavern-accent-soft text-tavern-accent' : 'bg-tavern-bg-hover text-tavern-text-muted')}>
                {stateLabel(state)}{state === 'in_use' && item.updateAvailable ? ' · 有更新' : ''}
              </span>
            </div>
            <div className="grid sm:grid-cols-2 gap-1 text-xs text-tavern-text-muted">
              <span>{m.languages.join(' / ')} · {m.dtype.toUpperCase()} · {m.dimensions} 维</span>
              <span>安装 {bytes(m.installedSize)} · 建议内存 {m.recommendedMemoryMb} MB</span>
              <span>许可证：<a className="text-tavern-accent hover:underline" href={m.license.url}>{m.license.name}</a></span>
              <span>版本 {m.version} · {m.architecture}</span>
            </div>
            {task && <div><div className="h-1.5 rounded bg-tavern-bg-hover overflow-hidden"><div className="h-full bg-tavern-accent" style={{ width: `${progress}%` }} /></div><p className="text-xs text-tavern-text-muted mt-1">{bytes(task.downloadedBytes)} / {bytes(task.totalBytes)} {task.speedBytesPerSecond ? `· ${bytes(task.speedBytesPerSecond)}/s` : ''}</p></div>}
            {item.error && <p className="text-xs text-tavern-danger">{item.error}</p>}
            <div className="flex flex-wrap gap-2">
              {state === 'not_installed' && <button className="btn-secondary" onClick={() => setInstallingCandidate(item)}><Download className="w-4 h-4" />安装</button>}
              {resumableFailure && <button className="btn-secondary" onClick={() => void act(`resume:${task.taskId}`, () => window.api.localModel.resume(task.taskId), '已从断点继续下载。')}><Play className="w-4 h-4" />继续下载</button>}
              {['failed', 'corrupted', 'incompatible'].includes(state) && !resumableFailure && !installedRecord && <button className="btn-secondary" onClick={() => setInstallingCandidate(item)}><Download className="w-4 h-4" />重新安装</button>}
              {task && (task.kind === 'index' ? ['queued', 'installing'].includes(state) : state === 'downloading') && <button className="btn-secondary" onClick={() => void window.api.localModel.pause(task.taskId)}><Pause className="w-4 h-4" />暂停</button>}
              {state === 'paused' && task && <button className="btn-secondary" onClick={() => void window.api.localModel.resume(task.taskId)}><Play className="w-4 h-4" />继续</button>}
              {task && (task.kind === 'index' ? ['queued', 'installing', 'paused'].includes(state) : ['downloading', 'paused', 'queued'].includes(state) || resumableFailure) && <button className="btn-secondary text-tavern-danger" onClick={() => void window.api.localModel.cancel(task.taskId)}>{resumableFailure ? '放弃任务' : '取消任务'}</button>}
              {['ready', 'in_use', 'update_available'].includes(state) && <button className="btn-secondary" onClick={() => activate(item)} disabled={item.active}><CheckCircle2 className="w-4 h-4" />{item.active ? '当前默认' : '测试并设为默认'}</button>}
              {installedRecord && ['ready', 'in_use', 'update_available', 'failed', 'corrupted', 'incompatible', 'uninstall_pending'].includes(state) && <button className="btn-secondary text-tavern-danger" onClick={() => void prepareUninstall(installedRecord)}><Trash2 className="w-4 h-4" />卸载</button>}
              {item.active && <button className="btn-secondary" onClick={() => act(`rollback:${m.id}`, async () => { const result = await window.api.localModel.rollback(m.id); if (!result.ok) throw new Error(result.error) }, '已回滚到上一个可用版本。')}><ArchiveRestore className="w-4 h-4" />回滚</button>}
            </div>
          </article>
        })}

        {tasks.length > 0 && <div className="border-t border-tavern-border-soft pt-3"><h3 className="text-sm font-medium mb-2">后台任务</h3><div className="space-y-1">{tasks.slice(0, 8).map((task) => <div key={task.taskId} className="flex items-center justify-between text-xs"><span>{task.modelId}@{task.version} · {taskLabel(task)}</span><span className={task.error ? 'text-tavern-danger' : 'text-tavern-text-muted'}>{task.error ?? (task.kind === 'index' ? `${task.downloadedBytes} / ${task.totalBytes} 本` : `${bytes(task.downloadedBytes)} / ${bytes(task.totalBytes)}`)}</span></div>)}</div></div>}
        {message && <p className={cn('text-xs', message.ok ? 'text-tavern-success' : 'text-tavern-danger')}>{message.text}</p>}
      </div>

      {uninstalling && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="卸载本地模型">
        <div className="card max-w-md w-full p-5 space-y-4">
          <div><h3 className="font-semibold">卸载“{uninstalling.manifest.displayName} {uninstalling.manifest.version}”？</h3><p className="text-sm text-tavern-text-muted mt-2">{uninstallImpact?.active ? '它当前是默认模型。' : ''}卸载后聊天仍可正常使用，并自动回退到关键词和本地词法检索。世界书正文不会被删除。</p></div>
          {uninstallImpact && <div className="rounded-lg bg-tavern-bg-hover p-3 text-sm space-y-1"><p>{uninstallImpact.lorebookCount} 本世界书 · {uninstallImpact.entryCount} 条向量</p><p>模型 {bytes(uninstallImpact.modelBytes)} · 相关索引 {bytes(uninstallImpact.indexBytes)}</p></div>}
          <label className="flex gap-2 text-sm"><input type="radio" checked={removeIndexes} onChange={() => setRemoveIndexes(true)} />删除模型和该版本索引，释放更多空间（推荐）</label>
          <label className="flex gap-2 text-sm"><input type="radio" checked={!removeIndexes} onChange={() => setRemoveIndexes(false)} />仅删除模型，保留索引供相同版本重装后复用</label>
          <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setUninstalling(null)}>取消</button><button className="btn-primary" onClick={confirmUninstall}>卸载</button></div>
        </div>
      </div>}
      {installingCandidate && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="安装本地模型">
        <div className="card max-w-md w-full p-5 space-y-4">
          <div><h3 className="font-semibold">安装“{installingCandidate.manifest.displayName}”？</h3><p className="text-sm text-tavern-text-muted mt-2">模型会下载到{usage.modelRoot ? ` ${usage.modelRoot}` : '轻语模型目录'}，只在本机 CPU worker 中运行。下载 {bytes(installingCandidate.manifest.files.reduce((sum, file) => sum + file.size, 0))}，安装后约 {bytes(installingCandidate.manifest.installedSize)}，建议内存 {installingCandidate.manifest.recommendedMemoryMb} MB。</p></div>
          <div className="text-sm"><p>用途：{installingCandidate.manifest.description}</p><p>语言：{installingCandidate.manifest.languages.join(' / ')}</p><p>许可证：{installingCandidate.manifest.license.name}</p></div>
          <p className="text-xs text-tavern-text-muted">文件会先进入 staging，逐项通过 Ed25519 清单签名、大小与 SHA-256 校验后再原子安装和自检。</p>
          <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setInstallingCandidate(null)}>取消</button><button className="btn-primary" onClick={() => { const target = installingCandidate; setInstallingCandidate(null); void act(`install:${target.manifest.id}`, () => window.api.localModel.install(target.manifest.id, target.manifest.version), '下载任务已创建，可关闭此页面继续执行。') }}>确认安装</button></div>
        </div>
      </div>}
    </LocalModelsShell>
  )
}
