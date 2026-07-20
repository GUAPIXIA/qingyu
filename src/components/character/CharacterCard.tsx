import type { Character } from '../../../shared/types'
import { useCharacterStore } from '../../store/useCharacterStore'
import { formatRelativeTime } from '../../utils/format'
import { Edit3, Trash2, MessageSquare, Download } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../lib/utils'

interface CharacterCardProps {
  character: Character
  onEdit: () => void
  onDelete: () => void
  onChat: () => void
  viewMode?: 'grid' | 'list'
}

export function CharacterCard({ character, onEdit, onDelete, onChat, viewMode = 'grid' }: CharacterCardProps) {
  const { exportPng, exportJson } = useCharacterStore()
  const [showMenu, setShowMenu] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [showPreview, setShowPreview] = useState(false)

  const handlePreviewClick = () => {
    if (character.avatar && !imgError) setShowPreview(true)
  }

  const renderAvatar = (className: string) => (
    <div
      className={cn('bg-tavern-bg-hover overflow-hidden cursor-pointer', className)}
      onClick={handlePreviewClick}
    >
      {character.avatar && !imgError ? (
        <img
          src={character.avatar}
          alt={character.name}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          onError={() => setImgError(true)}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <span className={cn('font-display text-tavern-text-muted', viewMode === 'list' ? 'text-xl' : 'text-4xl')}>
            {character.name[0]}
          </span>
        </div>
      )}
    </div>
  )

  const actionButtons = (
    <>
      <button
        onClick={onChat}
        className="p-2 rounded-lg bg-tavern-accent text-tavern-bg hover:bg-tavern-accent-hover transition-colors"
        title="开始对话"
      >
        <MessageSquare className="w-4 h-4" />
      </button>
      <button
        onClick={onEdit}
        className="p-2 rounded-lg bg-tavern-bg-card/90 text-tavern-text hover:bg-tavern-bg-card transition-colors"
        title="编辑"
      >
        <Edit3 className="w-4 h-4" />
      </button>
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="p-2 rounded-lg bg-tavern-bg-card/90 text-tavern-text hover:bg-tavern-bg-card transition-colors relative"
        title="导出"
      >
        <Download className="w-4 h-4" />
        {showMenu && (
          <>
            <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setShowMenu(false) }} />
            <div className="absolute bottom-full right-0 mb-1 z-20 bg-tavern-bg-card border border-tavern-border rounded-lg shadow-xl py-1 text-sm min-w-[120px]">
              <button
                onClick={(e) => { e.stopPropagation(); exportPng(character.id); setShowMenu(false) }}
                className="w-full px-4 py-2 text-left hover:bg-tavern-bg-hover transition-colors flex items-center gap-2"
              >
                <Download className="w-3.5 h-3.5" />
                导出 PNG
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); exportJson(character.id); setShowMenu(false) }}
                className="w-full px-4 py-2 text-left hover:bg-tavern-bg-hover transition-colors flex items-center gap-2"
              >
                <Download className="w-3.5 h-3.5" />
                导出 JSON
              </button>
            </div>
          </>
        )}
      </button>
      <button
        onClick={onDelete}
        className="p-2 rounded-lg bg-tavern-danger/90 text-white hover:bg-tavern-danger transition-colors"
        title="删除角色"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </>
  )

  // 列表模式：横向卡片
  if (viewMode === 'list') {
    return (
      <>
        <div className="flex gap-4 p-3 rounded-xl border border-tavern-border-soft bg-tavern-bg-card hover:border-tavern-accent/50 transition-colors">
          {/* 左侧封面 */}
          <div className="shrink-0">
            {renderAvatar('w-24 h-32 rounded-lg overflow-hidden')}
          </div>

          {/* 右侧信息 */}
          <div className="flex-1 min-w-0 flex flex-col justify-between">
            <div>
              <h3 className="font-medium text-tavern-text">{character.name}</h3>
              {character.description && (
                <p className="text-sm text-tavern-text-muted mt-1 line-clamp-3">{character.description}</p>
              )}
              <div className="flex gap-1 flex-wrap mt-2">
                {character.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-1.5 py-0.5 rounded text-xs bg-tavern-bg-hover text-tavern-text-soft"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs text-tavern-text-muted">{formatRelativeTime(character.updatedAt)}</span>
              <div className="flex gap-1">
                {actionButtons}
              </div>
            </div>
          </div>
        </div>

        {/* 大图预览 */}
        {showPreview && character.avatar && (
          <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8 animate-fade-in"
            onClick={() => setShowPreview(false)}
          >
            <button
              className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors text-lg"
              onClick={() => setShowPreview(false)}
            >
              ✕
            </button>
            <img
              src={character.avatar}
              alt={character.name}
              className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
      </>
    )
  }

  // 网格模式：现有卡片样式
  return (
    <div className="card overflow-hidden group hover:border-tavern-accent transition-colors">
      {/* 头像区 */}
      <div className="relative">
        {renderAvatar('aspect-[3/4]')}

        {/* 操作按钮悬浮 */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-end p-2 gap-1 pointer-events-none">
          <div className="pointer-events-auto flex gap-1">
            {actionButtons}
          </div>
        </div>
      </div>

      {/* 信息区 */}
      <div className="p-3">
        <h3 className="font-medium text-tavern-text truncate">{character.name}</h3>
        {character.description && (
          <p className="text-xs text-tavern-text-muted mt-0.5 line-clamp-2 h-8">
            {character.description}
          </p>
        )}
        <div className="flex items-center justify-between mt-2">
          <div className="flex gap-1 flex-wrap">
            {character.tags.slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="px-1.5 py-0.5 rounded text-xs bg-tavern-bg-hover text-tavern-text-soft"
              >
                {tag}
              </span>
            ))}
          </div>
          <span className="text-xs text-tavern-text-muted">
            {formatRelativeTime(character.updatedAt)}
          </span>
        </div>
      </div>

      {/* 大图预览 */}
      {showPreview && character.avatar && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8 animate-fade-in"
          onClick={() => setShowPreview(false)}
        >
          <button
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors text-lg"
            onClick={() => setShowPreview(false)}
          >
            ✕
          </button>
          <img
            src={character.avatar}
            alt={character.name}
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}
