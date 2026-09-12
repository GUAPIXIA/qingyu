import { useEffect, useRef, useState } from 'react'
import { useCharacterStore } from '../../store/useCharacterStore'
import { useGroupChatStore } from '../../store/useGroupChatStore'
import { cn } from '../../lib/utils'
import { charAssetUrl } from '../../utils/asset'
import { ChevronDown, Image as ImageIcon, LoaderCircle, Play, Reply, Send, Square, X as XIcon } from 'lucide-react'
import { registerDraftBridge } from './draftBridge'
import type { GroupChat, GroupMessage } from '../../../shared/types'

interface GroupChatInputProps {
  group: GroupChat
  replyTo?: GroupMessage | null
  onCancelReply?: () => void
}

const MODE_LABELS: Record<GroupChat['chatMode'], string> = {
  mention: '指定成员',
  polling: '按顺序',
  free: 'AI 自选',
}

export function GroupChatInput({ group, replyTo, onCancelReply }: GroupChatInputProps) {
  const [content, setContent] = useState('')
  const [showMention, setShowMention] = useState(false)
  const [targetCharId, setTargetCharId] = useState<string | null>(null)
  const [mentionOverrideId, setMentionOverrideId] = useState<string | null>(null)
  const [mentionFilter, setMentionFilter] = useState('')
  const [selectedImages, setSelectedImages] = useState<string[]>([])
  const [triggeringCharId, setTriggeringCharId] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 方向卡片读取最新草稿：用 ref 镜像避免桥持有过期的闭包值
  const contentRef = useRef(content)
  useEffect(() => { contentRef.current = content }, [content])

  const characters = useCharacterStore((state) => state.characters)
  const sendMessage = useGroupChatStore((state) => state.sendMessage)
  const triggerCharacterReply = useGroupChatStore((state) => state.triggerCharacterReply)
  const isStreaming = useGroupChatStore((state) => state.isStreaming)
  const stopStreaming = useGroupChatStore((state) => state.stopStreaming)

  const members = group.memberIds
    .map((id) => characters.find((character) => character.id === id))
    .filter(Boolean) as NonNullable<typeof characters[number]>[]
  const memberKey = group.memberIds.join(',')
  const firstMemberId = members[0]?.id ?? null
  const targetStillPresent = !!targetCharId && members.some((member) => member.id === targetCharId)
  const selectedTarget = members.find((member) => member.id === targetCharId) ?? members[0] ?? null
  const mentionOverride = members.find((member) => member.id === mentionOverrideId) ?? null
  const effectiveTarget = mentionOverride ?? selectedTarget
  const nextSpeaker = members[group.currentSpeakerIndex % Math.max(members.length, 1)] ?? null

  useEffect(() => {
    if (targetStillPresent) return
    setTargetCharId(firstMemberId)
  }, [firstMemberId, memberKey, targetStillPresent])

  // 方向卡片 → 输入框草稿桥（与单聊各自独立作用域）
  useEffect(() => {
    registerDraftBridge('group', {
      getText: () => contentRef.current,
      setDraft: (value) => {
        setContent(value)
        requestAnimationFrame(() => {
          const el = textareaRef.current
          if (!el) return
          el.style.height = 'auto'
          el.style.height = Math.min(el.scrollHeight, 200) + 'px'
        })
      },
    })
    return () => registerDraftBridge('group', null)
  }, [])

  useEffect(() => {
    if (group.chatMode !== 'mention') {
      setShowMention(false)
      setMentionOverrideId(null)
      return
    }
    const lastAt = content.lastIndexOf('@')
    if (lastAt < 0) {
      setShowMention(false)
      return
    }
    const afterAt = content.slice(lastAt + 1)
    if (afterAt.length === 0 && !showMention) return
    setMentionFilter(afterAt)
    setShowMention(true)
  }, [content, group.chatMode, showMention])

  const filteredMembers = members.filter((member) => member.name.toLowerCase().includes(mentionFilter.toLowerCase()))

  const resetTextareaHeight = () => {
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const selectMention = (charId: string) => {
    setMentionOverrideId(charId)
    const lastAt = content.lastIndexOf('@')
    if (lastAt >= 0) setContent(content.slice(0, lastAt).trimEnd())
    setShowMention(false)
  }

  const handleSend = async () => {
    if (!content.trim() || isStreaming) return
    if (group.chatMode === 'mention' && !effectiveTarget) return

    const trimmed = content.trim()
    const images = [...selectedImages]
    const responderId = group.chatMode === 'mention' ? effectiveTarget?.id : undefined
    setContent('')
    setSelectedImages([])
    setMentionOverrideId(null)
    resetTextareaHeight()
    onCancelReply?.()
    await sendMessage(trimmed, images, responderId, replyTo?.id ?? null)
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void handleSend()
    }
  }

  const handleSelectImage = async () => {
    const path = await window.api.file.selectImage()
    if (!path) return
    const base64 = await window.api.file.readImageAsBase64(path)
    if (base64) setSelectedImages((images) => [...images, base64])
  }

  const changeMode = async (mode: GroupChat['chatMode']) => {
    if (mode === group.chatMode) return
    setMentionOverrideId(null)
    await useGroupChatStore.getState().saveGroup({ ...group, chatMode: mode })
  }

  const handleImmediateReply = async (charId: string) => {
    if (isStreaming || triggeringCharId) return
    setTriggeringCharId(charId)
    try {
      await triggerCharacterReply(charId)
    } finally {
      setTriggeringCharId(null)
    }
  }

  return (
    <div className="border-t border-tavern-border-soft bg-tavern-bg-soft/90 px-3 pb-3 pt-2 backdrop-blur">
      <div className="mb-2 flex min-h-8 items-center gap-2 overflow-x-auto whitespace-nowrap rounded-xl border border-tavern-border-soft bg-tavern-bg-card/70 px-2 py-1.5 shadow-sm">
        <span className="shrink-0 text-[10px] font-medium text-tavern-text-muted">发送后</span>
        <label className="relative shrink-0">
          <select
            aria-label="发送后回复规则"
            value={group.chatMode}
            disabled={isStreaming}
            onChange={(event) => void changeMode(event.target.value as GroupChat['chatMode'])}
            className="h-7 appearance-none rounded-lg border border-tavern-border-soft bg-tavern-bg px-2.5 pr-7 text-[11px] font-medium text-tavern-text-soft outline-none transition-colors hover:border-tavern-border focus:border-tavern-accent disabled:opacity-50"
          >
            {(Object.entries(MODE_LABELS) as [GroupChat['chatMode'], string][]).map(([mode, label]) => (
              <option key={mode} value={mode}>{label}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-tavern-text-muted" />
        </label>

        {group.chatMode === 'mention' && (
          <label className="relative shrink-0">
            <select
              aria-label="指定回复成员"
              value={selectedTarget?.id ?? ''}
              disabled={isStreaming || members.length === 0}
              onChange={(event) => setTargetCharId(event.target.value || null)}
              className="h-7 max-w-40 appearance-none rounded-lg border border-tavern-accent/25 bg-tavern-accent-soft px-2.5 pr-7 text-[11px] font-medium text-tavern-accent outline-none disabled:opacity-50"
            >
              {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-tavern-accent" />
          </label>
        )}

        {group.chatMode === 'polling' && (
          <span className="shrink-0 text-[10px] text-tavern-text-muted">
            下一位 <b className="font-medium text-tavern-text-soft">{nextSpeaker?.name ?? '等待成员'}</b>
          </span>
        )}
        {group.chatMode === 'polling' && group.autoMode && (
          <span className="shrink-0 rounded-full bg-tavern-success/10 px-2 py-0.5 text-[10px] font-medium text-tavern-success">连续 {group.maxRounds} 轮</span>
        )}
        {group.chatMode === 'free' && <span className="shrink-0 text-[10px] text-tavern-text-muted">可由多人回应</span>}

        <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-tavern-border-soft" />
        <span className="shrink-0 text-[10px] font-medium text-tavern-text-muted">立即接话</span>
        {members.map((member) => {
          const isTriggering = triggeringCharId === member.id
          const avatar = member.avatar || charAssetUrl(member.id, 'avatar', member.updatedAt)
          return (
            <button
              key={member.id}
              type="button"
              disabled={isStreaming || triggeringCharId !== null}
              aria-label={`让 ${member.name}立即接话`}
              title={`让 ${member.name}根据当前对话立即接话`}
              onClick={() => void handleImmediateReply(member.id)}
              className={cn(
                'group flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-full border px-1.5 pr-2 text-[11px] transition-all',
                isTriggering
                  ? 'border-tavern-accent/40 bg-tavern-accent-soft text-tavern-accent'
                  : 'border-tavern-border-soft bg-tavern-bg text-tavern-text-soft hover:border-tavern-accent/35 hover:text-tavern-accent',
                (isStreaming || triggeringCharId !== null) && !isTriggering && 'opacity-45',
              )}
            >
              <span className="grid h-[18px] w-[18px] shrink-0 place-items-center overflow-hidden rounded-full bg-tavern-bg-hover text-[9px] font-bold">
                {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : member.name[0]}
              </span>
              <span className="truncate">{isTriggering ? '生成中' : member.name}</span>
              {isTriggering
                ? <LoaderCircle className="h-3 w-3 shrink-0 animate-spin" />
                : <Play className="h-2.5 w-2.5 shrink-0 opacity-45 transition-opacity group-hover:opacity-100" />}
            </button>
          )
        })}
      </div>

      {mentionOverride && (
        <div className="mb-2 flex items-center gap-1.5 text-[10px] text-tavern-text-muted">
          <span>仅本轮由</span>
          <span className="rounded-full bg-tavern-accent-soft px-2 py-0.5 font-medium text-tavern-accent">{mentionOverride.name}</span>
          <button type="button" onClick={() => setMentionOverrideId(null)} className="rounded p-0.5 hover:text-tavern-danger" aria-label="取消本轮回复者">
            <XIcon className="h-3 w-3" />
          </button>
        </div>
      )}

      {showMention && filteredMembers.length > 0 && (
        <div className="mb-2 max-h-32 overflow-y-auto rounded-lg border border-tavern-border bg-tavern-bg-card shadow-lg">
          {filteredMembers.map((member) => {
            const avatar = member.avatar || charAssetUrl(member.id, 'avatar', member.updatedAt)
            return (
              <button key={member.id} type="button" onClick={() => selectMention(member.id)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-tavern-bg-hover">
                {avatar
                  ? <img src={avatar} className="h-5 w-5 rounded-full object-cover" alt="" />
                  : <span className="grid h-5 w-5 place-items-center rounded-full bg-tavern-bg-hover text-[10px] font-bold">{member.name[0]}</span>}
                <span>{member.name}</span>
              </button>
            )
          })}
        </div>
      )}

      {replyTo && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-tavern-border-soft bg-tavern-bg-soft px-3 py-1.5">
          <Reply className="h-3.5 w-3.5 shrink-0 text-tavern-accent" />
          <div className="min-w-0 flex-1 text-xs">
            <span className="font-medium text-tavern-accent">
              {replyTo.characterId === '__user__' ? '用户' : (characters.find((character) => character.id === replyTo.characterId)?.name ?? '未知')}:
            </span>
            <span className="ml-1 truncate text-tavern-text-muted">{replyTo.content.slice(0, 60)}{replyTo.content.length > 60 ? '...' : ''}</span>
          </div>
          <button type="button" onClick={onCancelReply} className="shrink-0 rounded p-0.5 text-tavern-text-muted transition-colors hover:text-tavern-danger" title="取消引用">
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {selectedImages.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selectedImages.map((image, index) => (
            <div key={index} className="relative">
              <img src={image} alt="" className="h-12 w-12 rounded-lg border border-tavern-border-soft object-cover" />
              <button type="button" onClick={() => setSelectedImages((images) => images.filter((_, imageIndex) => imageIndex !== index))} className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-tavern-danger text-[8px] text-white" aria-label="移除图片">×</button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息…"
            rows={1}
            className="w-full resize-none rounded-xl border border-tavern-border-soft bg-tavern-bg px-3 py-2.5 pr-10 text-sm text-tavern-text transition-colors placeholder-tavern-text-muted/60 focus:border-tavern-accent focus:outline-none focus:ring-1 focus:ring-tavern-accent/30"
            style={{ minHeight: '42px', maxHeight: '120px' }}
            onInput={(event) => {
              const element = event.currentTarget
              requestAnimationFrame(() => {
                element.style.height = 'auto'
                element.style.height = `${Math.min(element.scrollHeight, 120)}px`
              })
            }}
          />
          <button type="button" onClick={handleSelectImage} className="absolute bottom-2 right-2 rounded p-1 text-tavern-text-muted transition-colors hover:text-tavern-text" title="上传图片">
            <ImageIcon className="h-4 w-4" />
          </button>
        </div>

        {isStreaming ? (
          <button type="button" onClick={stopStreaming} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-tavern-danger/20 text-tavern-danger transition-colors hover:bg-tavern-danger/30" aria-label="停止生成">
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <button type="button" onClick={() => void handleSend()} disabled={!content.trim()} aria-label="发送消息" className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors',
            content.trim() ? 'bg-tavern-accent text-white hover:bg-tavern-accent/90' : 'cursor-not-allowed bg-tavern-bg-hover text-tavern-text-muted',
          )}>
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}
