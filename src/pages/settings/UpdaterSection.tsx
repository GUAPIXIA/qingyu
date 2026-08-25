/**
 * 设置页「软件更新」面板。
 *
 * - 显示当前版本与检查更新按钮（镜像源优先，GitHub 兜底，见 electron/services/updater.ts）；
 * - 发现新版本后展示更新日志，手动下载（显示进度条），下载完成一键重启安装；
 * - 高级：自托管镜像源地址配置（留空仅走 GitHub Releases）。
 */
import { useCallback, useEffect, useState } from 'react'
import { SectionCard } from '../../components/common/SettingsShared'
import type { UpdaterState } from '../../../shared/ipc-api'
import { RefreshCw, Download, RotateCcw, Loader2 } from 'lucide-react'

export function UpdaterSection() {
  const [state, setState] = useState<UpdaterState | null>(null)
  const [busy, setBusy] = useState(false)
  /** 镜像源输入框内容（保存后才生效） */
  const [mirrorInput, setMirrorInput] = useState('')
  const [mirrorSaved, setMirrorSaved] = useState(false)
  const [currentVersion, setCurrentVersion] = useState('')

  useEffect(() => {
    window.api.updater.getState().then(setState)
    window.api.updater.getMirror().then((c) => setMirrorInput(c.mirrorUrl))
    window.api.app.getVersion().then(setCurrentVersion)
    return window.api.updater.onEvent(setState)
  }, [])

  const handleCheck = useCallback(async () => {
    setBusy(true)
    try {
      setState(await window.api.updater.check())
    } finally {
      setBusy(false)
    }
  }, [])

  const handleDownload = useCallback(async () => {
    setBusy(true)
    try {
      setState(await window.api.updater.download())
    } finally {
      setBusy(false)
    }
  }, [])

  const handleSaveMirror = useCallback(async () => {
    await window.api.updater.setMirror({ mirrorUrl: mirrorInput.trim() })
    setMirrorSaved(true)
    setTimeout(() => setMirrorSaved(false), 2000)
  }, [mirrorInput])

  const status = state?.status ?? 'idle'

  return (
    <SectionCard title="软件更新" icon={<RefreshCw className="w-4 h-4" />}>
      <div className="mt-3 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm">当前版本 v{currentVersion}</p>
            {state?.version && status !== 'none' && (
              <p className="text-xs text-tavern-text-muted mt-0.5">最新版本 v{state.version}</p>
            )}
          </div>
          {status === 'downloaded' ? (
            <button
              onClick={() => window.api.updater.install()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
              重启安装
            </button>
          ) : status === 'available' ? (
            <button
              onClick={handleDownload}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm transition-colors"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              下载更新
            </button>
          ) : (
            <button
              onClick={handleCheck}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-tavern-border hover:bg-tavern-bg-light disabled:opacity-50 text-sm transition-colors"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              检查更新
            </button>
          )}
        </div>

        {status === 'downloading' && typeof state?.percent === 'number' && (
          <div>
            <div className="h-1.5 w-full rounded-full bg-tavern-bg-light overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${state?.percent ?? 0}%` }}
              />
            </div>
            <p className="text-xs text-tavern-text-muted mt-1">{state?.percent ?? 0}%</p>
          </div>
        )}

        {(status === 'error' || state?.message) && (
          <p className={`text-xs ${status === 'error' ? 'text-red-400' : 'text-tavern-text-muted'}`}>
            {state?.message}
          </p>
        )}

        {state?.releaseNotes && status === 'available' && (
          <details className="text-xs text-tavern-text-muted">
            <summary className="cursor-pointer select-none">查看更新日志</summary>
            <pre className="mt-1 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{state.releaseNotes}</pre>
          </details>
        )}

        {/* 高级：镜像源 */}
        <details className="text-xs text-tavern-text-muted">
          <summary className="cursor-pointer select-none">高级设置：更新镜像源</summary>
          <div className="mt-2 space-y-2">
            <input
              type="text"
              value={mirrorInput}
              onChange={(e) => setMirrorInput(e.target.value)}
              placeholder="镜像目录 URL（含 latest.yml），留空仅用 GitHub"
              className="w-full px-2 py-1.5 rounded-md bg-tavern-bg-light border border-tavern-border text-xs focus:outline-none focus:border-tavern-accent"
            />
            <button
              onClick={handleSaveMirror}
              className="px-2.5 py-1 rounded-md border border-tavern-border hover:bg-tavern-bg-light text-xs transition-colors"
            >
              {mirrorSaved ? '已保存 ✓' : '保存'}
            </button>
          </div>
        </details>
      </div>
    </SectionCard>
  )
}
