import { useNavigate } from 'react-router-dom'
import { Loader2, Save, ImageOff } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useCharacterCreatorStore } from '../../store/useCharacterCreatorStore'
import type { AvatarPosition } from '../../store/useCharacterCreatorStore'

const POSITION_OPTIONS: { value: AvatarPosition; label: string; hint: string }[] = [
  { value: 'top', label: '偏上', hint: '保留头部' },
  { value: 'center', label: '居中', hint: '默认' },
  { value: 'bottom', label: '偏下', hint: '保留全身' },
]

export function ReviewStep() {
  const navigate = useNavigate()
  const draft = useCharacterCreatorStore((s) => s.draft)
  const coverBase64 = useCharacterCreatorStore((s) => s.coverBase64)
  const avatarPosition = useCharacterCreatorStore((s) => s.avatarPosition)
  const setAvatarPosition = useCharacterCreatorStore((s) => s.setAvatarPosition)
  const isSaving = useCharacterCreatorStore((s) => s.isSaving)
  const error = useCharacterCreatorStore((s) => s.error)
  const saveCharacter = useCharacterCreatorStore((s) => s.saveCharacter)

  const handleSave = async () => {
    const saved = await saveCharacter()
    if (saved) navigate('/chat')
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-5 items-start">
      {/* 封面 + 头像位置 */}
      <div className="space-y-3">
        <div className="relative aspect-[3/4] w-full rounded-xl border border-tavern-border-soft bg-tavern-bg-soft overflow-hidden flex items-center justify-center">
          {coverBase64 ? (
            <img src={coverBase64} alt="封面" className="w-full h-full object-cover" />
          ) : (
            <div className="text-center text-tavern-text-muted p-4">
              <ImageOff className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-xs">无封面</p>
            </div>
          )}
        </div>
        {coverBase64 && (
          <div className="field-card p-3">
            <label className="label mb-2 text-xs">头像裁剪位置（从封面 1:1 裁剪）</label>
            <div className="grid grid-cols-3 gap-1.5">
              {POSITION_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setAvatarPosition(opt.value)}
                  className={cn(
                    'px-2 py-1.5 rounded-lg text-xs border transition-colors',
                    avatarPosition === opt.value
                      ? 'bg-tavern-accent-soft border-tavern-accent/40 text-tavern-accent'
                      : 'border-tavern-border text-tavern-text-soft hover:border-tavern-accent/50',
                  )}
                  title={opt.hint}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 角色信息摘要 */}
      <div className="space-y-4">
        <div className="field-card">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-lg font-bold">
              {draft.name.trim() || '未命名角色'}
              {!draft.name.trim() && (
                <span className="text-xs font-normal text-tavern-text-muted ml-2">保存时将命名为「未命名角色」</span>
              )}
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {draft.tags.map((t) => (
                <span key={t} className="px-2 py-0.5 rounded-full bg-tavern-accent-soft text-tavern-accent text-xs">
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <PreviewField label="角色描述" text={draft.description} />
          <PreviewField label="性格特征" text={draft.personality} />
          <PreviewField label="场景设定" text={draft.scenario} />
          <PreviewField label="首条消息" text={draft.firstMessage} />
          <div className="sm:col-span-2">
            <PreviewField label="对话示例" text={draft.exampleDialog} mono />
          </div>
        </div>

        {error && (
          <div className="px-3 py-2 rounded-lg bg-tavern-danger/10 border border-tavern-danger/30 text-tavern-danger text-sm">
            {error}
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="btn-primary px-6"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                保存中…
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                保存角色
              </>
            )}
          </button>
          <span className="text-xs text-tavern-text-muted">
            保存后将创建角色并跳转到对话
          </span>
        </div>
      </div>
    </div>
  )
}

function PreviewField({ label, text, mono }: { label: string; text: string; mono?: boolean }) {
  return (
    <div className="field-card">
      <label className="label mb-1 text-xs">{label}</label>
      {text ? (
        <p className={cn('text-sm text-tavern-text whitespace-pre-wrap line-clamp-4', mono && 'font-mono text-xs')}>
          {text}
        </p>
      ) : (
        <p className="text-xs text-tavern-text-muted">（未填写）</p>
      )}
    </div>
  )
}
