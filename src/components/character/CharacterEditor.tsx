import React, { useState, useEffect, useRef } from 'react'
import type { Character, ProviderType } from '../../../shared/types'
import { Modal } from '../common/Modal'
import { ImagePlus, X, Languages, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useSettingsStore } from '../../store/useSettingsStore'

interface CharacterEditorProps {
  character: Character
  onSave: (character: Character) => void
  onClose: () => void
}

type TranslatableField = keyof Pick<Character, 'name' | 'description' | 'personality' | 'scenario' | 'firstMessage' | 'exampleDialog'>
const TRANSLATABLE_FIELDS: { key: TranslatableField; label: string }[] = [
  { key: 'name', label: '角色名' },
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
  const [translatingField, setTranslatingField] = useState<string | null>(null)
  const [translatedFields, setTranslatedFields] = useState<Set<string>>(new Set())
  const [translateError, setTranslateError] = useState<string | null>(null)
  const [coverReloading, setCoverReloading] = useState(false)
  const [coverError, setCoverError] = useState<string | null>(null)
  const [avatarError, setAvatarError] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // H-09 修复：追踪活跃的翻译请求，组件卸载时取消
  const activeRequestIdsRef = useRef<Set<string>>(new Set())
  const { settings } = useSettingsStore()

  useEffect(() => {
    setForm(character)
  }, [character])

  // H-09 修复：组件卸载时取消所有活跃的翻译请求
  useEffect(() => {
    return () => {
      const ids = Array.from(activeRequestIdsRef.current)
      for (const id of ids) {
        window.api.ai.cancelChat(id).catch(() => {})
      }
      activeRequestIdsRef.current.clear()
    }
  }, [])

  const update = (partial: Partial<Character>) => {
    setForm((prev) => ({ ...prev, ...partial }))
  }

  const handleImageSelect = async () => {
    const path = await window.api.file.selectImage()
    if (path) {
      const base64 = await window.api.file.readImageAsBase64(path)
      update({ avatar: base64, _importImageUrl: undefined })
    }
  }

  const handleBackgroundSelect = async () => {
    const path = await window.api.file.selectImage()
    if (path) {
      const base64 = await window.api.file.readImageAsBase64(path)
      update({ chatBackground: base64 })
    }
  }

  const handleReloadCover = async () => {
    if (!form._importImageUrl) return
    setCoverReloading(true)
    setCoverError(null)
    try {
      const result = await window.api.character.reloadAvatar(form.id, form._importImageUrl)
      if (result.success && result.avatar) {
        // 同时更新 avatar 和 cover，确保保存时 cover 字段不为空
        update({ avatar: result.avatar, cover: result.avatar, _importImageUrl: undefined })
        setAvatarError(false)
        setCoverError(null)
      } else {
        // 根据错误码显示用户友好提示
        const code = result.code ?? 'UNKNOWN'
        const errorMap: Record<string, string> = {
          TIMEOUT: '封面加载超时，请检查网络连接后重试',
          HTTP_ERROR: `封面图片加载失败 (${result.error || '未知HTTP错误'})`,
          NETWORK_ERROR: '网络连接失败，请检查 URL 是否可访问',
          INVALID_URL: '无效的封面图片 URL',
          INVALID_FORMAT: '不支持的图片格式',
          UNKNOWN: '封面加载失败，请稍后重试',
        }
        setCoverError(errorMap[code] || result.error || '封面加载失败')
      }
    } catch {
      setCoverError('封面加载失败，请稍后重试')
    }
    setCoverReloading(false)
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

    // 先翻译角色名，后续字段可引用中文名作为上下文
    let translatedName = form.name
    if (form.name && form.name.trim()) {
      try {
        const result = await translateText(form.name, '角色名', settings, profile, form.name)
        if (result) {
          translatedName = result
          const tc = { ...(form.translatedContent || {}) }
          tc.name = result
          update({ translatedContent: tc } as Partial<Character>)
          setTranslatedFields((prev) => new Set(prev).add('name'))
        }
      } catch {
        setTranslateError('翻译"角色名"时出现错误，已跳过')
      }
    }

    // 翻译其余字段，使用翻译后的名称作为上下文
    for (const { key, label } of TRANSLATABLE_FIELDS) {
      if (key === 'name') continue // 已翻译
      const text = form[key]
      if (!text || !text.trim()) continue

      try {
        const result = await translateText(text, label, settings, profile, translatedName)
        if (result) {
          const tc = { ...(form.translatedContent || {}) }
          tc[key] = result
          update({ translatedContent: tc } as Partial<Character>)
          setTranslatedFields((prev) => new Set(prev).add(key))
        }
      } catch {
        setTranslateError(`翻译"${label}"时出现错误，已跳过`)
      }
    }

    setTranslating(false)
  }

  // 单字段独立翻译
  const handleTranslateField = async (fieldKey: TranslatableField) => {
    const text = form[fieldKey]
    if (!text || !text.trim()) return

    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile || (!profile.apiKey && profile.provider !== 'ollama')) {
      setTranslateError('请先配置 API 连接')
      return
    }

    const nameForContext = form.translatedContent?.name ?? undefined
    const fieldLabel = TRANSLATABLE_FIELDS.find(f => f.key === fieldKey)?.label ?? fieldKey

    setTranslatingField(fieldKey)
    try {
      const result = await translateText(text, fieldLabel, settings, profile, nameForContext)
      if (result) {
        const tc = { ...(form.translatedContent || {}) }
        tc[fieldKey] = result
        update({ translatedContent: tc } as Partial<Character>)
        setTranslatedFields(prev => new Set(prev).add(fieldKey))
      }
    } catch {
      setTranslateError(`翻译"${fieldLabel}"失败`)
    }
    setTranslatingField(null)
  }

  // 翻译单条备选开场白
  const handleTranslateGreeting = async (index: number) => {
    const greetings = form.alternateGreetings || []
    const text = greetings[index]
    if (!text || !text.trim()) return

    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile || (!profile.apiKey && profile.provider !== 'ollama')) {
      setTranslateError('请先配置 API 连接')
      return
    }

    const nameForContext = form.translatedContent?.name ?? undefined
    setTranslatingField(`greeting-${index}`)
    try {
      const result = await translateText(text, '首条消息', settings, profile, nameForContext)
      if (result) {
        const updated = [...greetings]
        updated[index] = result
        update({ alternateGreetings: updated })
      }
    } catch {
      setTranslateError('翻译备选开场白失败')
    }
    setTranslatingField(null)
  }

  // H-09 修复：translateText 移入组件内部以追踪活跃请求
  const translateText = async (
    text: string,
    fieldLabel: string,
    settings: ReturnType<typeof useSettingsStore.getState>['settings'],
    profile: { provider: ProviderType; apiKey: string; baseUrl: string; model: string },
    characterName?: string,
  ): Promise<string> => {
    const requestId = `translate-card-${Date.now()}-${Math.random().toString(36).slice(2)}`
    activeRequestIdsRef.current.add(requestId)

    return new Promise((resolve) => {
      let result = ''

      const cleanup = () => {
        activeRequestIdsRef.current.delete(requestId)
        unbindChunk(); unbindDone(); unbindError()
      }

      const unbindChunk = window.api.ai.onChunk((data) => {
        if (data.requestId !== requestId) return
        result += data.text
      })
      const unbindDone = window.api.ai.onDone((doneId) => {
        if (doneId !== requestId) return
        cleanup()
        const cleaned = result.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
        resolve(cleaned || text)
      })
      const unbindError = window.api.ai.onError((data) => {
        if (data.requestId !== requestId) return
        cleanup()
        resolve('')
      })

      // 根据字段类型定制翻译提示
      const nameHint = characterName ? `\n- 角色名为「${characterName}」，其他字段中出现该名字时请一并翻译为中文` : ''
      const fieldHints: Record<string, string> = {
        '角色名': '- 这是角色名，请音译或意译为地道的中文名字',
        '角色描述': '- 这是角色外观/背景描写，使用自然流畅的中文叙述',
        '性格特征': '- 这是性格标签或描述，使用中文角色扮演圈常用表达（如"傲娇""腹黑"等），保留 {{char}} 等变量',
        '场景设定': '- 这是故事背景设定，使用中文同人/创作圈常见的叙述风格',
        '首条消息': '- 这是角色初次见面对话/开场独白，保持人物语气和口吻风格，对话中的人名一并翻译',
        '对话示例': '- 这是示例对话，角色名和对话中的人名一并翻译，保持口语化风格，*动作描写*保留原格式',
      }
      const fieldHint = fieldHints[fieldLabel] || ''

      window.api.ai.chat({
        requestId,
        messages: [
          {
            role: 'system',
            content: [
              '你是一位资深的 AI 角色扮演本地化翻译专家，专门将英文角色卡精准翻译为中文。',
              '',
              '## 核心翻译原则',
              '- 角色名：音译或意译为自然的中文名字，不使用直译',
              '- 描述/设定：使用地道的中文表达，保持原文叙述风格',
              '- 对话：保持角色的语气、口吻、情感色彩，中文表达要口语化自然',
              '- 性格特征：使用中文角色扮演圈常用标签（如"傲娇""天然呆""腹黑""元气"等）',
              '- 保留所有 Markdown 格式、HTML 标签、特殊标记（{{user}}、{{char}}、*动作描写* 等）不变',
              '- 只输出翻译结果，禁止添加解释、备注或额外内容',
              '- 禁止输出 <thought> 标签或任何格式标记，只输出纯翻译文本',
              nameHint,
              '',
              `## 当前字段: ${fieldLabel}`,
              fieldHint,
            ].filter(Boolean).join('\n'),
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
        cleanup()
        resolve('')
      })
    })
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
            disabled={translating || translatingField !== null || !form.description}
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
              {form.avatar && !avatarError ? (
                <img src={form.avatar} alt="" className="w-full h-full object-cover" onError={() => setAvatarError(true)} />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-tavern-text-muted">
                  <ImagePlus className="w-8 h-8" />
                </div>
              )}
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <span className="text-xs text-white">更换头像</span>
              </div>
            </div>
            {form._importImageUrl && !form.avatar && (
              <button
                className="btn-mini mt-2 w-full flex items-center justify-center gap-1"
                onClick={handleReloadCover}
                disabled={coverReloading}
              >
                {coverReloading ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3" />
                )}
                重新加载封面
              </button>
            )}
            {coverError && (
              <p className="text-xs text-tavern-danger mt-1">{coverError}</p>
            )}
          </div>
          <div className="flex-1 space-y-3">
            <div>
              <label className="label">
                角色名 *
                {(translatedFields.has('name') || form.translatedContent?.name) && (
                  <span className="text-xs text-tavern-accent ml-1">(已翻译)</span>
                )}
                <button
                  className="ml-2 p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent-soft transition-colors align-middle"
                  onClick={() => handleTranslateField('name')}
                  disabled={translatingField === 'name' || !form.name}
                  title="AI 翻译此字段"
                >
                  {translatingField === 'name' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Languages className="w-3.5 h-3.5" />
                  )}
                </button>
              </label>
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
            {(translatedFields.has('description') || form.translatedContent?.description) && (
              <span className="text-xs text-tavern-accent ml-1">(已翻译)</span>
            )}
            <button
              className="ml-2 p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent-soft transition-colors align-middle"
              onClick={() => handleTranslateField('description')}
              disabled={translatingField === 'description' || !form.description}
              title="AI 翻译此字段"
            >
              {translatingField === 'description' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Languages className="w-3.5 h-3.5" />
              )}
            </button>
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
            {(translatedFields.has('personality') || form.translatedContent?.personality) && (
              <span className="text-xs text-tavern-accent ml-1">(已翻译)</span>
            )}
            <button
              className="ml-2 p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent-soft transition-colors align-middle"
              onClick={() => handleTranslateField('personality')}
              disabled={translatingField === 'personality' || !form.personality}
              title="AI 翻译此字段"
            >
              {translatingField === 'personality' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Languages className="w-3.5 h-3.5" />
              )}
            </button>
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
                {(translatedFields.has('scenario') || form.translatedContent?.scenario) && (
                  <span className="text-xs text-tavern-accent ml-1">(已翻译)</span>
                )}
                <button
                  className="ml-2 p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent-soft transition-colors align-middle"
                  onClick={() => handleTranslateField('scenario')}
                  disabled={translatingField === 'scenario' || !form.scenario}
                  title="AI 翻译此字段"
                >
                  {translatingField === 'scenario' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Languages className="w-3.5 h-3.5" />
                  )}
                </button>
              </label>
              <textarea
                className="textarea min-h-[80px] resize-y"
                value={form.scenario}
                onChange={(e) => update({ scenario: e.target.value })}
                placeholder="对话发生的场景和背景"
            />
          </div>

            {/* 角色系统提示词（覆盖预设） */}
            <div>
              <label className="label">角色系统提示词（覆盖预设）</label>
              <textarea
                className="textarea min-h-[80px] resize-y"
                value={form.systemPrompt || ''}
                onChange={(e) => update({ systemPrompt: e.target.value })}
                placeholder="为这个角色设定专属的系统提示词，留空则使用预设中的系统提示词"
              />
              <p className="text-xs text-tavern-text-muted mt-1">留空则使用预设中的系统提示词</p>
            </div>

            {/* 首条消息 */}
            <div>
              <label className="label">
                首条消息
                {(translatedFields.has('firstMessage') || form.translatedContent?.firstMessage) && (
                  <span className="text-xs text-tavern-accent ml-1">(已翻译)</span>
                )}
                <button
                  className="ml-2 p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent-soft transition-colors align-middle"
                  onClick={() => handleTranslateField('firstMessage')}
                  disabled={translatingField === 'firstMessage' || !form.firstMessage}
                  title="AI 翻译此字段"
                >
                  {translatingField === 'firstMessage' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Languages className="w-3.5 h-3.5" />
                  )}
                </button>
              </label>
              <textarea
                className="textarea min-h-[120px] resize-y"
                value={form.firstMessage}
                onChange={(e) => update({ firstMessage: e.target.value })}
                placeholder="角色发送的第一条消息，用于开启对话"
            />
          </div>

            {/* 备选开场白 */}
            <div>
              <label className="label">备选开场白</label>
              <div className="space-y-2">
                {(form.alternateGreetings || []).map((g, i) => (
                  <div key={i} className="flex gap-2">
                    <textarea
                      className="textarea min-h-[60px] resize-y flex-1 text-sm"
                      value={g}
                      onChange={(e) => {
                        const updated = [...(form.alternateGreetings || [])]
                        updated[i] = e.target.value
                        update({ alternateGreetings: updated })
                      }}
                      placeholder="备选的开场问候语"
                    />
                    <div className="flex flex-col gap-1 self-start shrink-0">
                      <button
                        className="btn-ghost p-1.5 text-tavern-text-muted hover:text-tavern-accent"
                        onClick={() => handleTranslateGreeting(i)}
                        disabled={translatingField === `greeting-${i}` || !g.trim()}
                        title="AI 翻译"
                      >
                        {translatingField === `greeting-${i}` ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Languages className="w-3.5 h-3.5" />
                        )}
                      </button>
                      <button
                        className="btn-ghost p-1.5 text-tavern-danger"
                        onClick={() => update({ alternateGreetings: (form.alternateGreetings || []).filter((_, j) => j !== i) })}
                        title="删除"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  className="btn-ghost text-sm text-tavern-accent"
                  onClick={() => update({ alternateGreetings: [...(form.alternateGreetings || []), ''] })}
                >
                  + 添加备选开场白
                </button>
              </div>
            </div>

            {/* 对话后指令 */}
            <div>
              <label className="label">对话后指令</label>
              <textarea
                className="textarea min-h-[60px] resize-y"
                value={form.postHistoryInstructions || ''}
                onChange={(e) => update({ postHistoryInstructions: e.target.value })}
                placeholder="如：始终使用中文回复、禁止使用emoji、每次回复不超过200字..."
              />
            </div>

            {/* 群聊开场白 */}
            <div>
              <label className="label">群聊开场白</label>
              <div className="space-y-2">
                {(form.groupOnlyGreetings || []).map((g, i) => (
                  <div key={i} className="flex gap-2">
                    <textarea
                      className="textarea min-h-[60px] resize-y flex-1 text-sm"
                      value={g}
                      onChange={(e) => {
                        const updated = [...(form.groupOnlyGreetings || [])]
                        updated[i] = e.target.value
                        update({ groupOnlyGreetings: updated })
                      }}
                      placeholder="群聊中使用的开场问候语"
                    />
                    <button
                      className="btn-ghost p-1.5 text-tavern-danger self-start shrink-0"
                      onClick={() => update({ groupOnlyGreetings: (form.groupOnlyGreetings || []).filter((_, j) => j !== i) })}
                      title="删除"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                <button
                  className="btn-ghost text-sm text-tavern-accent"
                  onClick={() => update({ groupOnlyGreetings: [...(form.groupOnlyGreetings || []), ''] })}
                >
                  + 添加群聊开场白
                </button>
              </div>
            </div>

            {/* 对话示例 */}
            <div>
              <label className="label">
                对话示例
                {(translatedFields.has('exampleDialog') || form.translatedContent?.exampleDialog) && (
                  <span className="text-xs text-tavern-accent ml-1">(已翻译)</span>
                )}
                <button
                  className="ml-2 p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent-soft transition-colors align-middle"
                  onClick={() => handleTranslateField('exampleDialog')}
                  disabled={translatingField === 'exampleDialog' || !form.exampleDialog}
                  title="AI 翻译此字段"
                >
                  {translatingField === 'exampleDialog' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Languages className="w-3.5 h-3.5" />
                  )}
                </button>
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

            {/* 聊天背景 */}
            <div>
              <label className="label">聊天背景</label>
              <div className="flex items-center gap-3">
                <div
                  className="w-32 h-20 rounded-lg bg-tavern-bg-hover border border-tavern-border cursor-pointer overflow-hidden relative group shrink-0"
                  onClick={handleBackgroundSelect}
                >
                  {form.chatBackground ? (
                    <img src={form.chatBackground} className="w-full h-full object-cover" alt="" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-tavern-text-muted">
                      <ImagePlus className="w-6 h-6" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <span className="text-xs text-white">{form.chatBackground ? '更换背景' : '选择背景'}</span>
                  </div>
                </div>
                {form.chatBackground && (
                  <button
                    className="btn-ghost text-xs text-tavern-danger shrink-0"
                    onClick={() => update({ chatBackground: undefined })}
                  >
                    移除背景
                  </button>
                )}
              </div>
              <p className="text-xs text-tavern-text-muted mt-1">为该角色设置专属的聊天页背景图</p>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
