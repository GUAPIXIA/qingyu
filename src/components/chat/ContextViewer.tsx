import { useEffect, useMemo, useState } from 'react'
import { Bot, BookOpen, MessagesSquare, Settings, User } from 'lucide-react'
import type { Character, Preset } from '../../../shared/types'
import { useChatStore } from '../../store/useChatStore'
import { countChars, formatCharCount } from '../../utils/charCounter'
import { cn } from '../../lib/utils'
import { Modal } from '../common/Modal'
import { LorebookDebugPanel } from './LorebookDebugPanel'

interface ContextViewerProps {
  open: boolean
  onClose: () => void
  character: Character
  preset: Preset | null
}

export function ContextViewer({ open, onClose, character, preset }: ContextViewerProps) {
  const buildContextReport = useChatStore((state) => state.buildContextReport)
  const liveLorebookDiagnostics = useChatStore((state) => state.lastLorebookDiagnostics)
  const liveDiagnosticsSessionId = useChatStore((state) => state.lastLorebookDiagnosticsSessionId)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const [tab, setTab] = useState<'messages' | 'lorebook'>('messages')

  const report = useMemo(() => {
    if (!open) return null
    return buildContextReport(character, preset)
  }, [open, character, preset, buildContextReport])
  const context = useMemo(() => report?.messages ?? [], [report])

  useEffect(() => {
    if (!open) setTab('messages')
  }, [open])

  const totalChars = useMemo(() => {
    return context.reduce((sum, message) => sum + countChars(message.content).total, 0)
  }, [context])

  const roleConfig = {
    system: { icon: Settings, label: 'System', color: 'text-tavern-accent', bg: 'bg-tavern-accent-soft' },
    user: { icon: User, label: 'User', color: 'text-tavern-user', bg: 'bg-tavern-user/10' },
    assistant: { icon: Bot, label: 'Assistant', color: 'text-tavern-assistant', bg: 'bg-tavern-assistant/10' },
  }

  return (
    <Modal open={open} onClose={onClose} title="上下文预览" width="xl">
      <div className="space-y-3">
        <div className="flex gap-1 rounded-xl border border-tavern-border-soft bg-tavern-bg-soft p-1">
          <button
            type="button"
            onClick={() => setTab('messages')}
            className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
              tab === 'messages' ? 'bg-tavern-bg text-tavern-accent shadow-sm' : 'text-tavern-text-muted hover:text-tavern-text',
            )}
          >
            <MessagesSquare className="h-3.5 w-3.5" />消息列表
          </button>
          <button
            type="button"
            onClick={() => setTab('lorebook')}
            className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
              tab === 'lorebook' ? 'bg-tavern-bg text-tavern-accent shadow-sm' : 'text-tavern-text-muted hover:text-tavern-text',
            )}
          >
            <BookOpen className="h-3.5 w-3.5" />世界书触发
            {(report?.lorebookDiagnostics?.summary.droppedEntries ?? 0) > 0 && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />}
          </button>
        </div>

        {tab === 'messages' ? (
          <>
            <div className="flex items-center justify-between rounded-lg border border-tavern-border-soft bg-tavern-bg-soft p-3">
              <div className="text-sm text-tavern-text-soft">共 {context.length} 条消息</div>
              <div className="flex items-center gap-3 text-sm">
                <span className="text-tavern-text-muted">总字符:</span>
                <span className="font-bold text-tavern-accent">{formatCharCount(totalChars)}</span>
              </div>
            </div>

            <div className="max-h-[60vh] space-y-2 overflow-y-auto">
              {context.map((message, index) => {
                const config = roleConfig[message.role]
                const Icon = config.icon
                return (
                  <div key={index} className="overflow-hidden rounded-lg border border-tavern-border-soft">
                    <div className={cn('flex items-center gap-2 px-3 py-1.5 text-xs font-medium', config.bg, config.color)}>
                      <Icon className="h-3.5 w-3.5" />
                      {config.label}
                      <span className="ml-auto text-tavern-text-muted">{formatCharCount(countChars(message.content).total)} 字符</span>
                    </div>
                    <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-sm text-tavern-text-soft">{message.content}</div>
                  </div>
                )
              })}
            </div>

            <div className="text-center text-xs text-tavern-text-muted">这是当前模拟构建的完整上下文（含系统提示、角色设定、历史消息）</div>
          </>
        ) : (
          <LorebookDebugPanel
            live={liveDiagnosticsSessionId === currentSessionId ? liveLorebookDiagnostics : null}
            preview={report?.lorebookDiagnostics ?? null}
          />
        )}
      </div>
    </Modal>
  )
}
