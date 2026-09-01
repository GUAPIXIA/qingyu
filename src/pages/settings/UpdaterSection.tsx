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

function SourceCard({
  label,
  result,
  checking,
  icon,
  hint,
  onOpen,
}: {
  label: string
  result?: UpdateSourceResult
  checking: boolean
  icon: React.ReactNode
  hint: string
  onOpen?: () => void
}) {
  const statusText = checking && !result
    ? '获取中…'
    : result?.status === 'error'
      ? '获取失败'
      : result?.version
        ? `v${result.version}`
        : '暂无结果'
  const interactive = Boolean(onOpen) && !checking
  const content = (
    <>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-tavern-border-soft bg-tavern-bg-light text-tavern-text-soft">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-3">
          <span className="text-xs text-tavern-text-muted">{label}</span>
          <span className={result?.status === 'error' ? 'text-xs text-red-400' : 'text-xs font-semibold text-tavern-text'}>
            {statusText}
          </span>
        </span>
        <span className="mt-0.5 block text-[11px] text-tavern-text-muted/80">
          {interactive ? hint : result?.status === 'error' ? '版本获取失败' : '等待检查结果'}
        </span>
      </span>
      {interactive && (
        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-tavern-text-muted transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />
      )}
    </>
  )

  return interactive ? (
    <button
      type="button"
      onClick={onOpen}
      className="group flex min-h-16 items-center gap-2.5 rounded-lg border border-tavern-border-soft bg-tavern-bg-soft/55 px-3 py-2 text-left transition-colors hover:border-tavern-accent/45 hover:bg-tavern-accent-soft/35"
    >
      {content}
    </button>
  ) : (
    <div className="flex min-h-16 items-center gap-2.5 rounded-lg border border-tavern-border-soft bg-tavern-bg-soft/55 px-3 py-2">
      {content}
    </div>
  )
}

export function UpdaterSection() {
  const [state, setState] = useState<UpdaterState | null>(null)
  const [busy, setBusy] = useState(false)
  const [currentVersion, setCurrentVersion] = useState('')
  const [linkError, setLinkError] = useState('')

  const handleCheck = useCallback(async () => {
    setBusy(true)
    setLinkError('')
    try {
      setState(await window.api.updater.check())
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    const unsubscribe = window.api.updater.onEvent((nextState) => {
      if (active) setState(nextState)
    })

    void Promise.all([
      window.api.updater.getState(),
      window.api.app.getVersion(),
    ]).then(([snapshot, version]) => {
      if (!active) return
      setState(snapshot)
      setCurrentVersion(version)
      // 主进程状态在本次应用运行期间持续保存：仅 idle 代表本次启动尚未检查。
      // 离开设置页再进入不会重复请求；应用重启后状态恢复 idle，会重新自动检查。
      if (snapshot.status === 'idle') void handleCheck()
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [handleCheck])

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
  const githubAvailable = state?.github?.status === 'available'
  const showResults = checking || Boolean(state?.server || state?.github)
  const showDownloadLinks = !checking && Boolean(state?.server || state?.github)
  const serverDownloadUrl = state?.server?.downloadUrl

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
    <SectionCard title="软件更新" icon={<RefreshCw className="h-4 w-4" />} storageKey="updater">
      <div className="mt-3 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm">当前版本 v{currentVersion || '...'}</p>
          {action}
        </div>

        {showResults && (
          <div className="grid gap-2 sm:grid-cols-2" aria-label="更新来源版本">
            <SourceCard
              label="服务器最新版本"
              result={state?.server}
              checking={checking}
              icon={<Server className="h-4 w-4" aria-hidden />}
              hint="国内线路 · 点击下载"
              onOpen={serverDownloadUrl ? () => void handleOpenLink(serverDownloadUrl) : undefined}
            />
            <SourceCard
              label="GitHub 最新版本"
              result={state?.github}
              checking={checking}
              icon={<Github className="h-4 w-4" aria-hidden />}
              hint="GitHub Releases · 点击下载"
              onOpen={!checking ? () => void handleOpenLink(GITHUB_RELEASES_URL) : undefined}
            />
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

        {showDownloadLinks && (
          <div>
            <div className="flex items-start gap-2 border-t border-tavern-border-soft pt-2.5 text-xs">
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
