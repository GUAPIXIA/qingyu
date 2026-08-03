import { Search, Check } from 'lucide-react'
import { Modal } from '../../components/common/Modal'
import { charAssetUrl } from '../../utils/asset'
import { cn } from '../../lib/utils'
import type { Character } from '../../../shared/types'

interface NewGroupModalProps {
  open: boolean
  characters: Character[]
  filteredCharacters: Character[]
  selectedMemberIds: string[]
  memberSearch: string
  onMemberSearchChange: (v: string) => void
  onToggleMember: (id: string) => void
  onCreate: () => void
  onClose: () => void
}

/** 新建群聊：角色选择弹窗 */
export function NewGroupModal(props: NewGroupModalProps) {
  const {
    open, characters, filteredCharacters, selectedMemberIds, memberSearch,
    onMemberSearchChange, onToggleMember, onCreate, onClose,
  } = props
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建群聊 - 选择角色"
      width="md"
      footer={
        <div className="flex items-center justify-between w-full">
          <span className="text-xs text-tavern-text-muted">
            已选 {selectedMemberIds.length} 位角色
            {selectedMemberIds.length > 0 && (
              <span className="ml-2 text-tavern-text-soft">
                群聊名称：{selectedMemberIds
                  .map(id => characters.find(c => c.id === id)?.name ?? '未知')
                  .join('、')}
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="btn-ghost text-xs">
              取消
            </button>
            <button
              onClick={onCreate}
              disabled={selectedMemberIds.length === 0}
              className="btn-primary text-xs"
            >
              创建群聊
            </button>
          </div>
        </div>
      }
    >
      {/* 搜索框 */}
      <div className="mb-2 relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-tavern-text-muted" />
        <input
          value={memberSearch}
          onChange={e => onMemberSearchChange(e.target.value)}
          placeholder="搜索角色名称、描述或标签..."
          className="w-full pl-8 pr-3 py-1.5 text-sm bg-tavern-bg border border-tavern-border rounded-lg text-tavern-text outline-none focus:border-tavern-accent"
          autoFocus
        />
      </div>

      <div className="space-y-1 max-h-72 overflow-y-auto">
        {characters.length === 0 ? (
          <div className="py-8 text-center text-sm text-tavern-text-muted">
            暂无角色，请先创建或导入角色
          </div>
        ) : filteredCharacters.length === 0 ? (
          <div className="py-8 text-center text-sm text-tavern-text-muted">
            未找到匹配的角色
          </div>
        ) : (
          filteredCharacters.map(char => {
            const selected = selectedMemberIds.includes(char.id)
            return (
              <div
                key={char.id}
                onClick={() => onToggleMember(char.id)}
                role="button"
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && onToggleMember(char.id)}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors',
                  selected
                    ? 'bg-tavern-accent-soft border border-tavern-accent'
                    : 'hover:bg-tavern-bg-hover border border-transparent'
                )}
              >
                {(char.avatar || charAssetUrl(char.id, 'avatar', char.updatedAt)) ? (
                  <img src={char.avatar || charAssetUrl(char.id, 'avatar', char.updatedAt)} className="w-9 h-9 rounded-lg object-cover shrink-0" alt="" />
                ) : (
                  <div className="w-9 h-9 rounded-lg bg-tavern-bg-hover flex items-center justify-center text-sm font-bold text-tavern-text-muted shrink-0">
                    {char.name[0]}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-tavern-text truncate">{char.name}</div>
                  {char.description && (
                    <div className="text-xs text-tavern-text-muted truncate">{char.description}</div>
                  )}
                </div>
                <div className={cn(
                  'w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors',
                  selected ? 'bg-tavern-accent border-tavern-accent' : 'border-tavern-border'
                )}>
                  {selected && <Check className="w-3 h-3 text-white" />}
                </div>
              </div>
            )
          })
        )}
      </div>
    </Modal>
  )
}
