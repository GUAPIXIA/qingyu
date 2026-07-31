import { useCharacterStore } from '../../store/useCharacterStore'
import { cn } from '../../lib/utils'
import { getDisplayName } from '../../utils/variables'
import { charAssetUrl } from '../../utils/asset'
import { MessageSquare } from 'lucide-react'

interface GroupMemberBarProps {
  memberIds: string[]
  currentSpeakerIndex: number
  onSpeakerClick?: (charId: string) => void
  themeColor?: string
}

export function GroupMemberBar({ memberIds, currentSpeakerIndex, onSpeakerClick, themeColor }: GroupMemberBarProps) {
  const { characters } = useCharacterStore()
  const members = memberIds
    .map(id => characters.find(c => c.id === id))
    .filter(Boolean) as NonNullable<typeof characters[number]>[]

  if (members.length === 0) return null

  return (
    <div className="border-t border-tavern-border-soft bg-tavern-bg-soft px-3 py-2 flex items-center gap-3 overflow-x-auto">
      <span className="text-[10px] text-tavern-text-muted shrink-0 font-medium">成员</span>
      {members.map((m) => {
        // 用角色 ID 匹配 currentSpeakerIndex，避免过滤后索引错位
        const isCurrent = m.id === memberIds[currentSpeakerIndex]
        return (
          <button
            key={m.id}
            onClick={() => onSpeakerClick?.(m.id)}
            className={cn(
              'flex items-center gap-1.5 px-2 py-1 rounded-full text-xs transition-all shrink-0 relative',
              isCurrent
                ? 'bg-tavern-accent-soft text-tavern-accent ring-2 ring-tavern-accent/50 shadow-sm'
                : 'bg-tavern-bg-hover text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg'
            )}
            style={isCurrent && themeColor ? {
              backgroundColor: `${themeColor}20`,
              color: themeColor,
              boxShadow: `0 0 0 2px ${themeColor}80, 0 2px 8px ${themeColor}30`,
            } : undefined}
            title={getDisplayName(m)}
          >
            {/* 头像带呼吸动画指示器 */}
            <div className="relative">
              {(m.avatar || charAssetUrl(m.id, 'avatar', m.updatedAt)) ? (
                <img src={m.avatar || charAssetUrl(m.id, 'avatar', m.updatedAt)} className={cn(
                  'w-5 h-5 rounded-full object-cover',
                  isCurrent && 'ring-2 ring-current/30'
                )} alt="" />
              ) : (
                <div className={cn(
                  'w-5 h-5 rounded-full bg-tavern-bg flex items-center justify-center text-[10px] font-bold',
                  isCurrent && 'ring-2 ring-current/30'
                )}>
                  {m.translatedContent?.name?.[0] ?? m.name[0]}
                </div>
              )}
              {isCurrent && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-tavern-accent animate-pulse" />
              )}
            </div>
            <span className={cn(isCurrent && 'font-medium')}>{getDisplayName(m)}</span>
            {isCurrent && (
              <MessageSquare className="w-3 h-3 opacity-70" />
            )}
          </button>
        )
      })}
    </div>
  )
}
