import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { LocalModelTaskSnapshot } from '../../../shared/localModels'

const activeStates = new Set(['queued', 'downloading', 'paused', 'verifying', 'installing', 'testing', 'uninstalling', 'uninstall_pending'])

export function LocalModelTaskCenter() {
  const [tasks, setTasks] = useState<LocalModelTaskSnapshot[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!window.api?.localModel) return
    void window.api.localModel.tasks().then(setTasks).catch(() => {})
    return window.api.localModel.onProgress(({ task }) => setTasks((current) => [task, ...current.filter((item) => item.taskId !== task.taskId)]))
  }, [])
  const visible = tasks.filter((task) => activeStates.has(task.state))
  if (visible.length === 0) return null
  return <aside className="motion-disclosure fixed bottom-4 right-4 z-40 w-80 rounded-lg border border-tavern-border bg-tavern-bg shadow-xl" aria-label="本地模型任务中心">
    <button className="w-full flex items-center justify-between px-3 py-2 text-sm" onClick={() => setOpen((value) => !value)}>
      <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin text-tavern-accent" />本地模型任务 {visible.length}</span>{open ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
    </button>
    {open && <div className="motion-disclosure border-t border-tavern-border-soft px-3 py-2 space-y-2 max-h-48 overflow-auto">{visible.map((task) => {
      const progress = task.totalBytes ? Math.round(task.downloadedBytes / task.totalBytes * 100) : 0
      return <div key={task.taskId} className="text-xs"><div className="flex justify-between"><span className="truncate">{task.modelId}@{task.version}</span><span>{task.state} · {progress}%</span></div><div className="h-1 mt-1 rounded bg-tavern-bg-hover"><div className="h-full rounded bg-tavern-accent transition-[width] duration-200 ease-out" style={{ width: `${progress}%` }} /></div></div>
    })}</div>}
  </aside>
}
