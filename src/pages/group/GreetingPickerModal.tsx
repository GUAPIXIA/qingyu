import { Users } from 'lucide-react'
import { Modal } from '../../components/common/Modal'
import { useCharacterStore } from '../../store/useCharacterStore'
import { useGroupChatStore } from '../../store/useGroupChatStore'
import { charAssetUrl } from '../../utils/asset'
import type { GroupChat } from '../../../shared/types'

interface GreetingPickerModalProps {
  open: boolean
  group: GroupChat | null
  messagesCount: number
  isStreaming: boolean
  onClose: () => void
}

/** 群聊开场白选择弹窗：展示每位角色的开场白，点击后以该角色身份插入 */
export function GreetingPickerModal({ open, group, messagesCount, isStreaming, onClose }: GreetingPickerModalProps) {
  const { characters } = useCharacterStore()
  if (!open || !group || messagesCount > 0 || isStreaming) return null

  const memberGreetings: { charId: string; charName: string; avatar?: string; greetings: string[] }[] = []
  group.memberIds.forEach(id => {
    const char = characters.find(c => c.id === id)
    const displayName = char?.translatedContent?.name ?? char?.name ?? ''
    if (char?.groupOnlyGreetings && char.groupOnlyGreetings.length > 0) {
      memberGreetings.push({ charId: id, charName: displayName, avatar: char.avatar || charAssetUrl(char.id, 'avatar', char.updatedAt), greetings: char.groupOnlyGreetings })
    } else if (char?.firstMessage) {
      const displayFirstMsg = char.translatedContent?.firstMessage ?? char.firstMessage
      memberGreetings.push({ charId: id, charName: displayName, avatar: char.avatar || charAssetUrl(char.id, 'avatar', char.updatedAt), greetings: [displayFirstMsg] })
    }
  })
  if (memberGreetings.length === 0) return null

  return (
    <Modal
      open={true}
      onClose={onClose}
      width="custom"
      widthClassName="w-[560px]"
      headerClassName="px-5 py-4 bg-tavern-bg-soft"
      header={
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-tavern-accent-soft text-tavern-accent"
            style={group.themeColor ? { backgroundColor: `${group.themeColor}20`, color: group.themeColor } : undefined}
          >
            <Users className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-display font-bold text-lg truncate">{group.name}</h3>
            <p className="text-xs text-tavern-text-muted">
              选择一个开场白开始群聊对话 · {memberGreetings.length} 位角色
            </p>
          </div>
        </div>
      }
      footer={
        <>
          <span className="text-xs text-tavern-text-muted mr-auto">
            点击任意开场白开始群聊，或
          </span>
          <button
            className="btn-secondary text-xs"
            onClick={onClose}
          >
            跳过，手动开始
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {memberGreetings.map((member) => (
          <div key={member.charId} className="space-y-1.5">
            <div className="flex items-center gap-2 px-1">
              {member.avatar ? (
                <img src={member.avatar} className="w-5 h-5 rounded-full object-cover" alt="" />
              ) : (
                <div className="w-5 h-5 rounded-full bg-tavern-bg-hover flex items-center justify-center text-[10px] font-bold text-tavern-text-muted">
                  {member.charName[0]}
                </div>
              )}
              <span className="text-xs font-medium text-tavern-text">{member.charName}</span>
              <span className="text-[10px] text-tavern-text-muted">{member.greetings.length} 条开场白</span>
            </div>
            {member.greetings.map((greeting, gi) => (
              <button
                key={`${member.charId}-${gi}`}
                onClick={async () => {
                  onClose()
                  const { currentSessionId } = useGroupChatStore.getState()
                  if (!currentSessionId) return
                  const { insertCharacterMessage } = useGroupChatStore.getState()
                  await insertCharacterMessage(member.charId, greeting)
                }}
                className="w-full text-left px-3 py-2.5 rounded-lg border border-tavern-border-soft hover:bg-tavern-accent-soft/30 text-xs text-tavern-text transition-all group"
                style={group.themeColor ? { ['--gc-theme' as string]: group.themeColor } : undefined}
              >
                <span className="text-tavern-text-muted text-[10px] block mb-0.5">
                  {member.greetings.length > 1 ? `开场白 #${gi + 1}` : '开场白'}
                </span>
                <span className="line-clamp-3 whitespace-pre-wrap">{greeting}</span>
                <div className="mt-2 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                  style={group.themeColor ? { color: group.themeColor } : undefined}>
                  点击以 {member.charName} 的身份发送此开场白
                </div>
              </button>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  )
}
