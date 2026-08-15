/**
 * 角色卡制作向导状态管理
 *
 * - aiExpand: 一句话概念 → AI 扩展为完整角色设定（流式，支持取消）
 * - aiGenerateField: 单字段「帮我写」（以其他字段为上下文）
 * - generateCover: 调用 imageGen 生成 3:4 封面（DALL-E 正方形自动裁 3:4）
 * - saveCharacter: 保存（含 1:1 头像裁剪）+ 选中 + 清草稿
 * - 草稿持久化：文本字段 + 封面缩略图（完整 base64 不落 localStorage）
 */
import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { useCharacterStore } from './useCharacterStore'
import { useSettingsStore } from './useSettingsStore'
import { cropAvatar, cropCoverTo34, downscaleImage } from '../utils/avatarCrop'
import { buildCoverPrompt } from '../utils/charPrompt'
import type { Character } from '../../shared/types'
import type { ChatParams } from '../../shared/types'

export const DRAFT_KEY = 'character-creator-draft'

export type CreatorStep = 0 | 1 | 2
export type AvatarPosition = 'top' | 'center' | 'bottom'
export type GenerateField = 'name' | 'description' | 'personality' | 'scenario' | 'firstMessage' | 'exampleDialog' | 'tags'

export interface DraftSnapshot {
  step: number
  draft: Omit<Character, 'avatar' | 'cover'>
  coverThumb?: string
  avatarPosition: AvatarPosition
  savedAt: number
}

/** AI 角色扩展 System Prompt */
export const CHARACTER_EXPAND_PROMPT = `你是一位专业的角色设计师，擅长创作有深度的 AI 角色扮演角色。
用户会给出一个简短的角色概念，请将其扩展为完整的角色设定。

输出要求：
1. 严格按照 JSON 格式输出，不要输出其他内容
2. JSON 字段：
   - "name": 角色名字（简洁有特色）
   - "description": 角色外貌与背景描述（100-300字）
   - "personality": 性格特征（50-150字）
   - "scenario": 登场场景（50-150字）
   - "firstMessage": 角色开场白（含 *动作描写*，用 {{user}} 指代用户）
   - "exampleDialog": 对话示例（使用 {{user}} 和 {{char}} 占位符，多轮用 <START> 分隔）
   - "tags": 3-8个标签数组
3. 内容用中文撰写
4. firstMessage 要生动有趣`

const FIELD_LABELS: Record<GenerateField, string> = {
  name: '角色名',
  description: '角色描述',
  personality: '性格特征',
  scenario: '场景设定',
  firstMessage: '首条消息',
  exampleDialog: '对话示例',
  tags: '标签',
}

/** 单字段生成的 System Prompt 构建 */
export function buildFieldGeneratePrompt(field: GenerateField, draft: Character, userInput?: string) {
  const context: string[] = []
  if (draft.name && field !== 'name') context.push(`角色名：${draft.name}`)
  if (draft.description && field !== 'description') context.push(`描述：${draft.description}`)
  if (draft.personality && field !== 'personality') context.push(`性格：${draft.personality}`)
  if (draft.scenario && field !== 'scenario') context.push(`场景：${draft.scenario}`)
  if (draft.firstMessage && field !== 'firstMessage') context.push(`首条消息：${draft.firstMessage}`)
  if (draft.exampleDialog && field !== 'exampleDialog') context.push(`对话示例：${draft.exampleDialog}`)
  if (draft.tags?.length && field !== 'tags') context.push(`标签：${draft.tags.join('、')}`)

  const extra = field === 'tags'
    ? '输出 3-8 个标签，用顿号或逗号分隔，只输出标签本身'
    : '只输出字段内容，不要解释，用中文撰写'

  const userInputBlock = userInput?.trim()
    ? `\n\n用户提供的想法或草稿（请在此基础上创作或修改，完整保留用户的意图与细节）：\n${userInput.trim()}`
    : ''

  return {
    systemPrompt: `你是一位专业的角色设计师。请根据以下角色信息，为指定字段生成内容。
## 已有角色信息
${context.join('\n') || '（无）'}

要求：${extra}`,
    userContent: `请为字段「${FIELD_LABELS[field]}」生成内容。${userInputBlock}`,
  }
}

/** 开场白（含备选）生成的 System Prompt 构建 */
export function buildGreetingPrompt(index: number, draft: Character, userInput?: string) {
  // 收集已有开场白并排除当前这条（避免与自身重复）
  const existing: string[] = []
  if (draft.firstMessage) existing.push(draft.firstMessage)
  if (draft.alternateGreetings?.length) existing.push(...draft.alternateGreetings.filter(Boolean))
  const self = index === -1 ? draft.firstMessage : draft.alternateGreetings?.[index]
  const others = existing.filter((g) => g !== self)

  const context = [
    draft.name && `角色名：${draft.name}`,
    draft.description && `描述：${draft.description}`,
    draft.personality && `性格：${draft.personality}`,
    draft.scenario && `场景：${draft.scenario}`,
  ].filter(Boolean)

  const diversityHint = others.length
    ? `\n\n已有的开场白（请生成与它们风格不同的新一条，避免重复）：\n${others.map((g, i) => `${i + 1}. ${g}`).join('\n')}`
    : ''

  const userInputBlock = userInput?.trim()
    ? `\n\n用户提供的想法或草稿（请在此基础上创作或修改，完整保留用户的意图与细节）：\n${userInput.trim()}`
    : ''

  return {
    systemPrompt: `你是一位专业的角色设计师。请为角色生成一条开场白。${diversityHint}\n\n要求：开场白含 *动作描写*，用 {{user}} 指代用户，生动有趣；只输出内容，不要解释，用中文撰写。\n## 角色信息\n${context.join('\n') || '（无）'}`,
    userContent: `请为角色生成一条开场白。${userInputBlock}`,
  }
}

/** 清理单字段 AI 输出：剥离思考块（<thought>/<thinking> 等）与元语言引导句，tags 支持 JSON 数组 */
export function cleanFieldOutput(text: string, field?: GenerateField): string {
  if (!text) return ''
  let out = text
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '') // 主进程包裹的推理内容（DeepSeek-R1 等）
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '') // 兜底：模型直接输出的 thinking 标签
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '') // 兜底：reasoning 标签
    .trim()
  // 剥离元语言引导句："好的，这是为你生成的内容：xxx"（要求到冒号才剥，避免误伤以"好的"开头的角色内容）
  const leadIn = out.match(/^(?:好的|没问题|当然可以|当然|可以|以下是为|以下是|下面是|这是为|这是|为你生成|已为你生成|已经为你生成)[^：:\n]{0,25}?[:：]/)
  if (leadIn) out = out.slice(leadIn[0].length).trim()
  if (field === 'tags') {
    // 模型可能直接输出 JSON 数组
    const trimmed = out.trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const arr = JSON.parse(trimmed) as unknown
        if (Array.isArray(arr)) {
          const tags = arr.filter((t): t is string => typeof t === 'string')
          if (tags.length) return tags.join('、')
        }
      } catch {
        // 非 JSON 数组，走下方普通切分
      }
    }
  }
  return out
}

const STRING_FIELDS = ['name', 'description', 'personality', 'scenario', 'firstMessage', 'exampleDialog'] as const

/** 完整 JSON 解析：字段类型过滤 */
function normalizeFields(data: Record<string, unknown>): Partial<Character> {
  const result: Partial<Character> = {}
  for (const field of STRING_FIELDS) {
    if (typeof data[field] === 'string') {
      ;(result as Record<string, unknown>)[field] = data[field]
    }
  }
  if (Array.isArray(data.tags)) {
    result.tags = data.tags.filter((t): t is string => typeof t === 'string').slice(0, 8)
  }
  return result
}

/** 截断恢复：流式中断时逐字段正则提取已完成的键值对 */
function extractPartialFields(text: string): Partial<Character> {
  const result: Partial<Character> = {}
  for (const field of STRING_FIELDS) {
    const m = text.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))
    if (m) {
      ;(result as Record<string, unknown>)[field] = m[1]
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
    }
  }
  const tagsMatch = text.match(/"tags"\s*:\s*\[([^\]]*)\]/)
  if (tagsMatch) {
    const tags = [...tagsMatch[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).slice(0, 8)
    if (tags.length) result.tags = tags
  }
  return result
}

/** AI 返回文本 → 结构化角色字段（容错：代码块包裹 / 前后杂文 / 截断 JSON 部分恢复） */
export function parseExpandResult(text: string): Partial<Character> | null {
  if (!text) return null
  // 剥离代码块标记 + 推理内容块（<thought> 内可能含 { } 干扰 JSON 边界定位）
  const cleaned = text
    .replace(/```(?:json)?/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim()
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) {
    // 无完整 JSON 结构（截断/中断）→ 正则部分恢复
    const partial = extractPartialFields(cleaned)
    return Object.keys(partial).length > 0 ? partial : null
  }
  try {
    const data = JSON.parse(cleaned.slice(first, last + 1))
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
    return normalizeFields(data as Record<string, unknown>)
  } catch {
    // 解析失败（如截断）→ 正则部分恢复
    const partial = extractPartialFields(cleaned)
    return Object.keys(partial).length > 0 ? partial : null
  }
}

function createEmptyDraft(): Character {
  const now = Date.now()
  return {
    id: nanoid(),
    name: '',
    avatar: '',
    description: '',
    personality: '',
    scenario: '',
    firstMessage: '',
    exampleDialog: '',
    tags: [],
    lorebookId: null,
    alternateGreetings: [],
    creator: '',
    createdAt: now,
    updatedAt: now,
  }
}

interface CharacterCreatorState {
  step: CreatorStep
  draft: Character
  // 封面
  coverMode: 'upload' | 'generate'
  coverBase64: string | null
  /** 封面来自草稿缩略图（低清 192×256）时为 true，保存前需重新上传/生成 */
  coverIsThumb: boolean
  coverPrompt: string
  negativePrompt: string
  coverSize: string
  avatarPosition: AvatarPosition
  // AI 生成状态
  isExpanding: boolean
  isGeneratingCover: boolean
  isSaving: boolean
  generatingField: GenerateField | null
  /** 开场白生成中：-1 = 主首条消息，>=0 = 备选开场白（alternateGreetings[i]） */
  generatingGreetingIndex: number | null
  expandRequestId: string | null
  // 错误
  error: string | null

  setStep: (step: CreatorStep) => void
  setCoverMode: (mode: 'upload' | 'generate') => void
  updateDraft: (partial: Partial<Character>) => void
  setAvatarPosition: (pos: AvatarPosition) => void
  setCover: (base64: string | null, mode?: 'upload' | 'generate') => void
  setCoverPrompt: (prompt: string) => void
  setNegativePrompt: (p: string) => void
  setCoverSize: (size: string) => void
  buildPromptFromDraft: () => boolean
  aiExpand: (concept: string) => Promise<void>
  aiGenerateField: (field: GenerateField, userInput?: string) => Promise<void>
  /** 生成开场白（-1 = 主首条消息，>=0 = 备选开场白 i），要求与已有开场白风格不同 */
  aiGenerateGreeting: (index: number, userInput?: string) => Promise<void>
  cancelExpand: () => void
  generateCover: () => Promise<void>
  saveCharacter: () => Promise<Character | null>
  /** 草稿持久化（缩略图降采样后写入 localStorage） */
  persistDraft: () => Promise<void>
  /** 恢复草稿；无草稿或损坏返回 false */
  restoreDraft: () => boolean
  /** 是否已有草稿 */
  hasDraft: () => boolean
  clearDraft: () => void
  reset: () => void
}

/** 运行一次流式 AI 调用，返回 requestId（自动绑定/解绑回调，支持取消） */
function runAIChat(
  params: Omit<ChatParams, 'requestId'>,
  callbacks: {
    onChunk?: (fullText: string) => void
    onDone?: (fullText: string) => void
    onError?: (error: string) => void
  },
): string {
  const requestId = `charcreate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let fullText = ''
  let finished = false
  const unbindChunk = window.api.ai.onChunk((data) => {
    if (data.requestId !== requestId) return
    fullText += data.text
    callbacks.onChunk?.(fullText)
  })
  const unbindDone = window.api.ai.onDone((doneId) => {
    if (doneId !== requestId) return
    finished = true
    unbindChunk()
    unbindDone()
    unbindError()
    callbacks.onDone?.(fullText)
  })
  const unbindError = window.api.ai.onError((data) => {
    if (data.requestId !== requestId) return
    finished = true
    unbindChunk()
    unbindDone()
    unbindError()
    callbacks.onError?.(data.error)
  })
  window.api.ai.chat({ ...params, requestId }).catch((e: unknown) => {
    if (finished) return
    unbindChunk()
    unbindDone()
    unbindError()
    callbacks.onError?.(e instanceof Error ? e.message : String(e))
  })
  return requestId
}

export const useCharacterCreatorStore = create<CharacterCreatorState>((set, get) => ({
  step: 0,
  draft: createEmptyDraft(),
  coverMode: 'upload',
  coverBase64: null,
  coverIsThumb: false,
  coverPrompt: '',
  negativePrompt: 'lowres, bad anatomy, bad hands, worst quality, low quality, blurry, watermark',
  coverSize: '576x768',
  avatarPosition: 'center',
  isExpanding: false,
  isGeneratingCover: false,
  isSaving: false,
  generatingField: null,
  generatingGreetingIndex: null,
  expandRequestId: null,
  error: null,

  setStep: (step) => set({ step, error: null }),

  setCoverMode: (mode) => set({ coverMode: mode }),

  updateDraft: (partial) => set((state) => ({ draft: { ...state.draft, ...partial } })),

  setAvatarPosition: (pos) => set({ avatarPosition: pos }),

  setCover: (base64, mode) =>
    set((state) => ({
      coverBase64: base64,
      coverMode: mode ?? state.coverMode,
      coverIsThumb: false, // 用户主动上传/生成的封面视为高清，清除缩略图标记
    })),

  setCoverPrompt: (coverPrompt) => set({ coverPrompt }),
  setNegativePrompt: (negativePrompt) => set({ negativePrompt }),
  setCoverSize: (coverSize) => set({ coverSize }),

  /** 从草稿构建提示词并填入编辑框；信息不足返回 false */
  buildPromptFromDraft: () => {
    const { draft } = get()
    const prompt = buildCoverPrompt(draft)
    if (!prompt) return false
    set({ coverPrompt: prompt, error: null })
    return true
  },

  aiExpand: async (concept) => {
    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile) {
      set({ error: '请先在「API 页面」配置 AI 连接' })
      return
    }
    if (!concept.trim()) {
      set({ error: '请先输入角色概念，如「赛博朋克世界的女黑客」' })
      return
    }
    // 重复点击时取消上一次
    const prevRequest = get().expandRequestId
    if (prevRequest) {
      window.api.ai.cancelChat(prevRequest)
    }
    set({ isExpanding: true, error: null })

    const requestId = runAIChat(
      {
        messages: [
          { role: 'system', content: CHARACTER_EXPAND_PROMPT },
          { role: 'user', content: concept },
        ],
        provider: profile.provider,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        model: profile.model,
        temperature: 0.8,
        topP: 0.95,
        maxTokens: 2048,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stream: true,
      },
      {
        onDone: (text) => {
          // H-13 修复：主进程 abort 被视为正常结束并补发 aiDone，被取消/替换的旧请求
          // 必须忽略其 onDone，否则污染新请求状态与草稿
          if (get().expandRequestId !== requestId) return
          const parsed = parseExpandResult(text)
          set((state) => ({
            draft: { ...state.draft, ...(parsed ?? {}) },
            isExpanding: false,
            expandRequestId: null,
            error: parsed ? null : 'AI 返回内容无法解析，请重试或手动填写',
          }))
        },
        onError: (err) => {
          if (get().expandRequestId !== requestId) return
          set({ isExpanding: false, expandRequestId: null, error: err })
        },
      },
    )
    set({ expandRequestId: requestId })
  },

  aiGenerateField: async (field, userInput) => {
    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile) {
      set({ error: '请先在「API 页面」配置 AI 连接' })
      return
    }
    const prevFieldRequest = get().expandRequestId
    if (prevFieldRequest) {
      window.api.ai.cancelChat(prevFieldRequest)
    }
    set({ generatingField: field, error: null })

    const { systemPrompt, userContent } = buildFieldGeneratePrompt(field, get().draft, userInput)
    const requestId = runAIChat(
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        provider: profile.provider,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        model: profile.model,
        temperature: 0.8,
        topP: 0.95,
        maxTokens: 1024,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stream: true,
      },
      {
        onDone: (text) => {
          // H-13：被取消/替换的旧请求忽略其补发 aiDone
          if (get().expandRequestId !== requestId) return
          const content = cleanFieldOutput(text, field).trim()
          set((state) => {
            if (!content) {
              return { generatingField: null, expandRequestId: null, error: `「${FIELD_LABELS[field]}」生成失败，请重试` }
            }
            const draft = { ...state.draft }
            if (field === 'tags') {
              draft.tags = content
                .split(/[,，、\s]+/)
                .map((t) => t.trim())
                .filter(Boolean)
                .slice(0, 8)
            } else {
              ;(draft as unknown as Record<string, unknown>)[field] = content
            }
            return { draft, generatingField: null, expandRequestId: null, error: null }
          })
        },
        onError: (err) => {
          if (get().expandRequestId !== requestId) return
          set({ generatingField: null, expandRequestId: null, error: err })
        },
      },
    )
    // H-12 修复：写入 expandRequestId（此前从不写入，取消按钮/重复点击取消完全失效）
    set({ expandRequestId: requestId })
  },

  aiGenerateGreeting: async (index, userInput) => {
    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile) {
      set({ error: '请先在「API 页面」配置 AI 连接' })
      return
    }
    const prevGreetingRequest = get().expandRequestId
    if (prevGreetingRequest) {
      window.api.ai.cancelChat(prevGreetingRequest)
    }
    set({ generatingGreetingIndex: index, error: null })

    const { systemPrompt, userContent } = buildGreetingPrompt(index, get().draft, userInput)
    const requestId = runAIChat(
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        provider: profile.provider,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        model: profile.model,
        temperature: 0.9,
        topP: 0.95,
        maxTokens: 1024,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stream: true,
      },
      {
        onDone: (text) => {
          // H-13：被取消/替换的旧请求忽略其补发 aiDone
          if (get().expandRequestId !== requestId) return
          const content = cleanFieldOutput(text).trim()
          set((state) => {
            if (!content) {
              return { generatingGreetingIndex: null, expandRequestId: null, error: '开场白生成失败，请重试' }
            }
            const draft = { ...state.draft }
            if (index === -1) {
              draft.firstMessage = content
            } else {
              const list = [...(draft.alternateGreetings ?? [])]
              while (list.length <= index) list.push('')
              list[index] = content
              draft.alternateGreetings = list
            }
            return { draft, generatingGreetingIndex: null, expandRequestId: null, error: null }
          })
        },
        onError: (err) => {
          if (get().expandRequestId !== requestId) return
          set({ generatingGreetingIndex: null, expandRequestId: null, error: err })
        },
      },
    )
    // H-12 修复：写入 expandRequestId
    set({ expandRequestId: requestId })
  },

  cancelExpand: () => {
    const { expandRequestId } = get()
    if (expandRequestId) {
      window.api.ai.cancelChat(expandRequestId)
    }
    set({ isExpanding: false, generatingField: null, generatingGreetingIndex: null, expandRequestId: null })
  },

  generateCover: async () => {
    const { coverPrompt, negativePrompt, coverSize } = get()
    if (!coverPrompt.trim()) {
      set({ error: '提示词不能为空，可点击「重新构建提示词」自动生成' })
      return
    }
    const gen = useSettingsStore.getState().getActiveImageGen()
    if (!gen) {
      set({ error: '未配置生图模组，请先在「API 页面」配置 SD WebUI 或 DALL-E' })
      return
    }
    set({ isGeneratingCover: true, error: null })
    try {
      const result = await window.api.imageGen.generate(coverPrompt, {
        negativePrompt,
        size: coverSize,
      })
      if (!result.success || !result.images?.length) {
        set({ error: result.error || '生图失败，请重试' })
        return
      }
      let img = result.images[0]
      // DALL-E（openai provider）返回 1024×1024 正方形 → 前端裁为 3:4 封面
      if (gen.provider === 'openai') {
        img = (await cropCoverTo34(img)) ?? img
      }
      set({ coverBase64: img, coverMode: 'generate', error: null })
    } catch (e) {
      set({ error: `生图失败：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      set({ isGeneratingCover: false })
    }
  },

  saveCharacter: async () => {
    const { draft, coverBase64, avatarPosition, coverIsThumb } = get()
    if (get().isSaving) return null
    if (coverIsThumb) {
      set({ error: '草稿封面是压缩缩略图（192×256），请回到「封面制作」重新上传或生成高清封面后再保存' })
      return null
    }
    set({ isSaving: true, error: null })
    try {
      const character: Character = {
        ...draft,
        name: draft.name.trim() || '未命名角色',
        updatedAt: Date.now(),
      }
      if (coverBase64) {
        const avatar = await cropAvatar(coverBase64, { position: avatarPosition })
        if (avatar) character.avatar = avatar
        character.cover = coverBase64
      }
      const store = useCharacterStore.getState()
      await store.saveCharacter(character)
      await store.loadCharacters()
      store.selectCharacter(character.id)
      get().clearDraft()
      return character
    } catch (e) {
      set({ error: `保存失败：${e instanceof Error ? e.message : String(e)}` })
      return null
    } finally {
      set({ isSaving: false })
    }
  },

  persistDraft: async () => {
    const { draft, step, coverBase64, avatarPosition } = get()
    try {
      const snapshot: DraftSnapshot = {
        step,
        draft: { ...draft, avatar: '', cover: undefined } as unknown as Omit<Character, 'avatar' | 'cover'>,
        avatarPosition,
        savedAt: Date.now(),
      }
      if (coverBase64) {
        snapshot.coverThumb = (await downscaleImage(coverBase64, 192, 256)) ?? undefined
      }
      localStorage.setItem(DRAFT_KEY, JSON.stringify(snapshot))
    } catch (e) {
      // 配额不足/隐私模式：仅保留内存草稿，不阻塞流程
      console.warn('[character-creator] 草稿持久化失败', e)
    }
  },

  restoreDraft: () => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      if (!raw) return false
      const saved = JSON.parse(raw) as DraftSnapshot
      if (!saved || typeof saved !== 'object' || !saved.draft?.id) return false
      const restored = {
        ...saved.draft,
        // 数组字段兜底：旧版本/手写草稿可能缺失，避免渲染层 .map 崩溃
        tags: Array.isArray(saved.draft.tags) ? saved.draft.tags : [],
        alternateGreetings: Array.isArray(saved.draft.alternateGreetings)
          ? saved.draft.alternateGreetings
          : [],
        lorebookId: saved.draft.lorebookId ?? null,
        avatar: '',
        cover: saved.coverThumb ?? undefined,
      } as Character
      set({
        step: (saved.step ?? 0) as CreatorStep,
        draft: restored,
        avatarPosition: saved.avatarPosition ?? 'center',
        coverBase64: saved.coverThumb ?? null,
        coverIsThumb: !!saved.coverThumb,
        coverMode: 'upload',
        error: null,
      })
      return true
    } catch {
      return false
    }
  },

  hasDraft: () => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      if (!raw) return false
      const saved = JSON.parse(raw) as DraftSnapshot
      return !!saved?.draft?.id
    } catch {
      return false
    }
  },

  clearDraft: () => {
    try {
      localStorage.removeItem(DRAFT_KEY)
    } catch {
      // ignore
    }
  },

  reset: () => {
    const prevResetRequest = get().expandRequestId
    if (prevResetRequest) {
      window.api.ai.cancelChat(prevResetRequest)
    }
    set({
      step: 0,
      draft: createEmptyDraft(),
      coverMode: 'upload',
      coverBase64: null,
      coverIsThumb: false,
      coverPrompt: '',
      negativePrompt: 'lowres, bad anatomy, bad hands, worst quality, low quality, blurry, watermark',
      coverSize: '576x768',
      avatarPosition: 'center',
      isExpanding: false,
      isGeneratingCover: false,
      isSaving: false,
      generatingField: null,
      generatingGreetingIndex: null,
      expandRequestId: null,
      error: null,
    })
    get().clearDraft()
  },
}))
