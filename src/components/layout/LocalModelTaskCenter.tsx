import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Loader2, AlertTriangle } from 'lucide-react'
import type { LocalModelTaskSnapshot } from '../../../shared/localModels'

const activeStates = new Set(['queued', 'downloading', 'paused', 'verifying', 'installing', 'testing', 'uninstalling', 'uninstall_pending'])
const failedStates = new Set(['failed', 'corrupted'])

const stateLabel: Record<string, string> = {
  queued: '排队中',
  downloading: '下载中',
  paused: '已暂停',
  verifying: '校验中',
  installing: '安装中',
  testing: '测试中',
  uninstalling: '卸载中',
  uninstall_pending: '待确认卸载',
  ready: '已就绪',
  failed: '失败',
  corrupted: '校验失败',
}

export function LocalModelTaskCenter() {
  const [tasks, setTasks] = useState<LocalModelTaskSnapshot[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!window.api?.localModel) return
    void window.api.localModel.tasks().then(setTasks).catch(() => {})
    return window.api.localModel.onProgress(({ task }) => setTasks((current) => [task, ...current.filter((item) => item.taskId !== task.taskId)]))
  }, [])
  const visible = tasks.filter((task) => activeStates.has(task.state) || failedStates.has(task.state))
  if (visible.length === 0) return null
  const failedCount = visible.filter((t) => failedStates.has(t.state)).length
  return (
    <aside className="motion-disclosure fixed bottom-4 right-4 z-40 w-80 rounded-lg border border-tavern-border bg-tavern-bg shadow-xl" aria-label="本地模型任务中心">
      <button className="w-full flex items-center justify-between px-3 py-2 text-sm" onClick={() => setOpen((value) => !value)}>
        <span className="flex items-center gap-2">
          {failedCount > 0 ? <AlertTriangle className="w-4 h-4 text-tavern-danger" /> : <Loader2 className="w-4 h-4 animate-spin text-tavern-accent" />}
          本地模型任务 {visible.length}{failedCount > 0 ? `（${failedCount} 失败）` : ''}
        </span>
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
      </button>
      {open && (
        <div className="motion-disclosure border-t border-tavern-border-soft px-3 py-2 space-y-2 max-h-48 overflow-auto">
          {visible.map((task) => {
            const progress = task.totalBytes ? Math.round(task.downloadedBytes / task.totalBytes * 100) : 0
            const label = stateLabel[task.state] ?? task.state
            const isFailed = failedStates.has(task.state)
            return (
              <div key={task.taskId} className="text-xs">
                <div className="flex justify-between gap-2">
                  <span className="truncate">{task.modelId}@{task.version}</span>
                  <span className={isFailed ? 'text-tavern-danger shrink-0' : 'shrink-0'}>{label} · {progress}%</span>
                </div>
                <div className="h-1 mt-1 rounded bg-tavern-bg-hover">
                  <div
                    className={`h-full rounded transition-[width] duration-200 ease-out ${isFailed ? 'bg-tavern-danger' : 'bg-tavern-accent'}`}
                    style={{ width: `${progress}%` }}
                  />
                </div>
                {isFailed && (task as { error?: string }).error && (
                  <p className="mt-1 text-tavern-danger/80 break-words">{(task as { error?: string }).error}</p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </aside>
  )
}
