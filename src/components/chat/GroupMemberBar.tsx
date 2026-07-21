import { useCharacterStore } from '../../store/useCharacterStore'
import { cn } from '../../lib/utils'

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
      {members.map((m, idx) => (
        <button
          key={m.id}
          onClick={() => onSpeakerClick?.(m.id)}
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-full text-xs transition-colors shrink-0',
            idx === currentSpeakerIndex
              ? 'bg-tavern-accent-soft text-tavern-accent ring-1 ring-tavern-accent/30'
              : 'bg-tavern-bg-hover text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg'
          )}
          style={idx === currentSpeakerIndex && themeColor ? {
            backgroundColor: `${themeColor}20`,
            color: themeColor,
            boxShadow: `0 0 0 1px ${themeColor}4D`,
          } : undefined}
          title={m.translatedContent?.name ?? m.name}
        >
          {m.avatar ? (
            <img src={m.avatar} className="w-5 h-5 rounded-full object-cover" alt="" />
          ) : (
            <div className="w-5 h-5 rounded-full bg-tavern-bg flex items-center justify-center text-[10px] font-bold">
              {m.translatedContent?.name?.[0] ?? m.name[0]}
            </div>
          )}
          <span>{m.translatedContent?.name ?? m.name}</span>
          {idx === currentSpeakerIndex && (
            <span className="text-[10px] opacity-60">发言中</span>
          )}
        </button>
      ))}
    </div>
  )
}
