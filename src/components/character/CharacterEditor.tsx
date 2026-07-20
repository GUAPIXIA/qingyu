import { useState, useEffect, useRef } from 'react'
import type { Character, ProviderType } from '../../../shared/types'
import { Modal } from '../common/Modal'
import { ImagePlus, X, Languages, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useSettingsStore } from '../../store/useSettingsStore'

interface CharacterEditorProps {
  character: Character
  onSave: (character: Character) => void
  onClose: () => void
}

type TranslatableField = keyof Pick<Character, 'description' | 'personality' | 'scenario' | 'firstMessage' | 'exampleDialog'>

const TRANSLATABLE_FIELDS: { key: TranslatableField; label: string }[] = [
  { key: 'description', label: '角色描述' },
  { key: 'personality', label: '性格特征' },
  { key: 'scenario', label: '场景设定' },
  { key: 'firstMessage', label: '首条消息' },
  { key: 'exampleDialog', label: '对话示例' },
]

export function CharacterEditor({ character, onSave, onClose }: CharacterEditorProps) {
  const [form, setForm] = useState<Character>(character)
  const [tagInput, setTagInput] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [translatedFields, setTranslatedFields] = useState<Set<string>>(new Set())
  const [translateError, setTranslateError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { settings } = useSettingsStore()

  useEffect(() => {
    setForm(character)
  }, [character])

  const update = (partial: Partial<Character>) => {
    setForm((prev) => ({ ...prev, ...partial }))
  }

  const handleImageSelect = async () => {
    const path = await window.api.file.selectImage()
    if (path) {
      const base64 = await window.api.file.readImageAsBase64(path)
      update({ avatar: base64 })
    }
  }

  const handleAddTag = () => {
    const tag = tagInput.trim()
    if (tag && !form.tags.includes(tag)) {
      update({ tags: [...form.tags, tag] })
    }
    setTagInput('')
  }

  const handleRemoveTag = (tag: string) => {
    update({ tags: form.tags.filter((t) => t !== tag) })
  }

  const handleSave = () => {
    if (!form.name.trim()) {
      form.name = '未命名角色'
    }
    onSave(form)
  }

  const handleAiTranslate = async () => {
    setTranslating(true)
    setTranslateError(null)
    setTranslatedFields(new Set())

    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile || (!profile.apiKey && profile.provider !== 'ollama')) {
      setTranslateError('请先配置 API 连接')
      setTranslating(false)
      return
    }

    for (const { key, label } of TRANSLATABLE_FIELDS) {
      const text = form[key]
      if (!text || !text.trim()) continue

      try {
        const result = await translateText(text, label, settings, profile)
        if (result) {
          update({ [key]: result } as Partial<Character>)
          setTranslatedFields((prev) => new Set(prev).add(key))
        }
      } catch {
        // 单个字段失败不阻断其他字段
        setTranslateError(`翻译"${label}"时出现错误，已跳过`)
      }
    }

    setTranslating(false)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={character.name === '新角色' ? '创建角色' : '编辑角色'}
      width="lg"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>取消</button>
          <button
            className="btn-secondary"
            onClick={handleAiTranslate}
            disabled={translating || !form.description}
            title={!form.description ? '请先填写角色描述' : '使用 AI 将角色卡翻译为中文'}
          >
            {translating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                翻译中 ({translatedFields.size}/{TRANSLATABLE_FIELDS.filter(f => !!form[f.key]).length})
              </>
            ) : (
              <>
                <Languages className="w-4 h-4" />
                AI 翻译
              </>
            )}
          </button>
          <button className="btn-primary" onClick={handleSave}>保存</button>
        </>
      }
    >
      <div className="space-y-4">
        {/* 翻译错误提示 */}
        {translateError && (
          <div className="px-3 py-2 rounded bg-tavern-danger/10 border border-tavern-danger/30 text-sm text-tavern-danger">
            {translateError}
          </div>
        )}

        {/* 头像和名字 */}
        <div className="flex gap-4">
          <div className="shrink-0">
            <div
              className="w-24 h-24 rounded-2xl overflow-hidden bg-tavern-bg-hover border border-tavern-border cursor-pointer relative group"
              onClick={handleImageSelect}
            >
              {form.avatar ? (
                <img src={form.avatar} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-tavern-text-muted">
                  <ImagePlus className="w-8 h-8" />
                </div>
              )}
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <span className="text-xs text-white">更换头像</span>
              </div>
            </div>
          </div>
          <div className="flex-1 space-y-3">
            <div>
              <label className="label">角色名 *</label>
              <input
                className="input"
                value={form.name}
                onChange={(e) => update({ name: e.target.value })}
                placeholder="输入角色名"
              />
            </div>
            <div>
              <label className="label">标签</label>
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {form.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-tavern-accent-soft text-tavern-accent"
                  >
                    {tag}
                    <button onClick={() => handleRemoveTag(tag)} className="hover:text-tavern-danger">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <input
                className="input"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleAddTag()
                  }
                }}
                placeholder="输入标签后回车"
              />
            </div>
          </div>
        </div>

        {/* 描述 */}
        <div>
          <label className="label">
            角色描述
            {translatedFields.has('description') && (
              <span className="text-xs text-tavern-accent ml-1">(已翻译)</span>
            )}
          </label>
          <textarea
            className="textarea min-h-[120px] resize-y"
            value={form.description}
            onChange={(e) => update({ description: e.target.value })}
            placeholder="描述角色的外貌、身份、背景等基本信息"
          />
        </div>

        {/* 性格 */}
        <div>
          <label className="label">
            性格特征
            {translatedFields.has('personality') && (
              <span className="text-xs text-tavern-accent ml-1">(已翻译)</span>
            )}
          </label>
          <textarea
            className="textarea min-h-[80px] resize-y"
            value={form.personality}
            onChange={(e) => update({ personality: e.target.value })}
            placeholder="描述角色的性格特点、说话方式等"
          />
        </div>

        {/* 高级选项 */}
        <div>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-sm text-tavern-accent hover:text-tavern-accent-hover transition-colors"
          >
            {showAdvanced ? '▼ 收起高级选项' : '▶ 展开高级选项'}
          </button>
        </div>

        {showAdvanced && (
          <div className="space-y-4 animate-fade-in">
            {/* 场景 */}
            <div>
              <label className="label">
                场景设定
                {translatedFields.has('scenario') && (
                  <span className="text-xs text-tavern-accent ml-1">(已翻译)</span>
                )}
              </label>
              <textarea
                className="textarea min-h-[80px] resize-y"
                value={form.scenario}
                onChange={(e) => update({ scenario: e.target.value })}
                placeholder="对话发生的场景和背景"
              />
            </div>

            {/* 首条消息 */}
            <div>
              <label className="label">
                首条消息
                {translatedFields.has('firstMessage') && (
                  <span className="text-xs text-tavern-accent ml-1">(已翻译)</span>
                )}
              </label>
              <textarea
                className="textarea min-h-[120px] resize-y"
                value={form.firstMessage}
                onChange={(e) => update({ firstMessage: e.target.value })}
                placeholder="角色发送的第一条消息，用于开启对话"
              />
            </div>

            {/* 对话示例 */}
            <div>
              <label className="label">
                对话示例
                {translatedFields.has('exampleDialog') && (
                  <span className="text-xs text-tavern-accent ml-1">(已翻译)</span>
                )}
              </label>
              <textarea
                className="textarea min-h-[100px] resize-y font-mono text-xs"
                value={form.exampleDialog}
                onChange={(e) => update({ exampleDialog: e.target.value })}
                placeholder={'<START>\n{{user}}: 你好\n{{char}}: 你好呀！'}
              />
              <p className="text-xs text-tavern-text-muted mt-1">
                使用 {'{{user}}'} 和 {'{{char}}'} 作为用户和角色名的占位符
              </p>
            </div>

            {/* 创作者 */}
            <div>
              <label className="label">创作者</label>
              <input
                className="input"
                value={form.creator}
                onChange={(e) => update({ creator: e.target.value })}
                placeholder="角色卡作者"
              />
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

/** 使用 AI 翻译单段文本 */
async function translateText(
  text: string,
  fieldLabel: string,
  settings: ReturnType<typeof useSettingsStore.getState>['settings'],
  profile: { provider: ProviderType; apiKey: string; baseUrl: string; model: string },
): Promise<string> {
  const requestId = `translate-card-${Date.now()}-${Math.random().toString(36).slice(2)}`

  return new Promise((resolve) => {
    let result = ''

    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      result += data.text
    })
    const unbindDone = window.api.ai.onDone((doneId) => {
      if (doneId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()
      resolve(result.trim() || text)
    })
    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()
      resolve('')
    })

    window.api.ai.chat({
      requestId,
      messages: [
        {
          role: 'system',
          content: `你是一个角色扮演角色卡翻译助手。请将以下${fieldLabel}翻译成中文。保持角色扮演的风格和语气，保留原文中的 Markdown 格式、HTML 标签和特殊标记（如 {{user}}、{{char}}、*动作描写*等）。只输出翻译结果，不要添加任何解释。`,
        },
        { role: 'user', content: text },
      ],
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: settings.activeModel || profile.model,
      temperature: 0.3,
      topP: 0.9,
      maxTokens: 4096,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: true,
    }).catch(() => {
      unbindChunk(); unbindDone(); unbindError()
      resolve('')
    })
  })
}
