import { Modal } from '../common/Modal'
import { charAssetUrl } from '../../utils/asset'
import { getDisplayName, replaceVariables } from '../../utils/variables'
import { cn } from '../../lib/utils'
import type { Character } from '../../../shared/types'

interface ChatGreetingPickerModalProps {
  open: boolean
  character: Character | null
  selectedGreeting: string
  userName: string
  onSelectGreeting: (greeting: string) => void
  /** 跳过 / 关闭（清空选择） */
  onClose: () => void
  /** 使用选中开场白开始对话 */
  onStart: () => void
}

/**
 * 单聊开场白选择弹窗（从 ChatPage 拆出）：
 * 展示角色的首条消息与备选开场白，选中后开始对话。
 */
export function ChatGreetingPickerModal({
  open,
  character,
  selectedGreeting,
  userName,
  onSelectGreeting,
  onClose,
  onStart,
}: ChatGreetingPickerModalProps) {
  if (!open || !character) return null

  // 展示名：译文优先（预览时用原始名，避免 getDisplayName 的 "(原文)" 后缀污染替换）
  const previewName = character.translatedContent?.name ?? character.name
  const greetings = [
    character.translatedContent?.firstMessage ?? character.firstMessage,
    ...(character.alternateGreetings || []).map((g, i) => character.translatedContent?.alternateGreetings?.[i] || g),
  ].filter(Boolean)

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="custom"
      widthClassName="w-[560px]"
      headerClassName="px-5 py-4 bg-tavern-bg-soft"
      header={
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="w-12 h-12 rounded-lg overflow-hidden bg-tavern-bg-hover shrink-0">
            <img
              src={charAssetUrl(character.id, 'cover', character.updatedAt)}
              alt=""
              className="w-full h-full object-cover"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-display font-bold text-lg truncate">{getDisplayName(character)}</h3>
            <p className="text-xs text-tavern-text-muted">选择一个开场白开始对话</p>
          </div>
        </div>
      }
      footer={
        <>
          <span className={cn(
            'text-xs mr-auto',
            selectedGreeting ? 'text-tavern-accent' : 'text-tavern-text-muted'
          )}>
            {selectedGreeting ? '✓ 已选择开场白' : '请选择一条开场白，或跳过直接开始'}
          </span>
          <button className="btn-secondary" onClick={onClose}>
            跳过
          </button>
          <button className="btn-primary" onClick={onStart} disabled={!selectedGreeting}>
            开始对话
          </button>
        </>
      }
    >
      <div className="space-y-2">
        {greetings.map((greeting, i) => (
          <div
            key={i}
            className={cn(
              'p-3 rounded-lg border cursor-pointer transition-all text-sm',
              selectedGreeting === greeting
                ? 'border-tavern-accent bg-tavern-accent-soft shadow-sm'
                : 'border-tavern-border hover:bg-tavern-bg-hover hover:border-tavern-border-soft'
            )}
            onClick={() => onSelectGreeting(greeting)}
          >
            <div className="flex gap-2.5">
              <span className={cn(
                'shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold mt-0.5',
                selectedGreeting === greeting
                  ? 'bg-tavern-accent text-tavern-bg'
                  : 'bg-tavern-bg-hover text-tavern-text-muted'
              )}>
                {i + 1}
              </span>
              <div className="flex-1 line-clamp-4 whitespace-pre-wrap text-tavern-text-soft">
                {replaceVariables(greeting, userName, previewName)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}
