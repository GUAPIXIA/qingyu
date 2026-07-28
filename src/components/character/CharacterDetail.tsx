import type { Character } from '../../../shared/types'
import { getDisplayName } from '../../utils/variables'
import { formatRelativeTime } from '../../utils/format'
import { X, Edit3, MessageSquare, Calendar, Tag, BookOpen, Sparkles, MessageCircle, MessagesSquare, Settings, Link2, User, Clock } from 'lucide-react'
import { useState } from 'react'

interface CharacterDetailProps {
  character: Character
  onClose: () => void
  onEdit: () => void
  onChat: () => void
}

function InfoRow({ icon: Icon, label, value, mono }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string | undefined | null; mono?: boolean }) {
  if (!value) return null
  return (
    <div className="flex gap-2.5">
      <Icon className="w-4 h-4 text-tavern-text-muted shrink-0 mt-0.5" />
      <div className="min-w-0">
        <span className="text-xs text-tavern-text-muted block">{label}</span>
        <p className={mono ? 'text-sm font-mono text-tavern-text-soft whitespace-pre-wrap break-words' : 'text-sm text-tavern-text whitespace-pre-wrap break-words'}>{value}</p>
      </div>
    </div>
  )
}

function Section({ icon: Icon, title, children }: { icon: React.ComponentType<{ className?: string }>; title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-tavern-border-soft pt-4">
      <h4 className="flex items-center gap-1.5 text-sm font-medium text-tavern-text mb-3">
        <Icon className="w-4 h-4 text-tavern-text-muted" />
        {title}
      </h4>
      {children}
    </section>
  )
}

function TagList({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <p className="text-sm text-tavern-text-muted italic">无</p>
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map(tag => (
        <span key={tag} className="px-2 py-0.5 rounded text-xs bg-tavern-bg-hover text-tavern-text-soft">{tag}</span>
      ))}
    </div>
  )
}

export function CharacterDetail({ character, onClose, onEdit, onChat }: CharacterDetailProps) {
  const [imgError, setImgError] = useState(false)
  const coverSrc = character.cover || character.avatar
  const hasTranslation = character.translatedContent && Object.keys(character.translatedContent).length > 0

  return (
    <>
      {/* 遮罩 */}
      <div className="fixed inset-0 bg-black/40 z-40 animate-fade-in" onClick={onClose} />

      {/* 侧边面板 */}
      <div className="fixed right-0 top-0 bottom-0 w-[420px] max-w-[90vw] z-50 bg-tavern-bg-card border-l border-tavern-border shadow-2xl flex flex-col animate-slide-in-right">
        {/* 顶部操作栏 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-tavern-border-soft shrink-0">
          <h2 className="font-display font-bold text-lg text-tavern-text truncate">{getDisplayName(character)}</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={onChat}
              className="p-2 rounded-lg bg-tavern-accent text-white hover:bg-tavern-accent-hover transition-colors"
              title="开始对话"
            >
              <MessageSquare className="w-4 h-4" />
            </button>
            <button
              onClick={onEdit}
              className="p-2 rounded-lg hover:bg-tavern-bg-hover text-tavern-text-soft hover:text-tavern-text transition-colors"
              title="编辑"
            >
              <Edit3 className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-tavern-bg-hover text-tavern-text-muted hover:text-tavern-text transition-colors"
              title="关闭"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* 滚动内容区 */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* 封面图 */}
          {coverSrc && !imgError && (
            <div className="rounded-xl overflow-hidden bg-tavern-bg-hover">
              <img
                src={coverSrc}
                alt={character.name}
                className="w-full max-h-48 object-contain"
                onError={() => setImgError(true)}
              />
            </div>
          )}

          {/* 基本信息 */}
          <section className="space-y-2.5">
            <div className="flex flex-wrap gap-1.5">
              {character.pinned && (
                <span className="px-2 py-0.5 rounded text-xs bg-tavern-accent/10 text-tavern-accent font-medium">已置顶</span>
              )}
            </div>
            <InfoRow icon={User} label="创作者" value={character.creator || undefined} />
            <div className="flex gap-2.5">
              <Clock className="w-4 h-4 text-tavern-text-muted shrink-0 mt-0.5" />
              <div className="min-w-0 space-y-1">
                <span className="text-xs text-tavern-text-muted block">时间</span>
                <p className="text-sm text-tavern-text">
                  创建于 {new Date(character.createdAt).toLocaleDateString('zh-CN')}
                  <span className="text-tavern-text-muted mx-1.5">·</span>
                  更新于 {formatRelativeTime(character.updatedAt)}
                </p>
              </div>
            </div>
          </section>

          {/* 标签 */}
          <Section icon={Tag} title="标签">
            <TagList tags={character.tags} />
          </Section>

          {/* 角色设定 */}
          <Section icon={BookOpen} title="角色设定">
            <div className="space-y-3">
              <InfoRow icon={BookOpen} label="描述" value={(character.translatedContent?.description ?? character.description) || undefined} />
              <InfoRow icon={Sparkles} label="性格特征" value={(character.translatedContent?.personality ?? character.personality) || undefined} />
              <InfoRow icon={MessageCircle} label="场景设定" value={(character.translatedContent?.scenario ?? character.scenario) || undefined} />
            </div>
          </Section>

          {/* 对话设定 */}
          {(character.firstMessage || character.alternateGreetings?.length > 0 || character.exampleDialog || character.groupOnlyGreetings?.length > 0) && (
            <Section icon={MessagesSquare} title="对话设定">
              <div className="space-y-3">
                <InfoRow icon={MessageSquare} label="首条消息" value={(character.translatedContent?.firstMessage ?? character.firstMessage) || undefined} />
                {character.alternateGreetings.length > 0 && (
                  <InfoRow icon={MessagesSquare} label={`备选问候语 (${character.alternateGreetings.length})`} value={character.alternateGreetings.join('\n\n')} />
                )}
                <InfoRow icon={MessageCircle} label="对话示例" value={(character.translatedContent?.exampleDialog ?? character.exampleDialog) || undefined} mono />
                {character.groupOnlyGreetings && character.groupOnlyGreetings.length > 0 && (
                  <InfoRow icon={MessagesSquare} label={`群聊专属问候 (${character.groupOnlyGreetings.length})`} value={character.groupOnlyGreetings.join('\n\n')} />
                )}
              </div>
            </Section>
          )}

          {/* 高级设定 */}
          {(character.systemPrompt || character.postHistoryInstructions) && (
            <Section icon={Settings} title="高级设定">
              <div className="space-y-3">
                <InfoRow icon={Settings} label="系统提示词（覆盖预设）" value={character.systemPrompt || undefined} mono />
                <InfoRow icon={Settings} label="对话历史后注入" value={character.postHistoryInstructions || undefined} />
              </div>
            </Section>
          )}

          {/* 绑定信息 */}
          {(character.boundPresetId || (character.boundLorebookIds && character.boundLorebookIds.length > 0)) && (
            <Section icon={Link2} title="绑定设置">
              <div className="space-y-2 text-sm text-tavern-text-soft">
                {character.boundPresetId && <p>🔧 绑定了预设（切换时自动激活）</p>}
                {character.boundLorebookIds && character.boundLorebookIds.length > 0 && (
                  <p>📚 绑定了 {character.boundLorebookIds.length} 本世界书（切换时自动激活）</p>
                )}
              </div>
            </Section>
          )}

          {/* 翻译内容对照 */}
          {hasTranslation && character.translatedContent && (
            <Section icon={Sparkles} title="AI 翻译内容">
              <div className="space-y-2 text-sm">
                {character.translatedContent.name && (
                  <div className="flex gap-2">
                    <span className="text-tavern-text-muted shrink-0">名称:</span>
                    <span className="text-tavern-text-soft">{character.translatedContent.name}</span>
                  </div>
                )}
                {/* Only show translation entries that differ from originals and aren't already shown above */}
              </div>
            </Section>
          )}

          {/* 底部留白 */}
          <div className="h-4" />
        </div>

        {/* 底部操作 */}
        <div className="px-5 py-3 border-t border-tavern-border-soft shrink-0 flex gap-2">
          <button onClick={onChat} className="btn-primary flex-1 flex items-center justify-center gap-2">
            <MessageSquare className="w-4 h-4" />
            开始对话
          </button>
          <button onClick={onEdit} className="btn-secondary flex items-center justify-center gap-2">
            <Edit3 className="w-4 h-4" />
            编辑
          </button>
        </div>
      </div>
    </>
  )
}
