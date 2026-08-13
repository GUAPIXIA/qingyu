import React, { useState, useEffect, useRef } from 'react'
import type { Character, ProviderType } from '../../../shared/types'
import { Modal } from '../common/Modal'
import { IdentitySection } from './editor/IdentitySection'
import { AdvancedSection } from './editor/AdvancedSection'
import type { TranslatableField } from './editor/types'
import { Languages, Loader2 } from 'lucide-react'
import { useSettingsStore } from '../../store/useSettingsStore'
import { translationMaxTokens } from '../../store/chatConstants'
import { isLocalProvider, isLocalUrl } from '../../utils/defaults'
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
function useTaResize(id: string, defaultMinH: number): { ref: React.RefObject<HTMLTextAreaElement>; style: React.CSSProperties } {
  const ref = useRef<HTMLTextAreaElement | null>(null)
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
  return { ref: ref as React.RefObject<HTMLTextAreaElement>, style }
}

/** B-05：预设绑定选择器 */
interface CharacterEditorProps {
  character: Character
  onSave: (character: Character) => void
  onClose: () => void
}

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
  // NEW-L10：记录当前编辑的角色 ID，仅在切换角色时重置表单
  const lastCharIdRef = useRef(character.id)
  const [tagInput, setTagInput] = useState('')
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
    // NEW-L10 修复：仅当编辑对象切换（不同角色）时重置表单，
    // 避免外部 character 对象更新（如自动保存刷新）覆盖用户未保存的编辑
    if (character.id !== lastCharIdRef.current) {
      lastCharIdRef.current = character.id
      setForm(character)
    }
  }, [character])

  // H-09 修复：组件卸载时取消所有活跃的翻译请求
  useEffect(() => {
    const ref = activeRequestIdsRef
    return () => {
      const ids = Array.from(ref.current)
      for (const id of ids) {
        window.api.ai.cancelChat(id).catch((e) => logError('CharacterEditor:cancelChat', e))
      }
      ref.current.clear()
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
    // BUG-33 修复：不直接修改 form 状态对象（违反不可变更新原则），
    // 通过 setForm 生成新对象，保存时同样使用新值
    if (!form.name.trim()) {
      const renamed = { ...form, name: '未命名角色' }
      setForm(renamed)
      onSave(renamed)
      return
    }
    onSave(form)
  }

  const handleAiTranslate = async () => {
    setTranslating(true)
    setTranslateError(null)
    setTranslatedFields(new Set())

    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) {
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
          // 译文统一存入 translatedContent，原文永不覆盖（UI 双语对照，AI 上下文按需取译文）
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
    if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) {
      setTranslateError('请先配置 API 连接')
      return
    }

    const nameForContext = form.translatedContent?.name ?? undefined
    const fieldLabel = TRANSLATABLE_FIELDS.find(f => f.key === fieldKey)?.label ?? fieldKey

    setTranslatingField(fieldKey)
    try {
      const result = await translateText(text, fieldLabel, settings, profile, nameForContext)
      if (result) {
        // 译文统一存入 translatedContent，原文永不覆盖
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
    if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) {
      setTranslateError('请先配置 API 连接')
      return
    }

    const nameForContext = form.translatedContent?.name ?? undefined
    setTranslatingField(`greeting-${index}`)
    try {
      const result = await translateText(text, '首条消息', settings, profile, nameForContext)
      if (result) {
        // 译文存入 translatedContent.alternateGreetings（与原数组索引对齐），原文不覆盖
        const originals = form.alternateGreetings || []
        const tc = { ...(form.translatedContent || {}) }
        const translated = [...(tc.alternateGreetings || new Array<string>(originals.length).fill(''))]
        translated[index] = result
        tc.alternateGreetings = translated
        update({ translatedContent: tc } as Partial<Character>)
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
        maxTokens: translationMaxTokens(text),
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
      width="custom"
      widthClassName="max-w-5xl"
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        {/* 翻译错误提示 */}
        {translateError && (
          <div className="px-3 py-2 rounded bg-tavern-danger/10 border border-tavern-danger/30 text-sm text-tavern-danger lg:col-span-2">
            {translateError}
          </div>
        )}

        <div className="space-y-4 min-w-0">
          <IdentitySection
            form={form}
            update={update}
            tagInput={tagInput}
            setTagInput={setTagInput}
            handleAddTag={handleAddTag}
            handleRemoveTag={handleRemoveTag}
            handleImageSelect={handleImageSelect}
            handleReloadCover={handleReloadCover}
            handleBackgroundSelect={handleBackgroundSelect}
            coverReloading={coverReloading}
            coverError={coverError}
            avatarError={avatarError}
            setAvatarError={setAvatarError}
            taPersonality={taPersonality}
            taScenario={taScenario}
            taPosthist={taPosthist}
            taExdialog={taExdialog}
            translatedFields={translatedFields}
            translatingField={translatingField}
            handleTranslateField={handleTranslateField}
            handleTranslateGreeting={handleTranslateGreeting}
          />
        </div>
        <div className="space-y-4 min-w-0">
          <AdvancedSection
            form={form}
            update={update}
            taDesc={taDesc}
            taSysprompt={taSysprompt}
            taFirstmsg={taFirstmsg}
            translatedFields={translatedFields}
            translatingField={translatingField}
            handleTranslateField={handleTranslateField}
            handleTranslateGreeting={handleTranslateGreeting}
          />
        </div>
      </div>
    </Modal>
  )
}
