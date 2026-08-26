/** 设置页「软件更新」：固定服务器/GitHub 双源检查，GitHub 负责自动更新。 */
import { useCallback, useEffect, useState } from 'react'
import {
  ArrowUpRight,
  CircleAlert,
  CloudDownload,
  Download,
  Github,
  Loader2,
  RefreshCw,
  RotateCcw,
  Server,
} from 'lucide-react'
import { SectionCard } from '../../components/common/SettingsShared'
import type { UpdateSourceResult, UpdaterState } from '../../../shared/ipc-api'

const GITHUB_RELEASES_URL = 'https://github.com/GUAPIXIA/qingyu/releases'
const QUARK_DOWNLOAD_URL = 'https://pan.quark.cn/s/a9853284d260'

function SourceResult({
  label,
  result,
  checking,
}: {
  label: string
  result?: UpdateSourceResult
  checking: boolean
}) {
  const statusText = checking && !result
    ? '获取中…'
    : result?.status === 'error'
      ? '获取失败'
      : result?.version
        ? `v${result.version}`
        : '暂无结果'
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-tavern-border-soft bg-tavern-bg-soft/55 px-3 py-2">
      <span className="text-xs text-tavern-text-muted">{label}</span>
      <span className={result?.status === 'error' ? 'text-xs text-red-400' : 'text-xs font-medium text-tavern-text'}>
        {statusText}
      </span>
    </div>
  )
}

export function UpdaterSection() {
  const [state, setState] = useState<UpdaterState | null>(null)
  const [busy, setBusy] = useState(false)
  const [currentVersion, setCurrentVersion] = useState('')
  const [linkError, setLinkError] = useState('')

  useEffect(() => {
    window.api.updater.getState().then(setState)
    window.api.app.getVersion().then(setCurrentVersion)
    return window.api.updater.onEvent(setState)
  }, [])

  const handleCheck = useCallback(async () => {
    setBusy(true)
    setLinkError('')
    try {
      setState(await window.api.updater.check())
    } finally {
      setBusy(false)
    }
  }, [])

  const handleDownload = useCallback(async () => {
    setBusy(true)
    setLinkError('')
    try {
      setState(await window.api.updater.download())
    } finally {
      setBusy(false)
    }
  }, [])

  const handleOpenLink = useCallback(async (url: string) => {
    setLinkError('')
    try {
      await window.api.app.openExternal(url)
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : '无法打开下载链接')
    }
  }, [])

  const status = state?.status ?? 'idle'
  const checking = status === 'checking'
  const serverAvailable = state?.server?.status === 'available'
  const githubAvailable = state?.github?.status === 'available'
  const showResults = checking || Boolean(state?.server || state?.github)
  const showManualDownloads = Boolean(state?.hasAvailableUpdate)
    && status !== 'downloading'
    && status !== 'downloaded'
    && (serverAvailable || githubAvailable)

  const action = status === 'downloaded' ? (
    <button
      type="button"
      onClick={() => window.api.updater.install()}
      className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-emerald-500"
    >
      <RotateCcw className="h-4 w-4" aria-hidden />
      重启安装
    </button>
  ) : status === 'downloading' ? (
    <button type="button" disabled className="flex items-center gap-1.5 rounded-lg border border-tavern-border px-3 py-1.5 text-sm opacity-60">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      下载中
    </button>
  ) : githubAvailable ? (
    <button
      type="button"
      onClick={handleDownload}
      disabled={busy}
      className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
      {status === 'error' ? '重试下载' : '下载更新'}
    </button>
  ) : (
    <button
      type="button"
      onClick={handleCheck}
      disabled={busy || checking}
      className="flex items-center gap-1.5 rounded-lg border border-tavern-border px-3 py-1.5 text-sm transition-colors hover:bg-tavern-bg-light disabled:opacity-50"
    >
      {busy || checking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
      {checking ? '检查中' : status === 'idle' ? '检查更新' : '重新检查'}
    </button>
  )

  return (
    <SectionCard title="软件更新" icon={<RefreshCw className="h-4 w-4" />}>
      <div className="mt-3 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm">当前版本 v{currentVersion || '...'}</p>
          {action}
        </div>

        {showResults && (
          <div className="grid gap-2 sm:grid-cols-2" aria-label="更新来源版本">
            <SourceResult label="服务器最新版本" result={state?.server} checking={checking} />
            <SourceResult label="GitHub 最新版本" result={state?.github} checking={checking} />
          </div>
        )}

        {status === 'downloading' && typeof state?.percent === 'number' && (
          <div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-tavern-bg-light">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${state.percent}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-tavern-text-muted">{state.percent}%</p>
          </div>
        )}

        {state?.message && status !== 'checking' && (
          <p className={status === 'error' ? 'text-xs text-red-400' : 'text-xs text-tavern-text-muted'}>
            {state.message}
          </p>
        )}

        {state?.releaseNotes && githubAvailable && (
          <details className="text-xs text-tavern-text-muted">
            <summary className="cursor-pointer select-none">查看 GitHub 更新日志</summary>
            <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words">{state.releaseNotes}</pre>
          </details>
        )}

        {showManualDownloads && (
          <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-soft/65 p-3">
            <div className="mb-2.5">
              <p className="text-sm font-medium text-tavern-text">手动下载安装包</p>
              <p className="mt-0.5 text-xs text-tavern-text-muted">已确认存在新版本，可选择对应发布渠道</p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {serverAvailable && state?.server?.downloadUrl && (
                <button
                  type="button"
                  onClick={() => void handleOpenLink(state.server!.downloadUrl!)}
                  className="group flex min-h-14 items-center gap-2.5 rounded-lg border border-tavern-accent/30 bg-tavern-accent-soft/45 px-3 py-2 text-left transition-colors hover:border-tavern-accent/60 hover:bg-tavern-accent-soft"
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-tavern-accent text-white shadow-sm">
                    <Server className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-tavern-text">服务器下载</span>
                    <span className="block text-[11px] text-tavern-text-muted">v{state.server.version} · 国内线路</span>
                  </span>
                  <ArrowUpRight className="h-3.5 w-3.5 text-tavern-text-muted transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />
                </button>
              )}

              {githubAvailable && (
                <button
                  type="button"
                  onClick={() => void handleOpenLink(GITHUB_RELEASES_URL)}
                  className="group flex min-h-14 items-center gap-2.5 rounded-lg border border-tavern-border bg-tavern-bg px-3 py-2 text-left transition-colors hover:border-tavern-text-muted hover:bg-tavern-bg-hover"
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-tavern-border bg-tavern-bg-light text-tavern-text">
                    <Github className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-tavern-text">GitHub 下载</span>
                    <span className="block text-[11px] text-tavern-text-muted">v{state?.github?.version} · Releases</span>
                  </span>
                  <ArrowUpRight className="h-3.5 w-3.5 text-tavern-text-muted transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />
                </button>
              )}
            </div>

            <div className="mt-2.5 flex items-start gap-2 border-t border-tavern-border-soft pt-2.5 text-xs">
              <CloudDownload className="mt-0.5 h-3.5 w-3.5 shrink-0 text-tavern-text-muted" aria-hidden />
              <div className="min-w-0">
                <span className="text-tavern-text-muted">夸克网盘备用下载（版本以网盘页面为准）：</span>
                <button
                  type="button"
                  onClick={() => void handleOpenLink(QUARK_DOWNLOAD_URL)}
                  className="ml-1 break-all text-left text-tavern-accent underline decoration-tavern-accent/35 underline-offset-2 hover:decoration-tavern-accent"
                >
                  {QUARK_DOWNLOAD_URL}
                </button>
              </div>
            </div>
            {linkError && (
              <p role="alert" className="mt-2 flex items-center gap-1 text-xs text-red-400">
                <CircleAlert className="h-3.5 w-3.5" aria-hidden />
                {linkError}
              </p>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  )
}
