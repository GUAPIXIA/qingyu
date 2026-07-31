import React, { useState, useEffect, useRef } from 'react'
import type { Character, ProviderType, Preset, Lorebook } from '../../../shared/types'
import { Modal } from '../common/Modal'
import { ImagePlus, X, Languages, Loader2, RefreshCw } from 'lucide-react'
import { useSettingsStore } from '../../store/useSettingsStore'
import { charAssetUrl } from '../../utils/asset'
import { logError } from '../../lib/logger'

// B-05：记住 textarea 手动调整后的大小（使用原生 DOM 事件，React 合成事件无法捕获浏览器 resize handle）
const TA_HEIGHTS_KEY = 'editor-ta-heights'
function loadTaHeights(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(TA_HEIGHTS_KEY) || '{}') } catch { return {} }
}
function saveTaHeight(id: string, h: number) {
  const heights = loadTaHeights()
  heights[id] = h
  localStorage.setItem(TA_HEIGHTS_KEY, JSON.stringify(heights))
}
/** 绑定 textarea ref：恢复记忆高度 + 监听原生 mouseup 保存高度 */
function useTaResize(id: string, defaultMinH: number) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const saved = loadTaHeights()[id]

  // 挂载后恢复记忆高度
  useEffect(() => {
    const ta = ref.current
    if (ta && saved && saved > defaultMinH) {
      ta.style.height = `${saved}px`
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 监听原生 mouseup（浏览器 resize handle 的 mouseup 不会触发 React 合成事件）
  useEffect(() => {
    const ta = ref.current
    if (!ta) return
    const onMouseUp = () => {
      saveTaHeight(id, ta.offsetHeight)
    }
    ta.addEventListener('mouseup', onMouseUp)
    return () => ta.removeEventListener('mouseup', onMouseUp)
  }, [id])

  const style: React.CSSProperties = {
    minHeight: `${saved && saved > defaultMinH ? saved : defaultMinH}px`,
  }
  return { ref, style }
}

/** B-05：预设绑定选择器 */
function PresetBinding({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const [presets, setPresets] = useState<Preset[]>([])
  useEffect(() => { window.api.preset.list().then(setPresets).catch((e) => logError('CharacterEditor:loadPresets', e)) }, [])
  return (
    <div>
      <label className="label">绑定预设</label>
      <select className="input text-sm" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">不绑定</option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <p className="text-xs text-tavern-text-muted mt-1">切换到此角色时自动激活该预设</p>
    </div>
  )
}

/** B-05：世界书绑定选择器 */
function LorebookBinding({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const [lorebooks, setLorebooks] = useState<Lorebook[]>([])
  useEffect(() => { window.api.lorebook.list().then(setLorebooks).catch((e) => logError('CharacterEditor:loadLorebooks', e)) }, [])
  const toggle = (id: string) => {
    if (value.includes(id)) onChange(value.filter(v => v !== id))
    else onChange([...value, id])
  }
  return (
    <div>
      <label className="label">绑定世界书</label>
      <div className="max-h-32 overflow-y-auto border border-tavern-border rounded-lg p-2 space-y-1">
        {lorebooks.length === 0 ? (
          <p className="text-xs text-tavern-text-muted py-1">暂无世界书</p>
        ) : (
          lorebooks.map((lb) => (
            <label key={lb.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-tavern-bg-hover rounded px-1 py-0.5">
              <input type="checkbox" checked={value.includes(lb.id)} onChange={() => toggle(lb.id)} className="accent-tavern-accent" />
              <span className="truncate">{lb.name}</span>
            </label>
          ))
        )}
      </div>
      <p className="text-xs text-tavern-text-muted mt-1">切换到此角色时自动激活选中的世界书</p>
    </div>
  )
}

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
  // H-09 修复：追踪活跃的翻译请求，组件卸载时取消
  const activeRequestIdsRef = useRef<Set<string>>(new Set())
  const { settings } = useSettingsStore()

  // B-05：textarea 高度记忆
  const taDesc = useTaResize('desc', 120)
  const taPersonality = useTaResize('personality', 80)
  const taScenario = useTaResize('scenario', 80)
  const taSysprompt = useTaResize('sysprompt', 80)
  const taFirstmsg = useTaResize('firstmsg', 120)
  const taPosthist = useTaResize('posthist', 60)
  const taExdialog = useTaResize('exdialog', 100)

  useEffect(() => {
    setForm(character)
  }, [character])

  // H-09 修复：组件卸载时取消所有活跃的翻译请求
  useEffect(() => {
    return () => {
      const ids = Array.from(activeRequestIdsRef.current)
      for (const id of ids) {
        window.api.ai.cancelChat(id).catch((e) => logError('CharacterEditor:cancelChat', e))
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
          // 首条消息直接替换原文（用于发送给 AI），其他字段存入 translatedContent 双语显示
          if (key === 'firstMessage') {
            update({ firstMessage: result })
          } else {
            const tc = { ...(form.translatedContent || {}) }
            tc[key] = result
            update({ translatedContent: tc } as Partial<Character>)
          }
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
        // 首条消息直接替换原文（用于发送给 AI），其他字段存入 translatedContent 双语显示
        if (fieldKey === 'firstMessage') {
          update({ firstMessage: result })
        } else {
          const tc = { ...(form.translatedContent || {}) }
          tc[fieldKey] = result
          update({ translatedContent: tc } as Partial<Character>)
          setTranslatedFields(prev => new Set(prev).add(fieldKey))
        }
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
              {(form.avatar || (form.id ? charAssetUrl(form.id, 'avatar', form.updatedAt) : '')) && !avatarError ? (
                <img src={form.avatar || charAssetUrl(form.id, 'avatar', form.updatedAt)} alt="" className="w-full h-full object-cover" onError={() => setAvatarError(true)} />
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
              {form.translatedContent?.name && form.translatedContent.name !== form.name && (
                <div className="mt-1.5 pl-2 border-l-2 border-tavern-accent">
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-tavern-accent font-medium">翻译：</span>
                    <button
                      className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger transition-colors"
                      onClick={() => {
                        const tc = { ...form.translatedContent }
                        delete tc.name
                        update({ translatedContent: tc } as Partial<Character>)
                      }}
                      title="清除翻译"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <p className="text-xs text-tavern-text-soft mt-0.5">
                    {form.translatedContent.name}
                  </p>
                </div>
              )}
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
            ref={taDesc.ref}
            style={taDesc.style}
            className="textarea min-h-[120px] resize-y"
            value={form.description}
            onChange={(e) => update({ description: e.target.value })}
            placeholder="描述角色的外貌、身份、背景等基本信息"
          />
          {form.translatedContent?.description && (
            <div className="mt-1.5 pl-2 border-l-2 border-tavern-accent">
              <div className="flex items-center gap-1">
                <span className="text-xs text-tavern-accent font-medium">翻译：</span>
                <button
                  className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger transition-colors"
                  onClick={() => {
                    const tc = { ...form.translatedContent }
                    delete tc.description
                    update({ translatedContent: tc } as Partial<Character>)
                  }}
                  title="清除翻译"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <p className="text-xs text-tavern-text-soft mt-0.5 whitespace-pre-wrap">
                {form.translatedContent.description}
              </p>
            </div>
          )}
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
            ref={taPersonality.ref}
            style={taPersonality.style}
            className="textarea min-h-[80px] resize-y"
            value={form.personality}
            onChange={(e) => update({ personality: e.target.value })}
            placeholder="描述角色的性格特点、说话方式等"
          />
          {form.translatedContent?.personality && (
            <div className="mt-1.5 pl-2 border-l-2 border-tavern-accent">
              <div className="flex items-center gap-1">
                <span className="text-xs text-tavern-accent font-medium">翻译：</span>
                <button
                  className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger transition-colors"
                  onClick={() => {
                    const tc = { ...form.translatedContent }
                    delete tc.personality
                    update({ translatedContent: tc } as Partial<Character>)
                  }}
                  title="清除翻译"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <p className="text-xs text-tavern-text-soft mt-0.5 whitespace-pre-wrap">
                {form.translatedContent.personality}
              </p>
            </div>
          )}
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
                ref={taScenario.ref}
                style={taScenario.style}
                className="textarea min-h-[80px] resize-y"
                value={form.scenario}
                onChange={(e) => update({ scenario: e.target.value })}
                placeholder="对话发生的场景和背景"
            />
            {form.translatedContent?.scenario && (
              <div className="mt-1.5 pl-2 border-l-2 border-tavern-accent">
                <div className="flex items-center gap-1">
                  <span className="text-xs text-tavern-accent font-medium">翻译：</span>
                  <button
                    className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger transition-colors"
                    onClick={() => {
                      const tc = { ...form.translatedContent }
                      delete tc.scenario
                      update({ translatedContent: tc } as Partial<Character>)
                    }}
                    title="清除翻译"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <p className="text-xs text-tavern-text-soft mt-0.5 whitespace-pre-wrap">
                  {form.translatedContent.scenario}
                </p>
              </div>
            )}
          </div>

            {/* 角色系统提示词（覆盖预设） */}
            <div>
              <label className="label">角色系统提示词（覆盖预设）</label>
              <textarea
                ref={taSysprompt.ref}
                style={taSysprompt.style}
                className="textarea min-h-[80px] resize-y"
                value={form.systemPrompt || ''}
                onChange={(e) => update({ systemPrompt: e.target.value })}
                placeholder="为这个角色设定专属的系统提示词，留空则使用预设中的系统提示词"
              />
              <p className="text-xs text-tavern-text-muted mt-1">留空则使用预设中的系统提示词</p>
            </div>

            {/* B-05 修复：预设和世界书绑定 */}
            <div className="grid grid-cols-2 gap-4">
              <PresetBinding value={form.boundPresetId ?? null} onChange={(id) => update({ boundPresetId: id })} />
              <LorebookBinding value={form.boundLorebookIds ?? []} onChange={(ids) => update({ boundLorebookIds: ids })} />
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
                ref={taFirstmsg.ref}
                style={taFirstmsg.style}
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
                ref={taPosthist.ref}
                style={taPosthist.style}
                className="textarea min-h-[60px] resize-y"
                value={form.postHistoryInstructions || ''}
                onChange={(e) => update({ postHistoryInstructions: e.target.value })}
                placeholder="如：始终使用中文回复、禁止使用emoji、每次回复不超过200字..."
              />
            </div>

            {/* 角色级作者注释 */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <label className="label mb-0">角色级作者注释</label>
                  <p className="text-xs text-tavern-text-muted">自定义后覆盖全局设置，关闭后使用全局</p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="accent-[var(--color-accent)]"
                    checked={!!form.authorNote}
                    onChange={(e) => update({ authorNote: e.target.checked ? { enabled: true, text: '', position: 'middle', depth: 1 } : undefined })}
                  />
                  <span className="text-sm">自定义</span>
                </label>
              </div>
              {form.authorNote && (
                <>
                  <div className="flex items-center justify-between">
                    <label className="label mb-0">启用注入</label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="accent-[var(--color-accent)]"
                        checked={form.authorNote.enabled}
                        onChange={(e) => update({ authorNote: { ...form.authorNote!, enabled: e.target.checked } })}
                      />
                      <span className="text-sm">{form.authorNote.enabled ? '开' : '关'}</span>
                    </label>
                  </div>
                  <div>
                    <label className="label">注释内容</label>
                    <textarea
                      className="textarea min-h-[60px] resize-y"
                      value={form.authorNote.text || ''}
                      onChange={(e) => update({ authorNote: { ...form.authorNote!, text: e.target.value } })}
                      placeholder="该角色独享的剧情引导，如：她暗恋主角但不愿承认…"
                    />
                  </div>
                  <div>
                    <label className="label">注入位置</label>
                    <select
                      className="select"
                      value={form.authorNote.position}
                      onChange={(e) => update({ authorNote: { ...form.authorNote!, position: e.target.value as 'top' | 'middle' | 'bottom' } })}
                    >
                      <option value="top">系统提示之后</option>
                      <option value="middle">历史消息中（按深度）</option>
                      <option value="bottom">历史消息末尾</option>
                    </select>
                  </div>
                  {form.authorNote.position === 'middle' && (
                    <div>
                      <label className="label">注入深度（0 = 最新消息前）</label>
                      <input
                        type="number"
                        min={0}
                        className="input"
                        value={form.authorNote.depth ?? 1}
                        onChange={(e) => update({ authorNote: { ...form.authorNote!, depth: Math.max(0, Number(e.target.value) || 0) } })}
                      />
                    </div>
                  )}
                </>
              )}
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
                ref={taExdialog.ref}
                style={taExdialog.style}
                className="textarea min-h-[100px] resize-y font-mono text-xs"
                value={form.exampleDialog}
                onChange={(e) => update({ exampleDialog: e.target.value })}
                placeholder={'<START>\n{{user}}: 你好\n{{char}}: 你好呀！'}
              />
              {form.translatedContent?.exampleDialog && (
                <div className="mt-1.5 pl-2 border-l-2 border-tavern-accent">
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-tavern-accent font-medium">翻译：</span>
                    <button
                      className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger transition-colors"
                      onClick={() => {
                        const tc = { ...form.translatedContent }
                        delete tc.exampleDialog
                        update({ translatedContent: tc } as Partial<Character>)
                      }}
                      title="清除翻译"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <p className="text-xs text-tavern-text-soft mt-0.5 whitespace-pre-wrap">
                    {form.translatedContent.exampleDialog}
                  </p>
                </div>
              )}
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
