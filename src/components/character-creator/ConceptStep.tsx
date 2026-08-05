import { useState } from 'react'
import { Sparkles, Wand2, X, Loader2, AlertCircle, Plus, Trash2, SlidersHorizontal } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useCharacterCreatorStore } from '../../store/useCharacterCreatorStore'
import type { GenerateField } from '../../store/useCharacterCreatorStore'
import type { AuthorNoteConfig } from '../../../shared/types'

/* ===================== 通用「帮我写」小组件 ===================== */

interface AiHelpButtonProps {
  generating: boolean
  open: boolean
  onToggle: () => void
  className?: string
}

/** 「帮我写 / 收起」按钮 */
function AiHelpButton({ generating, open, onToggle, className }: AiHelpButtonProps) {
  return (
    <button
      type="button"
      onClick={() => {
        if (!generating) onToggle()
      }}
      disabled={generating}
      className={cn(
        'flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors shrink-0',
        generating
          ? 'text-tavern-accent cursor-wait'
          : open
            ? 'text-tavern-accent bg-tavern-accent-soft'
            : 'text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent-soft',
        className,
      )}
    >
      {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
      {generating ? '生成中…' : open ? '收起' : '帮我写'}
    </button>
  )
}

interface AiInputPanelProps {
  targetLabel: string
  generating: boolean
  onCancel: () => void
  onGenerate: (input: string) => void
}

/** 用户输入面板：填入想法/草稿，AI 据此生成或修改 */
function AiInputPanel({ targetLabel, generating, onCancel, onGenerate }: AiInputPanelProps) {
  const [userInput, setUserInput] = useState('')
  const handleGenerate = () => {
    onGenerate(userInput)
    setUserInput('')
  }
  return (
    <div className="mt-2.5 rounded-lg border border-tavern-accent/30 bg-tavern-bg-card p-2.5 space-y-2 animate-fade-in">
      <textarea
        autoFocus
        value={userInput}
        onChange={(e) => setUserInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            handleGenerate()
          }
        }}
        placeholder={`告诉 AI 你想要什么：可写方向或草稿片段，AI 将据此生成/修改${targetLabel}\n例：想写一个说话带刺的傲娇少女，开场白要有点火药味`}
        className="textarea min-h-[70px] resize-y text-xs"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-tavern-text-muted">Ctrl+Enter 快速生成 · 留空则 AI 自主创作</span>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary text-xs" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn-primary text-xs" onClick={handleGenerate} disabled={generating}>
            {generating ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                生成中…
              </>
            ) : (
              <>
                <Wand2 className="w-3.5 h-3.5" />
                生成{userInput.trim() ? '并修改' : ''}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ===================== 字段卡片 ===================== */

interface FieldCardProps {
  label: string
  field: GenerateField
  hint?: string
  className?: string
  children?: React.ReactNode
}

/** 字段卡片：label + 帮我写按钮 + 内容 */
function FieldCard({ label, field, hint, className, children }: FieldCardProps) {
  const generatingField = useCharacterCreatorStore((s) => s.generatingField)
  const aiGenerateField = useCharacterCreatorStore((s) => s.aiGenerateField)
  const isGenerating = generatingField === field
  const [open, setOpen] = useState(false)

  return (
    <div className={cn('field-card', className)}>
      <div className="flex items-center justify-between mb-1.5">
        <label className="label mb-0">
          {label}
          {hint && <span className="text-xs text-tavern-text-muted ml-1.5 font-normal">{hint}</span>}
        </label>
        <AiHelpButton
          generating={isGenerating}
          open={open}
          onToggle={() => {
            setOpen(!open)
          }}
        />
      </div>
      {children}
      {open && (
        <AiInputPanel
          targetLabel={`「${label}」`}
          generating={isGenerating}
          onCancel={() => setOpen(false)}
          onGenerate={(input) => {
            aiGenerateField(field, input)
            setOpen(false)
          }}
        />
      )}
    </div>
  )
}

/** 标签编辑器 */
function TagEditor() {
  const draft = useCharacterCreatorStore((s) => s.draft)
  const updateDraft = useCharacterCreatorStore((s) => s.updateDraft)
  const [tagInput, setTagInput] = useState('')

  const handleAddTag = () => {
    const tag = tagInput.trim()
    if (!tag) return
    if (!draft.tags.includes(tag)) {
      updateDraft({ tags: [...draft.tags, tag].slice(0, 8) })
    }
    setTagInput('')
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {draft.tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-tavern-accent-soft text-tavern-accent text-xs"
        >
          {tag}
          <button
            type="button"
            onClick={() => updateDraft({ tags: draft.tags.filter((t) => t !== tag) })}
            className="hover:opacity-70"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={tagInput}
        onChange={(e) => setTagInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            handleAddTag()
          }
        }}
        onBlur={handleAddTag}
        placeholder={draft.tags.length >= 8 ? '最多 8 个标签' : '输入标签后回车'}
        disabled={draft.tags.length >= 8}
        className="input w-32 min-h-0 py-1 text-xs"
      />
    </div>
  )
}

/** 首条消息卡片：主消息 + 多条备选开场白（alternateGreetings），每条可独立 AI 生成 */
function GreetingCard() {
  const draft = useCharacterCreatorStore((s) => s.draft)
  const updateDraft = useCharacterCreatorStore((s) => s.updateDraft)
  const generatingIndex = useCharacterCreatorStore((s) => s.generatingGreetingIndex)
  const aiGenerateGreeting = useCharacterCreatorStore((s) => s.aiGenerateGreeting)
  /** 打开的输入面板：-1 = 主消息，>=0 = 备选开场白 i，null = 全部收起 */
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  const variants = draft.alternateGreetings ?? []

  const updateVariant = (i: number, value: string) => {
    const next = [...variants]
    next[i] = value
    updateDraft({ alternateGreetings: next })
  }

  return (
    <div className="field-card lg:col-span-2">
      <div className="flex items-center justify-between mb-1.5">
        <label className="label mb-0">
          首条消息
          <span className="text-xs text-tavern-text-muted ml-1.5 font-normal">
            可添加多条备选开场白，新对话时选择
          </span>
        </label>
        <AiHelpButton
          generating={generatingIndex === -1}
          open={openIndex === -1}
          onToggle={() => setOpenIndex(openIndex === -1 ? null : -1)}
        />
      </div>

      {/* 主消息 */}
      <textarea
        value={draft.firstMessage}
        onChange={(e) => updateDraft({ firstMessage: e.target.value })}
        placeholder={'*手指在虚拟键盘上飞速跳动*\n"来了？我等你好久了。"'}
        className="textarea min-h-[90px] resize-y"
      />
      {openIndex === -1 && (
        <AiInputPanel
          targetLabel="主首条消息"
          generating={generatingIndex === -1}
          onCancel={() => setOpenIndex(null)}
          onGenerate={(input) => {
            aiGenerateGreeting(-1, input)
            setOpenIndex(null)
          }}
        />
      )}

      {/* 备选开场白列表 */}
      {variants.map((greeting, i) => (
        <div
          key={i}
          className="mt-3 rounded-lg border border-tavern-border-soft bg-tavern-bg-card/60 p-2.5"
        >
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-tavern-text-soft">备选开场白 {i + 1}</span>
            <div className="flex items-center gap-1">
              <AiHelpButton
                generating={generatingIndex === i}
                open={openIndex === i}
                onToggle={() => setOpenIndex(openIndex === i ? null : i)}
              />
              <button
                type="button"
                onClick={() => updateDraft({ alternateGreetings: variants.filter((_, j) => j !== i) })}
                className="p-1 rounded text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-danger/10 transition-colors"
                title="删除此备选开场白"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <textarea
            value={greeting}
            onChange={(e) => updateVariant(i, e.target.value)}
            placeholder={`备选开场白 ${i + 1}：与主消息不同风格的开场白`}
            className="textarea min-h-[70px] resize-y"
          />
          {openIndex === i && (
            <AiInputPanel
              targetLabel={`备选开场白 ${i + 1}`}
              generating={generatingIndex === i}
              onCancel={() => setOpenIndex(null)}
              onGenerate={(input) => {
                aiGenerateGreeting(i, input)
                setOpenIndex(null)
              }}
            />
          )}
        </div>
      ))}

      {/* 添加备选开场白 */}
      {variants.length < 6 && (
        <button
          type="button"
          onClick={() => updateDraft({ alternateGreetings: [...variants, ''] })}
          className="mt-2.5 flex items-center gap-1 text-xs text-tavern-accent hover:opacity-80 transition-opacity"
        >
          <Plus className="w-3.5 h-3.5" />
          添加备选开场白
        </button>
      )}
    </div>
  )
}

/** 高级设置（可选）：默认记忆 / 作者注释 / 创作者备注 */
function AdvancedSettings() {
  const draft = useCharacterCreatorStore((s) => s.draft)
  const updateDraft = useCharacterCreatorStore((s) => s.updateDraft)

  const updateAuthorNote = (patch: Partial<AuthorNoteConfig>) => {
    const current: AuthorNoteConfig = draft.authorNote ?? {
      enabled: false,
      text: '',
      position: 'top',
      depth: 0,
    }
    updateDraft({ authorNote: { ...current, ...patch } })
  }

  return (
    <div className="field-card">
      <div className="flex items-center gap-2 mb-3">
        <SlidersHorizontal className="w-4 h-4 text-tavern-text-muted" />
        <span className="font-medium text-sm">高级设置（可选）</span>
        <span className="text-xs text-tavern-text-muted">不填也能保存角色</span>
      </div>
      <div className="space-y-4">
        {/* 默认记忆设置 */}
        <div>
          <label className="label mb-2">长记忆默认设置（新会话继承，会话内可单独覆盖）</label>
          <div className="flex items-center gap-4 flex-wrap">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={!!draft.defaultMemoryEnabled}
                onChange={(e) => updateDraft({ defaultMemoryEnabled: e.target.checked })}
                className="accent-[var(--tavern-accent)]"
              />
              默认开启长记忆
            </label>
            <label className="flex items-center gap-2 text-sm">
              模式
              <select
                value={draft.defaultMemoryMode ?? 'auto'}
                onChange={(e) =>
                  updateDraft({ defaultMemoryMode: e.target.value as 'manual' | 'auto' })
                }
                className="input min-h-0 py-1 w-auto"
              >
                <option value="auto">自动</option>
                <option value="manual">手动</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              自动摘要间隔
              <input
                type="number"
                min={1}
                max={100}
                value={draft.defaultMemoryInterval ?? 10}
                onChange={(e) =>
                  updateDraft({ defaultMemoryInterval: Math.max(1, Math.min(100, Number(e.target.value) || 10)) })
                }
                className="input min-h-0 py-1 w-16"
              />
              条消息
            </label>
          </div>
        </div>

        {/* 作者注释 */}
        <div className="pt-3 border-t border-tavern-border-soft">
          <div className="flex items-center justify-between mb-2">
            <label className="label mb-0">
              作者注释
              <span className="text-xs text-tavern-text-muted ml-1.5 font-normal">
                注入到上下文中引导模型（未设置时使用全局）
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={!!draft.authorNote?.enabled}
                onChange={(e) => updateAuthorNote({ enabled: e.target.checked })}
                className="accent-[var(--tavern-accent)]"
              />
              启用
            </label>
          </div>
          {draft.authorNote?.enabled && (
            <div className="space-y-3">
              <textarea
                value={draft.authorNote?.text ?? ''}
                onChange={(e) => updateAuthorNote({ text: e.target.value })}
                placeholder="如：这个故事发生在 2087 年的新上海，角色说话简洁、常用黑客术语…"
                className="textarea min-h-[80px] resize-y"
              />
              <div className="flex items-center gap-4 flex-wrap">
                <label className="flex items-center gap-2 text-sm">
                  注入位置
                  <select
                    value={draft.authorNote?.position ?? 'top'}
                    onChange={(e) =>
                      updateAuthorNote({ position: e.target.value as AuthorNoteConfig['position'] })
                    }
                    className="input min-h-0 py-1 w-auto"
                  >
                    <option value="top">系统提示后</option>
                    <option value="middle">历史消息中</option>
                    <option value="bottom">历史消息末尾</option>
                  </select>
                </label>
                {draft.authorNote?.position === 'middle' && (
                  <label className="flex items-center gap-2 text-sm">
                    注入深度
                    <input
                      type="number"
                      min={0}
                      max={20}
                      value={draft.authorNote?.depth ?? 0}
                      onChange={(e) => updateAuthorNote({ depth: Math.max(0, Number(e.target.value) || 0) })}
                      className="input min-h-0 py-1 w-16"
                    />
                    （0 = 对话末尾）
                  </label>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 创作者备注 */}
        <div className="pt-3 border-t border-tavern-border-soft">
          <label className="label mb-1.5">
            创作者备注
            <span className="text-xs text-tavern-text-muted ml-1.5 font-normal">
              隐藏元数据，导出角色卡时保留
            </span>
          </label>
          <textarea
            value={draft.creatorNotes ?? ''}
            onChange={(e) => updateDraft({ creatorNotes: e.target.value })}
            placeholder="角色卡来源、创作灵感等（对模型不可见）"
            className="textarea min-h-[60px] resize-y"
          />
        </div>
      </div>
    </div>
  )
}

/* ===================== Step 1 主组件 ===================== */

export function ConceptStep() {
  const [concept, setConcept] = useState('')
  const draft = useCharacterCreatorStore((s) => s.draft)
  const updateDraft = useCharacterCreatorStore((s) => s.updateDraft)
  const isExpanding = useCharacterCreatorStore((s) => s.isExpanding)
  const error = useCharacterCreatorStore((s) => s.error)
  const aiExpand = useCharacterCreatorStore((s) => s.aiExpand)
  const cancelExpand = useCharacterCreatorStore((s) => s.cancelExpand)

  return (
    <div className="space-y-5">
      {/* AI 一句话扩展 */}
      <div className="field-card border-tavern-accent/30">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles className="w-4 h-4 text-tavern-accent" />
          <span className="font-medium text-sm">AI 一句话扩展</span>
          <span className="text-xs text-tavern-text-muted">输入简短概念，AI 自动生成完整设定，再逐字段微调</span>
        </div>
        <div className="flex gap-2">
          <textarea
            value={concept}
            onChange={(e) => setConcept(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                aiExpand(concept)
              }
            }}
            placeholder="例：赛博朋克世界的女黑客，冷酷但有柔软的一面"
            className="textarea min-h-[64px] resize-y flex-1"
            disabled={isExpanding}
          />
          {isExpanding ? (
            <button type="button" onClick={cancelExpand} className="btn-secondary shrink-0 self-start">
              <Loader2 className="w-4 h-4 animate-spin" />
              停止
            </button>
          ) : (
            <button type="button" onClick={() => aiExpand(concept)} className="btn-primary shrink-0 self-start">
              <Sparkles className="w-4 h-4" />
              AI 扩展
            </button>
          )}
        </div>
        {isExpanding && (
          <div className="mt-2 text-xs text-tavern-accent animate-pulse">
            AI 正在构思角色…（完成后自动填入下方字段，可随时停止）
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-tavern-danger/10 border border-tavern-danger/30 text-tavern-danger text-sm animate-fade-in">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => useCharacterCreatorStore.setState({ error: null })} className="p-0.5 hover:opacity-70">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 字段编辑 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <FieldCard label="角色名" field="name" hint="简洁有特色">
          <input
            type="text"
            value={draft.name}
            onChange={(e) => updateDraft({ name: e.target.value })}
            placeholder="如：零"
            className="input"
          />
        </FieldCard>

        <FieldCard label="标签" field="tags" hint="3-8 个">
          <TagEditor />
        </FieldCard>

        <FieldCard label="角色描述" field="description" hint="外貌与背景" className="lg:col-span-2">
          <textarea
            value={draft.description}
            onChange={(e) => updateDraft({ description: e.target.value })}
            placeholder="角色的外貌、身份与背景故事…"
            className="textarea min-h-[120px] resize-y"
          />
        </FieldCard>

        <FieldCard label="性格特征" field="personality">
          <textarea
            value={draft.personality}
            onChange={(e) => updateDraft({ personality: e.target.value })}
            placeholder="性格特点、说话方式、行为习惯…"
            className="textarea min-h-[100px] resize-y"
          />
        </FieldCard>

        <FieldCard label="场景设定" field="scenario">
          <textarea
            value={draft.scenario}
            onChange={(e) => updateDraft({ scenario: e.target.value })}
            placeholder="角色登场时所在的场景…"
            className="textarea min-h-[100px] resize-y"
          />
        </FieldCard>

        <GreetingCard />

        <FieldCard label="对话示例" field="exampleDialog" hint="{{char}} / {{user}}，多轮用 <START> 分隔" className="lg:col-span-2">
          <textarea
            value={draft.exampleDialog}
            onChange={(e) => updateDraft({ exampleDialog: e.target.value })}
            placeholder={'{{user}}: 你为什么做这一行？\n{{char}}: 因为有趣。\n<START>\n{{user}}: …'}
            className="textarea min-h-[100px] resize-y font-mono text-xs"
          />
        </FieldCard>
      </div>

      {/* 高级设置（可选） */}
      <AdvancedSettings />
    </div>
  )
}
