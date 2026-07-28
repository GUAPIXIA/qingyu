import { useState, useRef, useEffect } from 'react'
import { useCharacterStore } from '../../store/useCharacterStore'
import { useGroupChatStore } from '../../store/useGroupChatStore'
import { cn } from '../../lib/utils'
import {
  Send,
  Square,
  Repeat,
  Zap,
  AtSign,
  Image as ImageIcon,
  ChevronDown,
  X as XIcon,
  Reply,
} from 'lucide-react'
import type { GroupChat, GroupMessage } from '../../../shared/types'

interface GroupChatInputProps {
  group: GroupChat
  replyTo?: GroupMessage | null
  onCancelReply?: () => void
}

const MODE_LABELS: Record<GroupChat['chatMode'], string> = {
  mention: '@点名',
  polling: '轮询',
  free: '自由',
}

export function GroupChatInput({ group, replyTo, onCancelReply }: GroupChatInputProps) {
  const [content, setContent] = useState('')
  const [showMention, setShowMention] = useState(false)
  const [showModeMenu, setShowModeMenu] = useState(false)
  const [targetCharId, setTargetCharId] = useState<string | null>(null)
  const [mentionFilter, setMentionFilter] = useState('')
  const [selectedImages, setSelectedImages] = useState<string[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { characters } = useCharacterStore()
  const { sendMessage, isStreaming, stopStreaming } = useGroupChatStore()

  const members = group.memberIds
    .map(id => characters.find(c => c.id === id))
    .filter(Boolean) as NonNullable<typeof characters[number]>[]

  const targetChar = targetCharId ? members.find(m => m.id === targetCharId) : null

  // @mention 检测
  useEffect(() => {
    if (group.chatMode !== 'mention') return

    const lastAt = content.lastIndexOf('@')
    if (lastAt >= 0) {
      const afterAt = content.slice(lastAt + 1)
      // 不自动弹下拉框，仅在用户继续输入后过滤
      if (afterAt.length === 0 && !showMention) return
      setMentionFilter(afterAt)
      setShowMention(true)
    } else {
      setShowMention(false)
    }
  }, [content, group.chatMode])

  const filteredMembers = members.filter(m =>
    m.name.toLowerCase().includes(mentionFilter.toLowerCase())
  )

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const selectMention = (charId: string, _name: string) => {
    setTargetCharId(charId)
    // 移除 @name 部分
    const lastAt = content.lastIndexOf('@')
    if (lastAt >= 0) {
      const before = content.slice(0, lastAt)
      setContent(before.trimEnd())
    }
    setShowMention(false)
  }

  const handleSend = async () => {
    if (!content.trim() || isStreaming) return
    const trimmed = content.trim()
    const images = [...selectedImages]
    const replyToId = replyTo?.id ?? null

    if (group.chatMode === 'mention' && !targetCharId) {
      // 未点名则默认第一个成员
      const firstMember = members[0]
      if (!firstMember) {
        return
      }
      setContent('')
      setSelectedImages([])
      setTargetCharId(null)
      resetTextareaHeight()
      onCancelReply?.()
      await sendMessage(trimmed, images, firstMember.id, replyToId)
    } else {
      setContent('')
      setSelectedImages([])
      setTargetCharId(null)
      resetTextareaHeight()
      onCancelReply?.()
      await sendMessage(trimmed, images, targetCharId ?? undefined, replyToId)
    }
  }

  const resetTextareaHeight = () => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleSelectImage = async () => {
    const path = await window.api.file.selectImage()
    if (path) {
      const base64 = await window.api.file.readImageAsBase64(path)
      if (base64) {
        setSelectedImages(prev => [...prev, base64])
      }
    }
  }

  const changeMode = async (mode: GroupChat['chatMode']) => {
    const store = useGroupChatStore.getState()
    await store.saveGroup({ ...group, chatMode: mode })
    setShowModeMenu(false)
    setTargetCharId(null)
  }

  return (
    <div className="border-t border-tavern-border-soft bg-tavern-bg-soft/80 backdrop-blur p-3">
      {/* 模式指示栏 */}
      <div className="flex items-center gap-2 mb-2 px-1">
        {/* 模式切换 */}
        <div className="relative">
          <button
            onClick={() => setShowModeMenu(!showModeMenu)}
            className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-tavern-bg-hover text-tavern-text-muted hover:text-tavern-text transition-colors"
          >
            {group.chatMode === 'polling' && group.autoMode ? (
              <Repeat className="w-3 h-3 text-tavern-success" />
            ) : group.chatMode === 'mention' ? (
              <AtSign className="w-3 h-3" />
            ) : (
              <Zap className="w-3 h-3" />
            )}
            {MODE_LABELS[group.chatMode]}
            <ChevronDown className="w-3 h-3" />
          </button>

          {showModeMenu && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowModeMenu(false)} />
              <div className="absolute bottom-full left-0 mb-1 w-36 bg-tavern-bg-card border border-tavern-border rounded-lg shadow-xl z-30 py-1">
                {(Object.entries(MODE_LABELS) as [GroupChat['chatMode'], string][]).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => changeMode(key)}
                    className={cn(
                      'w-full text-left px-3 py-1.5 text-xs hover:bg-tavern-bg-hover transition-colors',
                      key === group.chatMode && 'text-tavern-accent font-medium'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* polling 模式额外控件 */}
        {group.chatMode === 'polling' && (
          <button
            onClick={() => {
              useGroupChatStore.getState().saveGroup({ ...group, autoMode: !group.autoMode })
            }}
            className={cn(
              'px-2 py-0.5 text-xs rounded transition-colors',
              group.autoMode
                ? 'bg-tavern-success/10 text-tavern-success'
                : 'bg-tavern-bg-hover text-tavern-text-muted hover:text-tavern-text'
            )}
          >
            {group.autoMode ? <Repeat className="w-3 h-3 inline mr-0.5" /> : null}
            自动 {group.autoMode ? 'ON' : 'OFF'}
          </button>
        )}

        {/* 当前目标角色 */}
        {group.chatMode === 'mention' && targetChar && (
          <span className="text-xs text-tavern-accent bg-tavern-accent-soft px-1.5 py-0.5 rounded">
            @{targetChar.name}
          </span>
        )}

        {/* 轮数指示 */}
        {group.chatMode === 'polling' && group.autoMode && (
          <span className="text-[10px] text-tavern-text-muted ml-auto">
            每轮 {group.maxRounds} 次
          </span>
        )}

        {/* 成员快捷点名 */}
        {group.chatMode === 'mention' && (
          <div className="flex items-center gap-1 ml-auto">
            {members.slice(0, 4).map(m => (
              <button
                key={m.id}
                onClick={() => {
                  setTargetCharId(m.id)
                  setShowMention(false)
                }}
                className={cn(
                  'w-6 h-6 rounded-full flex items-center justify-center text-[10px] border transition-colors',
                  targetCharId === m.id
                    ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                    : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border'
                )}
                title={m.name}
              >
                {m.name[0]}
              </button>
            ))}
            {members.length > 4 && (
              <button
                onClick={() => setShowMention(true)}
                className="w-6 h-6 rounded-full bg-tavern-bg-hover text-[10px] text-tavern-text-muted hover:text-tavern-text"
              >
                +{members.length - 4}
              </button>
            )}
          </div>
        )}
      </div>

      {/* @mention 下拉 */}
      {showMention && filteredMembers.length > 0 && (
        <div className="mb-2 bg-tavern-bg-card border border-tavern-border rounded-lg shadow-lg max-h-32 overflow-y-auto">
          {filteredMembers.map(m => (
            <button
              key={m.id}
              onClick={() => selectMention(m.id, m.name)}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-tavern-bg-hover transition-colors text-left',
                targetCharId === m.id && 'bg-tavern-accent-soft text-tavern-accent'
              )}
            >
              {m.avatar ? (
                <img src={m.avatar} className="w-5 h-5 rounded-full object-cover" alt="" />
              ) : (
                <div className="w-5 h-5 rounded-full bg-tavern-bg-hover flex items-center justify-center text-[10px] font-bold">
                  {m.name[0]}
                </div>
              )}
              <span>{m.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* 引用回复预览条 */}
      {replyTo && (
        <div className="mb-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-tavern-bg-soft border border-tavern-border-soft">
          <Reply className="w-3.5 h-3.5 text-tavern-accent shrink-0" />
          <div className="min-w-0 flex-1 text-xs">
            <span className="text-tavern-accent font-medium">
              {replyTo.characterId === '__user__'
                ? '用户'
                : (characters.find(c => c.id === replyTo.characterId)?.name ?? '未知')
            }:
            </span>
            <span className="text-tavern-text-muted ml-1 truncate">
              {replyTo.content.slice(0, 60)}
              {replyTo.content.length > 60 ? '...' : ''}
            </span>
          </div>
          <button
            onClick={onCancelReply}
            className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger transition-colors shrink-0"
            title="取消引用"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 已选图片预览 */}
      {selectedImages.length > 0 && (
        <div className="flex gap-1.5 mb-2 flex-wrap">
          {selectedImages.map((img, i) => (
            <div key={i} className="relative">
              <img src={img} alt="" className="w-12 h-12 rounded-lg object-cover border border-tavern-border-soft" />
              <button
                onClick={() => setSelectedImages(prev => prev.filter((_, idx) => idx !== i))}
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-tavern-danger text-white flex items-center justify-center text-[8px]"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 输入区 */}
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={e => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              group.chatMode === 'mention'
                ? '输入消息，使用 @ 点名角色...'
                : '输入消息，所有角色将依次/自由回复...'
            }
            rows={1}
            className="w-full resize-none rounded-xl border border-tavern-border-soft bg-tavern-bg px-3 py-2.5 pr-10 text-sm text-tavern-text placeholder-tavern-text-muted/60 focus:outline-none focus:border-tavern-accent focus:ring-1 focus:ring-tavern-accent/30 transition-colors"
            style={{ minHeight: '42px', maxHeight: '120px' }}
            onInput={(e) => {
              // P-10 修复：用 requestAnimationFrame 避免同步 reflow
              const el = e.currentTarget
              requestAnimationFrame(() => {
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 120) + 'px'
              })
            }}
          />
          <button
            onClick={handleSelectImage}
            className="absolute right-2 bottom-2 p-1 rounded text-tavern-text-muted hover:text-tavern-text transition-colors"
            title="上传图片"
          >
            <ImageIcon className="w-4 h-4" />
          </button>
        </div>

        {isStreaming ? (
          <button
            onClick={stopStreaming}
            className="shrink-0 w-10 h-10 rounded-xl bg-tavern-danger/20 text-tavern-danger hover:bg-tavern-danger/30 transition-colors flex items-center justify-center"
          >
            <Square className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!content.trim()}
            className={cn(
              'shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-colors',
              content.trim()
                ? 'bg-tavern-accent text-white hover:bg-tavern-accent/90'
                : 'bg-tavern-bg-hover text-tavern-text-muted cursor-not-allowed'
            )}
          >
            <Send className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}
