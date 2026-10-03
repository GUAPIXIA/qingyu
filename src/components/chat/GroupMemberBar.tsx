import { useCharacterStore } from '../../store/useCharacterStore'
import { cn } from '../../lib/utils'
import { getDisplayName } from '../../../shared/chat-core/variables'
import { Square } from 'lucide-react'

// UEX-P1-12：群调度条（GroupMemberBar）——生成中显示成员接力进度：
// 当前说话者 + 接力 x/N + 「停剩余」；非生成中整条收起，避免常态噪声。
interface GroupMemberBarProps {
  /** 群成员 ID 顺序 = 发言顺序（x/N 的 x 按此序号） */
  memberIds: string[]
  /** 正在生成的角色 ID；接力间隙（尚未轮到下一位）为 null */
  currentStreamingCharId: string | null
  /** 仅生成中显示（收起常态噪声） */
  isStreaming: boolean
  /** UEX-P1-12：停剩余——停止后续成员接力，保留已生成内容 */
  onStopRemaining: () => void
  themeColor?: string
}

export function GroupMemberBar({ memberIds, currentStreamingCharId, isStreaming, onStopRemaining, themeColor }: GroupMemberBarProps) {
  const characters = useCharacterStore((s) => s.characters)
  // UEX-P1-12：x/N 沿用原最小文案口径（streamingSpeakerOrder）——
  // x = 当前说话者在群成员里的序号（1 起），N = 成员总数；间隙/未知为 0。
  const speakerIndex = currentStreamingCharId ? memberIds.indexOf(currentStreamingCharId) : -1
  const speakerOrder = speakerIndex >= 0 ? speakerIndex + 1 : 0
  const speaker = currentStreamingCharId
    ? characters.find((character) => character.id === currentStreamingCharId)
    : undefined

  // UEX-P1-12：生成中才显示（常驻会遮噪消息区，收起）
  if (!isStreaming) return null

  return (
    <div
      data-testid="group-member-bar"
      className="border-t border-tavern-border-soft bg-tavern-bg-soft px-3 py-2 flex items-center gap-2 overflow-x-auto"
    >
      {/* ---- 生成中 + 当前说话者 + 接力进度 x/N ---- */}
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-tavern-text-soft">
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-tavern-accent opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-tavern-accent" />
        </span>
        生成中
      </span>
      <span
        data-testid="group-member-bar-speaker"
        className="shrink-0 text-[11px] text-tavern-text-muted"
      >
        {currentStreamingCharId
          ? `当前说话者 ${getDisplayName(speaker) || '未知'}`
          : '等待下一位发言'}
      </span>
      <span
        data-testid="group-member-bar-progress"
        aria-label="成员接力进度"
        className="shrink-0 rounded-full bg-tavern-accent-soft px-2 py-0.5 text-[10px] font-medium text-tavern-accent"
      >
        {speakerOrder}/{memberIds.length}
      </span>

      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-tavern-border-soft" />

      {/* ---- 成员接力队列：序号圆点 + 名字，当前说话者高亮（对齐 GroupChatMessage 发言者标识风格） ---- */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {memberIds.map((id, index) => {
          const member = characters.find((character) => character.id === id)
          const isCurrent = id === currentStreamingCharId
          const label = member ? getDisplayName(member) : '未知'
          return (
            <span
              key={id}
              data-testid="group-member-bar-member"
              data-char-id={id}
              data-current={isCurrent ? 'true' : 'false'}
              title={`第 ${index + 1} 位发言 · ${label}`}
              className={cn(
                'flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] transition-colors',
                isCurrent
                  ? 'bg-tavern-accent-soft font-medium text-tavern-accent ring-2 ring-tavern-accent/40 shadow-sm'
                  : 'bg-tavern-bg-hover text-tavern-text-muted',
              )}
              style={isCurrent && themeColor ? {
                backgroundColor: `${themeColor}20`,
                color: themeColor,
                boxShadow: `0 0 0 2px ${themeColor}66`,
              } : undefined}
            >
              {/* 序号圆点：与 x/N 的 x 同口径（成员序号，1 起） */}
              <span
                aria-hidden
                className={cn(
                  'grid h-4 w-4 place-items-center rounded-full text-[9px] font-bold',
                  isCurrent ? 'bg-tavern-accent text-white' : 'bg-tavern-bg text-tavern-text-muted',
                )}
                style={isCurrent && themeColor ? { backgroundColor: themeColor, color: '#fff' } : undefined}
              >
                {index + 1}
              </span>
              <span className="max-w-24 truncate">{label}</span>
            </span>
          )
        })}
      </div>

      {/* ---- UEX-P1-12：「停剩余」= 停止语义的独立按钮（stopStreaming 同义入口）：
           停止后续成员接力但保留已生成内容 ---- */}
      <button
        type="button"
        onClick={onStopRemaining}
        title="停止后续成员接力，保留已生成内容"
        aria-label="停剩余"
        className="flex shrink-0 items-center gap-1 rounded-lg border border-tavern-danger/30 bg-tavern-danger/10 px-2 py-1 text-[11px] font-medium text-tavern-danger transition-colors hover:bg-tavern-danger/20"
      >
        <Square className="h-3 w-3" aria-hidden />
        停剩余
      </button>
    </div>
  )
}
