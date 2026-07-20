import { useState, useMemo } from 'react'
import { Modal } from '../common/Modal'
import { Eye, User, Bot, Settings } from 'lucide-react'
import type { Character, Preset, Lorebook } from '../../../shared/types'
import { useChatStore } from '../../store/useChatStore'
import { estimateTokens } from '../../utils/tokenCounter'
import { cn } from '../../lib/utils'

interface ContextViewerProps {
  open: boolean
  onClose: () => void
  character: Character
  preset: Preset | null
  lorebook: Lorebook | null
}

export function ContextViewer({ open, onClose, character, preset, lorebook }: ContextViewerProps) {
  const { buildContext } = useChatStore()

  const context = useMemo(() => {
    if (!open) return []
    return buildContext(character, preset, lorebook)
  }, [open, character, preset, lorebook, buildContext])

  const totalTokens = useMemo(() => {
    return context.reduce((sum, msg) => sum + estimateTokens(msg.content), 0)
  }, [context])

  const roleConfig = {
    system: { icon: Settings, label: 'System', color: 'text-tavern-accent', bg: 'bg-tavern-accent-soft' },
    user: { icon: User, label: 'User', color: 'text-tavern-user', bg: 'bg-tavern-user/10' },
    assistant: { icon: Bot, label: 'Assistant', color: 'text-tavern-assistant', bg: 'bg-tavern-assistant/10' },
  }

  return (
    <Modal open={open} onClose={onClose} title="上下文预览" width="xl">
      <div className="space-y-3">
        {/* 统计 */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-tavern-bg-soft border border-tavern-border-soft">
          <div className="text-sm text-tavern-text-soft">
            共 {context.length} 条消息
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-tavern-text-muted">预估 Token:</span>
            <span className="font-bold text-tavern-accent">{totalTokens}</span>
          </div>
        </div>

        {/* 消息列表 */}
        <div className="max-h-[60vh] overflow-y-auto space-y-2">
          {context.map((msg, i) => {
            const cfg = roleConfig[msg.role]
            const Icon = cfg.icon
            return (
              <div key={i} className="rounded-lg border border-tavern-border-soft overflow-hidden">
                <div className={cn('flex items-center gap-2 px-3 py-1.5 text-xs font-medium', cfg.bg, cfg.color)}>
                  <Icon className="w-3.5 h-3.5" />
                  {cfg.label}
                  <span className="ml-auto text-tavern-text-muted">{estimateTokens(msg.content)} tok</span>
                </div>
                <div className="px-3 py-2 text-sm text-tavern-text-soft whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                  {msg.content}
                </div>
              </div>
            )
          })}
        </div>

        <div className="text-xs text-tavern-text-muted text-center">
          这是即将发送给 AI 的完整上下文（含系统提示、角色设定、历史消息）
        </div>
      </div>
    </Modal>
  )
}
