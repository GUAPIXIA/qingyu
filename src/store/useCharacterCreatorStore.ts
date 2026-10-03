/**
 * 角色卡制作向导状态管理
 *
 * - aiExpand: 一句话概念 → AI 扩展为完整角色设定（流式，支持取消）
 * - aiGenerateField: 单字段「帮我写」（以其他字段为上下文）
 * - UEX-P2-07: 「帮我写」生成结果不再直接覆盖字段，进入 pendingGeneration 待确认，
 *   由 applyGenerated('replace' | 'append' | 'discard') 三选处理
 * - generateCover: 调用 imageGen 生成 3:4 封面（DALL-E 正方形自动裁 3:4）
 * - saveCharacter: 保存（含 1:1 头像裁剪）+ 选中 + 清草稿
 * - 草稿持久化：文本字段 + 封面缩略图（完整 base64 不落 localStorage）
 */
import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { useCharacterStore } from './useCharacterStore'
import { useSettingsStore } from './useSettingsStore'
import { useToastStore } from './useToastStore'
import { cropAvatar, cropCoverTo34, downscaleImage } from '../utils/avatarCrop'
import { buildCoverPrompt } from '../utils/charPrompt'
import type { Character } from '../../shared/types'
import type { ChatParams } from '../../shared/types'
import { stripAllThinking } from '../../shared/thoughtMarkup'
import { resolveRendererGenerationTaskBudget } from './generationTaskBudget'
import { EditorAssistant, type EditorTicket, type EditorSuggestion } from './editorAssistant'
const creatorAssistant = new EditorAssistant('character-creator', '')

export const DRAFT_KEY = 'character-creator-draft'

export type CreatorStep = 0 | 1 | 2
export type AvatarPosition = 'top' | 'center' | 'bottom'
export type GenerateField = 'name' | 'description' | 'personality' | 'scenario' | 'firstMessage' | 'exampleDialog' | 'tags'

/** UEX-P2-07：「帮我写」生成结果的落点（普通字段 / 开场白） */
export type GeneratedTarget =
  | { kind: 'field'; field: GenerateField }
  | { kind: 'greeting'; index: number } // -1 = 主首条消息，>=0 = 备选开场白（alternateGreetings[i]）

/** UEX-P2-07：待确认的生成结果（生成完成不直接写 draft，等用户替换/追加/放弃） */
export interface PendingGeneration {
  target: GeneratedTarget
  /** 生成结果原文（tags 为顿号/逗号分隔文本，apply 时解析为数组） */
  content: string
  /** 发起时的原值；替换核对版本，显式追加基于最新草稿。 */
  original: string
  source?: EditorTicket
}

/** UEX-P2-07：三选动作——replace 覆盖 / append 追加 / discard 放弃 */
export type ApplyGeneratedAction = 'replace' | 'append' | 'discard'

/** UEX-P2-07：tags 生成原文 → 标签数组（顿号/逗号/空白切分，上限 8 与标签编辑器一致） */
export function parseGeneratedTags(content: string): string[] {
  return content
    .split(/[,，、\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8)
}

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
  let out = stripAllThinking(text)
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
  const cleaned = stripAllThinking(text.replace(/```(?:json)?/gi, ''))
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

/** UEX-P1-19：草稿是否含实质内容（name/step/任一文本字段/标签/备选开场白/封面非空；
 * 空草稿也带 nanoid id，不能只看 id） */
export function isDraftMeaningful(input: {
  draft?: Partial<Character> | null
  step?: number
  cover?: string | null
}): boolean {
  const d = input.draft
  if (!d) return false
  if ((input.step ?? 0) > 0) return true
  if (input.cover) return true
  const textFields = [d.name, d.description, d.personality, d.scenario, d.firstMessage, d.exampleDialog]
  if (textFields.some((v) => typeof v === 'string' && v.trim().length > 0)) return true
  if (Array.isArray(d.tags) && d.tags.length > 0) return true
  if (d.alternateGreetings?.some((g) => typeof g === 'string' && g.trim().length > 0)) return true
  return false
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
  oldSuggestions: EditorSuggestion[]
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
  /** UEX-P2-07：待确认的「帮我写」生成结果（单槽位；新生成会静默丢弃旧的未决结果） */
  pendingGeneration: PendingGeneration | null
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
  /** UEX-P2-07：处理待确认生成结果（replace 覆盖 / append 追加 / discard 放弃），apply 时读最新 draft */
  applyGenerated: (action: ApplyGeneratedAction) => void
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

/** 与其他编辑辅助共用取消、监听清理、超时和任务路由。 */
function runAIChat(params: Omit<ChatParams, 'requestId'>, callbacks: {
  onDone?: (text: string) => void; onError?: (error: string) => void
}, ticket: EditorTicket): string {
  void creatorAssistant.request(ticket, { ...params, requestId: ticket.task.id })
    .then(text => callbacks.onDone?.(text))
    .catch(error => callbacks.onError?.(error instanceof Error ? error.message : String(error)))
    .finally(() => creatorAssistant.finish(ticket))
  return ticket.task.id
}

export const useCharacterCreatorStore = create<CharacterCreatorState>((set, get) => ({
  oldSuggestions: [],
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
  pendingGeneration: null,
  expandRequestId: null,
  error: null,

  setStep: (step) => set({ step, error: null }),

  setCoverMode: (mode) => set({ coverMode: mode }),

  updateDraft: (partial) => {
    creatorAssistant.touch()
    set((state) => ({ draft: { ...state.draft, ...partial } }))
  },

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
    // 登记新任务时统一取消上一次，包括预算等待。
    set({ isExpanding: true, generatingField: null, generatingGreetingIndex: null, pendingGeneration: null, error: null })
    const initialDraft = structuredClone(get().draft)
    creatorAssistant.syncObject(initialDraft.id)
    const ticket = creatorAssistant.begin('character_expand', [initialDraft, concept])
    set({ expandRequestId: ticket.task.id })
    const model = profile.model
    let plan
    try {
      plan = await resolveRendererGenerationTaskBudget({
        profile, model, task: 'character_expand', inputChars: concept.length,
      })
    } catch (error) {
      if (creatorAssistant.owns(ticket)) set({ isExpanding: false, generatingField: null, generatingGreetingIndex: null, expandRequestId: null, error: error instanceof Error ? error.message : String(error) })
      creatorAssistant.finish(ticket)
      return
    }

    if (!creatorAssistant.owns(ticket)) return
    const requestId = runAIChat(
      {
        messages: [
          { role: 'system', content: CHARACTER_EXPAND_PROMPT },
          { role: 'user', content: concept },
        ],
        provider: profile.provider,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        model,
        temperature: 0.8,
        topP: 0.95,
        maxTokens: plan.requestMaxTokens,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stream: true,
        reasoningGate: plan.reasoningGate,
      },
      {
        onDone: (text) => {
          // H-13 修复：主进程 abort 被视为正常结束并补发 aiDone，被取消/替换的旧请求
          // 必须忽略其 onDone，否则污染新请求状态与草稿
          if (get().expandRequestId !== ticket.task.id || !creatorAssistant.owns(ticket)) return
          const parsed = parseExpandResult(text)
          if (parsed && !creatorAssistant.current(ticket)) {
            creatorAssistant.keep(ticket, JSON.stringify(parsed, null, 2), '角色设定扩展')
            set({ oldSuggestions: [...creatorAssistant.suggestions], isExpanding: false, expandRequestId: null })
            return
          }
          if (parsed) creatorAssistant.touch()
          set((state) => ({
            draft: { ...state.draft, ...(parsed ?? {}) },
            isExpanding: false,
            expandRequestId: null,
            error: parsed ? null : 'AI 返回内容无法解析，请重试或手动填写',
          }))
        },
        onError: (err) => {
          if (get().expandRequestId !== ticket.task.id || !creatorAssistant.owns(ticket)) return
          set({ isExpanding: false, expandRequestId: null, error: err })
        },
      },
      ticket,
    )
    set({ expandRequestId: requestId })
  },

  aiGenerateField: async (field, userInput) => {
    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile) {
      set({ error: '请先在「API 页面」配置 AI 连接' })
      return
    }
    // UEX-P2-07：简单方案——再次点「帮我写」时静默丢弃旧的未决生成结果，再发起新生成
    set({ isExpanding: false, generatingField: field, generatingGreetingIndex: null, error: null, pendingGeneration: null })

    const initialDraft = structuredClone(get().draft)
    creatorAssistant.syncObject(initialDraft.id)
    const ticket = creatorAssistant.begin('character_field', [initialDraft, [field, userInput]])
    set({ expandRequestId: ticket.task.id })
    const { systemPrompt, userContent } = buildFieldGeneratePrompt(field, initialDraft, userInput)
    const model = profile.model
    let plan
    try {
      plan = await resolveRendererGenerationTaskBudget({
        profile, model, task: 'character_field', inputChars: userContent.length,
      })
    } catch (error) {
      if (creatorAssistant.owns(ticket)) set({ isExpanding: false, generatingField: null, generatingGreetingIndex: null, expandRequestId: null, error: error instanceof Error ? error.message : String(error) })
      creatorAssistant.finish(ticket)
      return
    }
    if (!creatorAssistant.owns(ticket)) return
    const requestId = runAIChat(
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        provider: profile.provider,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        model,
        temperature: 0.8,
        topP: 0.95,
        maxTokens: plan.requestMaxTokens,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stream: true,
        reasoningGate: plan.reasoningGate,
      },
      {
        onDone: (text) => {
          // H-13：被取消/替换的旧请求忽略其补发 aiDone
          if (get().expandRequestId !== ticket.task.id || !creatorAssistant.owns(ticket)) return
          const content = cleanFieldOutput(text, field).trim()
          if (!content) {
            set({ generatingField: null, expandRequestId: null, error: `「${FIELD_LABELS[field]}」生成失败，请重试` })
            return
          }
          // UEX-P2-07：生成结果进入待确认（替换/追加/放弃），不直接覆盖 draft 字段
          set({
            pendingGeneration: {
              target: { kind: 'field', field },
              content, source: ticket,
              // 对比发起时的原值；提交时另行核对版本。
              original: field === 'tags' ? (initialDraft.tags ?? []).join('、') : initialDraft[field] ?? '',
            },
            generatingField: null,
            expandRequestId: null,
            error: null,
          })
        },
        onError: (err) => {
          if (get().expandRequestId !== ticket.task.id || !creatorAssistant.owns(ticket)) return
          set({ generatingField: null, expandRequestId: null, error: err })
        },
      },
      ticket,
    )
    // 与任务身份一致，旧任务回调不能修改新操作状态。
    set({ expandRequestId: requestId })
  },

  aiGenerateGreeting: async (index, userInput) => {
    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile) {
      set({ error: '请先在「API 页面」配置 AI 连接' })
      return
    }
    // UEX-P2-07：简单方案——新生成静默丢弃旧的未决生成结果
    set({ isExpanding: false, generatingField: null, generatingGreetingIndex: index, error: null, pendingGeneration: null })

    const initialDraft = structuredClone(get().draft)
    creatorAssistant.syncObject(initialDraft.id)
    const ticket = creatorAssistant.begin('greeting', [initialDraft, [index, userInput]])
    set({ expandRequestId: ticket.task.id })
    const { systemPrompt, userContent } = buildGreetingPrompt(index, initialDraft, userInput)
    const model = profile.model
    let plan
    try {
      plan = await resolveRendererGenerationTaskBudget({
        profile, model, task: 'greeting', inputChars: userContent.length,
      })
    } catch (error) {
      if (creatorAssistant.owns(ticket)) set({ isExpanding: false, generatingField: null, generatingGreetingIndex: null, expandRequestId: null, error: error instanceof Error ? error.message : String(error) })
      creatorAssistant.finish(ticket)
      return
    }
    if (!creatorAssistant.owns(ticket)) return
    const requestId = runAIChat(
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        provider: profile.provider,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        model,
        temperature: 0.9,
        topP: 0.95,
        maxTokens: plan.requestMaxTokens,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stream: true,
        reasoningGate: plan.reasoningGate,
      },
      {
        onDone: (text) => {
          // H-13：被取消/替换的旧请求忽略其补发 aiDone
          if (get().expandRequestId !== ticket.task.id || !creatorAssistant.owns(ticket)) return
          const content = cleanFieldOutput(text).trim()
          if (!content) {
            set({ generatingGreetingIndex: null, expandRequestId: null, error: '开场白生成失败，请重试' })
            return
          }
          // UEX-P2-07：生成结果进入待确认（替换/追加/放弃），不直接覆盖开场白
          set({
            pendingGeneration: {
              target: { kind: 'greeting', index },
              content, source: ticket,
              // 生成时原文仅作 UI 对比展示；apply 时读最新 draft
              original: index === -1
                ? initialDraft.firstMessage
                : initialDraft.alternateGreetings?.[index] ?? '',
            },
            generatingGreetingIndex: null,
            expandRequestId: null,
            error: null,
          })
        },
        onError: (err) => {
          if (get().expandRequestId !== ticket.task.id || !creatorAssistant.owns(ticket)) return
          set({ generatingGreetingIndex: null, expandRequestId: null, error: err })
        },
      },
      ticket,
    )
    // 保留当前任务身份。
    set({ expandRequestId: requestId })
  },

  /** UEX-P2-07：处理待确认生成结果——replace 覆盖 / append 追加 / discard 放弃；
   * 替换核对发起版本；追加由用户明确选择，并基于最新草稿计算。 */
  applyGenerated: (action) => {
    const pending = get().pendingGeneration
    if (!pending) return
    if (action === 'discard') {
      // 放弃 = 丢弃生成结果；draft 从未被写入，天然恢复原样
      set({ pendingGeneration: null })
      return
    }
    if (pending.source && (!creatorAssistant.owns(pending.source) || (action === 'replace' && !creatorAssistant.current(pending.source)))) {
      set({ error: '草稿已变化，请查看旧建议或重新生成；未覆盖当前输入' })
      return
    }
    creatorAssistant.touch()
    set((state) => {
      const draft = { ...state.draft }
      const { target, content } = pending
      if (target.kind === 'field') {
        if (target.field === 'tags') {
          const generated = parseGeneratedTags(content)
          // replace = 替换整个标签数组；append = 合并去重（现有标签在前，上限 8）
          draft.tags =
            action === 'replace'
              ? generated
              : [...new Set([...(draft.tags ?? []), ...generated])].slice(0, 8)
        } else {
          const current = draft[target.field] ?? ''
          // replace = 覆盖；append = 当前值 + 空行分隔 + 新内容（当前值取 apply 时最新）
          draft[target.field] = action === 'replace' ? content : current ? `${current}\n\n${content}` : content
        }
      } else if (action === 'replace') {
        // 开场白 replace = 覆盖当前开场白（-1 主消息 / >=0 备选 i，沿用原索引扩容语义）
        if (target.index === -1) {
          draft.firstMessage = content
        } else {
          const list = [...(draft.alternateGreetings ?? [])]
          while (list.length <= target.index) list.push('')
          list[target.index] = content
          draft.alternateGreetings = list
        }
      } else {
        // 开场白 append = 数据结构支持变体数组 → 追加为新备选开场白（不动当前文本）
        draft.alternateGreetings = [...(draft.alternateGreetings ?? []), content]
      }
      return { draft, pendingGeneration: null }
    })
  },

  cancelExpand: () => {
    creatorAssistant.cancel()
    const { expandRequestId } = get()
    if (expandRequestId) {
      window.api.ai.cancelChat(expandRequestId)
    }
    set({ isExpanding: false, generatingField: null, generatingGreetingIndex: null, expandRequestId: null, pendingGeneration: null })
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
      // DALL-E 3 只接受标准尺寸，封面固定出 1024×1024 正方形，再由 cropCoverTo34 裁成 3:4。
      // 其余 provider（sd-webui / comfyui）沿用用户选择的 3:4 尺寸。
      const size = gen.provider === 'openai' ? '1024x1024' : coverSize
      const result = await window.api.imageGen.generate(coverPrompt, {
        negativePrompt,
        size,
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
        if (avatar) {
          character.avatar = avatar
        } else {
          // UEX-P2-08：头像裁剪失败不再静默——轻提示，不阻塞保存（保持降级语义）
          useToastStore.getState().push({ variant: 'warning', title: '头像生成失败，可稍后手动设置', requestId: 'char-create-avatar' })
        }
        character.cover = coverBase64
      }
      const store = useCharacterStore.getState()
      await store.saveCharacter(character)
      await store.loadCharacters()
      store.selectCharacter(character.id)
      get().clearDraft()
      get().reset()
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
      creatorAssistant.cancel(); creatorAssistant.touch(); creatorAssistant.syncObject(restored.id)
      set({
        isExpanding: false, generatingField: null, generatingGreetingIndex: null, expandRequestId: null, oldSuggestions: [],
        step: (saved.step ?? 0) as CreatorStep,
        draft: restored,
        avatarPosition: saved.avatarPosition ?? 'center',
        coverBase64: saved.coverThumb ?? null,
        coverIsThumb: !!saved.coverThumb,
        coverMode: 'upload',
        error: null,
        pendingGeneration: null, // UEX-P2-07：待确认生成结果不随草稿持久化，恢复时清空
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
      if (!saved?.draft?.id) return false
      // UEX-P1-19：空草稿也有 nanoid id，需含实质内容才算可恢复草稿
      return isDraftMeaningful({ draft: saved.draft, step: saved.step, cover: saved.coverThumb })
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
    creatorAssistant.cancel(); creatorAssistant.touch()
    const prevResetRequest = get().expandRequestId
    if (prevResetRequest) {
      window.api.ai.cancelChat(prevResetRequest)
    }
    set({
      oldSuggestions: [],
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
      pendingGeneration: null,
      expandRequestId: null,
      error: null,
    })
    get().clearDraft()
  },
}))
