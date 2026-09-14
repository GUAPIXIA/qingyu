/**
 * 生成效果分批评测器（对话 / 续写 / 下一步方向 / 生图提示词 / 预设生成）
 *
 * 目标：用项目**已配置的模型**（--model，默认 deepseek-v4.1-flash；活跃 profile 常为 chenxi）跑真实生成链路，
 * 量化各生成面的产出质量与结构合规率。所有提示词都由被测代码自己装配，脚本不重写提示词。
 *
 * 真实链路：
 *   对话     buildContextMessagesFromData + buildChatParamsFromData → openaiAdapter.chat
 *   续写     buildContinueContext → chat → parseContinueResult → evaluateContinueLength（含一次修复重发）
 *   方向     buildDialogueDirectionSystemPrompt/UserPrompt → chat → parseDialogueDirections（含一次重试）
 *   提示词   imagineCommand.execute → buildSystemPrompt → callAiHelper → parseImagePromptResult → finalizeImagePrompt
 *   预设     PresetsPage 同款提示词 → parsePresetGeneration
 *
 * 用法（分批跑，结果可 --append 累积到同一 out 目录）：
 *   npx tsx scripts/evaluate-generation.ts --batch dialogue --key-file "$TEMP/qingyu-eval-key.txt" \
 *     --base-url https://api.commandcode.ai/provider/v1 --model deepseek-v4.1-flash \
 *     --out .poc-tmp/eval-gen
 *   --batch continue|directions|imagine|preset|all   --judge on|off   --only <caseId,caseId>
 *
 * 说明：
 * - 不生图：imagine 批次把 window.api.imageGen.generate 替换为捕获函数。
 * - 非流式：脚本用 stream=false 调用（与应用同一提示词、同一适配器；仅省去 SSE 分片）。
 * - 评审用同一模型（受“只允许该模型”约束），属自评审，结论需结合结构化校验一起看。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openaiAdapter } from '../electron/services/adapters/openai'
import { claudeAdapter } from '../electron/services/adapters/claude'
import { isRetryableError } from '../electron/services/adapters/types'
import type { ChatParams, Character, Message, Preset, Settings } from '../shared/types'
import type { ActiveProfile, ContextBuildData } from '../shared/contextTypes'

// ===================== 类型 =====================

type BatchName = 'dialogue' | 'group' | 'stream' | 'continue' | 'directions' | 'imagine' | 'preset' | 'memory' | 'verify'
type Level = 'pass' | 'warn' | 'fail'

interface Check {
  id: string
  level: Level
  detail: string
}

interface TransportStat {
  index: number
  status: number
  finishReason: string | null
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  contentChars: number
}

interface JudgeVerdict {
  parsed: boolean
  verdict?: string
  scores?: Record<string, number>
  issues: string[]
  raw: string
}

interface CaseResult {
  batch: BatchName
  id: string
  title: string
  systemPrompt: string
  userPrompt: string
  /** 首次响应（原始） */
  raw: string
  /** 业务最终结果（解析/替换后） */
  final: string
  attempts: number
  extra: Record<string, unknown>
  checks: Check[]
  judge?: JudgeVerdict
  /** 生成调用的传输统计（不含评审调用） */
  transport: TransportStat[]
  /** 评审调用的传输统计 */
  judgeTransport?: TransportStat[]
  durationMs: number
  error?: string
}

interface CliOptions {
  baseUrl: string
  model: string
  /** 活跃 profile 的 provider（openai / anthropic 等），不得按模型名猜测 */
  provider: string
  apiKey: string
  batches: BatchName[]
  judge: boolean
  outDir: string
  append: boolean
  only: string[]
  concurrency: number
  reps: number
  /** 只补评审，不重新生成（用已有 results-<batch>.json） */
  judgeOnly: boolean
  /** 只用已有 results-*.json 重新生成报告（不调用模型） */
  reportOnly: boolean
}

// ===================== 固定夹具 =====================

const CHAR_SUWAN: Character = {
  id: 'eval-suwan',
  name: '苏晚',
  avatar: '',
  description: '28 岁女性，鹅蛋脸，黑色长发及腰，深褐色眼睛，身形清瘦高挑，左眉尾有一道浅疤。市立图书馆古籍修复师，习惯随身带一小卷棉线。',
  personality: '外冷内热，说话简短，遇事习惯先观察再动手；对在意的人会记住细枝末节。',
  scenario: '梅雨季的老城区公寓，阳台正对着一条积水窄巷。',
  firstMessage: '（她把湿伞靠在门边，没有看你）“……你淋透了。进来吧，别站在走廊上滴水。”',
  exampleDialog: '{{user}}: 今天怎么这么晚？\n{{char}}: “书库漏雨。”她把外套挂好，“我一个人搬了四箱。”',
  tags: ['现代', '日常', '慢热'],
  lorebookId: null,
  creator: 'eval',
  createdAt: 0,
  updatedAt: 0,
  alternateGreetings: [],
  postHistoryInstructions: '保持简短克制的对白节奏；不替{{user}}做决定，不描写{{user}}的内心。',
}

const CHAR_LINYAN: Character = {
  id: 'eval-linyan',
  name: '林砚',
  avatar: '',
  description: '二十五六岁，高束发，眉峰锐利，常年一身靛蓝短打，左手小指缺了一节旧伤。六扇门捕快。',
  personality: '爽利、爱抬杠，办案时不讲情面，私下心软，厌恶拖泥带水。',
  scenario: '江南梅雨，城隍庙后巷的凶案现场。',
  firstMessage: '（她蹲在尸首旁，头也不抬）“……又见面了。这回你可别再说自己是路过的。”',
  exampleDialog: '{{user}}: 我只是路过。\n{{char}}: “路过的人不会带着凶器的鞘。”她终于抬眼。',
  tags: ['古风', '悬疑', '强角色'],
  lorebookId: null,
  creator: 'eval',
  createdAt: 0,
  updatedAt: 0,
  alternateGreetings: [],
}

/** 生图批次角色 */
const CHAR_SHEN: Character = {
  ...CHAR_SUWAN,
  id: 'eval-shen',
  name: '沈星回',
  description: '29 岁女性，东亚面孔，丹凤眼，齐肩黑直发，鼻梁挺直，身形偏瘦，右手腕缠着白色绷带。',
  personality: '沉静、谨慎，习惯用短句回答问题。',
  scenario: '冬夜末班地铁的车厢连接处。',
}

const USER_PROFILE = {
  name: '陈默',
  description: '三十岁上下，短寸头，常穿深灰连帽外套。',
  persona: '说话直接，不绕弯子。',
}

function asMessage(partial: Partial<Message> & Pick<Message, 'role' | 'content'>): Message {
  return {
    id: `m-${Math.random().toString(36).slice(2, 9)}`,
    sessionId: 'eval-session',
    characterId: 'eval-suwan',
    images: [],
    isEditing: false,
    timestamp: Date.now(),
    ...partial,
  } as Message
}

/** 苏晚：雨夜阳台，收在悬念处（用于对话与方向） */
const SUWAN_MESSAGES: Message[] = [
  asMessage({ role: 'user', content: '外面雨太大了，先把窗关上吧。', name: USER_PROFILE.name } as never),
  asMessage({ role: 'assistant', content: '<thought>他浑身是水，先别问为什么来。</thought>\n\n苏晚没有回头，右手还攥着栏杆，指节发白。' }),
  asMessage({ role: 'user', content: '你的外套全湿了。', name: USER_PROFILE.name } as never),
  asMessage({
    role: 'assistant',
    content: '“我知道。”她这才松开栏杆转过身，湿透的黑色风衣下摆滴着水。\n\n*左手把贴在脸侧的湿发拨到耳后，目光越过我看向桌上那盏台灯。*\n\n“……你来得正好。灯，半小时前就灭了。”',
  }),
  asMessage({ role: 'user', content: '停电了？物业怎么说。', name: USER_PROFILE.name } as never),
  asMessage({
    role: 'assistant',
    content: '*她弯腰从鞋柜最下层摸出一支用剩的蜡烛，火柴划了两次才点着。*\n\n“整栋楼都停了。物业电话打不通。”\n\n*烛火把她的影子拉长在墙上，她忽然压低声音。*\n\n“……刚才有人在楼下巷子里喊我的名字。”',
  }),
]

/** 林砚：凶案现场，用于跨题材验证 */
const LINYAN_MESSAGES: Message[] = [
  asMessage({ role: 'user', content: '我真的只是路过。', name: USER_PROFILE.name } as never),
  asMessage({
    role: 'assistant',
    content: '“路过的人不会带着凶器的鞘。”林砚终于抬眼。\n\n*她站起身，靛蓝短打的下摆扫过积水的青砖。*\n\n“死的是漕帮的账房。三更天，后巷，一刀封喉——手法干净得不像本地人。”',
  }),
  asMessage({ role: 'user', content: '你怀疑我？', name: USER_PROFILE.name } as never),
  asMessage({
    role: 'assistant',
    content: '*她从袖中抖出半截断刃，刃口朝你。*\n\n“我怀疑所有人。但这截刀柄上刻着‘陈’字。”\n\n“……你姓陈。”',
  }),
]

/** 沈星回：末班地铁，用于生图批次 */
const SHEN_MESSAGES: Message[] = [
  asMessage({ role: 'user', content: '末班车快到了，你的手怎么了？', name: USER_PROFILE.name } as never),
  asMessage({
    role: 'assistant',
    content: '“……旧伤。”她把右手往袖口里缩了缩。\n\n*车厢连接处的风把她额前碎发吹起来，她盯着玻璃门上自己的倒影。*\n\n“别问了。到站你就下车。”',
  }),
  asMessage({ role: 'user', content: '我的站还早，你先说。', name: USER_PROFILE.name } as never),
  asMessage({
    role: 'assistant',
    content: '*她沉默了几秒，把缠着绷带的右手从袖子里伸出来，指节上还留着没洗净的血痕。*\n\n“……不是我的血。”\n\n*车门上方到站灯亮起，她忽然侧头看向你，口罩上方的眼睛很亮。*',
  }),
]

/** 世界书：一条常驻（现实向规则）+ 一条关键词触发（停电） */
const LOREBOOK_FIXTURE = {
  id: 'eval-lore',
  name: '老城区设定',
  description: '',
  scanDepth: 4,
  tokenBudget: 0,
  entryCount: 2,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  entries: [
    {
      id: 'e-always',
      keywords: [],
      content: '本世界没有任何超自然力量，一切事件都有现实解释；角色不会使用魔法、异能或未卜先知。',
      position: 'before_char' as const,
      order: 100,
      probability: 100,
      enabled: true,
      constant: true,
    },
    {
      id: 'e-blackout',
      keywords: ['停电', '蜡烛', '灯'],
      content: '老城区这栋公寓楼今晚因变压器故障停电，楼道声控灯也不亮；苏晚家里只剩一支约两指长的蜡烛。',
      position: 'after_char' as const,
      order: 90,
      probability: 100,
      enabled: true,
    },
  ],
} as never

/** 预设：中性角色扮演预设（避免使用用户目录里的成人向预设） */
const PRESET_FIXTURE: Preset = {
  id: 'eval-preset',
  name: '评测用中性预设',
  description: 'eval',
  systemPrompt:
    '你是沉浸式互动叙事引擎，扮演 {{char}} 与 {{user}} 持续互动。保持角色设定与已有情节一致，用具体动作与对白推进场景，不替 {{user}} 决定行动或言语。',
  jailbreak: '',
  maxContext: 32000,
  temperature: 0.8,
  topP: 0.95,
  maxTokens: 0, // 0=自动预算：DeepSeek V4 类推理模型在 1024 硬上限下会把预算全花在推理上，正文为空（渲染评测需有正文）
  frequencyPenalty: 0,
  presencePenalty: 0,
  isBuiltin: false,
}

const BASE_SETTINGS: Settings = {
  providers: {} as Settings['providers'],
  connectionProfiles: [],
  activeProfileId: null,
  activeModel: 'deepseek-v4.1-flash',
  activePresetId: 'eval-preset',
  activeCharacterId: 'eval-suwan',
  activeSessionId: 'eval-session',
  theme: 'dark',
  themeColor: 'amber',
  fontSize: 'comfortable',
  fontSizeCustom: 0,
  bubbleStyle: 'round',
  messageSpacing: 20,
  messageWidth: 768,
  streamOutput: false,
  autoScroll: true,
  defaultMemoryEnabled: true,
  defaultNarrativeMode: 'immersive',
  continueIntensity: 'steady',
  continueLength: 'standard',
  ttsEnabled: false,
  ttsModels: [],
  activeTTSModelId: null,
  imageGenModels: [],
  activeImageGenModelId: null,
  visionModels: [],
  activeVisionModelId: null,
  userName: USER_PROFILE.name,
  userDescription: USER_PROFILE.description,
  userPersona: USER_PROFILE.persona,
  activePersonaId: null,
  defaultPersonaId: null,
  htmlRendering: false,
  showTokenCount: true,
  enableThoughtFormat: true,
  autoExpandThought: false,
  exampleDialogMode: 'always',
  lorebookRatio: 0.5,
  coverBlurStrength: 8,
  enableUsageTracking: false,
  useCoverAsBackground: false,
  translationTargetLang: '中文',
  coverProxyUrl: '',
  fontFamily: 'system',
  customFontId: null,
  semanticTrigger: { enabled: false, provider: 'local', baseUrl: '', model: '', apiKey: '', threshold: 0.3, maxResults: 3 },
  localModels: { retrievalMode: 'local', autoIndex: false, updatePolicy: 'notify', idleOnly: true, batchSize: 8 },
  personaInjection: { enabled: true, position: 'system', includeDescription: true, includePersona: true },
  contextCompression: { enabled: true, minDropTokens: 2000 },
  autoTitle: false,
  schemaVersion: 2,
  authorNote: { enabled: false, text: '', position: 'middle', depth: 1 },
} as Settings

function makeSession(overrides: Record<string, unknown> = {}): never {
  return {
    id: 'eval-session',
    characterId: 'eval-suwan',
    title: '评测会话',
    createdAt: 0,
    updatedAt: 0,
    messageCount: 0,
    lastMessage: '',
    narrativeMode: 'immersive',
    memoryEnabled: false,
    ...overrides,
  } as never
}

function makeBuildData(opts: {
  character: Character
  messages: Message[]
  session: unknown
  lorebooks?: unknown[]
  activeLorebookIds?: string[]
  /** 覆盖预设（评测用例可去掉用户硬上限，验证动态预算的完整余量） */
  preset?: Preset | null
}): ContextBuildData {
  const profile: ActiveProfile = {
    name: 'eval-profile',
    provider: globalEvalProvider,
    apiKey: 'INJECTED-BY-SCRIPT',
    baseUrl: globalEvalBaseUrl,
    model: globalEvalModel,
    maxContext: 1_000_000,
  }
  return {
    character: opts.character,
    preset: opts.preset === undefined ? PRESET_FIXTURE : opts.preset,
    chat: {
      messages: opts.messages,
      sessions: [opts.session as never],
      currentSessionId: 'eval-session',
      activeLorebookIds: opts.activeLorebookIds ?? [],
      semanticFactsHits: [],
      semanticLoreHits: [],
    },
    settings: { settings: BASE_SETTINGS, profile },
    lorebooks: (opts.lorebooks ?? []) as never,
    regexRules: [],
    // W1/§5.4 复测（G1 取证后）：--reasoning-samples 注入近期推理样本，
    // 让预算走 P90 驱动的保守余量路径（不可信门控），用于 A/B 对照
    ...(globalEvalReasoningSamples.length > 0 ? { reasoningSamples: [...globalEvalReasoningSamples] } : {}),
  }
}

// 由 CLI / 安全包装脚本注入的活跃 profile 元数据（不含密钥）
let globalEvalProvider = 'openai'
let globalEvalBaseUrl = 'https://api.commandcode.ai/provider/v1'
let globalEvalModel = 'deepseek-v4.1-flash'
/** W1/§5.4：`--reasoning-samples a,b,c` 注入的近期推理样本（缺省为空 = 静态档案余量） */
let globalEvalReasoningSamples: number[] = []

// ===================== 模型调用 =====================

/** callModel / group 对 maxTokens<=0 的抬升下限（OpenAI 兼容端点要求 >0） */
const EVAL_MAX_TOKENS_FLOOR = 4096

const transportLog: Array<{ index: number; url: string; request: string; status: number; response: string }> = []
let transportSeq = 0
let outDirForDebug = ''
/** 流式响应的异步抓取（tee）：汇总前需要 await，否则读到半截 body */
const pendingCaptures: Array<Promise<void>> = []

/**
 * 等待所有流式抓取结束。**阶段8 G1 取证必须在汇总 transport 前调用**：
 * 流式请求不能像非流式那样先把整个 body 读干再返回，否则 AbortController 无法中断
 * 已经缓冲完的响应流，"提前中止"这条路径会被评测器自己屏蔽（实测：推理越线 5498 >
 * 阈值 3481 却未中止）。
 */
async function settleTransportCapture(): Promise<void> {
  await Promise.all(pendingCaptures.splice(0))
}

function installHttpDebug(): void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const requestBody = typeof init?.body === 'string' ? init.body : String(init?.body ?? '')
    let streaming = false
    try { streaming = (JSON.parse(requestBody) as { stream?: boolean })?.stream === true } catch { /* 非 JSON 体 */ }
    const entry = { index: transportSeq++, url, request: requestBody, status: response.status, response: '' }
    transportLog.push(entry)

    if (streaming && response.body) {
      // 关键：边读边转发。tee 出的捕获流异步累积，客户端流立即可读，
      // 提前中止才能中断它（否则 await clone().text() 会把整个流缓冲完）。
      const [forClient, forCapture] = response.body.tee()
      const capture = (async () => {
        const reader = forCapture.getReader()
        const decoder = new TextDecoder()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            entry.response += decoder.decode(value, { stream: true })
          }
        } catch { /* 内部中止/客户端取消时捕获流提前结束，属预期 */ }
      })()
      pendingCaptures.push(capture.then(() => {
        if (outDirForDebug) {
          try { appendFileSync(join(outDirForDebug, 'http-debug.jsonl'), JSON.stringify(entry) + '\n') } catch { /* 忽略 */ }
        }
      }))
      return new Response(forClient, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }

    let body = ''
    try { body = await response.clone().text() } catch { /* 忽略 */ }
    entry.response = body
    if (outDirForDebug) {
      appendFileSync(join(outDirForDebug, 'http-debug.jsonl'), JSON.stringify(entry) + '\n')
    }
    return response
  }) as typeof fetch
}

interface ModelCallResult {
  text: string
  /** 适配器结构化完成事件（阶段3契约）的结束原因 */
  finishReason: string
  transport: TransportStat[]
}

/**
 * SSE 响应体（`stream: true`）的数值摘要：解析每个 `data:` 事件的 usage / finish_reason / 正文长度。
 * 阶段8 G1 取证需要流式调用的真实 reasoning 占比与结局，而 `JSON.parse` 对 SSE 一定失败
 * （此前流式批次的 token 统计恒为 0，等于漏测）。
 */
function parseSseSummary(body: string): {
  finishReason: string | null
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  contentChars: number
} | null {
  if (!body || !body.includes('data:')) return null
  let finishReason: string | null = null
  let promptTokens = 0
  let completionTokens = 0
  let reasoningTokens = 0
  let contentChars = 0
  let sawEvent = false
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>
    } catch {
      continue
    }
    sawEvent = true
    const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | undefined
    if (usage) {
      promptTokens = usage.prompt_tokens ?? promptTokens
      completionTokens = usage.completion_tokens ?? completionTokens
      reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? reasoningTokens
    }
    const choices = parsed.choices as Array<{ finish_reason?: string | null; delta?: { content?: string } }> | undefined
    const choice = choices?.[0]
    if (choice?.finish_reason) finishReason = choice.finish_reason
    if (choice?.delta?.content) contentChars += String(choice.delta.content).length
  }
  if (!sawEvent) return null
  return { finishReason, promptTokens, completionTokens, reasoningTokens, contentChars }
}

function summarizeTransport(entries: typeof transportLog): TransportStat[] {
  return entries.map((entry) => {
    let finishReason: string | null = null
    let promptTokens = 0
    let completionTokens = 0
    let reasoningTokens = 0
    let contentChars = 0
    let parsedBody: Record<string, unknown> | null = null
    try {
      parsedBody = JSON.parse(entry.response) as Record<string, unknown>
    } catch { /* SSE 或错误体：交给下面的解析 */ }
    if (parsedBody && (parsedBody.choices || parsedBody.usage)) {
      const choice = (parsedBody.choices as Array<{ finish_reason?: string | null; message?: { content?: string } }> | undefined)?.[0]
      finishReason = choice?.finish_reason ?? null
      const usage = parsedBody.usage as { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | undefined
      promptTokens = usage?.prompt_tokens ?? 0
      completionTokens = usage?.completion_tokens ?? 0
      reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0
      contentChars = (choice?.message?.content ?? '').length
    } else {
      // 流式（SSE）或非 JSON 错误体
      const sse = parseSseSummary(entry.response)
      if (sse) ({ finishReason, promptTokens, completionTokens, reasoningTokens, contentChars } = sse)
    }
    return { index: entry.index, status: entry.status, finishReason, promptTokens, completionTokens, reasoningTokens, contentChars }
  })
}

function isEmptyResponseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /未返回任何内容|content_filter/.test(message)
}

/**
 * 按 **provider** 选择适配器（与应用正式调用链一致），禁止按模型名猜测。
 * 不支持的 provider 明确报错，不静默退回 OpenAI。
 */
function adapterForProvider(provider: string) {
  const p = provider.toLowerCase()
  if (p === 'claude' || p === 'anthropic') return claudeAdapter
  if (p === 'openai' || p === 'openai-compatible' || p === 'openrouter' || p === 'deepseek' || p === 'custom') {
    return openaiAdapter
  }
  throw new Error(
    `评测器不支持当前 provider=${provider}；请先在适配器层实现该 provider，禁止静默退回 OpenAI。`,
  )
}

function createModelCaller(options: CliOptions) {
  return async function callModel(input: {
    systemPrompt: string
    userPrompt: string
    temperature: number
    maxTokens: number
    label: string
    /** 追加的 system 说明（续写格式重试/长度修复用） */
    systemSuffix?: string
    /** 与 ChatParams.allowTruncatedOutput 对齐（生图/长记忆等可容错解析的辅助链路会开启） */
    allowTruncatedOutput?: boolean
    /** W5：门控指令（与生产同口径）；缺省时适配器走旧分支 */
    reasoningGate?: import('../shared/reasoningGate').ReasoningGateDirective
  }): Promise<ModelCallResult> {
    const systemContent = input.systemSuffix
      ? `${input.systemPrompt}\n\n${input.systemSuffix}`
      : input.systemPrompt
    // 评测夹具 maxTokens=0 表示「无用户硬上限」；OpenAI 兼容端点要求 max_tokens>0。
    // 直传 0 会 400（Too small）。这里抬到与 stream 同口径的下限，供渲染冒烟使用。
    const requestMaxTokens = input.maxTokens > 0 ? input.maxTokens : EVAL_MAX_TOKENS_FLOOR
    // 阶段8：默认门控按主对话档位策略（与生产 streamGroupAI/streamAIResponse 同口径）
    const { resolveDefaultGateLevel, resolveReasoningGate } = await import('../shared/reasoningGate')
    // 对照开关（归因用）：
    // - GENERATION_EVAL_NO_GATE=1：不发门控指令（复现改造前路径；legacy reasoningMode 仍在）
    // - GENERATION_EVAL_NO_THINKING_PARAM=1：连 legacy 的 reasoningMode:'disabled' 也不发，
    //   用于验证"该端点是否根本关不掉推理"（真基线臂）
    const omitThinkingParam = process.env.GENERATION_EVAL_NO_THINKING_PARAM === '1'
    const defaultLevel = omitThinkingParam || process.env.GENERATION_EVAL_NO_GATE === '1'
      ? undefined
      : resolveDefaultGateLevel({ model: options.model, enabled: true })
    const defaultGateDirective = defaultLevel
      ? (() => {
          const g = resolveReasoningGate({ model: options.model, requestedLevel: defaultLevel, enabled: true })
          return { level: defaultLevel, knob: g.knob, tokens: g.gateTokens }
        })()
      : undefined
    const params: ChatParams = {
      requestId: `gen-eval-${input.label}`,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: input.userPrompt },
      ],
      provider: options.provider as ChatParams['provider'],
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      model: options.model,
      temperature: input.temperature,
      topP: 0.9,
      maxTokens: requestMaxTokens,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: false,
      // legacy 关推理字段；真基线臂（NO_THINKING_PARAM=1）下完全不发，用于验证端点是否本就不接受关闭
      ...(omitThinkingParam ? {} : { reasoningMode: 'disabled' as const }),
      // W5：门控指令（与生产同口径）。默认按主对话档位策略下发（deepseek-v4 → off，
      // 其余 → standard）；方向等用例可显式覆盖自己的档位。缺省时适配器走旧分支。
      ...(input.reasoningGate ?? defaultGateDirective ? { reasoningGate: input.reasoningGate ?? defaultGateDirective } : {}),
      allowTruncatedOutput: input.allowTruncatedOutput,
    }

    let lastError: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      const startIndex = transportLog.length
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('timeout')), 5 * 60 * 1000)
      try {
        // 阶段3契约：适配器返回 AICompletion（正文 + finishReason + usage）
        // 按 provider 选适配器（与应用一致），禁止按模型名猜测
        const completion = await adapterForProvider(options.provider).chat(params, () => {}, controller.signal)
        return {
          text: completion.text,
          finishReason: completion.finishReason,
          transport: summarizeTransport(transportLog.slice(startIndex)),
        }
      } catch (err) {
        lastError = err
        const stats = summarizeTransport(transportLog.slice(startIndex))
        if (isEmptyResponseError(err) && attempt < 3) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
          continue
        }
        if (isRetryableError(err) && attempt < 3) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
          continue
        }
        const wrapped = new Error(`${err instanceof Error ? err.message : String(err)} | transport=${JSON.stringify(stats)}`)
        throw wrapped
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError
  }
}

type CallModel = ReturnType<typeof createModelCaller>

// ===================== 文本检查工具 =====================

function countVisible(text: string): number {
  return (text.match(/[^\s]/g) ?? []).length
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
}

function isCompleteChineseSentence(text: string): boolean {
  // 动作段落以 * 收尾（*动作描写*）、结尾 thought 块也不代表未写完，先剥离再判句末标点
  const normalized = text
    .trim()
    .replace(/(?:<\s*\/?\s*(?:thought|thinking)\s*>|\*|\s)+$/gi, '')
  return /[。！？…”"』」）)]$/.test(normalized)
}

function hasChinese(text: string): boolean {
  const han = (text.match(/[\u3400-\u9fff]/g) ?? []).length
  return han >= Math.max(4, Math.floor(text.length * 0.15))
}

function containsMeta(text: string): string | null {
  const patterns: Array<[RegExp, string]> = [
    [/^(好的|没问题|以下|下面是)[^\n]{0,20}([：:])\s*$/m, '元说明行'],
    [/\*\*[^*]+\*\*\s*[：:]/, 'Markdown 粗体标题'],
    [/^#{1,6}\s/m, 'Markdown 标题'],
    [/^[-*]\s+\S/m, '项目符号列表'],
    [/```/, '代码块'],
    [/\b(as an AI|I cannot|language model)\b/i, '英文 AI 自述'],
    [/作为(一个)?(AI|人工智能|语言模型)/, '中文 AI 自述'],
  ]
  for (const [re, label] of patterns) {
    if (re.test(text)) return label
  }
  return null
}

function check(id: string, ok: boolean, detail: string, level: Level = 'fail'): Check {
  return { id, level: ok ? 'pass' : level, detail }
}

// ===================== S10：心理描写与推理隔离检查 =====================

/**
 * S10 检查项（thought 修复后的验收口径）：
 * - `<thought>` 是当前角色第一人称内心独白，必须用“我”，且不含模型计划/规则分析/上下文复述；
 * - 供应商推理（`<think>` / `<thinking>`）不得出现在正文任何位置；
 * - 全局叙事：正文旁白保持第三人称（对白内的“我”不计），thought 仍属焦点角色的第一人称。
 *
 * C3 口径（与 shared/thoughtContract.ts 强契约一致）：每轮必须且只输出一组 <thought>；
 * 出现率期望由强契约决定，不再是开放决策。若复测显示强契约导致合规率下降，再回到产品决策。
 */
const THOUGHT_LEAK_PATTERN =
  /(【输出格式】|写作计划|写作思路|写作要求|大纲|草稿|我需要先|让我先|用户(要求|希望|说)|系统(提示|指令)|上下文|复述|上文提到|作为(一个)?(AI|人工智能|语言模型)|规则分析|分析一下规则|输出约束)/

function extractThoughts(raw: string): string[] {
  return Array.from(raw.matchAll(/<thought>([\s\S]*?)<\/thought>/gi)).map((m) => m[1].trim())
}

function hasUnclosedThought(raw: string): boolean {
  const opens = (raw.match(/<thought[\s>]/gi) ?? []).length
  const closes = (raw.match(/<\/thought>/gi) ?? []).length
  return opens !== closes
}

/** 剥离对白引用后的旁白（判断全局叙事第三人称时排除对白里的“我”） */
function narrationOnly(text: string): string {
  return text
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/[“「『][^”」』]*[”」』]/g, '')
}

function addThoughtAndReasoningChecks(
  checks: Check[],
  opts: { raw: string; narrativeMode: 'immersive' | 'omniscient'; characterNames: string[] },
): void {
  const { raw, narrativeMode } = opts
  const thoughts = extractThoughts(raw)
  const vendorMarkers = raw.match(/<\s*\/?\s*(?:think|thinking)\s*>/gi) ?? []

  checks.push(check(
    's10-no-vendor-reasoning',
    vendorMarkers.length === 0,
    vendorMarkers.length > 0 ? `正文含供应商推理标记 ${vendorMarkers.join('')}` : '无 <think>/<thinking> 供应商推理标记',
  ))
  checks.push(check(
    's10-thought-closed',
    !hasUnclosedThought(raw),
    hasUnclosedThought(raw) ? '存在未闭合 <thought>（收尾器应回退该块）' : 'thought 标签成对闭合',
  ))
  if (thoughts.length === 0) {
    // C3 / thoughtContract 强契约：每轮必须且只输出一组 <thought>，缺失即失败
    checks.push(check('s10-thought-present', false, '未输出 <thought>（thoughtContract 强契约：每轮必须且只输出一组）'))
  } else if (thoughts.length > 1) {
    checks.push(check('s10-thought-present', false, `输出了 ${thoughts.length} 组 <thought>（强契约要求只输出一组）`))
  } else {
    checks.push(check('s10-thought-present', true, '输出一组 <thought>'))
    const firstPerson = thoughts.filter((t) => /我/.test(t))
    const leaks = thoughts.filter((t) => THOUGHT_LEAK_PATTERN.test(t))
    const tooLong = thoughts.filter((t) => (t.match(/[。！？]/g) ?? []).length > 3)
    checks.push(check(
      's10-thought-first-person',
      firstPerson.length === thoughts.length,
      `含“我”的 thought ${firstPerson.length}/${thoughts.length} 段`,
    ))
    checks.push(check(
      's10-thought-no-plan',
      leaks.length === 0,
      leaks.length > 0 ? `thought 含模型计划/规则分析：${leaks[0].slice(0, 48)}` : 'thought 无计划/规则分析/上下文复述',
    ))
    checks.push(check(
      's10-thought-brief',
      tooLong.length === 0,
      `超 3 句的 thought ${tooLong.length} 段（要求简短）`,
    ))
  }

  if (narrativeMode === 'omniscient') {
    const narration = narrationOnly(raw)
    const firstPersonNarration = (narration.match(/我(?!们)/g) ?? []).length
    const thirdPersonPresent = /(他|她)/.test(narration) || opts.characterNames.some((name) => narration.includes(name))
    checks.push(check(
      's10-omniscient-third-person',
      firstPersonNarration === 0 && thirdPersonPresent,
      `旁白第一人称“我” ${firstPersonNarration} 次；第三人称标记 ${thirdPersonPresent ? '有' : '无'}`,
      firstPersonNarration === 1 ? 'warn' : 'fail',
    ))
  }
}

// ===================== 批次 1：对话生成 =====================

interface DialogueCase {
  id: string
  title: string
  character: Character
  messages: Message[]
  session: unknown
  lorebooks?: unknown[]
  activeLorebookIds?: string[]
  /** 覆盖预设（缺省用 PRESET_FIXTURE，其 maxTokens=1024 会作为用户硬上限） */
  preset?: Preset | null
  focus: string
  /** 期望在回复中出现/遵守的上下文事实（评审用） */
  contextFacts: string[]
}

function dialogueCases(): DialogueCase[] {
  return [
    {
      id: 'd1-suwan-immersive',
      title: '苏晚 · 代入式 · 悬疑收束',
      character: CHAR_SUWAN,
      messages: SUWAN_MESSAGES,
      session: makeSession(),
      focus: '承接“有人喊名字”的悬念，角色应该有所反应但不越权替用户行动',
      contextFacts: ['停电', '蜡烛', '楼下有人喊苏晚的名字', '苏晚外冷内热、说话简短'],
    },
    {
      id: 'd2-suwan-omniscient',
      title: '苏晚 · 全局叙事 · 第三人称',
      character: CHAR_SUWAN,
      messages: SUWAN_MESSAGES,
      session: makeSession({ narrativeMode: 'omniscient' }),
      focus: '旁白第三人称推进，不得替用户角色作重大决定，不得写成苏晚第一人称独白',
      contextFacts: ['停电', '蜡烛', '楼下有人喊苏晚的名字', '第三人称旁白'],
    },
    {
      id: 'd3-lore-memory',
      title: '苏晚 · 世界书+长记忆注入',
      character: CHAR_SUWAN,
      messages: SUWAN_MESSAGES,
      session: makeSession({
        memoryEnabled: true,
        memoryCurrentState: '苏晚的公寓已停电三小时；她左手腕有一道未处理的擦伤。',
        memory: '苏晚是古籍修复师，讨厌别人碰她的工具；阳台栏杆第三根是断的。',
        memoryFacts: ['阳台栏杆第三根是断的，不能扶', '苏晚讨厌别人碰她的修复工具', '她左手腕有擦伤'],
      }),
      lorebooks: [LOREBOOK_FIXTURE],
      activeLorebookIds: ['eval-lore'],
      focus: '世界书触发（停电）与长记忆（擦伤/断栏杆）是否被正确使用且不矛盾',
      contextFacts: [
        '世界无超自然力量',
        '变压器故障停电、蜡烛只剩两指长',
        '苏晚左手腕有未处理的擦伤',
        '阳台第三根栏杆是断的',
      ],
    },
    {
      id: 'd4-linyan-immersive',
      title: '林砚 · 古风悬疑 · 跨题材',
      character: CHAR_LINYAN,
      messages: LINYAN_MESSAGES,
      session: makeSession(),
      focus: '在“你姓陈”的指认后继续施压，保持古风语感与捕快口吻',
      contextFacts: ['凶案死者是漕帮账房', '断刃刀柄刻着“陈”字', '林砚爽利爱抬杠、办案不讲情面'],
    },
    {
      id: 'd5-first-turn',
      title: '苏晚 · 首轮开场（无历史）',
      character: CHAR_SUWAN,
      messages: [asMessage({ role: 'user', content: '（我敲了敲门，把伞收好）我来了。', name: USER_PROFILE.name } as never)],
      session: makeSession(),
      focus: '开场要能立住角色、给出可继续的钩子，不堆砌设定',
      contextFacts: ['梅雨季', '苏晚外冷内热', '不替用户决定行动'],
    },
    {
      // S10：去掉夹具预设的用户硬上限（maxTokens=1024），验证动态预算（正文 + 推理余量）的端到端表现
      id: 'd6-immersive-uncapped',
      title: '苏晚 · 代入式 · 无用户硬上限',
      character: CHAR_SUWAN,
      messages: SUWAN_MESSAGES,
      session: makeSession(),
      preset: { ...PRESET_FIXTURE, id: 'eval-preset-uncapped', maxTokens: 0 },
      focus: '无用户硬上限时，动态预算应为推理留出余量，不出现正文被推理挤空或半句截断',
      contextFacts: ['停电', '蜡烛', '楼下有人喊苏晚的名字', '苏晚外冷内热、说话简短'],
    },
  ]
}

async function runDialogueCase(options: CliOptions, callModel: CallModel, testCase: DialogueCase): Promise<CaseResult> {
  const data = makeBuildData({
    character: testCase.character,
    messages: testCase.messages,
    session: testCase.session,
    lorebooks: testCase.lorebooks,
    activeLorebookIds: testCase.activeLorebookIds,
    preset: testCase.preset,
  })
  const { buildContextMessagesFromData, buildChatParamsFromData } = await import('../src/context/contextBuilder')
  const built = buildContextMessagesFromData(data)
  const params = buildChatParamsFromData(data, built.messages, { requestMaxTokens: built.requestMaxTokens })
  const systemPrompt = built.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n---\n\n')
  const userPrompt = built.messages.filter((m) => m.role !== 'system').map((m) => `${m.role}: ${m.content}`).join('\n')
  const bodyFormatPresent = systemPrompt.includes('【本轮回应范围】')

  const started = Date.now()
  const checks: Check[] = []
  let raw = ''
  let normalizedRaw = ''
  let transport: TransportStat[] = []
  let attempts = 0
  let error: string | undefined
  try {
    const result = await callModel({
      systemPrompt,
      userPrompt,
      temperature: params.temperature ?? 0.8,
      maxTokens: params.maxTokens ?? 1024,
      label: testCase.id,
    })
    raw = result.text
    transport = result.transport
    attempts = transport.length
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const durationMs = Date.now() - started

  const final = raw
  if (!error) {
    const paragraphs = splitParagraphs(raw)
    const dialogueParagraphs = paragraphs.filter((p) => /[“"][^”"]+[”"]/.test(p))
    const actionParagraphs = paragraphs.filter((p) => /^\*[\s\S]*\*$/.test(p.trim()))
    const dialogueWithName = dialogueParagraphs.filter((p) =>
      new RegExp(`${testCase.character.name}\\s*[：:]\\s*[“"]`).test(p),
    )
    const mixed = paragraphs.filter((p) => /[“"]/.test(p) && /\*/.test(p))
    const meta = containsMeta(raw)
    const lastTransport = transport.at(-1)
    const narrativeMode = (testCase.session as { narrativeMode?: 'immersive' | 'omniscient' })?.narrativeMode ?? 'immersive'

    checks.push(check('non-empty', raw.trim().length > 0, `回复 ${countVisible(raw)} 可见字符`))
    checks.push(check('chinese', hasChinese(raw), '中文正文占比'))
    // 阶段二起不再要求固定 2–6 段/每轮必有对白/动作必加星号（展示样式由渲染层负责），保留为观察项
    checks.push(check('paragraphs-2-6', paragraphs.length >= 2 && paragraphs.length <= 6, `段落数 ${paragraphs.length}（阶段二不再固定段数，仅观察）`, 'warn'))
    checks.push(check('has-dialogue', dialogueParagraphs.length >= 1, `含引号对白段落 ${dialogueParagraphs.length}（新协议允许纯动作/独白回合）`, 'warn'))
    checks.push(
      check('dialogue-speaker-format', dialogueWithName.length >= 1, `“${testCase.character.name}：“…””格式段落 ${dialogueWithName.length}`, 'warn'),
    )
    checks.push(check('action-asterisk', actionParagraphs.length >= 1, `整段星号包裹的动作段落 ${actionParagraphs.length}`, 'warn'))
    checks.push(check('no-dialogue-in-action', mixed.length === 0, `对白与星号混写段落 ${mixed.length}`, 'warn'))
    checks.push(check('no-meta', !meta, meta ? `命中：${meta}` : '无标题/列表/代码块/AI 自述'))
    checks.push(
      check(
        'complete-ending',
        isCompleteChineseSentence(raw),
        isCompleteChineseSentence(raw) ? '结尾完整' : `结尾疑似被截断：「${raw.trim().slice(-24)}」`,
      ),
    )
    // S10：thought 质量与供应商推理隔离（thought 修复后的验收口径）
    addThoughtAndReasoningChecks(checks, { raw, narrativeMode, characterNames: [testCase.character.name] })
    checks.push(check('body-format-injected', bodyFormatPresent, 'system 中含【本轮回应范围】（阶段二约束已注入）'))
    // 用户可见的最终形态：应用会在落盘前补裸对白的角色名前缀（仅代入式单聊；全局叙事不推断说话人）
    if (narrativeMode === 'immersive') {
      const { normalizeRoleplayDialoguePrefixes } = await import('../src/utils/messagePostProcess')
      normalizedRaw = normalizeRoleplayDialoguePrefixes(raw, testCase.character.name, narrativeMode)
      const normalizedWithName = splitParagraphs(normalizedRaw).filter((p) =>
        new RegExp(`${testCase.character.name}\\s*[：:]\\s*[“"]`).test(p),
      )
      checks.push(
        check(
          'dialogue-speaker-after-normalize',
          normalizedWithName.length >= 1 || dialogueParagraphs.length === 0,
          `后处理后合规对白段落 ${normalizedWithName.length}（原始 ${dialogueWithName.length}）`,
          'warn',
        ),
      )
    } else {
      // 全局叙事不做前缀补齐（多说话人不可推断），检查应为无操作
      const { normalizeRoleplayDialoguePrefixes } = await import('../src/utils/messagePostProcess')
      normalizedRaw = normalizeRoleplayDialoguePrefixes(raw, testCase.character.name, narrativeMode)
      checks.push(check('normalize-noop-omniscient', normalizedRaw === raw, '全局叙事不补说话人前缀（行为固化）'))
    }
    if (lastTransport) {
      checks.push(
        check(
          'not-truncated-by-budget',
          lastTransport.finishReason !== 'length',
          `finish_reason=${lastTransport.finishReason}，completion=${lastTransport.completionTokens}（reasoning ${lastTransport.reasoningTokens}）`,
        ),
      )
    }
  } else {
    checks.push(check('request', false, error))
  }

  return {
    batch: 'dialogue',
    id: testCase.id,
    title: testCase.title,
    systemPrompt,
    userPrompt,
    raw,
    final,
    attempts,
    extra: {
      paragraphs: splitParagraphs(raw).length,
      visibleChars: countVisible(raw),
      maxTokens: params.maxTokens,
      temperature: params.temperature,
      focus: testCase.focus,
      contextFacts: testCase.contextFacts,
      normalizedRaw: normalizedRaw || null,
    },
    checks,
    transport,
    durationMs,
    error,
  }
}

// ===================== 批次 1b：群聊生成（S10） =====================

/** 群聊批次成员：江离（与苏晚同属现代都市，便于内容评审） */
const CHAR_JIANGLI: Character = {
  id: 'eval-jiangli',
  name: '江离',
  avatar: '',
  description: '三十岁上下，深夜电台主播，声音低沉，习惯用很短的句子；右手常年戴一枚旧银戒指。',
  personality: '话少、观察力强，喜欢用反问；不轻易表态，但会替人记住承诺。',
  scenario: '午夜电台直播间，窗外是同一个梅雨季。',
  firstMessage: '（他推上麦克风开关）“……这里是午夜档。今晚在线的人，可以说话。”',
  exampleDialog: '{{user}}: 你在听吗？\n{{char}}: “在。”他敲了敲桌沿，“你说。”',
  tags: ['现代', '都市', '克制'],
  lorebookId: null,
  creator: 'eval',
  createdAt: 0,
  updatedAt: 0,
  alternateGreetings: [],
}

interface GroupCase {
  id: string
  title: string
  mode: 'mention' | 'polling' | 'free'
  members: Character[]
  group: GroupChatLike
  session: GroupSessionLike
  messages: GroupMessageLike[]
  /** mention/polling：本轮应发言的角色 */
  targetCharId?: string
  focus: string
  contextFacts: string[]
}

/** 评测脚本内的群聊/群聊消息最小形状（真实类型在 shared/types.ts） */
type GroupChatLike = {
  id: string; name: string; memberIds: string[]; currentSpeakerIndex?: number
  autoMode?: boolean; chatMode: string; maxRounds?: number; speakerInterval?: number
  lorebookIds: string[]; presetId?: string | null; systemPrompt?: string
  createdAt?: number; updatedAt?: number; defaultNarrativeMode?: string | null
}
type GroupSessionLike = {
  id: string; groupId: string; title: string; createdAt: number; updatedAt: number
  messageCount: number; narrativeMode: 'immersive' | 'omniscient'; memoryEnabled: boolean
}
type GroupMessageLike = {
  id: string; groupId: string; characterId: string; content: string
  images: string[]; timestamp: number; round: number; narrativeMode?: string
  speakerKind?: string; generationKind?: string
}

function groupMessage(characterId: string, content: string, ts: number, round = 1): GroupMessageLike {
  const isUser = characterId === '__user__'
  return {
    id: `gm-${characterId}-${ts}`,
    groupId: 'eval-group',
    characterId,
    content,
    images: [],
    timestamp: ts,
    round,
    narrativeMode: 'immersive',
    speakerKind: isUser ? 'persona' : 'character',
    generationKind: isUser ? 'manual' : 'assistant_reply',
  }
}

function makeGroupSession(narrativeMode: 'immersive' | 'omniscient' = 'immersive'): GroupSessionLike {
  return {
    id: 'eval-group-session',
    groupId: 'eval-group',
    title: '评测群聊会话',
    createdAt: 0,
    updatedAt: 0,
    messageCount: 6,
    narrativeMode,
    memoryEnabled: false,
  }
}

function groupCases(): GroupCase[] {
  const members = [CHAR_SUWAN, CHAR_JIANGLI]
  const history: GroupMessageLike[] = [
    groupMessage('__user__', '你们那边也在停电吗？我这儿整个楼道都黑了。', 1000),
    groupMessage(CHAR_JIANGLI.id, '“我这边有备用电源。”他敲了敲桌沿，“不过信号很差。”', 2000),
    groupMessage(CHAR_SUWAN.id, '“整栋楼都停了。物业电话打不通。”', 3000),
    groupMessage('__user__', '@苏晚 楼下好像有人喊你的名字，你以前听过那个声音吗？', 4000),
  ]
  const base = {
    members,
    group: {
      id: 'eval-group', name: '旧城夜谈', memberIds: members.map((m) => m.id),
      currentSpeakerIndex: 0, autoMode: false, maxRounds: 3, speakerInterval: 0,
      lorebookIds: [], presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
    } as GroupChatLike,
    session: makeGroupSession(),
  }
  return [
    {
      id: 'g-mention-suwan',
      title: '群聊 · 点名 · @苏晚',
      mode: 'mention',
      ...base,
      group: { ...base.group, chatMode: 'mention' },
      messages: history,
      targetCharId: CHAR_SUWAN.id,
      focus: '只由被点名的苏晚回应：对白用苏晚第一人称，动作/神态可第三人称叙述；不替江离或用户发言，承接“楼下有人喊名字”的悬念',
      contextFacts: ['停电', '楼下有人喊苏晚的名字', '江离在电台直播间', '苏晚说话简短'],
    },
    {
      id: 'g-polling-jiangli',
      title: '群聊 · 轮询 · 轮到江离',
      mode: 'polling',
      ...base,
      group: { ...base.group, chatMode: 'polling' },
      messages: [
        ...history.slice(0, 3),
        groupMessage('__user__', '江离，你先把刚才的录音放一遍。', 4000),
      ],
      targetCharId: CHAR_JIANGLI.id,
      focus: '只由江离回应：对白用江离第一人称，动作/神态可第三人称叙述；保持话少克制，不替苏晚或用户发言',
      contextFacts: ['停电', '江离是深夜电台主播、话少', '楼道信号很差'],
    },
    {
      id: 'g-free-night',
      title: '群聊 · 自由发言 · 多人参与',
      mode: 'free',
      ...base,
      group: { ...base.group, chatMode: 'free' },
      messages: [
        ...history.slice(0, 3),
        groupMessage('__user__', '那今晚怎么办？你们俩谁有主意？', 4000),
      ],
      focus: '自由发言：多个角色可用【角色名】分段标注各自发言，用户不被替代；观点之间有区分度',
      contextFacts: ['停电', '苏晚务实、江离话少', '两人都在场'],
    },
  ]
}

async function runGroupCase(options: CliOptions, callModel: CallModel, testCase: GroupCase): Promise<CaseResult> {
  const { buildGroupChatContext } = await import('../src/store/groupChatContext')
  const { useSettingsStore } = await import('../src/store/useSettingsStore')
  const { useCharacterStore } = await import('../src/store/useCharacterStore')
  const { usePersonaStore } = await import('../src/store/usePersonaStore')

  // 群聊上下文依赖三个 store：只注入成员/人设与模型名，不注入任何连接档案或凭据
  // （getActiveProfile() 返回 null → 预算按 activeModel + 默认上下文长度兜底）
  useCharacterStore.setState({ characters: testCase.members } as never)
  useSettingsStore.setState({
    settings: {
      ...BASE_SETTINGS,
      activeModel: options.model,
      connectionProfiles: [],
      activeProfileId: null,
      activeCharacterId: testCase.members[0].id,
    },
    credentials: {},
    loaded: true,
    _saveTimer: null,
  } as never)
  usePersonaStore.setState({ personas: [], activePersonaId: null, getPersona: () => undefined } as never)

  const state = {
    currentGroup: testCase.group,
    currentSessionId: testCase.session.id,
    sessions: [testCase.session],
    messages: testCase.messages,
    _semanticLoreHits: [],
    _semanticFactsHits: [],
    _semanticLoreAvailable: false,
  }
  const built = buildGroupChatContext((() => state) as never, testCase.targetCharId)
  const systemPrompt = built.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n---\n\n')
  const userPrompt = built.messages.filter((m) => m.role !== 'system').map((m) => `${m.role}: ${m.content}`).join('\n')
  const targetName = testCase.targetCharId
    ? testCase.members.find((m) => m.id === testCase.targetCharId)?.name ?? ''
    : ''

  const started = Date.now()
  const checks: Check[] = []
  let raw = ''
  let error: string | undefined
  let transport: TransportStat[] = []
  let attempts = 0
  try {
    const result = await callModel({
      systemPrompt,
      userPrompt,
      temperature: PRESET_FIXTURE.temperature ?? 0.8,
      maxTokens: Math.max(PRESET_FIXTURE.maxTokens || 0, EVAL_MAX_TOKENS_FLOOR),
      label: testCase.id,
    })
    raw = result.text
    transport = result.transport
    attempts = transport.length
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const durationMs = Date.now() - started

  const memberNames = testCase.members.map((m) => m.name)
  const segments = Array.from(raw.matchAll(/【([^】]{1,10})】/g)).map((m) => m[1].trim())
  const unknownSegments = segments.filter((name) => !memberNames.includes(name))
  const lastTransport = transport.at(-1)

  if (!error) {
    const meta = containsMeta(raw)
    checks.push(check('non-empty', raw.trim().length > 0, `回复 ${countVisible(raw)} 可见字符`))
    checks.push(check('chinese', hasChinese(raw), '中文正文占比'))
    checks.push(check('complete-ending', isCompleteChineseSentence(raw), isCompleteChineseSentence(raw) ? '结尾完整' : `结尾疑似被截断：「${raw.trim().slice(-24)}」`))
    checks.push(check('no-meta', !meta, meta ? `命中：${meta}` : '无标题/列表/代码块/AI 自述'))
    checks.push(check('mode-rules-injected', systemPrompt.includes('【对话规则】'), 'system 含【对话规则】（群聊模式约束已注入）'))
    checks.push(check(
      'thought-protocol-injected',
      systemPrompt.includes('第一人称') && systemPrompt.includes('<thought>'),
      'system 含 thought 第一人称独白协议（S10 语义）',
    ))
    if (testCase.mode === 'free') {
      checks.push(check('segment-names-valid', unknownSegments.length === 0, unknownSegments.length > 0 ? `未识别发言人标记：${unknownSegments.join('、')}` : `【角色名】分段 ${segments.length} 段（${segments.join('、') || '无标记'}）`))
      const distinctSpeakers = new Set(segments).size
      checks.push(check('free-multi-speaker', distinctSpeakers >= 1, distinctSpeakers >= 2 ? `多角色发言 ${distinctSpeakers} 位` : '仅一位角色发言（自由发言允许）', 'warn'))
    } else {
      const otherMarkers = segments.filter((name) => name !== targetName)
      checks.push(check(
        'single-speaker',
        otherMarkers.length === 0,
        otherMarkers.length === 0 ? `未出现其他角色分段标记（本轮应只有 ${targetName} 发言）` : `出现其他角色标记：${otherMarkers.join('、')}`,
      ))
      // 项目既有风格（单聊同款）：动作/神态可用第三人称叙述，对白必须是本角色的第一人称。
      // 因此只禁止把其他成员写成说话人，不要求全篇第一人称；无“我”仅作观察（短回复可能省略）。
      const othersVoicing = memberNames
        .filter((name) => name !== targetName)
        .filter((name) => new RegExp(`${name}\\s*(说|道|开口|问|答|：|:)`).test(raw))
      checks.push(check(
        'actor-consistency',
        othersVoicing.length === 0,
        othersVoicing.length === 0 ? '未替其他成员发言（叙述主体是本角色）' : `把其他成员写成说话人：${othersVoicing.join('、')}`,
      ))
      checks.push(check('speaker-voice', /我/.test(raw), /我/.test(raw) ? '对白为第一人称' : '未见第一人称（短回复可能省略，需人工确认）', 'warn'))
    }
    addThoughtAndReasoningChecks(checks, { raw, narrativeMode: 'immersive', characterNames: memberNames })
    if (lastTransport) {
      checks.push(check('not-truncated-by-budget', lastTransport.finishReason !== 'length', `finish_reason=${lastTransport.finishReason}，completion=${lastTransport.completionTokens}（reasoning ${lastTransport.reasoningTokens}）`))
    }
  } else {
    checks.push(check('request', false, error))
  }

  return {
    batch: 'group',
    id: testCase.id,
    title: testCase.title,
    systemPrompt,
    userPrompt,
    raw,
    final: raw,
    attempts,
    extra: {
      mode: testCase.mode,
      target: targetName || null,
      memberNames,
      segments,
      visibleChars: countVisible(raw),
      paragraphs: splitParagraphs(raw).length,
      focus: testCase.focus,
      contextFacts: testCase.contextFacts,
    },
    checks,
    transport,
    durationMs,
    error,
  }
}

// ===================== 批次 1c：流式推理隔离（S10） =====================

/**
 * 流式检查：供应商推理不得出现在 chunk 里（适配器必须丢弃 reasoning_content），
 * 且流式拼接结果与完成事件的正文一致；业务管线（stripVendorThinking）对结果应为无操作。
 */
interface StreamCase {
  id: string
  title: string
  character: Character
  messages: Message[]
  session: unknown
  focus: string
}

function streamCases(): StreamCase[] {
  return [
    {
      id: 'st-suwan-immersive',
      title: '流式 · 代入式（推理隔离）',
      character: CHAR_SUWAN,
      messages: SUWAN_MESSAGES,
      session: makeSession(),
      focus: '流式 chunk 与落盘正文都不得出现供应商推理',
    },
    {
      id: 'st-suwan-omniscient',
      title: '流式 · 全局叙事（推理隔离）',
      character: CHAR_SUWAN,
      messages: SUWAN_MESSAGES,
      session: makeSession({ narrativeMode: 'omniscient' }),
      focus: '流式 chunk 与落盘正文都不得出现供应商推理，正文保持第三人称',
    },
  ]
}

async function runStreamCase(options: CliOptions, testCase: StreamCase): Promise<CaseResult> {
  const { buildContextMessagesFromData, buildChatParamsFromData } = await import('../src/context/contextBuilder')
  const { stripVendorThinking } = await import('../src/utils/messagePostProcess')
  const data = makeBuildData({ character: testCase.character, messages: testCase.messages, session: testCase.session })
  const built = buildContextMessagesFromData(data)
  const params = buildChatParamsFromData(data, built.messages)
  const systemPrompt = built.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n---\n\n')
  const userPrompt = built.messages.filter((m) => m.role !== 'system').map((m) => `${m.role}: ${m.content}`).join('\n')

  // W5：流式用例的门控（与生产同口径；NO_GATE=1 时走旧路径对照）
  const { resolveDefaultGateLevel, resolveReasoningGate } = await import('../shared/reasoningGate')
  const omitThinkingParam = process.env.GENERATION_EVAL_NO_THINKING_PARAM === '1'
  const streamGateLevel = omitThinkingParam || process.env.GENERATION_EVAL_NO_GATE === '1'
    ? undefined
    : resolveDefaultGateLevel({ model: options.model, enabled: true })
  const streamGate = streamGateLevel
    ? (() => {
        const g = resolveReasoningGate({ model: options.model, requestedLevel: streamGateLevel, enabled: true })
        return { level: streamGateLevel, knob: g.knob, tokens: g.gateTokens }
      })()
    : undefined

  const started = Date.now()
  const checks: Check[] = []
  const transport: TransportStat[] = []
  const deltas: string[] = []
  let finalText = ''
  let error: string | undefined
  let earlyAbort = false
  // 流式用例的目的是验证推理隔离，不受预算吃满干扰：固定充裕预算
  // （夹具预设 maxTokens=1024 会作为用户硬上限，DeepSeek V4 类模型可能把 1024 全花在推理上导致空响应）
  const streamBudget = Math.max(params.maxTokens ?? 0, 4096)
  try {
    const transportStart = transportLog.length
    const completion = await adapterForProvider(options.provider).chat(
      {
        requestId: `gen-eval-${testCase.id}`,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        provider: options.provider as ChatParams['provider'],
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        model: options.model,
        temperature: params.temperature ?? 0.8,
        topP: 0.9,
        maxTokens: streamBudget,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stream: true,
        ...(omitThinkingParam ? {} : { reasoningMode: 'disabled' as const }),
        // W5：与生产同口径的门控（deepseek-v4 → off；可用 GENERATION_EVAL_NO_GATE=1 关闭对照）
        ...(streamGate ? { reasoningGate: streamGate } : {}),
      },
      (text) => { deltas.push(text) },
      // 适配器需要可中止 signal（提前中止依赖它）
      new AbortController().signal,
    )
    finalText = completion.text
    earlyAbort = completion.earlyAbort === true
    // 流式抓取是异步 tee，汇总前必须等它读完
    await settleTransportCapture()
    transport.push(...summarizeTransport(transportLog.slice(transportStart)))
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const durationMs = Date.now() - started

  const deltaText = deltas.join('')
  const vendorMarker = /<\s*\/?\s*(?:think|thinking)\s*>/i
  if (!error) {
    const narrativeMode = (testCase.session as { narrativeMode?: 'immersive' | 'omniscient' })?.narrativeMode ?? 'immersive'
    checks.push(check('s10-stream-no-vendor-reasoning', !vendorMarker.test(deltaText), vendorMarker.test(deltaText) ? '流式 chunk 中出现供应商推理标记' : `流式 chunk ${deltas.length} 片，无 <think>/<thinking> 标记`))
    checks.push(check('s10-stream-matches-final', deltaText === finalText, deltaText === finalText ? 'chunk 拼接与完成事件正文一致' : `chunk ${deltaText.length} 字符 ≠ 完成正文 ${finalText.length} 字符`))
    checks.push(check('s10-final-no-vendor-reasoning', !vendorMarker.test(finalText), vendorMarker.test(finalText) ? '完成正文含供应商推理标记' : '完成正文无推理标记'))
    checks.push(check('s10-pipeline-strip-noop', stripVendorThinking(finalText).trim() === finalText.trim(), '业务清理（stripVendorThinking）对结果无操作（无需剥离）'))
    checks.push(check('complete-ending', isCompleteChineseSentence(finalText), isCompleteChineseSentence(finalText) ? '结尾完整' : `结尾疑似被截断：「${finalText.trim().slice(-24)}」`))
    checks.push(check('stream-headroom', true, `固定预算 maxTokens=${streamBudget}（隔离推理吃满预算的干扰，仅验证推理隔离）`))
    if (earlyAbort) checks.push(check('early-abort', true, '阶段8：应用层因推理越线提前中止（正文为空）'))
    addThoughtAndReasoningChecks(checks, { raw: finalText, narrativeMode, characterNames: [testCase.character.name] })
  } else {
    // 阶段8：提前中止是结构化结局而非普通错误，单独记录以便核对
    checks.push(check('request', false, error + (earlyAbort ? '（本次为提前中止：推理越线且正文为空）' : '')))
  }

  return {
    batch: 'stream',
    id: testCase.id,
    title: testCase.title,
    systemPrompt,
    userPrompt,
    raw: finalText,
    final: finalText,
    attempts: 1,
    extra: {
      deltaCount: deltas.length,
      deltaChars: deltaText.length,
      visibleChars: countVisible(finalText),
      focus: testCase.focus,
    },
    checks,
    transport,
    durationMs,
    error,
  }
}

// ===================== 批次 2：续写 =====================

interface ContinueCase {
  id: string
  title: string
  narrativeMode: 'immersive' | 'omniscient'
  intensity: 'subtle' | 'steady' | 'active' | 'bold'
  length: 'brief' | 'standard' | 'detailed' | 'extended'
  hasInput: boolean
  originalInput: string
  character: Character
  messages: Message[]
  focus: string
}

function continueCases(): ContinueCase[] {
  const cases: ContinueCase[] = []
  const intensities: ContinueCase['intensity'][] = ['subtle', 'steady', 'active', 'bold']
  for (const intensity of intensities) {
    cases.push({
      id: `c-imm-${intensity}-std-in`,
      title: `代入式 · ${intensity} · 小段 · 有输入`,
      narrativeMode: 'immersive',
      intensity,
      length: 'standard',
      hasInput: true,
      originalInput: '“你先把湿外套脱了，我去看看楼下的',
      character: CHAR_SUWAN,
      messages: SUWAN_MESSAGES,
      focus: '以用户陈默的口吻补完未完成的话；不得替苏晚发言',
    })
  }
  cases.push({
    id: 'c-imm-active-brief-in',
    title: '代入式 · 转折 · 短句 · 有输入',
    narrativeMode: 'immersive',
    intensity: 'active',
    length: 'brief',
    hasInput: true,
    originalInput: '“别出声，我听见',
    character: CHAR_SUWAN,
    messages: SUWAN_MESSAGES,
    focus: '短档应在 20–60 字内收尾',
  })
  cases.push({
    id: 'c-imm-active-detailed-in',
    title: '代入式 · 转折 · 展开 · 有输入',
    narrativeMode: 'immersive',
    intensity: 'active',
    length: 'detailed',
    hasInput: true,
    originalInput: '“灯灭了也好，正好我可以',
    character: CHAR_SUWAN,
    messages: SUWAN_MESSAGES,
    focus: '展开档应在 220–420 字内、2–3 段',
  })
  cases.push({
    id: 'c-imm-active-extended-in',
    title: '代入式 · 转折 · 长篇 · 有输入',
    narrativeMode: 'immersive',
    intensity: 'active',
    length: 'extended',
    hasInput: true,
    originalInput: '“说起来，我今天其实',
    character: CHAR_SUWAN,
    messages: SUWAN_MESSAGES,
    focus: '长篇档应在 500–900 字内、4–6 段',
  })
  cases.push({
    id: 'c-imm-steady-nofill',
    title: '代入式 · 波澜 · 无输入（生成一条用户回复）',
    narrativeMode: 'immersive',
    intensity: 'steady',
    length: 'standard',
    hasInput: false,
    originalInput: '',
    character: CHAR_SUWAN,
    messages: SUWAN_MESSAGES,
    focus: '无输入时应生成用户视角的一条回复，承接悬念',
  })
  // S10：有输入/无输入 × 4 档位 的完整矩阵（无输入侧的其余三档）
  for (const intensity of ['subtle', 'active', 'bold'] as const) {
    cases.push({
      id: `c-imm-${intensity}-std-nofill`,
      title: `代入式 · ${intensity} · 无输入`,
      narrativeMode: 'immersive',
      intensity,
      length: 'standard',
      hasInput: false,
      originalInput: '',
      character: CHAR_SUWAN,
      messages: SUWAN_MESSAGES,
      focus: `无输入时以用户视角承接悬念；${intensity} 档位推进幅度正确`,
    })
  }
  for (const intensity of ['subtle', 'bold'] as const) {
    cases.push({
      id: `c-omni-${intensity}-std-in`,
      title: `全局叙事 · ${intensity} · 小段 · 有输入`,
      narrativeMode: 'omniscient',
      intensity,
      length: 'standard',
      hasInput: true,
      originalInput: '雨声忽然小了，楼道里传来',
      character: CHAR_SUWAN,
      messages: SUWAN_MESSAGES,
      focus: '第三人称旁白推动；subtle 只加细微变化，bold 可给明显转折；不写出苏晚的完整反应',
    })
  }
  cases.push({
    id: 'c-omni-active-nofill',
    title: '全局叙事 · 转折 · 无输入',
    narrativeMode: 'omniscient',
    intensity: 'active',
    length: 'standard',
    hasInput: false,
    originalInput: '',
    character: CHAR_SUWAN,
    messages: SUWAN_MESSAGES,
    focus: '无输入时承接最近未解决的矛盾（有人喊名字）',
  })
  return cases
}

async function runContinueCase(options: CliOptions, callModel: CallModel, testCase: ContinueCase): Promise<CaseResult> {
  const { buildContinueContext, parseContinueResult, evaluateContinueLength } =
    await import('../src/components/chat/aiInputHelper')
  const { CONTINUE_INTENSITY_PARAMS, CONTINUE_REQUEST_MAX_TOKENS } =
    await import('../shared/continueIntensity')

  const contextMessages = buildContinueContext({
    character: testCase.character,
    userName: USER_PROFILE.name,
    charName: testCase.character.name,
    recentMessages: testCase.messages,
    originalInput: testCase.originalInput,
    hasInput: testCase.hasInput,
    narrativeMode: testCase.narrativeMode,
    intensity: testCase.intensity,
    length: testCase.length,
  })
  const systemPrompt = contextMessages[0].content
  const userPrompt = contextMessages[contextMessages.length - 1].content
  const temperature = CONTINUE_INTENSITY_PARAMS[testCase.intensity].temperature

  const started = Date.now()
  const checks: Check[] = []
  const transport: TransportStat[] = []
  let raw = ''
  let cleaned = ''
  let error: string | undefined
  let repair: string | undefined
  let attempts = 0
  try {
    const first = await callModel({
      systemPrompt,
      userPrompt,
      temperature,
      maxTokens: CONTINUE_REQUEST_MAX_TOKENS,
      label: testCase.id,
    })
    raw = first.text
    transport.push(...first.transport)
    attempts += first.transport.length
    cleaned = parseContinueResult(raw, USER_PROFILE.name, testCase.character.name, testCase.narrativeMode)

    if (!cleaned) {
      // 真实链路的格式重试：追加 system 说明后重发
      const retry = await callModel({
        systemPrompt,
        userPrompt,
        temperature: Math.min(temperature, 0.3),
        maxTokens: CONTINUE_REQUEST_MAX_TOKENS,
        label: `${testCase.id}-fmt-retry`,
        systemSuffix: '上一次输出格式无效。不要分析、解释或复述规则；只返回一组包含简体中文正文的 <continuation>...</continuation>。',
      })
      attempts += retry.transport.length
      transport.push(...retry.transport)
      cleaned = parseContinueResult(retry.text, USER_PROFILE.name, testCase.character.name, testCase.narrativeMode)
      if (cleaned) repair = 'format-retry'
    }

    if (cleaned) {
      let verdict = evaluateContinueLength(cleaned, testCase.length)
      if (verdict.action === 'trim' && verdict.trimmedText) {
        checks.push(check('length-trim', true, `超上限 ${verdict.chars} 字 → 句边界收束至 ${countVisible(verdict.trimmedText)} 字`, 'warn'))
        cleaned = verdict.trimmedText
        verdict = evaluateContinueLength(cleaned, testCase.length)
      } else if (verdict.action === 'supplement' || verdict.action === 'compress') {
        // 真实链路：追加长度修复说明后重发一次
        const fix = await callModel({
          systemPrompt,
          userPrompt,
          temperature,
          maxTokens: CONTINUE_REQUEST_MAX_TOKENS,
          label: `${testCase.id}-${verdict.action}-fix`,
          systemSuffix:
            verdict.action === 'compress'
              ? `上一次输出约 ${verdict.chars} 个可见字符，超出本次目标。请压缩重写，保留关键信息与因果，必须在目标区间内以完整句收尾。`
              : `上一次输出约 ${verdict.chars} 个可见字符${verdict.truncated ? '且未写完' : ''}，请补足到目标区间，以完整句收尾；不要复述已有内容。`,
        })
        attempts += fix.transport.length
        transport.push(...fix.transport)
        const fixed = parseContinueResult(fix.text, USER_PROFILE.name, testCase.character.name, testCase.narrativeMode)
        if (fixed) {
          cleaned = fixed
          repair = verdict.action
        }
        checks.push(check('needs-length-repair', false, `首次长度判定为 ${verdict.action}（${verdict.chars} 字）`, 'warn'))
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const durationMs = Date.now() - started

  const { minChars, maxChars } = (await import('../shared/continueIntensity')).CONTINUE_LENGTH_PARAMS[testCase.length]
  const chars = countVisible(cleaned)
  if (!error) {
    const meta = containsMeta(cleaned)
    const charName = testCase.character.name
    const speaksAsChar = new RegExp(`${charName}\\s*[：:]\\s*[“"]`).test(cleaned)
    checks.push(check('parsed', cleaned.length > 0, cleaned ? `解析出正文 ${chars} 可见字符` : 'parseContinueResult 返回空'))
    checks.push(
      check(
        'length-band',
        chars >= minChars * 0.8 && chars <= maxChars * 1.2,
        `目标 ${minChars}–${maxChars} 字，实际 ${chars} 字`,
      ),
    )
    checks.push(check('complete-sentence', isCompleteChineseSentence(cleaned), isCompleteChineseSentence(cleaned) ? '完整句收尾' : '结尾不完整（疑似截断）'))
    if (testCase.narrativeMode === 'immersive') {
      checks.push(check('user-voice-only', !speaksAsChar, speaksAsChar ? '出现角色名对白（越权替角色发言）' : '未替角色发言'))
    } else {
      const firstPerson = /^我[\u4e00-\u9fff]/.test(cleaned)
      checks.push(check('third-person', !firstPerson, firstPerson ? '以“我”开头（旁白应为第三人称）' : '第三人称旁白'))
      checks.push(check('no-dialogue-block', !/[“"][^”"]{6,}[”"]/.test(cleaned), '旁白不应生成大段角色对白', 'warn'))
    }
    checks.push(check('no-meta', !meta, meta ? `命中：${meta}` : '无标题/列表/AI 自述'))
    const last = transport.at(-1)
    if (last && attempts > 0) {
      checks.push(
        check('within-budget', last.finishReason !== 'length', `finish_reason=${last.finishReason}，completion=${last.completionTokens}（reasoning ${last.reasoningTokens}）`),
      )
    }
  } else {
    checks.push(check('request', false, error))
  }

  return {
    batch: 'continue',
    id: testCase.id,
    title: testCase.title,
    systemPrompt,
    userPrompt,
    raw,
    final: cleaned,
    attempts,
    extra: {
      narrativeMode: testCase.narrativeMode,
      intensity: testCase.intensity,
      length: testCase.length,
      hasInput: testCase.hasInput,
      visibleChars: chars,
      targetBand: [minChars, maxChars],
      repair: repair ?? null,
      focus: testCase.focus,
    },
    checks,
    transport,
    durationMs,
    error,
  }
}

// ===================== 批次 3：下一步方向 =====================

interface DirectionCase {
  id: string
  title: string
  userName: string
  charName: string
  narrativeMode: 'immersive' | 'omniscient'
  character: Character
  recentMessages: Array<{ speaker: string; content: string }>
  latestReply: string
  worldState?: string
  focus: string
}

function directionCases(): DirectionCase[] {
  const recent = [
    { speaker: USER_PROFILE.name, content: '外面雨太大了，先把窗关上吧。' },
    { speaker: '苏晚', content: '苏晚没有回头，右手还攥着栏杆，指节发白。' },
    { speaker: USER_PROFILE.name, content: '停电了？物业怎么说。' },
    { speaker: '苏晚', content: '“整栋楼都停了。物业电话打不通。”烛火把她的影子拉长在墙上，“……刚才有人在楼下巷子里喊我的名字。”' },
  ]
  const latestReply = '“整栋楼都停了。物业电话打不通。”\n\n*烛火把她的影子拉长在墙上，她忽然压低声音。*\n\n“……刚才有人在楼下巷子里喊我的名字。”'
  return [
    {
      id: 'dir-immersive',
      title: '代入式 · 苏晚 · 悬念现场',
      userName: USER_PROFILE.name,
      charName: '苏晚',
      narrativeMode: 'immersive',
      character: CHAR_SUWAN,
      recentMessages: recent,
      latestReply,
      focus: '三个方向应是玩家“可以说的话/可以做的事”，且 safe/explore/risky 语义分明',
    },
    {
      id: 'dir-omniscient',
      title: '全局叙事 · 苏晚 · 旁白推动',
      userName: USER_PROFILE.name,
      charName: '苏晚',
      narrativeMode: 'omniscient',
      character: CHAR_SUWAN,
      recentMessages: recent,
      latestReply,
      focus: '方向应写成旁白式的剧情推动/世界变化，不得是某个角色的第一人称台词',
    },
    {
      id: 'dir-worldstate',
      title: '代入式 · 带世界状态（长记忆）',
      userName: USER_PROFILE.name,
      charName: '苏晚',
      narrativeMode: 'immersive',
      character: CHAR_SUWAN,
      recentMessages: recent,
      latestReply,
      worldState: '停电三小时；苏晚左手腕有未处理的擦伤；楼下有人喊过她的名字。',
      focus: '方向应利用世界状态（擦伤/停电/喊名），不引入与之矛盾的信息',
    },
    {
      id: 'dir-linyan-conflict',
      title: '代入式 · 林砚 · 高压指认',
      userName: USER_PROFILE.name,
      charName: '林砚',
      narrativeMode: 'immersive',
      character: CHAR_LINYAN,
      recentMessages: [
        { speaker: USER_PROFILE.name, content: '我真的只是路过。' },
        { speaker: '林砚', content: '“路过的人不会带着凶器的鞘。”林砚终于抬眼。' },
        { speaker: USER_PROFILE.name, content: '你怀疑我？' },
        { speaker: '林砚', content: '“我怀疑所有人。但这截刀柄上刻着‘陈’字。”' },
      ],
      latestReply: '*她从袖中抖出半截断刃，刃口朝你。*\n\n“我怀疑所有人。但这截刀柄上刻着‘陈’字。”\n\n“……你姓陈。”',
      focus: '高压对峙下给出三种可行的应对方向，避免三句同义重复',
    },
  ]
}

async function runDirectionCase(options: CliOptions, callModel: CallModel, testCase: DirectionCase): Promise<CaseResult> {
  const {
    buildDialogueDirectionSystemPrompt,
    buildDialogueDirectionUserPrompt,
    parseDialogueDirections,
    DIALOGUE_DIRECTION_TEMPERATURE,
    DIALOGUE_DIRECTION_LIMITS,
  } = await import('../shared/dialogueDirections')
  // W5：方向预算已收编到后台档案 + 统一预算 + off 门控（与生产同口径）
  const { BACKGROUND_GENERATION_PROFILES } = await import('../shared/backgroundGeneration')
  const { resolveRequestBudget } = await import('../shared/modelOutputProfile')
  const { resolveReasoningGate } = await import('../shared/reasoningGate')
  const directionGate = resolveReasoningGate({ model: options.model, requestedLevel: 'off', enabled: true })
  const directionBudget = resolveRequestBudget({
    model: options.model,
    hardMaxChars: BACKGROUND_GENERATION_PROFILES.direction.expectedBodyChars,
    reasoningGate: directionGate,
  }).requestMaxTokens

  const input = {
    userName: testCase.userName,
    charName: testCase.charName,
    characterDescription: testCase.character.description,
    narrativeMode: testCase.narrativeMode,
    recentMessages: testCase.recentMessages,
    latestReply: testCase.latestReply,
    worldState: testCase.worldState,
  }
  const systemPrompt = buildDialogueDirectionSystemPrompt(input)
  const userPrompt = buildDialogueDirectionUserPrompt(input)

  const started = Date.now()
  const checks: Check[] = []
  const transport: TransportStat[] = []
  let raw = ''
  let directions: unknown[] = []
  let error: string | undefined
  let attempts = 0
  let firstParseOk = false
  try {
    const first = await callModel({
      systemPrompt,
      userPrompt,
      temperature: DIALOGUE_DIRECTION_TEMPERATURE,
      maxTokens: directionBudget,
      reasoningGate: { level: 'off', knob: directionGate.knob, tokens: directionGate.gateTokens },
      label: testCase.id,
    })
    raw = first.text
    transport.push(...first.transport)
    attempts += first.transport.length
    directions = parseDialogueDirections(raw)
    firstParseOk = directions.length > 0

    if (!firstParseOk) {
      const retry = await callModel({
        systemPrompt: `${systemPrompt}\n\n上一次输出结构不合法。不要分析或解释，只返回一组 <directions>...</directions> 包裹的合法 JSON 数组。`,
        userPrompt,
        temperature: DIALOGUE_DIRECTION_TEMPERATURE,
        maxTokens: directionBudget,
        reasoningGate: { level: 'off', knob: directionGate.knob, tokens: directionGate.gateTokens },
        label: `${testCase.id}-retry`,
      })
      transport.push(...retry.transport)
      attempts += retry.transport.length
      directions = parseDialogueDirections(retry.text)
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const durationMs = Date.now() - started

  if (!error) {
    const list = directions as Array<{ id: string; label: string; content: string; tendency: string }>
    const tendencies = new Set(list.map((d) => d.tendency))
    const last = transport.at(-1)
    checks.push(check('parsed-structure', list.length === 3, `parseDialogueDirections 返回 ${list.length} 条`))
    checks.push(check('first-attempt-ok', firstParseOk, firstParseOk ? '首次输出即合法' : '首次非法，依赖重试一次', 'warn'))
    checks.push(check('tendency-coverage', tendencies.size === 3, `倾向集合 {${[...tendencies].join(',')}}`))
    if (list.length === 3) {
      const labelBad = list.filter((d) => {
        const n = countVisible(d.label)
        return n < DIALOGUE_DIRECTION_LIMITS.labelMinChars || n > DIALOGUE_DIRECTION_LIMITS.labelMaxChars
      })
      const contentBad = list.filter((d) => {
        const n = countVisible(d.content)
        return n < DIALOGUE_DIRECTION_LIMITS.contentMinChars || n > DIALOGUE_DIRECTION_LIMITS.contentMaxChars
      })
      checks.push(check('label-length', labelBad.length === 0, `越界 label ${labelBad.length} 条（要求 6–14 字）`, 'warn'))
      checks.push(check('content-length', contentBad.length === 0, `越界 content ${contentBad.length} 条（要求 15–60 字）`, 'warn'))
    }
    checks.push(
      check(
        'budget-not-capped',
        last?.finishReason !== 'length',
        `finish_reason=${last?.finishReason}，completion=${last?.completionTokens}（reasoning ${last?.reasoningTokens}），预算 ${directionBudget}`,
      ),
    )
  } else {
    checks.push(check('request', false, error))
  }

  return {
    batch: 'directions',
    id: testCase.id,
    title: testCase.title,
    systemPrompt,
    userPrompt,
    raw,
    final: JSON.stringify(directions, null, 2),
    attempts,
    extra: { narrativeMode: testCase.narrativeMode, firstParseOk, focus: testCase.focus },
    checks,
    transport,
    durationMs,
    error,
  }
}

// ===================== 批次 4：生图提示词 =====================

interface ImagineCase {
  id: string
  title: string
  style: 'natural' | 'tags'
  mode: 'moment' | 'closeup' | 'full' | 'interaction' | 'background'
  selfMode: 'hidden' | 'silhouette' | 'translucent' | 'pov'
  character: Character
  focus: string
}

function imagineCases(): ImagineCase[] {
  return [
    {
      id: 'img-natural-moment',
      title: '自然语言 · 剧情瞬间',
      style: 'natural',
      mode: 'moment',
      selfMode: 'hidden',
      character: CHAR_SHEN,
      focus: '英文自然段；准确呈现最新剧情状态与角色外貌',
    },
    {
      id: 'img-tags-moment',
      title: '标签风格 · 剧情瞬间',
      style: 'tags',
      mode: 'moment',
      selfMode: 'hidden',
      character: CHAR_SHEN,
      focus: '以 best quality, masterpiece, highres 开头并覆盖姿势、动作与光线',
    },
    {
      id: 'img-natural-silhouette',
      title: '自然语言 · 近景 · 轮廓入镜',
      style: 'natural',
      mode: 'closeup',
      selfMode: 'silhouette',
      character: CHAR_SHEN,
      focus: '近景 + 受控前景轮廓片段，占位符必须被替换且只出现一次',
    },
    {
      id: 'img-background',
      title: '自然语言 · 环境空镜',
      style: 'natural',
      mode: 'background',
      selfMode: 'hidden',
      character: CHAR_SHEN,
      focus: '空镜规则生效：不得出现人物，重点呈现环境、光线与使用痕迹',
    },
    {
      id: 'img-tags-full',
      title: '标签风格 · 全身',
      style: 'tags',
      mode: 'full',
      selfMode: 'hidden',
      character: CHAR_SUWAN,
      focus: '全身构图完整，角色动作、服装状态与场景一致',
    },
  ]
}

async function runImagineCase(options: CliOptions, callModel: CallModel, testCase: ImagineCase): Promise<CaseResult> {
  const captured: Array<{ prompt: string; options: unknown }> = []
  const notifications: string[] = []
  const attempts: Array<{ systemPrompt: string; userPrompt: string; raw: string }> = []

  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      imageGen: {
        generate: async (prompt: string, opts?: unknown) => {
          captured.push({ prompt, options: opts })
          return { success: true, images: ['data:image/png;base64,EVAL-NO-IMAGE'] }
        },
      },
    },
  }

  const imageGenConfig = testCase.style === 'natural'
    ? { name: 'comfyui', provider: 'comfyui' as const, model: '', apiKey: '', baseUrl: 'http://127.0.0.1:8188', size: '1080x1920', quality: 'standard', workflowName: 'image_z_image_turbo', workflow: '{"57:28":{"class_type":"UNETLoader"}}' }
    : { name: 'SD', provider: 'sd-webui' as const, model: 'anime', apiKey: '', baseUrl: 'http://127.0.0.1:7860', size: '512x512', quality: 'standard', workflowName: undefined, workflow: undefined }

  const transport: TransportStat[] = []
  const ctx = {
    character: testCase.character,
    addImageMessage: async () => {},
    notify: (message: string) => { notifications.push(message) },
    callAiHelper: async (
      systemPrompt: string,
      userContent: string,
      aiOptions?: { temperature?: number; maxTokens?: number; allowTruncatedOutput?: boolean },
    ) => {
      const record = { systemPrompt, userPrompt: userContent, raw: '', error: '' }
      attempts.push(record)
      try {
        const result = await callModel({
          systemPrompt,
          userPrompt: userContent,
          temperature: aiOptions?.temperature ?? 0.5,
          maxTokens: aiOptions?.maxTokens ?? 900,
          allowTruncatedOutput: aiOptions?.allowTruncatedOutput,
          label: `${testCase.id}-a${attempts.length - 1}`,
        })
        transport.push(...result.transport)
        record.raw = result.text
        return result.text
      } catch (err) {
        record.error = err instanceof Error ? err.message : String(err)
        throw err
      }
    },
    getRecentMessages: () => (testCase.character.name === '苏晚' ? SUWAN_MESSAGES : SHEN_MESSAGES).map((m) => ({
      name: m.role === 'user' ? USER_PROFILE.name : testCase.character.name,
      content: m.content,
    })),
    getActiveImageGen: () => imageGenConfig,
    beginImageGeneration: () => 'eval-job',
    updateImageGeneration: () => {},
    finishImageGeneration: () => {},
    userName: USER_PROFILE.name,
    userProfile: USER_PROFILE,
  }

  const started = Date.now()
  const checks: Check[] = []
  let error: string | undefined
  try {
    const { imagineCommand } = await import('../src/commands/builtin/imagine')
    await imagineCommand.execute(['--mode', testCase.mode, '--self', testCase.selfMode], ctx as never)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const durationMs = Date.now() - started

  const finalPrompt = captured[0]?.prompt ?? ''
  const systemPrompt = attempts[0]?.systemPrompt ?? ''
  const userPrompt = attempts[0]?.userPrompt ?? ''
  const raw = attempts[0]?.raw ?? ''

  if (!error) {
    checks.push(check('produced', finalPrompt.length > 0, finalPrompt ? `产出 ${finalPrompt.length} 字符` : '未产出提示词'))
    checks.push(check('english-only', !/[\u4e00-\u9fff]/.test(finalPrompt), '提示词应为纯英文'))
    checks.push(check('no-placeholder', !finalPrompt.includes('{{SELF_COMPOSITION}}'), '占位符残留检查'))
    checks.push(check('no-tag-literal', !/<\s*\/?\s*prompt\b/i.test(finalPrompt), '无 <prompt> 标签字面量'))
    // R3：任意尖括号标记与元信息词不得混入最终提示词
    checks.push(check('no-meta-info',
      !/<\s*\/?\s*[a-z][a-z0-9_-]*\s*>/i.test(finalPrompt)
        && !/\b(?:let me|i['’]ll|i will|sorry|actually|correction)\b/i.test(finalPrompt),
      '无尖括号标记与元信息词'))
    if (testCase.style === 'tags') {
      checks.push(check('tag-prefix', /^best quality\s*,\s*masterpiece\s*,\s*highres/i.test(finalPrompt), '以 best quality, masterpiece, highres 开头', 'warn'))
    }
    if (testCase.mode !== 'background' && testCase.selfMode !== 'hidden') {
      const guardHit = /(cropped featureless dark shoulder|translucent contour|first-person (camera )?viewpoint|first-person viewpoint)/i.test(finalPrompt)
      checks.push(check('self-guard-present', guardHit, '受控入镜片段已注入'))
    }
    checks.push(check('no-role-name', !finalPrompt.toLowerCase().includes(testCase.character.name.toLowerCase()), '未用角色姓名代替外貌'))
  } else {
    checks.push(check('request', false, error))
  }

  return {
    batch: 'imagine',
    id: testCase.id,
    title: testCase.title,
    systemPrompt,
    userPrompt,
    raw,
    final: finalPrompt,
    attempts: attempts.length,
    extra: {
      style: testCase.style,
      mode: testCase.mode,
      selfMode: testCase.selfMode,
      promptChars: finalPrompt.length,
      focus: testCase.focus,
      genCalls: attempts.length,
      notifications,
      attemptErrors: attempts.map((a) => a.error).filter(Boolean),
    },
    checks,
    transport,
    durationMs,
    error,
  }
}

// ===================== 批次 5：预设生成 =====================

const PRESET_GEN_SYSTEM = `你是一个角色扮演预设配置生成器。根据用户的需求描述，生成中文预设。

严格按以下格式输出：
【SystemPrompt】
200 字内的系统提示词（含角色扮演要求、回复风格、语气、长度控制）

【Jailbreak】
可选的越狱/创作提示词；不需要时写“无”

【参数建议】
温度: <0-2>
TopP: <0-1>

只输出上述格式内容。`

interface PresetCase {
  id: string
  title: string
  description: string
  focus: string
}

function presetCases(): PresetCase[] {
  return [
    { id: 'p1-suspense', title: '悬疑向预设', description: '想要一个偏悬疑推理的角色扮演预设，回复要有氛围感、克制，控制单次字数不要太长', focus: 'systemPrompt ≤200 字，含风格/语气/长度控制；参数合理' },
    { id: 'p2-healing', title: '治愈日常向预设', description: '想要轻松治愈的日常向预设，对话口语化、多给生活细节，避免剧情大起大落', focus: '解析出 systemPrompt 与参数；不出现格式外内容' },
  ]
}

async function runPresetCase(options: CliOptions, callModel: CallModel, testCase: PresetCase): Promise<CaseResult> {
  const started = Date.now()
  const checks: Check[] = []
  let raw = ''
  let transport: TransportStat[] = []
  let error: string | undefined
  try {
    const result = await callModel({
      systemPrompt: PRESET_GEN_SYSTEM,
      userPrompt: testCase.description,
      temperature: 0.7,
      maxTokens: 1200,
      label: testCase.id,
    })
    raw = result.text
    transport = result.transport
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const durationMs = Date.now() - started

  const { parsePresetGeneration } = await import('../src/utils/presetGen')
  const parsed = parsePresetGeneration(raw)
  if (!error) {
    checks.push(check('parsed', !!parsed.systemPrompt, parsed.systemPrompt ? `systemPrompt ${countVisible(parsed.systemPrompt)} 可见字` : '未解析出 systemPrompt'))
    checks.push(check('system-prompt-length', countVisible(parsed.systemPrompt) <= 260, `systemPrompt ${countVisible(parsed.systemPrompt)} 字（要求约 ≤200）`, 'warn'))
    checks.push(check('format-clean', !/【Jailbreak】[\s\S]*【参数建议】[\s\S]*温度/.test(parsed.systemPrompt), '未把格式块混入 systemPrompt'))
    if (parsed.temperature !== undefined) {
      checks.push(check('temperature-range', parsed.temperature >= 0 && parsed.temperature <= 2, `温度建议 ${parsed.temperature}`))
    }
    checks.push(check('chinese', hasChinese(parsed.systemPrompt), '中文输出'))
  } else {
    checks.push(check('request', false, error))
  }

  return {
    batch: 'preset',
    id: testCase.id,
    title: testCase.title,
    systemPrompt: PRESET_GEN_SYSTEM,
    userPrompt: testCase.description,
    raw,
    final: JSON.stringify(parsed, null, 2),
    attempts: transport.length,
    extra: {
      systemPromptChars: countVisible(parsed.systemPrompt),
      systemPromptText: parsed.systemPrompt,
      jailbreak: parsed.jailbreak,
      temperature: parsed.temperature ?? null,
      topP: parsed.topP ?? null,
      focus: testCase.focus,
    },
    checks,
    transport,
    durationMs,
    error,
  }
}

// ===================== 批次 6：长记忆摘要 =====================

/**
 * 提示词与 src/store/memoryManager.ts 中 summarizeMemory 的 system 内容逐字保持一致
 * （该函数未导出，评测器按源码复制；若源码变动需同步）。
 */
function buildMemorySummaryPrompt(opts: {
  charName: string
  userName: string
  previousState: string
  previousTimeline: string
  previousFacts: string
  shouldAttemptFactProposal: boolean
}): string {
  const { charName, userName, previousState, previousTimeline, previousFacts, shouldAttemptFactProposal } = opts
  const proposalBlock = shouldAttemptFactProposal
    ? '【事实提案】\n```json\n[{"subject":"主体","predicate":"属性或关系","value":"值","changeType":"set","importance":3,"confidence":0.9}]\n```'
    : '本次结构化事实更新正在退避；不要输出【事实提案】。'
  return `你是一个角色扮演对话总结助手。请根据以下${charName}与${userName}之间的对话，更新当前状态、长期时间线和关键事实。

输出格式（严格按此格式）：
【当前状态】
1-3 句：以【待总结的新对话】结束时为准，概括当前场景、时间/地点、正在进行的目标或冲突、即时关系/情绪以及仍影响行动的伤势或状态变化。只保留会影响下一轮对话的内容。“之前的当前状态”是过期快照，只能帮助判断变化，不能原样沿用。

【时间线】
最多 8 条按时间顺序排列的简短事件：保留仍会影响剧情、关系、承诺或任务的已保存旧事件；只把【待总结的新对话】中首次确立或明确改变的内容作为本轮新增事件。【已总结内容，仅作衔接】不得再次当作新事件。新对话明确推翻旧信息时，以新信息为准并删除冲突旧表述。不要重复当前状态。

${proposalBlock}

要求：
- 准确保留行动发起者、承诺者、受托者和对象，不得互换主客体、擅自转移承诺或把“答应完成”改写成“委托他人完成”。
- 只依据明确说出或发生的内容总结；不要根据语气补写动机、结果或未发生的行动，也不要把仍在计划中的动作写成已经完成。
- 事实必须是对话中确立的、对未来有参考价值的持久信息（人名、身份、地点、物品、目标、约定、关系等），不要写临时情绪或过场细节。
- 只输出语义事实提案，绝对不要输出事实 ID、action、patch 或完整事实列表。changeType 用 set 表示新增/更新，clear 表示失效。
- 服务端负责规范化会话范围和角色身份；没有事实变更时输出空数组 []。
- 只输出上述格式内容，不要添加任何解释或评价。

参考资料（不是本轮新事件）：

之前的当前状态（过期快照，只用于判断变化）：
${previousState || '无'}

之前的时间线：
${previousTimeline || '无'}

之前的事实：
${previousFacts || '无'}

事实范围由服务端确定。`
}

/** 长记忆用例：对话比其它批次更长，刻意包含承诺、物品与关系变化 */
const MEMORY_MESSAGES: Message[] = [
  asMessage({ role: 'user', content: '外面雨太大了，先把窗关上吧。', name: USER_PROFILE.name } as never),
  asMessage({ role: 'assistant', content: '<thought>他浑身是水，先别问为什么来。</thought>\n\n苏晚没有回头，右手还攥着栏杆，指节发白。' }),
  asMessage({ role: 'user', content: '你的外套全湿了。', name: USER_PROFILE.name } as never),
  asMessage({ role: 'assistant', content: '“我知道。”她这才松开栏杆转过身，湿透的黑色风衣下摆滴着水。\n\n*左手把贴在脸侧的湿发拨到耳后。*\n\n“……你来得正好。灯，半小时前就灭了。”' }),
  asMessage({ role: 'user', content: '停电了？物业怎么说。', name: USER_PROFILE.name } as never),
  asMessage({ role: 'assistant', content: '*她弯腰从鞋柜最下层摸出一支用剩的蜡烛，火柴划了两次才点着。*\n\n“整栋楼都停了。物业电话打不通。”\n\n*烛火把她的影子拉长在墙上，她忽然压低声音。*\n\n“……刚才有人在楼下巷子里喊我的名字。”' }),
  asMessage({ role: 'user', content: '我下去看看。', name: USER_PROFILE.name } as never),
  asMessage({ role: 'assistant', content: '*她伸手拽住他的袖口，又立刻松开。*\n\n“别去。楼梯间黑。”\n\n*她沉默几秒，从抽屉里拿出一把黄铜钥匙放在桌上。*\n\n“这是我工作室的钥匙。明天上午十点，你替我去馆里把北窗关上——我答应过馆长，这几天不请假也得把《嘉祐集》补完。”' }),
  asMessage({ role: 'user', content: '好。你手上的伤呢？', name: USER_PROFILE.name } as never),
  asMessage({ role: 'assistant', content: '*她把左手腕翻过来，一道擦伤从袖口露出来，血已经干成暗色。*\n\n“搬书的时候蹭的。不疼。”\n\n*她顿了顿，声音低下去。*\n\n“……钥匙别弄丢。那是我妈留下的。”' }),
  asMessage({ role: 'user', content: '你妈？', name: USER_PROFILE.name } as never),
  asMessage({ role: 'assistant', content: '*她把蜡烛往桌心推了推，没有立刻回答。*\n\n“她也在图书馆做修复。十二年前那场库房火灾，她没出来。”\n\n*窗外的雨忽然砸得更响，她抬眼看向那扇没关严的窗。*\n\n“……所以我不喜欢停电。”' }),
]

interface MemoryCase {
  id: string
  title: string
  previousState: string
  previousTimeline: string
  previousFacts: string
  shouldAttemptFactProposal: boolean
  focus: string
  expectFacts: string[]
  /** 前 N 条消息视为"已总结内容，仅作衔接"（对齐 memoryManager 的 overlap 窗口） */
  overlapMessages?: number
}

function memoryCases(): MemoryCase[] {
  return [
    {
      id: 'mem-update',
      title: '长记忆更新 · 承诺与物品',
      previousState: '雨夜，苏晚的公寓停电，她与陈默在阳台说话。',
      previousTimeline: '1. 陈默雨夜到访苏晚的公寓\n2. 公寓停电，苏晚点起蜡烛',
      previousFacts: '苏晚的职业：市立图书馆古籍修复师',
      shouldAttemptFactProposal: true,
      focus: '应记录黄铜钥匙的托付、明早十点去馆里关北窗的约定、左手腕擦伤、母亲与库房火灾、不喜欢停电',
      expectFacts: ['黄铜钥匙的托付', '明天上午十点去图书馆关北窗', '苏晚左手腕擦伤', '苏晚母亲十二年前在库房火灾中去世'],
    },
    {
      id: 'mem-conflict',
      title: '长记忆更新 · 与旧事实冲突',
      previousState: '白天，陈默陪苏晚在市立图书馆修复《嘉祐集》，工作进展顺利。',
      previousTimeline: '1. 陈默到图书馆找苏晚\n2. 两人一起吃午饭',
      previousFacts: '苏晚的母亲：健在，住在城南；苏晚不养宠物',
      shouldAttemptFactProposal: true,
      focus: '新对话推翻了“母亲健在”，应以 clear 或改写体现；不得保留与火灾矛盾的旧事实',
      expectFacts: ['苏晚母亲已去世（十二年前库房火灾）', '停电与苏晚的应激关联'],
      overlapMessages: 4,
    },
  ]
}

async function runMemoryCase(options: CliOptions, callModel: CallModel, testCase: MemoryCase): Promise<CaseResult> {
  const { parseMemoryResult } = await import('../src/utils/memory')

  const systemPrompt = buildMemorySummaryPrompt({
    charName: CHAR_SUWAN.name,
    userName: USER_PROFILE.name,
    previousState: testCase.previousState,
    previousTimeline: testCase.previousTimeline,
    previousFacts: testCase.previousFacts,
    shouldAttemptFactProposal: testCase.shouldAttemptFactProposal,
  })
  // 输入窗口与 memoryManager 一致：标注"已总结的衔接段"与"待总结的新对话"
  const overlapCount = testCase.overlapMessages ?? 0
  const overlap = MEMORY_MESSAGES.slice(0, overlapCount)
  const selected = MEMORY_MESSAGES.slice(overlapCount)
  const formatMsg = (m: (typeof MEMORY_MESSAGES)[number]) =>
    `${m.role === 'user' ? USER_PROFILE.name : CHAR_SUWAN.name}: ${m.content}`
  const userPrompt = [
    overlap.length > 0 ? `【已总结内容，仅作衔接】\n${overlap.map(formatMsg).join('\n')}` : '',
    `【待总结的新对话】\n${selected.map(formatMsg).join('\n')}`,
  ].filter(Boolean).join('\n\n')

  const started = Date.now()
  const checks: Check[] = []
  let raw = ''
  let transport: TransportStat[] = []
  let error: string | undefined
  try {
    const result = await callModel({
      systemPrompt,
      userPrompt,
      temperature: 0.3,
      maxTokens: 6144,
      // 与 memoryManager 的调用一致：总结解析容忍缺段，允许截断返回以便拿到部分结果
      allowTruncatedOutput: true,
      label: testCase.id,
    })
    raw = result.text
    transport = result.transport
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const durationMs = Date.now() - started

  const parsed = parseMemoryResult(raw)
  const timelineSection = raw.match(/【时间线】([\s\S]*?)(?=【(?:事实|事实变更|事实提案)】|$)/)?.[1]?.trim() ?? ''
  const timelineLines = timelineSection.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!error) {
    const stateSentences = (parsed.currentState.match(/[。！？]/g) ?? []).length
    checks.push(check('current-state', parsed.currentState.length > 0, `【当前状态】${parsed.currentState.length} 字`))
    checks.push(check('state-1-3-sentences', stateSentences >= 1 && stateSentences <= 4, `当前状态 ${stateSentences} 句（要求 1–3）`, 'warn'))
    checks.push(check('timeline-present', timelineLines.length > 0, `【时间线】${timelineLines.length} 条`))
    checks.push(check('timeline-max-8', timelineLines.length <= 8, `时间线条数 ${timelineLines.length}（要求 ≤8）`, 'warn'))
    if (testCase.shouldAttemptFactProposal) {
      const proposals = parsed.factProposals
      checks.push(check('fact-proposals-json', Array.isArray(proposals), Array.isArray(proposals) ? `事实提案 ${proposals.length} 条（JSON 合法）` : '事实提案 JSON 解析失败或缺失'))
      if (Array.isArray(proposals)) {
        const badFields = proposals.filter((p) => /"(id|action|patch)"/.test(JSON.stringify(p)))
        // clear 提案按 subject+predicate 匹配旧事实，value 允许为空（2026-09-12 修复后的契约）
        const badShape = proposals.filter((p) => {
          if (!p.subject || !p.predicate) return true
          if (p.changeType !== 'set' && p.changeType !== 'clear') return true
          return p.changeType === 'set' && !p.value
        })
        checks.push(check('fact-fields-clean', badFields.length === 0, `含 id/action/patch 字段 ${badFields.length} 条`))
        checks.push(check('fact-shape', badShape.length === 0, `字段不完整 ${badShape.length} 条（subject/predicate/value/changeType）`))
      }
    }
    // 【事实提案】一节要求模型输出 ```json 代码块，检查元信息时必须先剔除该节
    const outsideProposals = raw.replace(/【事实提案】[\s\S]*$/, '')
    const meta = containsMeta(outsideProposals)
    const leakedThought = /<(?:thought|thinking)>/i.test(raw)
    checks.push(check('no-meta', !meta && !leakedThought, meta ? `命中：${meta}` : leakedThought ? '输出含 <thought> 思考块（会占用输出预算）' : '无思考标签/解释性内容'))
  } else {
    checks.push(check('request', false, error))
  }

  return {
    batch: 'memory',
    id: testCase.id,
    title: testCase.title,
    systemPrompt,
    userPrompt,
    raw,
    final: raw,
    attempts: transport.length,
    extra: {
      currentState: parsed.currentState,
      timelineLines: timelineLines.length,
      factProposals: parsed.factProposals?.length ?? 0,
      factsJson: parsed.factProposals ?? null,
      focus: testCase.focus,
      expectFacts: testCase.expectFacts,
    },
    checks,
    transport,
    durationMs,
    error,
  }
}

// ===================== 批次 7：修复验证（不调用模型） =====================

/**
 * 对 2026-09-12 修复轮的确定性校验：直接调用被测函数或读取实现契约，不消耗模型额度。
 * 每项失败都指向具体回归点，作为"修复是否真的生效"的可重复证据。
 */
interface VerifyCase {
  id: string
  title: string
  focus: string
}

function verifyCases(): VerifyCase[] {
  return [
    { id: 'v-memory-clear-proposal', title: '长记忆 clear 提案容错', focus: 'D3：clear 允许空 value；坏条目逐条丢弃' },
    { id: 'v-dialogue-prefix-normalize', title: '裸对白补角色名前缀', focus: 'D7：仅代入式、仅独占一行的引号对白，thought 内不改' },
    { id: 'v-main-chat-budget', title: '主对话输出预算', focus: '阶段一：正文预算+推理余量动态计算，DeepSeek V4 不再固定 8192，用户硬上限始终生效' },
    { id: 'v-adapter-length-error', title: '适配器结构化完成', focus: '阶段3：length 走 AICompletion 不抛错（非流式/流式/tool_calls）；content_filter 与空正文仍报错' },
    { id: 'v-imagine-meta-rejected', title: '生图提示词拒收元信息', focus: 'R3：自述纠错行与残缺 <prong> 标签不进入最终提示词' },
    { id: 'v-continue-overlap-trim', title: '续写重叠去重阈值', focus: 'R5：minOverlap=4 裁掉 4 字复读；默认 8 行为不变' },
    { id: 'v-dialogue-prefix-guard', title: '对白前缀跳过已含角色名的行', focus: 'R4：含角色名的引号行不二次加前缀，裸对白仍补' },
    { id: 'v-direction-budget', title: '方向生成预算', focus: 'D6：1536' },
    { id: 'v-continue-continuity', title: '续写衔接约束', focus: 'D4：提示词含"不得重复末尾措辞/优先回应悬念"' },
    { id: 'v-body-format-position', title: '回应范围注入位置', focus: '阶段二：本轮回应范围出现一次，且位于历史消息之后（末端约束），无固定段落数/星号协议' },
    { id: 'v-pipeline-flag', title: '生成管线灰度开关', focus: '阶段六：unified 动态预算，legacy 回退预设 maxTokens 直用且标记旧链路；回退不删数据' },
    { id: 'v-imagine-ethnicity-removed', title: '族裔功能已回退', focus: 'D2：imagine 与 Character 类型不再含 ethnicity' },
    { id: 'v-thought-isolation-pipeline', title: '推理隔离与落盘正文（S10）', focus: 'S10：供应商推理不进落盘正文/记忆上下文；<thought> 保留给渲染层' },
    { id: 'v-thought-tts-memory', title: 'TTS 与记忆上下文的推理隔离（S10）', focus: 'S10：TTS 预处理不朗读推理；记忆窗口使用落盘正文且不含推理标记' },
  ]
}

async function runVerifyCase(options: CliOptions, testCase: VerifyCase): Promise<CaseResult> {
  const started = Date.now()
  const checks: Check[] = []
  const extra: Record<string, unknown> = { focus: testCase.focus }

  if (testCase.id === 'v-memory-clear-proposal') {
    const { parseMemoryResult } = await import('../src/utils/memory')
    const goodClear = parseMemoryResult('【事实提案】\n```json\n[{"subject":"苏晚的母亲","predicate":"健在并住在城南","value":"","changeType":"clear"}]\n```')
    checks.push(check('clear-empty-value-accepted', goodClear.factProposals?.length === 1, `空 value 的 clear → ${goodClear.factProposals?.length ?? 'null'} 条`))
    const omitted = parseMemoryResult('【事实提案】\n```json\n[{"subject":"A","predicate":"B","changeType":"clear"}]\n```')
    checks.push(check('clear-missing-value-accepted', omitted.factProposals?.length === 1, `省略 value 的 clear → ${omitted.factProposals?.length ?? 'null'} 条`))
    const partial = parseMemoryResult('【事实提案】\n```json\n[{"subject":"A","predicate":"B","value":"C","changeType":"set"},{"subject":"","predicate":"B","value":"C","changeType":"set"}]\n```')
    checks.push(check('partial-keeps-valid', partial.factProposals?.length === 1, `1 好 + 1 坏 → 保留 ${partial.factProposals?.length ?? 'null'} 条`))
    const allBad = parseMemoryResult('【事实提案】\n```json\n[{"subject":"","predicate":"","value":"","changeType":"set"}]\n```')
    checks.push(check('all-invalid-still-null', allBad.factProposals === null, `全坏 → ${allBad.factProposals === null ? 'null（保持原契约）' : '未返回 null'}`))
    const setRequiresValue = parseMemoryResult('【事实提案】\n```json\n[{"subject":"A","predicate":"B","value":"","changeType":"set"}]\n```')
    checks.push(check('set-still-requires-value', setRequiresValue.factProposals === null, `set 空 value → ${setRequiresValue.factProposals === null ? 'null（仍拒绝）' : '被错误接受'}`))
    extra.sample = goodClear.factProposals
  }

  if (testCase.id === 'v-dialogue-prefix-normalize') {
    const { normalizeRoleplayDialoguePrefixes } = await import('../src/utils/messagePostProcess')
    const immersive = '苏晚：“我知道。”\n\n“你来得正好。”\n\n*她把门拉开。*'
    const normalized = normalizeRoleplayDialoguePrefixes(immersive, '苏晚', 'immersive')
    checks.push(check('adds-prefix', normalized.includes('苏晚：“你来得正好。”'), '独占一行的裸对白已补前缀'))
    checks.push(check('keeps-existing-prefix', (normalized.match(/苏晚：/g) ?? []).length === 2, `前缀总数 ${(normalized.match(/苏晚：/g) ?? []).length}（不重复添加）`))
    checks.push(check('keeps-action-line', normalized.includes('*她把门拉开。*'), '动作段落未被改写'))
    const thought = '<thought>“他不会承认的。”</thought>\n\n“你来得正好。”'
    const normalizedThought = normalizeRoleplayDialoguePrefixes(thought, '苏晚', 'immersive')
    checks.push(check('skips-thought-block', normalizedThought.startsWith('<thought>“他不会承认的。”</thought>'), 'thought 内部未被添加前缀'))
    const omniscient = normalizeRoleplayDialoguePrefixes(immersive, '苏晚', 'omniscient')
    checks.push(check('skips-omniscient', omniscient === immersive, '全局叙事保持原样（多说话人不可推断）'))
    extra.sample = normalized
  }

  if (testCase.id === 'v-main-chat-budget') {
    const { resolveRequestBudget, MAX_REQUEST_OUTPUT_TOKENS } = await import('../shared/modelOutputProfile')
    const { resolveResponsePolicy } = await import('../shared/responsePolicy')
    const brief = resolveResponsePolicy({ presetHint: 'brief' })
    const balanced = resolveResponsePolicy({ presetHint: 'balanced' })
    const detailed = resolveResponsePolicy({ presetHint: 'detailed' })
    checks.push(check('length-ranges-ordered', brief.hardMaxChars < balanced.hardMaxChars && balanced.hardMaxChars < detailed.hardMaxChars, `硬保护线 ${brief.hardMaxChars} < ${balanced.hardMaxChars} < ${detailed.hardMaxChars}`))
    const dsBrief = resolveRequestBudget({ model: 'deepseek/deepseek-v4.1-flash', hardMaxChars: brief.hardMaxChars })
    const dsBalanced = resolveRequestBudget({ model: 'deepseek/deepseek-v4.1-flash', hardMaxChars: balanced.hardMaxChars })
    const dsDetailed = resolveRequestBudget({ model: 'deepseek/deepseek-v4.1-flash', hardMaxChars: detailed.hardMaxChars })
    checks.push(check('deepseek-v4-dynamic', dsBalanced.requestMaxTokens < MAX_REQUEST_OUTPUT_TOKENS && dsBalanced.reasoningReserve >= 3072, `balanced → ${dsBalanced.requestMaxTokens}（正文 ${dsBalanced.bodyReserve} + 推理 ${dsBalanced.reasoningReserve}）`))
    checks.push(check('reasoning-reserve-stable-across-lengths', dsBrief.reasoningReserve === dsDetailed.reasoningReserve, `brief/detailed 推理余量一致（${dsBrief.reasoningReserve}）`))
    checks.push(check('body-budget-follows-policy', dsBrief.bodyReserve < dsDetailed.bodyReserve, `正文预算 ${dsBrief.bodyReserve} < ${dsDetailed.bodyReserve}`))
    const capped = resolveRequestBudget({ model: 'deepseek/deepseek-v4.1-flash', hardMaxChars: balanced.hardMaxChars, userHardCap: 1024 })
    checks.push(check('user-cap-respected', capped.requestMaxTokens === 1024 && capped.riskNotice === 'user_cap_below_reasoning_reserve', `硬上限 1024 → ${capped.requestMaxTokens}（riskNotice=${capped.riskNotice ?? 'none'}）`))
    const plain = resolveRequestBudget({ model: 'gpt-4o-mini', hardMaxChars: balanced.hardMaxChars })
    checks.push(check('plain-model-protocol-only', plain.reasoningReserve <= 256 && plain.requestMaxTokens <= MAX_REQUEST_OUTPUT_TOKENS, `gpt-4o-mini → ${plain.requestMaxTokens}（推理 ${plain.reasoningReserve}）`))
  }

  if (testCase.id === 'v-adapter-length-error') {
    const { openaiAdapter } = await import('../electron/services/adapters/openai')
    const originalFetch = globalThis.fetch
    const params = {
      requestId: 'verify-length',
      messages: [{ role: 'user' as const, content: 'hi' }],
      provider: 'openai' as const,
      apiKey: 'k',
      baseUrl: 'https://example.invalid/v1',
      model: 'deepseek/deepseek-v4.1-flash',
      maxTokens: 16,
      stream: false,
    }
    try {
      // 阶段3契约：length 是完成状态——非流式返回 AICompletion{finishReason:'length'}，不抛错
      globalThis.fetch = (async () => new Response(JSON.stringify({
        choices: [{ message: { content: '半截内容' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 1, completion_tokens: 16, total_tokens: 17 },
      }), { status: 200 })) as typeof fetch
      const nonStream = await openaiAdapter.chat(params, () => {})
      checks.push(check('non-stream-length-completion', nonStream.finishReason === 'length' && nonStream.text === '半截内容', `非流式：finishReason=${nonStream.finishReason}，正文保留=${nonStream.text}`))
      checks.push(check('non-stream-usage', nonStream.usage?.completionTokens === 16, `usage.completionTokens=${nonStream.usage?.completionTokens}`))

      const sse = [
        'data: {"choices":[{"delta":{"content":"半截"}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')
      globalThis.fetch = (async () => new Response(sse, { status: 200 })) as typeof fetch
      const streamCompletion = await openaiAdapter.chat({ ...params, stream: true }, () => {})
      checks.push(check('stream-length-completion', streamCompletion.finishReason === 'length' && streamCompletion.text === '半截', `流式：finishReason=${streamCompletion.finishReason}，正文保留=${streamCompletion.text}`))

      // content_filter / 空正文仍按真实错误处理
      globalThis.fetch = (async () => new Response(JSON.stringify({
        choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
      }), { status: 200 })) as typeof fetch
      let filterError: string | null = null
      try { await openaiAdapter.chat(params, () => {}) } catch (err) { filterError = err instanceof Error ? err.message : String(err) }
      checks.push(check('content-filter-still-throws', !!filterError && filterError.includes('content_filter'), `content_filter：${filterError ?? '未报错'}`))

      globalThis.fetch = (async () => new Response(JSON.stringify({
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      }), { status: 200 })) as typeof fetch
      let emptyError: string | null = null
      try { await openaiAdapter.chat(params, () => {}) } catch (err) { emptyError = err instanceof Error ? err.message : String(err) }
      checks.push(check('empty-still-throws', !!emptyError && emptyError.includes('未返回任何内容'), `空正文：${emptyError ?? '未报错'}`))

      // 流式 tool_calls：finishReason='tool_calls'，正文带标记
      const toolSse = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"get_","arguments":"{\\"ci"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"北京\\"}"}}]},"finish_reason":"length"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')
      globalThis.fetch = (async () => new Response(toolSse, { status: 200 })) as typeof fetch
      const toolCompletion = await openaiAdapter.chat({ ...params, stream: true }, () => {})
      checks.push(check('stream-toolcalls-completion', toolCompletion.finishReason === 'tool_calls' && toolCompletion.text.includes('[TOOL_CALL:'), `tool_calls：finishReason=${toolCompletion.finishReason}，标记保留=${toolCompletion.text.includes('[TOOL_CALL:')}`))
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  if (testCase.id === 'v-imagine-meta-rejected') {
    const { imagineCommand } = await import('../src/commands/builtin/imagine')
    const dirty = 'tag. Let me correct.\n\n<prong>best quality, masterpiece, highres, 1girl, silver hair, blue eyes, worried gaze, parted lips, standing sideways, right hand touching the window, left hand holding her coat, rumpled black coat, rain-soaked room, cinematic lighting'
    let generatedPrompt: string | null = null
    const originalWindow = (globalThis as unknown as { window?: unknown }).window
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        imageGen: {
          generate: async (prompt: string) => {
            generatedPrompt = prompt
            return { success: true, images: ['data:image/png;base64,VERIFY'] }
          },
        },
      },
    }
    try {
      const ctx = {
        character: CHAR_SUWAN,
        addImageMessage: async () => {},
        notify: () => {},
        callAiHelper: async () => dirty,
        getRecentMessages: () => [],
        getActiveImageGen: () => ({ name: 'SD', provider: 'sd-webui', model: 'anime', apiKey: '', baseUrl: 'http://127.0.0.1:7860', size: '512x512', quality: 'standard' }),
        beginImageGeneration: () => 'verify-job',
        updateImageGeneration: () => {},
        finishImageGeneration: () => {},
        userName: USER_PROFILE.name,
        userProfile: USER_PROFILE,
      }
      await imagineCommand.execute([], ctx as never)
    } finally {
      ;(globalThis as unknown as { window?: unknown }).window = originalWindow
    }
    const prompt = generatedPrompt ?? ''
    checks.push(check('meta-stripped', prompt.startsWith('best quality') && !prompt.includes('prong') && !prompt.includes('Let me'),
      prompt ? `产出：${prompt.slice(0, 60)}…` : '未产出提示词'))
    extra.sample = prompt
  }

  if (testCase.id === 'v-continue-overlap-trim') {
    const { trimContinuationOverlap } = await import('../src/utils/messagePostProcess')
    const prev = '说起来，我今天其实'
    const next = '今天其实去了趟老城区的旧货市场'
    checks.push(check('default-8-unchanged', trimContinuationOverlap(prev, next) === next, '默认阈值 8：4 字重叠不裁剪'))
    checks.push(check('min4-trims', trimContinuationOverlap(prev, next, 4) === '去了趟老城区的旧货市场', 'minOverlap=4：复读前缀已裁剪'))
    checks.push(check('min4-short-untouched', trimContinuationOverlap('我去看看楼下的', '积水有没有漫上来', 4) === '积水有没有漫上来', 'minOverlap=4：无重叠不改动'))
    extra.sample = trimContinuationOverlap(prev, next, 4)
  }

  if (testCase.id === 'v-dialogue-prefix-guard') {
    const { normalizeRoleplayDialoguePrefixes } = await import('../src/utils/messagePostProcess')
    const mixed = '“我没应。”苏晚顿了顿，“喊了两声就没了。”'
    checks.push(check('named-line-untouched', normalizeRoleplayDialoguePrefixes(mixed, '苏晚', 'immersive') === mixed, '行内已含角色名：保持原样'))
    checks.push(check('bare-line-still-prefixed', normalizeRoleplayDialoguePrefixes('“说。鞘哪来的。”', '林砚', 'immersive') === '林砚：“说。鞘哪来的。”', '不含角色名的裸对白：仍补前缀'))
    const singleChar = '“夜晚真安静。”'
    checks.push(check('single-char-name-guard', normalizeRoleplayDialoguePrefixes(singleChar, '晚', 'immersive') === singleChar, '单字角色名子串命中：跳过（行为固化）'))
    extra.sample = mixed
  }

  if (testCase.id === 'v-direction-budget') {
    // W5：1536 直连已退出；预算由后台档案换算（正文预留 + 门控承诺/保守余量）
    const { BACKGROUND_GENERATION_PROFILES } = await import('../shared/backgroundGeneration')
    const { BODY_RESERVE_MULTIPLIER, BODY_RESERVE_OVERHEAD_TOKENS, resolveRequestBudget } = await import('../shared/modelOutputProfile')
    const { resolveReasoningGate } = await import('../shared/reasoningGate')
    const gate = resolveReasoningGate({ model: options.model, requestedLevel: 'off', enabled: true })
    const budget = resolveRequestBudget({
      model: options.model,
      hardMaxChars: BACKGROUND_GENERATION_PROFILES.direction.expectedBodyChars,
      reasoningGate: gate,
    })
    const expectedBody = Math.ceil(
      BACKGROUND_GENERATION_PROFILES.direction.expectedBodyChars * BODY_RESERVE_MULTIPLIER,
    ) + BODY_RESERVE_OVERHEAD_TOKENS
    checks.push(check(
      'budget-from-profile',
      budget.bodyReserve === expectedBody && budget.requestMaxTokens === expectedBody + budget.reasoningReserve,
      `正文预留=${budget.bodyReserve}，推理预留=${budget.reasoningReserve}，请求上限=${budget.requestMaxTokens}（不再固定 1536）`,
    ))
  }

  if (testCase.id === 'v-continue-continuity') {
    const { buildContinueSystemPrompt } = await import('../src/components/chat/aiInputHelper')
    const withInput = buildContinueSystemPrompt('陈默', '苏晚', true, 'immersive', 'active', 'standard')
    checks.push(check('no-repeat-clause', withInput.includes('不得重复原文末尾'), '有输入：含"不得重复原文末尾"'))
    checks.push(check('grammar-join-clause', withInput.includes('与原文拼接后语法通顺'), '有输入：含拼接语法要求'))
    const noInput = buildContinueSystemPrompt('陈默', '苏晚', false, 'immersive', 'steady', 'standard')
    checks.push(check('answer-suspense-clause', noInput.includes('优先回应最近一条尚未解决'), '无输入：含"优先回应最近一条尚未解决"'))
    const omni = buildContinueSystemPrompt('陈默', '苏晚', true, 'omniscient', 'active', 'standard')
    checks.push(check('omniscient-clause', omni.includes('不得重复原文末尾'), '全局叙事同样注入'))
  }

  if (testCase.id === 'v-body-format-position') {
    const { buildContextMessagesFromData } = await import('../src/context/contextBuilder')
    const data = makeBuildData({ character: CHAR_SUWAN, messages: SUWAN_MESSAGES, session: makeSession() })
    const built = buildContextMessagesFromData(data)
    const withProtocol = built.messages.filter((m) => m.role === 'system' && m.content.includes('【本轮回应范围】'))
    checks.push(check('protocol-once', withProtocol.length === 1, `system 中协议出现 ${withProtocol.length} 次`))
    const lastHistoryIndex = built.messages.reduce(
      (acc, m, index) => (m.role === 'user' || m.role === 'assistant' ? index : acc),
      -1,
    )
    const protocolIndex = built.messages.findIndex((m) => m.role === 'system' && m.content.includes('【本轮回应范围】'))
    checks.push(check('protocol-after-history', protocolIndex > lastHistoryIndex, `协议位置 ${protocolIndex} > 最后一条历史 ${lastHistoryIndex}`))
    extra.systemCount = built.messages.filter((m) => m.role === 'system').length
    extra.messageCount = built.messages.length
  }

  if (testCase.id === 'v-pipeline-flag') {
    const { resolveChatRequestPlan, buildLegacyBodyFormatPrompt } = await import('../src/context/contextBuilder')
    const preset = PRESET_FIXTURE
    // unified（缺省）：动态预算
    const unified = resolveChatRequestPlan(makeBuildData({ character: CHAR_SUWAN, messages: SUWAN_MESSAGES, session: makeSession() }))
    checks.push(check('unified-default', !unified.pipelineLegacy && unified.requestMaxTokens > 0, `缺省 unified：requestMaxTokens=${unified.requestMaxTokens}`))
    // legacy：预设 maxTokens 直用（DeepSeek V4 不再恢复固定 8192）
    const legacySettings = { ...BASE_SETTINGS, generationPipeline: 'legacy' as const }
    const legacyData = {
      ...makeBuildData({ character: CHAR_SUWAN, messages: SUWAN_MESSAGES, session: makeSession() }),
      settings: { settings: legacySettings, profile: makeBuildData({ character: CHAR_SUWAN, messages: SUWAN_MESSAGES, session: makeSession() }).settings.profile },
    }
    const legacy = resolveChatRequestPlan(legacyData as never)
    checks.push(check('legacy-flag-resolved', legacy.pipelineLegacy, 'legacy 标记已解析'))
    // preset.maxTokens = 0 表示「自动」：legacy 路径同样不能直传 0（OpenAI 兼容端点会 400），
    // 由 resolveUserHardCap(0)=null 落到 DEFAULT_RESERVED_OUTPUT 兜底。
    const { DEFAULT_RESERVED_OUTPUT } = await import('../shared/chat-core/chatConstants')
    const expectedLegacyBudget = preset.maxTokens > 0 ? preset.maxTokens : DEFAULT_RESERVED_OUTPUT
    checks.push(check(
      'legacy-preset-maxTokens',
      legacy.requestMaxTokens === expectedLegacyBudget,
      `legacy 预算=${legacy.requestMaxTokens}（preset.maxTokens=${preset.maxTokens}；0=自动→兜底 ${DEFAULT_RESERVED_OUTPUT}）`,
    ))
    // legacy 提示词回退：旧排版协议可用且新提示词与其互斥
    checks.push(check('legacy-prompt-available', buildLegacyBodyFormatPrompt('苏晚').includes('正文排版协议'), '旧排版协议提示词保留（回退注入）'))
    checks.push(check('legacy-not-8192-floor', legacy.requestMaxTokens !== 8192 || preset.maxTokens === 8192, '旧固定 8192 下限不再恢复'))
  }

  if (testCase.id === 'v-imagine-ethnicity-removed') {
    const { readFileSync } = await import('node:fs')
    const imagineSrc = readFileSync('src/commands/builtin/imagine.ts', 'utf-8')
    const typesSrc = readFileSync('shared/types.ts', 'utf-8')
    checks.push(check('imagine-no-ethnicity', !/ethnicity/i.test(imagineSrc), 'imagine.ts 不含 ethnicity'))
    checks.push(check('types-no-ethnicity', !/ethnicity/i.test(typesSrc), 'shared/types.ts 不含 ethnicity'))
    checks.push(check('no-placeholder-injection', !imagineSrc.includes('explicitly defined ethnicity'), '不再注入英文族裔前缀'))
  }

  if (testCase.id === 'v-thought-isolation-pipeline') {
    const { runGeneratedReplyPipeline } = await import('../src/store/generatedReplyPipeline')
    const raw = '<thinking>模型计划：先分析规则再写正文，注意用户要求简短。</thinking><thought>不能让他发现我在害怕。</thought>她说：“今天不去。”'
    const outcome = await runGeneratedReplyPipeline({
      rawText: raw,
      finishReason: 'stop',
      regexRules: [],
      characterName: '苏晚',
    })
    checks.push(check('reasoning-not-in-content', !/模型计划|分析规则|用户要求/.test(outcome.content), '落盘正文不含供应商推理文本'))
    checks.push(check('thought-kept', outcome.content.includes('<thought>不能让他发现我在害怕。</thought>'), '<thought> 保留给渲染层（心理描写是业务特性）'))
    checks.push(check('body-kept', outcome.content.includes('“今天不去。”'), '正文完整保留'))
    const { extractThought, stripThoughtTags } = await import('../src/utils/messagePostProcess')
    const extracted = extractThought(outcome.content)
    checks.push(check('extract-thought-first-person', extracted.thought === '不能让他发现我在害怕。', `extractThought.thought=${extracted.thought ?? 'null'}`))
    checks.push(check('extract-content-clean', !/模型计划|分析规则/.test(extracted.content), '渲染正文不含推理'))
    extra.sample = outcome.content
    extra.ttsWithThought = stripThoughtTags(outcome.content)
  }

  if (testCase.id === 'v-thought-tts-memory') {
    const { stripThought, stripThoughtTags } = await import('../src/utils/messagePostProcess')
    const persisted = '<thought>不能让他发现我在害怕。</thought>她说：“今天不去。”'
    // TTS（默认）：剥离 thought 块后朗读正文；不得出现任何推理痕迹
    const ttsDefault = stripThought(persisted)
    checks.push(check('tts-default-drops-thought', !ttsDefault.includes('害怕') && ttsDefault.includes('今天不去'), `默认朗读：${ttsDefault.slice(0, 40)}`))
    // TTS（朗读内心想法）：保留 thought 内容但去标签，同样不含推理
    const ttsWithThought = stripThoughtTags(persisted)
    checks.push(check('tts-include-thought-no-reasoning', ttsWithThought.includes('害怕') && !/<thought>/.test(ttsWithThought), '朗读内心：去标签保留内容'))
    // 记忆摘要窗口：格式化只读取落盘正文（与 memoryManager.formatMessage 同口径）
    const { buildMemorySummaryWindow } = await import('../src/utils/memoryWindow')
    const formatted = `苏晚: ${persisted}`
    const window = buildMemorySummaryWindow(
      [{ id: 'm1', content: formatted, role: 'assistant', characterId: 'c1' } as never],
      undefined,
      (m) => m.content,
      (text) => Math.ceil(text.length / 2),
      { tokenBudget: 4000 },
    )
    const memoryText = [
      ...window.overlap.map((m) => m.content),
      ...window.selected.map((m) => m.content),
    ].join('\n')
    checks.push(check('memory-context-no-reasoning', !/<thinking>|模型计划|分析规则/.test(memoryText), '记忆上下文不含供应商推理标记'))
    checks.push(check('memory-context-has-body', memoryText.includes('今天不去'), '记忆上下文包含正文内容'))
  }

  return {
    batch: 'verify',
    id: testCase.id,
    title: testCase.title,
    systemPrompt: '',
    userPrompt: '',
    raw: '',
    final: '',
    attempts: 0,
    extra,
    checks,
    transport: [],
    durationMs: Date.now() - started,
  }
}

// ===================== 评审（同一模型离线复核） =====================

const DIALOGUE_JUDGE_SYSTEM = `你是角色扮演对话质量的严格评审员。用户会给你 JSON：角色设定(character)、最近对话(history)、场景焦点(focus)、需要核对的事实(context_facts)与模型回复(reply)。

请逐项判断并以 JSON 输出：
{
 "in_character": true/false,      // 语气/行为是否符合角色设定（外冷内热、说话简短等）
 "scene_continuity": true/false,  // 是否承接最近对话与既有事实，无矛盾（含 context_facts）
 "no_user_puppeting": true/false, // 是否避免了替用户角色（陈默/用户）说话、行动、作决定、写内心
 "format_ok": true/false,         // 按语义自然分段、对白使用中文引号、无标题/列表/代码块；不要求固定段数或星号
 "meta_free": true/false,         // 无写作说明、无 AI 自述、无解释性文字
 "thought_ok": true/false,        // 每轮须有一组 <thought>（强契约）：第一人称“我”、≤3 句、无模型计划/规则分析/上下文复述；缺失或多组视为 false
 "reasoning_isolated": true/false,// 回复中没有供应商推理痕迹（<think>/<thinking> 标签或“首先分析规则/用户要求…”式推理段落）
 "progression_ok": true/false,    // 推进幅度合理，未一次解决全部冲突、未堆砌设定
 "prose_quality": 1-5,            // 中文散文质量（具体、克制、无翻译腔）
 "verdict": "pass"/"fail",        // 以上布尔项全 true 且 prose_quality>=3 才 pass
 "issues": ["用中文列出具体问题，无则空数组"]
}
只输出 JSON 对象，不要输出其他文字或代码块。`

const GROUP_JUDGE_SYSTEM = `你是群聊角色扮演的严格评审员。用户会给你 JSON：群名与模式(group/mode)、成员(members)、最近群聊记录(history)、场景焦点(focus)、本轮应发言角色(target)、需要核对的事实(context_facts)与模型回复(reply)。

请逐项判断并以 JSON 输出：
{
 "speaker_correct": true/false,   // 只由 target 角色发声：对白属于 target；动作/神态可第三人称叙述 target 自己的行为（项目既有风格），但不得代替其他角色或用户说话、行动、写内心
 "in_character": true/false,      // 语气/行为符合该角色设定（苏晚简短克制 / 江离话少）
 "scene_continuity": true/false,  // 承接群聊记录与既有事实，无矛盾
 "no_user_puppeting": true/false, // 未替用户角色说话、行动、作决定
 "format_ok": true/false,         // mention/polling：单人发言，不出现其他角色的【名】分段；free：多角色发言须用【角色名】标注
 "thought_ok": true/false,        // 每轮须有一组 <thought>（强契约）：当前角色第一人称“我”、≤3 句、无模型计划/规则分析；缺失或多组视为 false
 "reasoning_isolated": true/false,// 没有供应商推理痕迹（<think>/<thinking> 或推理口吻分析段落）
 "meta_free": true/false,         // 无格式说明/AI 自述/解释性文字
 "distinct_voice": 1-5,           // 与其它成员口吻的区分度（1=分不出，5=口吻鲜明）
 "verdict": "pass"/"fail",        // 布尔项全 true 且 distinct_voice>=3 才 pass
 "issues": ["中文问题列表"]
}
只输出 JSON 对象。`

const CONTINUE_JUDGE_SYSTEM = `你是角色扮演“用户视角续写”的质量评审员。用户会给你 JSON：叙事模式(narrative_mode)、剧情变化档位(intensity)、目标篇幅(length/clause)、原文片段(original_input)、角色设定(character)、最近对话(history)与续写结果(continuation)。

请判断并以 JSON 输出：
{
 "voice_correct": true/false,     // 代入式：以用户(陈默)口吻，未替角色(苏晚)发言；全局：第三人称旁白，未写成角色第一人称
 "intensity_fit": true/false,     // 推进幅度符合档位（subtle 只细微变化；steady 小波澜；active 明显事件/压力；bold 可重大转折）
 "length_fit": true/false,        // 篇幅符合目标区间（以中文字符粗略估计即可），且没有为凑字数重复
 "continuity": true/false,        // 与原文片段自然衔接、与最近对话无矛盾
 "no_meta": true/false,           // 无格式说明、无“以下是续写”等元内容
 "reasoning_isolated": true/false,// 无供应商推理痕迹（<think>/<thinking> 或推理口吻分析）
 "natural": 1-5,                  // 中文表达自然度
 "verdict": "pass"/"fail",
 "issues": ["中文问题列表"]
}
只输出 JSON 对象。`

const MEMORY_JUDGE_SYSTEM = `你是角色扮演长记忆摘要的严格评审员。输入 JSON：conversation（完整新对话）、expect_facts（必须被记住的要点）、summary_output（模型输出）。

请判断并以 JSON 输出：
{
 "state_accurate": true/false,    // 【当前状态】是否准确概括当前场景/目标/关系，无编造
 "timeline_accurate": true/false, // 【时间线】事件顺序与内容是否正确、未重复当前状态
 "key_facts_kept": true/false,    // expect_facts 中的要点是否都体现在时间线或事实提案中
 "conflict_resolved": true/false, // 与“之前的事实”冲突时（如被推翻的旧事实）是否被更新或标记失效
 "no_hallucination": true/false,  // 未添加对话中不存在的信息
 "verdict": "pass"/"fail",
 "issues": ["中文问题列表"]
}
只输出 JSON 对象。`

const DIRECTION_JUDGE_SYSTEM = `你是“下一步方向”建议的质量评审员。输入 JSON：叙事模式(narrative_mode)、用户名(user)、角色名(char)、最近对话(history)、最新回复(latest_reply)、三个方向(directions)。

请判断并以 JSON 输出：
{
 "tendency_correct": true/false,  // safe/explore/risky 的语义确实分别是：稳妥承接 / 探索信息 / 冒险变化
 "distinct": true/false,          // 三个方向有实质差异，不是同义改写
 "actionable": true/false,        // 每个 content 都是用户可直接发送的话或可执行行动，符合叙事模式的身份
 "no_meta": true/false,           // 无“选项A/建议你/作为AI”等前缀或解释
 "in_world": true/false,          // 不含用户角色不该知道的幕后信息，与既有事实一致
 "verdict": "pass"/"fail",
 "issues": ["中文问题列表"]
}
只输出 JSON 对象。`

async function judgeCase(options: CliOptions, callModel: CallModel, result: CaseResult): Promise<JudgeVerdict> {
  let systemPrompt = ''
  let payload: unknown = null
  if (result.batch === 'dialogue') {
    systemPrompt = DIALOGUE_JUDGE_SYSTEM
    payload = {
      character: { name: result.id.includes('linyan') ? '林砚' : '苏晚', description: result.id.includes('linyan') ? CHAR_LINYAN.description : CHAR_SUWAN.description, personality: result.id.includes('linyan') ? CHAR_LINYAN.personality : CHAR_SUWAN.personality },
      history: result.userPrompt.slice(0, 4000),
      focus: result.extra.focus,
      context_facts: result.extra.contextFacts,
      reply: result.final,
    }
  } else if (result.batch === 'group') {
    systemPrompt = GROUP_JUDGE_SYSTEM
    payload = {
      group: { name: '旧城夜谈', mode: result.extra.mode },
      members: result.extra.memberNames,
      target: result.extra.target ?? '（自由发言，可由多角色参与）',
      history: result.userPrompt.slice(0, 4000),
      focus: result.extra.focus,
      context_facts: result.extra.contextFacts,
      reply: result.final,
    }
  } else if (result.batch === 'continue') {
    systemPrompt = CONTINUE_JUDGE_SYSTEM
    payload = {
      narrative_mode: result.extra.narrativeMode,
      intensity: result.extra.intensity,
      length: result.extra.length,
      target_band: result.extra.targetBand,
      original_input: result.userPrompt,
      character: { name: '苏晚', description: CHAR_SUWAN.description, personality: CHAR_SUWAN.personality },
      history: SUWAN_MESSAGES.map((m) => ({ role: m.role, content: m.content })),
      continuation: result.final,
    }
  } else if (result.batch === 'directions') {
    systemPrompt = DIRECTION_JUDGE_SYSTEM
    payload = {
      narrative_mode: result.extra.narrativeMode,
      user: USER_PROFILE.name,
      char: result.id.includes('linyan') ? '林砚' : '苏晚',
      history: result.userPrompt.slice(0, 3000),
      latest_reply: result.userPrompt.slice(-1200),
      directions: result.final,
    }
  } else if (result.batch === 'memory') {
    systemPrompt = MEMORY_JUDGE_SYSTEM
    payload = {
      character: { name: '苏晚', description: CHAR_SUWAN.description },
      user: USER_PROFILE.name,
      conversation: result.userPrompt,
      expect_facts: result.extra.expectFacts,
      summary_output: result.final,
    }
  } else {
    // stream / imagine / preset / verify 批次只有结构化检查，不设内容评审
    return { parsed: false, issues: [], raw: '__SKIP__' }
  }

  let raw = ''
  let parsed: Record<string, unknown> | null = null
  // 该端点忽略 thinking:disabled，推理会占用 max_tokens；评审是结构化长输出，
  // 预算给足以免“推理吃满 → 空正文”，并在失败时逐次加倍重试。
  let budget = 4000
  for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
    try {
      const res = await callModel({
        systemPrompt,
        userPrompt: JSON.stringify(payload, null, 2),
        temperature: 0,
        maxTokens: budget,
        label: `judge-${result.id}-a${attempt}`,
      })
      result.judgeTransport = [...(result.judgeTransport ?? []), ...res.transport]
      raw = res.text
      parsed = extractJson(raw)
    } catch (err) {
      raw = err instanceof Error ? err.message : String(err)
    }
    budget *= 2
  }
  return {
    parsed: !!parsed,
    verdict: typeof parsed?.verdict === 'string' ? parsed.verdict : undefined,
    scores: Object.fromEntries(
      Object.entries(parsed ?? {}).filter(([, v]) => typeof v === 'number'),
    ) as Record<string, number>,
    issues: Array.isArray(parsed?.issues) ? parsed!.issues.map(String) : [],
    raw: parsed ? '' : raw.slice(0, 600),
  }
}

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```[a-z]*/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

// ===================== CLI =====================

function parseArgs(argv: string[]): CliOptions {
  const get = (name: string, fallback?: string) => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
  }
  const batchArg = get('batch', 'all')!
  const all: BatchName[] = ['dialogue', 'group', 'stream', 'continue', 'directions', 'imagine', 'preset', 'memory', 'verify']
  const batches = batchArg === 'all'
    ? all
    : batchArg.split(',').map((s) => s.trim() as BatchName)
  for (const b of batches) if (!all.includes(b)) throw new Error(`未知 --batch: ${b}`)

  // verify 批次不调用模型、report-only 只重出报告，都不需要密钥
  const needsKey = batches.some((b) => b !== 'verify')
  const keyFile = get('key-file')
  const apiKey = process.env.GENERATION_EVAL_API_KEY
    || (keyFile && existsSync(keyFile) ? readFileSync(keyFile, 'utf-8').trim() : '')
  if (!apiKey && needsKey && !argv.includes('--report-only')) {
    throw new Error('缺少密钥：请用 --key-file <path> 或设置 GENERATION_EVAL_API_KEY')
  }

  const provider = get('provider', process.env.GENERATION_EVAL_PROVIDER || '')!
  if (!provider && needsKey && !argv.includes('--report-only') && !argv.includes('--judge-only')) {
    throw new Error(
      '缺少 --provider：必须由活跃 profile 注入（GENERATION_EVAL_PROVIDER），禁止按模型名猜测 provider',
    )
  }
  const baseUrl = get('base-url', process.env.GENERATION_EVAL_BASE_URL || '')!
  const model = get('model', process.env.GENERATION_EVAL_MODEL || '')!
  if (!model && needsKey && !argv.includes('--report-only') && !argv.includes('--judge-only')) {
    throw new Error('缺少 --model：必须由活跃 profile 注入（GENERATION_EVAL_MODEL）')
  }
  if (!baseUrl && needsKey && !argv.includes('--report-only') && !argv.includes('--judge-only')) {
    throw new Error('缺少 --base-url：必须由活跃 profile 注入（GENERATION_EVAL_BASE_URL）')
  }
  globalEvalProvider = provider || 'openai'
  globalEvalBaseUrl = baseUrl || 'https://api.commandcode.ai/provider/v1'
  globalEvalModel = model || 'deepseek-v4.1-flash'
  // W1/§5.4 复测：逗号分隔的近期推理样本（仅影响预算，不影响请求参数以外的行为）。
  // 注意：未传参数时 `''.split(',')` 会得到 [''] → Number('') === 0，
  // 曾因此把空样本变成 `[0]` 并让推理余量塌到协议下限（max_tokens 520 → 6/6 空正文）。
  globalEvalReasoningSamples = (get('reasoning-samples', '') || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)

  return {
    baseUrl: globalEvalBaseUrl,
    model: globalEvalModel,
    provider: globalEvalProvider,
    apiKey,
    batches,
    judge: (get('judge', 'on') || 'on') !== 'off',
    outDir: resolve(get('out', '.poc-tmp/eval-gen')!),
    append: argv.includes('--append'),
    only: argv.reduce<string[]>((acc, arg, index) => {
      if (arg === '--only' && argv[index + 1]) acc.push(...argv[index + 1].split(',').map((s) => s.trim()))
      return acc
    }, []),
    concurrency: Number(get('concurrency', '1')),
    reps: Number(get('reps', '1')),
    judgeOnly: argv.includes('--judge-only'),
    reportOnly: argv.includes('--report-only'),
  }
}

// ===================== 报告 =====================

function statusOf(result: CaseResult): string {
  const fails = result.checks.filter((c) => c.level === 'fail')
  const warns = result.checks.filter((c) => c.level === 'warn')
  if (result.error) return '❌ 运行错误'
  if (fails.length > 0) return `❌ ${fails.map((f) => f.id).join(', ')}`
  if (warns.length > 0) return `⚠️ ${warns.map((w) => w.id).join(', ')}`
  return '✅'
}

function judgeCell(result: CaseResult): string {
  if (!result.judge) return '—'
  if (!result.judge.parsed) return '⚠️ 评审解析失败'
  return result.judge.verdict === 'pass' ? '✅' : `❌ ${result.judge.issues.join('；')}`
}

function renderReport(options: CliOptions, results: CaseResult[]): string {
  const lines: string[] = []
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
  lines.push(`# 生成效果评测报告（分批）`)
  lines.push('')
  lines.push(`> 生成日期：${now} | provider：\`${options.provider}\` | 模型：\`${options.model}\` | 端点：\`${options.baseUrl}\``)
  lines.push(`> 批次：${[...new Set(results.map((r) => r.batch))].join('、')} | 用例数：${results.length} | 评审：${options.judge ? '同模型自评审' : '关闭'}`)
  lines.push('')

  const batchLabel: Record<BatchName, string> = {
    dialogue: '对话生成',
    group: '群聊生成（点名/轮询/自由发言）',
    stream: '流式推理隔离',
    continue: '续写',
    directions: '下一步方向',
    imagine: '生图提示词',
    preset: '预设生成',
    memory: '长记忆摘要',
    verify: '修复验证（不调模型）',
  }

  for (const batch of ['dialogue', 'group', 'stream', 'continue', 'directions', 'imagine', 'preset', 'memory', 'verify'] as BatchName[]) {
    const rows = results.filter((r) => r.batch === batch)
    if (rows.length === 0) continue
    lines.push(`## ${batchLabel[batch]}（${rows.length} 例）`)
    lines.push('')
    lines.push('| 用例 | 结果 | 规模 | 评审 | 问题摘要 |')
    lines.push('|---|---|---|---|---|')
    for (const r of rows) {
      const scale = `${
        r.batch === 'dialogue' ? `${r.extra.visibleChars ?? 0} 字/${r.extra.paragraphs ?? 0} 段` :
        r.batch === 'group' ? `${r.extra.visibleChars ?? 0} 字 / ${String(r.extra.mode ?? '')}${r.extra.target ? `·${r.extra.target}` : ''}` :
        r.batch === 'stream' ? `${r.extra.deltaCount ?? 0} 片 chunk / ${r.extra.visibleChars ?? 0} 字` :
        r.batch === 'memory' ? `状态 ${(r.extra.currentState as string | undefined)?.length ?? 0} 字 / 时间线 ${r.extra.timelineLines ?? 0} 条 / 提案 ${r.extra.factProposals ?? 0} 条` :
        r.batch === 'continue' ? `${r.extra.visibleChars ?? 0} 字（目标 ${(r.extra.targetBand as number[] | undefined)?.join('–') ?? '-'}）` :
        r.batch === 'directions' ? `${r.attempts} 次调用` :
        r.batch === 'imagine' ? `${r.extra.promptChars ?? 0} 字符${(r.extra.attemptErrors as string[] | undefined)?.length ? `（调用失败：${String(r.extra.attemptErrors).slice(0, 60)}）` : ''}` :
        `${r.extra.systemPromptChars ?? 0} 字`
      }`
      const problem = [
        ...r.checks.filter((c) => c.level !== 'pass').map((c) => `${c.id}: ${c.detail}`),
        ...(r.judge?.parsed && r.judge.verdict !== 'pass' ? r.judge.issues : []),
        ...(r.error ? [r.error.slice(0, 160)] : []),
      ].join('；')
      lines.push(`| ${r.title} | ${statusOf(r)} | ${scale} | ${judgeCell(r)} | ${problem.replace(/\n/g, ' ').slice(0, 220) || '—'} |`)
    }
    lines.push('')
  }

  // 结构化统计
  const allChecks = results.flatMap((r) => r.checks)
  const fails = allChecks.filter((c) => c.level === 'fail')
  const warns = allChecks.filter((c) => c.level === 'warn')
  const judged = results.filter((r) => r.judge?.parsed)
  const judgeFail = judged.filter((r) => r.judge?.verdict !== 'pass')
  const retried = results.filter((r) => r.attempts > 1)
  const transport = results.flatMap((r) => r.transport)
  const judgeTransport = results.flatMap((r) => r.judgeTransport ?? [])
  const totalReasoning = transport.reduce((s, t) => s + t.reasoningTokens, 0)
  const totalCompletion = transport.reduce((s, t) => s + t.completionTokens, 0)
  const lengthCapped = transport.filter((t) => t.finishReason === 'length').length

  lines.push('## 汇总')
  lines.push('')
  lines.push(`- 结构化检查：${allChecks.length} 项，失败 ${fails.length}，警告 ${warns.length}`)
  lines.push(`- 内容评审：${judged.length} 例完成，未通过 ${judgeFail.length} 例${judged.length < results.length ? `（未评审 ${results.length - judged.length} 例）` : ''}`)
  lines.push(`- 生成调用：${transport.length} 次（含重试/修复；${retried.length} 例发生重发）；评审调用 ${judgeTransport.length} 次`)
  lines.push(`- 输出预算（生成调用）：completion ${totalCompletion} token，其中推理 ${totalReasoning} token（${totalCompletion ? ((totalReasoning / totalCompletion) * 100).toFixed(1) : '0'}%）；finish_reason=length 的调用 ${lengthCapped} 次（仅统计成功返回的调用，失败的尝试见 http-debug.jsonl）`)
  const judgeReasoning = judgeTransport.reduce((s, t) => s + t.reasoningTokens, 0)
  const judgeCompletion = judgeTransport.reduce((s, t) => s + t.completionTokens, 0)
  if (judgeCompletion > 0) {
    lines.push(`- 输出预算（评审调用）：completion ${judgeCompletion} token，其中推理 ${judgeReasoning} token（${((judgeReasoning / judgeCompletion) * 100).toFixed(1)}%）；因推理吃满预算而空响应的调用 ${judgeTransport.filter((t) => t.finishReason === 'length' && t.contentChars === 0).length} 次`)
  }
  // S10 专项统计：thought 质量与推理隔离
  const s10Ids = ['s10-thought-present', 's10-thought-first-person', 's10-thought-no-plan', 's10-thought-brief', 's10-no-vendor-reasoning', 's10-thought-closed', 's10-omniscient-third-person', 's10-stream-no-vendor-reasoning', 's10-pipeline-strip-noop', 's10-final-no-vendor-reasoning']
  const s10Checks = allChecks.filter((c) => s10Ids.includes(c.id))
  if (s10Checks.length > 0) {
    const s10Fails = s10Checks.filter((c) => c.level === 'fail')
    const s10Warns = s10Checks.filter((c) => c.level === 'warn')
    lines.push('')
    lines.push(`- S10（thought 质量与推理隔离）：${s10Checks.length} 项检查，失败 ${s10Fails.length}，警告 ${s10Warns.length}`)
    const grouped = new Map<string, { pass: number; fail: number; warn: number }>()
    for (const c of s10Checks) {
      const row = grouped.get(c.id) ?? { pass: 0, fail: 0, warn: 0 }
      if (c.level === 'pass') row.pass++
      else if (c.level === 'warn') row.warn++
      else row.fail++
      grouped.set(c.id, row)
    }
    for (const [id, row] of grouped) {
      lines.push(`  - ${id}：通过 ${row.pass}，警告 ${row.warn}，失败 ${row.fail}`)
    }
    const thoughtCases = results.filter((r) => r.checks.some((c) => c.id.startsWith('s10-thought')))
    const noThought = thoughtCases.filter((r) => r.checks.some((c) => c.id === 's10-thought-present' && c.level === 'fail'))
    lines.push(`  - 覆盖 ${thoughtCases.length} 例；未输出 <thought> 的回合 ${noThought.length} 例（强契约：缺失即失败）`)
  }
  if (fails.length > 0) {
    lines.push('')
    lines.push('### 失败明细')
    lines.push('')
    for (const r of results) {
      const bad = r.checks.filter((c) => c.level === 'fail')
      if (bad.length === 0 && !r.error) continue
      lines.push(`- **${r.batch}/${r.title}**`)
      for (const b of bad) lines.push(`  - [fail] ${b.id}：${b.detail}`)
      if (r.error) lines.push(`  - [error] ${r.error.slice(0, 300)}`)
    }
  }
  lines.push('')
  lines.push('## 原始输出索引')
  lines.push('')
  lines.push('- `results.json`：全部用例的提示词、原始响应、检查与评审')
  lines.push('- `http-debug.jsonl`：每次 HTTP 请求/响应原文（含 usage 与 finish_reason）')
  return lines.join('\n')
}

// ===================== 主流程 =====================

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  mkdirSync(options.outDir, { recursive: true })
  outDirForDebug = options.outDir

  // --report-only：不调用模型，直接用已有 results-*.json 重出报告
  if (options.reportOnly) {
    const files = (['dialogue', 'group', 'stream', 'continue', 'directions', 'imagine', 'preset', 'memory', 'verify'] as BatchName[])
      .map((b) => join(options.outDir, `results-${b}.json`))
      .filter((f) => existsSync(f))
    const merged = files.flatMap((f) => JSON.parse(readFileSync(f, 'utf-8')) as CaseResult[])
    writeFileSync(join(options.outDir, 'results.json'), JSON.stringify(merged, null, 2), 'utf-8')
    writeFileSync(join(options.outDir, 'report.md'), renderReport(options, merged), 'utf-8')
    console.log(`报告已重生成：${join(options.outDir, 'report.md')}（${merged.length} 例）`)
    return
  }

  installHttpDebug()

  const callModel = createModelCaller(options)
  const results: CaseResult[] = []

  // --only 过滤按基础用例 id 匹配：重复采样生成的 -rN 后缀用例同时生效
  const want = (batch: BatchName, id: string) =>
    options.batches.includes(batch)
    && (options.only.length === 0
      || options.only.includes(id)
      || options.only.some((only) => id.startsWith(`${only}-r`)))

  /** --reps N：同一用例重复采样 N 次（第 2 次起 id 加 -rN 后缀），供概率型指标（G1）取样 */
  const expandReps = <T extends { id: string; title: string }>(cases: T[], reps: number): T[] =>
    reps > 1
      ? Array.from({ length: reps }, (_, i) =>
          cases.map((c) => (i === 0 ? c : { ...c, id: `${c.id}-r${i + 1}`, title: `${c.title}（第 ${i + 1} 次采样）` }))).flat()
      : cases

  const runBatch = async <T extends { id: string; title: string }>(
    batch: BatchName,
    cases: T[],
    runner: (testCase: T) => Promise<CaseResult>,
  ) => {
    const selected = cases.filter((c) => want(batch, c.id))
    const batchPath = join(options.outDir, `results-${batch}.json`)
    /** 按用例键合并写盘：--only 重跑不会丢掉同批次已完成的其它用例 */
    const persistBatch = (rows: CaseResult[]) => {
      let mergedRows = rows
      if (existsSync(batchPath)) {
        try {
          const existing = JSON.parse(readFileSync(batchPath, 'utf-8')) as CaseResult[]
          const keyed = new Map(existing.map((r) => [r.id, r]))
          for (const r of rows) keyed.set(r.id, r)
          mergedRows = Array.from(keyed.values())
        } catch { /* 忽略损坏文件 */ }
      }
      writeFileSync(batchPath, JSON.stringify(mergedRows, null, 2), 'utf-8')
    }
    if (options.judgeOnly) {
      if (!existsSync(batchPath)) throw new Error(`--judge-only 需要已存在的 ${batchPath}`)
      const existing = JSON.parse(readFileSync(batchPath, 'utf-8')) as CaseResult[]
      for (const r of existing) {
        if (r.batch === batch && (options.only.length === 0 || options.only.includes(r.id))) results.push(r)
      }
    } else {
      // G1 扩样（2026-09-13）：--concurrency N 真实并发（此前只解析不使用，几百次取样要跑数小时）。
      // 并发下写盘经串行化链，避免 read-modify-write 相互覆盖；
      // 延迟类指标（P50/P95）请用 --concurrency 1，并发会引入排队噪声。
      let persistChain: Promise<void> = Promise.resolve()
      const persistSerialized = (rows: CaseResult[]): Promise<void> => {
        persistChain = persistChain.then(() => persistBatch(rows)).catch(() => { /* 忽略单次写盘失败 */ })
        return persistChain
      }
      const workers = Math.max(1, Math.min(Math.floor(options.concurrency) || 1, selected.length))
      if (workers <= 1) {
        for (const testCase of selected) {
          process.stdout.write(`[${batch}] ${testCase.id} ... `)
          const result = await runner(testCase)
          process.stdout.write(`${statusOf(result)}\n`)
          results.push(result)
          // 每例落盘一次，支持中断后查看已完成部分
          persistBatch(results.filter((r) => r.batch === batch))
        }
      } else {
        process.stdout.write(`[${batch}] 并发 ${workers}，共 ${selected.length} 例\n`)
        const queue = [...selected]
        let done = 0
        await Promise.all(Array.from({ length: workers }, async () => {
          for (;;) {
            const testCase = queue.shift()
            if (!testCase) return
            let result: CaseResult
            try {
              result = await runner(testCase)
            } catch (err) {
              // 单例异常不拖垮整批（扩样期间的网络抖动很常见）
              result = {
                batch, id: testCase.id, title: testCase.title,
                systemPrompt: '', userPrompt: '', raw: '', final: '', attempts: 0,
                extra: {}, checks: [], transport: [], durationMs: 0,
                error: err instanceof Error ? err.message : String(err),
              }
            }
            results.push(result)
            done += 1
            process.stdout.write(`[${batch}] (${done}/${selected.length}) ${testCase.id} ... ${statusOf(result)}\n`)
            await persistSerialized(results.filter((r) => r.batch === batch))
          }
        }))
        await persistChain
      }
    }
    if (options.judge) {
      for (const result of results.filter((r) => r.batch === batch)) {
        if (!want(batch, result.id)) continue
        if (result.error) continue
        process.stdout.write(`[judge] ${result.id} ... `)
        try {
          result.judge = await judgeCase(options, callModel, result)
          if (result.judge.raw === '__SKIP__') {
            delete result.judge
            process.stdout.write('skip\n')
            continue
          }
          process.stdout.write(result.judge.parsed ? `${result.judge.verdict ?? '?'}\n` : 'parse-fail\n')
        } catch (err) {
          result.judge = { parsed: false, issues: [err instanceof Error ? err.message : String(err)], raw: '' }
          process.stdout.write('error\n')
        }
        persistBatch(results.filter((r) => r.batch === batch))
      }
    }
  }

  if (options.batches.includes('dialogue')) {
    // --reps N：同一用例重复采样 N 次（稳定性/方差观察），第 2 次起 id 加 -rN 后缀
    await runBatch('dialogue', expandReps(dialogueCases(), options.reps), (c) => runDialogueCase(options, callModel, c))
  }
  if (options.batches.includes('group')) {
    await runBatch('group', expandReps(groupCases(), options.reps), (c) => runGroupCase(options, callModel, c))
  }
  if (options.batches.includes('stream')) {
    // 阶段8 G1：提前中止/推理挤占是概率事件，流式批次同样需要重复采样
    await runBatch('stream', expandReps(streamCases(), options.reps), (c) => runStreamCase(options, c))
  }
  if (options.batches.includes('continue')) {
    await runBatch('continue', continueCases(), (c) => runContinueCase(options, callModel, c))
  }
  if (options.batches.includes('directions')) {
    // 阶段8 G1：方向任务需要"最多 2 次物理调用"与空正文率的重复采样
    await runBatch('directions', expandReps(directionCases(), options.reps), (c) => runDirectionCase(options, callModel, c))
  }
  if (options.batches.includes('imagine')) {
    await runBatch('imagine', imagineCases(), (c) => runImagineCase(options, callModel, c))
  }
  if (options.batches.includes('preset')) {
    await runBatch('preset', presetCases(), (c) => runPresetCase(options, callModel, c))
  }
  if (options.batches.includes('memory')) {
    await runBatch('memory', memoryCases(), (c) => runMemoryCase(options, callModel, c))
  }
  if (options.batches.includes('verify')) {
    await runBatch('verify', verifyCases(), (c) => runVerifyCase(options, c))
  }

  // 合并历史结果（分批累积）
  let merged = results
  const allPath = join(options.outDir, 'results.json')
  if (options.append && existsSync(allPath)) {
    try {
      const existing = JSON.parse(readFileSync(allPath, 'utf-8')) as CaseResult[]
      const keyed = new Map(existing.map((r) => [`${r.batch}|${r.id}`, r]))
      for (const r of results) keyed.set(`${r.batch}|${r.id}`, r)
      merged = Array.from(keyed.values())
    } catch { /* 忽略损坏的历史文件 */ }
  }
  writeFileSync(allPath, JSON.stringify(merged, null, 2), 'utf-8')
  writeFileSync(join(options.outDir, 'report.md'), renderReport(options, merged), 'utf-8')
  console.log(`\n完成：${results.length} 例；结果写入 ${allPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
