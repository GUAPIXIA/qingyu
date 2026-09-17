/**
 * /imagine 提示词生成评测器
 *
 * 覆盖「画面重点」（5 种 GenMode）× 「我方入镜」（4 种 SelfMode）的全部可运行组合，
 * 测量的是**提示词生成链路**，不生成图片：
 *
 *   imagineCommand.execute(args, ctx)
 *     → buildSystemPrompt(mode, selfMode)        真实系统提示词
 *     → ctx.callAiHelper(...)                    真实对话模型调用（OpenAI 兼容端点）
 *     → parseImagePromptResult(raw, style)       真实解析/重试判定
 *     → finalizeImagePrompt(...)                 真实占位符→固定构图片段替换
 *     → window.api.imageGen.generate(finalPrompt) 被替换为捕获函数（不生图）
 *
 * 组合说明：`--mode background --self <非 hidden>` 在命令内被强制归一为 hidden
 * （imagine.ts 的 parseOptions），因此 UI 可达组合为 4×4 + 1 = 17 个；脚本另做
 * 3 个“强制归一”契约检查（不调用模型）。
 *
 * 用法：
 *   IMAGINE_EVAL_API_KEY=sk-xxx npx tsx scripts/evaluate-imagine-prompts.ts \
 *     --base-url https://api.example.com/v1 --model gpt-4o-mini \
 *     --style both --reps 1 --judge on --out ./tmp/imagine-eval
 *
 * 也可用 --key-file <path> 从文件读取密钥（避免密钥进入 shell 历史）。
 * 退出码：0 = 全部组合通过；1 = 存在结构化校验失败；2 = 运行错误（如鉴权失败）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openaiAdapter } from '../electron/services/adapters/openai'
import { isRetryableError } from '../electron/services/adapters/types'
import type { ChatParams, Character } from '../shared/types'

// ===================== 类型 =====================

type GenMode = 'moment' | 'closeup' | 'full' | 'interaction' | 'background'
type SelfMode = 'hidden' | 'silhouette' | 'translucent' | 'pov'
type Style = 'natural' | 'tags'
type Level = 'pass' | 'warn' | 'fail'

interface Check {
  id: string
  level: Level
  detail: string
}

interface Attempt {
  index: number
  temperature: number
  maxTokens: number
  systemPrompt: string
  userContent: string
  raw: string
  error?: string
  durationMs: number
}

interface JudgeVerdict {
  parsed: boolean
  raw: string
  singleSubject?: boolean
  selfRule?: string
  framing?: string
  sceneFidelity?: string
  checklist?: Record<string, boolean>
  noMeta?: boolean
  verdict?: string
  issues?: string[]
}

interface RunResult {
  style: Style
  mode: GenMode
  selfMode: SelfMode
  rep: number
  args: string[]
  attempts: Attempt[]
  finalPrompt: string
  generateOptions: unknown
  notifications: string[]
  error?: string
  durationMs: number
  checks: Check[]
  judge?: JudgeVerdict
}

interface CliOptions {
  baseUrl: string
  model: string
  /** 评审模型；默认与生成模型相同，可用 --judge-model 指定更强的独立评委 */
  judgeModel: string
  apiKey: string
  styles: Style[]
  reps: number
  concurrency: number
  judge: boolean
  outDir: string
  only: string[]
  /** 追加到已有 outDir 的 results.json（分批跑用），而不是新建文件 */
  append: boolean
  /** 丢弃已有评审结论并重新评审（评审设置变更后使用） */
  rejudge: boolean
  /** 只补评审、不重新生成（用于补齐解析失败或缺失的评审） */
  judgeOnly: boolean
}

// ===================== 固定测试夹具 =====================

/**
 * 全部组合共用同一段对话结尾，保证唯一变量是「画面重点 × 我方入镜」。
 * 场景事实（雨夜阳台、湿透黑风衣、右手攥栏杆、拨湿发、看向台灯）供评审核对。
 */
const FIXTURE_CHARACTER: Character = {
  id: 'eval-char',
  name: '苏晚',
  avatar: '',
  description: '28 岁女性，鹅蛋脸，黑色长发及腰，深褐色眼睛，身形清瘦高挑，左眉尾有一道浅疤。',
  personality: '外冷内热，说话简短，遇事习惯先观察再动手。',
  scenario: '雨夜的旧公寓阳台。',
  firstMessage: '',
  exampleDialog: '',
  tags: [],
  lorebookId: null,
  creator: 'eval',
  createdAt: 0,
  updatedAt: 0,
  alternateGreetings: [],
}

const FIXTURE_USER = {
  name: '大本',
  /** 刻意写入外貌，验证系统提示词不会把它交给模型（避免我方被画成第二个人） */
  description: '短寸头，常穿灰色连帽卫衣。',
  persona: '直接、少废话。',
}

const FIXTURE_MESSAGES = [
  { role: 'user' as const, content: '外面雨太大了，先把窗关上吧。', name: FIXTURE_USER.name },
  { role: 'assistant' as const, content: '苏晚没有回头，右手还攥着栏杆，指节发白。', name: FIXTURE_CHARACTER.name },
  { role: 'user' as const, content: '你的外套全湿了。', name: FIXTURE_USER.name },
  { role: 'assistant' as const, content: '“我知道。”她这才松开栏杆转过身，湿透的黑色风衣下摆滴着水，左手把贴在脸侧的湿发拨到耳后，目光越过我看向桌上那盏台灯。', name: FIXTURE_CHARACTER.name },
]

const SCENE_FACTS = [
  '雨夜、雨声、旧公寓阳台',
  '湿透的黑色风衣、下摆滴水',
  '右手先攥栏杆后松开、左手把湿发拨到耳后',
  '转身动作、目光越过镜头方向看向桌上的台灯',
  '情绪克制、外冷内热',
]

// ===================== 矩阵定义与期望 =====================

const MODES: Array<{ value: GenMode; label: string; intent: string; subjectFragment: string }> = [
  { value: 'moment', label: '剧情瞬间', intent: '定格最新对话结尾正在发生的具体一刻', subjectFragment: '定格最新对话结尾正在发生的具体一刻' },
  { value: 'closeup', label: '对方近景', intent: '脸部、眼神、细微表情、上半身姿态与手部动作为重点', subjectFragment: '以脸部、眼神、细微表情、上半身姿态和手部动作为重点' },
  { value: 'full', label: '对方全身', intent: '完整呈现从头到脚的服装、重心、四肢姿势与动作', subjectFragment: '完整呈现从头到脚的服装' },
  { value: 'interaction', label: '互动构图', intent: '对方与镜头外/弱化的我方互动，对方仍是唯一清晰主体', subjectFragment: '表现对方正在与镜头外或弱化的我方互动' },
  { value: 'background', label: '环境空镜', intent: '只描绘地点、时间、天气、光线、物件与氛围，不出现任何人物', subjectFragment: '只描绘地点、时间、天气、光线、物件痕迹和氛围' },
]

const SELF_MODES: Array<{
  value: SelfMode
  label: string
  intent: string
  ruleFragment: string
  placeholderRequired: boolean
  guard: Record<Style, string>
}> = [
  {
    value: 'hidden',
    label: '不出现',
    intent: '我方完全不出现，对方是唯一清晰主体',
    ruleFragment: '我方角色完全不出现在画面中',
    placeholderRequired: false,
    guard: { natural: '', tags: '' },
  },
  {
    value: 'silhouette',
    label: '仅轮廓',
    intent: '仅允许极前景、虚焦、无特征的深色肩部边缘切割形状',
    ruleFragment: '安全的近镜头肩部边缘构图',
    placeholderRequired: true,
    guard: { natural: 'a cropped featureless dark shoulder-edge shape', tags: 'over-the-shoulder composition' },
  },
  {
    value: 'translucent',
    label: '半透明',
    intent: '仅允许极边缘、极淡的半透明轮廓线，无头脸/解剖/衣物细节',
    ruleFragment: '受控的半透明边缘线条',
    placeholderRequired: true,
    guard: { natural: 'a faint translucent contour line', tags: 'faint translucent edge contour' },
  },
  {
    value: 'pov',
    label: '第一人称',
    intent: '第一人称视角，不出现我方脸与身体，最多在底边出现一小块手掌',
    ruleFragment: '受控的第一人称镜头约束',
    placeholderRequired: true,
    guard: { natural: 'a strict first-person camera viewpoint', tags: 'first-person viewpoint' },
  },
]

const BACKGROUND_RULE_FRAGMENT = '环境空镜中不允许出现任何人物、肢体、倒影或人形轮廓'

/** 占位符（与 imagine.ts 保持一致，作为断言常量而非业务逻辑） */
const PLACEHOLDER = '{{SELF_COMPOSITION}}'

/** 尺寸期望：comfyui 由工作流决定（undefined）；sd-webui 竖版近景/全身、横版空镜 */
function expectedSize(style: Style, mode: GenMode): string | undefined {
  if (style === 'natural') return undefined
  if (mode === 'closeup' || mode === 'full') return '512x768'
  if (mode === 'background') return '768x512'
  return undefined
}

function buildCombos(options: CliOptions): Array<{ mode: GenMode; selfMode: SelfMode }> {
  const combos: Array<{ mode: GenMode; selfMode: SelfMode }> = []
  for (const mode of MODES) {
    for (const self of SELF_MODES) {
      if (mode.value === 'background' && self.value !== 'hidden') continue // UI 不可达：命令内强制归一
      if (options.only.length > 0 && !options.only.includes(`${mode.value}:${self.value}`)) continue
      combos.push({ mode: mode.value, selfMode: self.value })
    }
  }
  return combos
}

// ===================== 模型调用 =====================

/** 调试用：把每次请求的 URL、请求体与响应体原样落到 jsonl，便于定位“空内容”类问题。 */
function installHttpDebug(outDir: string): void {
  const logPath = join(outDir, 'http-debug.jsonl')
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init)
    const clone = response.clone()
    let body = ''
    try { body = await clone.text() } catch { /* 忽略 */ }
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    writeFileSync(logPath, `${JSON.stringify({ url, request: init?.body ?? null, status: response.status, response: body })}\n`, { flag: 'a' })
    return response
  }) as typeof fetch
}

/** 上游偶发返回空内容（推理吃满预算 / 聚合端点忽略 thinking 参数）时的重试判据。 */
function isEmptyResponseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /未返回任何内容|content_filter/.test(message)
}

function createModelCaller(options: CliOptions, model = options.model) {
  return async function callModel(input: {
    systemPrompt: string
    userContent: string
    temperature: number
    maxTokens: number
    label: string
  }): Promise<string> {
    const params: ChatParams = {
      requestId: `imagine-eval-${input.label}`,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userContent },
      ],
      provider: 'openai',
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      model,
      temperature: input.temperature,
      topP: 0.9,
      maxTokens: input.maxTokens,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: false,
      reasoningGate: { level: 'off', knob: 'none', tokens: 2048 },
    }

    let lastError: unknown
    for (let attempt = 0; attempt < 5; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('timeout')), 5 * 60 * 1000)
      try {
        return await openaiAdapter.chat(params, () => {}, controller.signal)
      } catch (err) {
        lastError = err
        // 空内容属于上游抖动而非提示词链路问题：重试并单独计数，避免污染评测结论
        if (isEmptyResponseError(err)) {
          transportRetries += 1
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
          continue
        }
        if (!isRetryableError(err)) throw err
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError
  }
}

/** 上游空响应重试计数（仅在报告中呈现，不代表提示词链路问题） */
let transportRetries = 0

// ===================== 单次运行 =====================

interface CapturedGenerate {
  prompt: string
  options: unknown
}

async function runOnce(
  options: CliOptions,
  callModel: ReturnType<typeof createModelCaller>,
  style: Style,
  mode: GenMode,
  selfMode: SelfMode,
  rep: number,
): Promise<RunResult> {
  const attempts: Attempt[] = []
  const notifications: string[] = []
  const captured: CapturedGenerate[] = []

  // 只替换生图调用：命令自身的解析、重试、占位符替换全部走真实实现
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

  const imageGenConfig = style === 'natural'
    ? { name: 'comfyui', provider: 'comfyui' as const, model: '', apiKey: '', baseUrl: 'http://127.0.0.1:8188', size: '1080x1920', quality: 'standard', workflowName: 'image_z_image_turbo', workflow: '{"57:28":{"class_type":"UNETLoader"}}' }
    : { name: 'SD', provider: 'sd-webui' as const, model: 'anime', apiKey: '', baseUrl: 'http://127.0.0.1:7860', size: '512x512', quality: 'standard', workflowName: undefined, workflow: undefined }

  const ctx = {
    character: FIXTURE_CHARACTER,
    addImageMessage: async () => {},
    notify: (message: string) => { notifications.push(message) },
    callAiHelper: async (
      systemPrompt: string,
      userContent: string,
      aiOptions?: { temperature?: number; maxTokens?: number },
    ) => {
      const started = Date.now()
      const record: Attempt = {
        index: attempts.length,
        temperature: aiOptions?.temperature ?? 0.5,
        maxTokens: aiOptions?.maxTokens ?? 900,
        systemPrompt,
        userContent,
        raw: '',
        durationMs: 0,
      }
      attempts.push(record)
      try {
        record.raw = await callModel({
          systemPrompt,
          userContent,
          temperature: record.temperature,
          maxTokens: record.maxTokens,
          label: `${style}-${mode}-${selfMode}-r${rep}-a${record.index}`,
        })
      } catch (err) {
        record.error = err instanceof Error ? err.message : String(err)
        throw err
      } finally {
        record.durationMs = Date.now() - started
      }
      return record.raw
    },
    getRecentMessages: () => FIXTURE_MESSAGES,
    getActiveImageGen: () => imageGenConfig,
    beginImageGeneration: () => 'eval-job',
    updateImageGeneration: () => {},
    finishImageGeneration: () => {},
    userName: FIXTURE_USER.name,
    userProfile: FIXTURE_USER,
  }

  const args = ['--mode', mode, '--self', selfMode]
  const started = Date.now()
  let error: string | undefined
  try {
    const { imagineCommand } = await import('../src/commands/builtin/imagine')
    await imagineCommand.execute(args, ctx as never)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const durationMs = Date.now() - started

  const result: RunResult = {
    style,
    mode,
    selfMode,
    rep,
    args,
    attempts,
    finalPrompt: captured[0]?.prompt ?? '',
    generateOptions: captured[0]?.options,
    notifications,
    error,
    durationMs,
    checks: [],
  }
  result.checks = runChecks(result)
  return result
}

// ===================== 结构化校验 =====================

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  return haystack.split(needle).length - 1
}

function runChecks(run: RunResult): Check[] {
  const checks: Check[] = []
  const modeDef = MODES.find((m) => m.value === run.mode)!
  const selfDef = SELF_MODES.find((s) => s.value === run.selfMode)!
  const first = run.attempts[0]
  const systemPrompt = first?.systemPrompt ?? ''
  const finalPrompt = run.finalPrompt
  const background = run.mode === 'background'
  const add = (id: string, level: Level, detail: string) => checks.push({ id, level, detail })

  // 1. 系统提示词：画面目标与入镜规则是否按组合正确装配
  add(
    'system-prompt-subject',
    systemPrompt.includes(modeDef.subjectFragment) ? 'pass' : 'fail',
    `画面目标片段: ${modeDef.subjectFragment}`,
  )
  const selfRuleFragment = background ? BACKGROUND_RULE_FRAGMENT : selfDef.ruleFragment
  add(
    'system-prompt-self-rule',
    systemPrompt.includes(selfRuleFragment) ? 'pass' : 'fail',
    `入镜规则片段(${run.selfMode}): ${selfRuleFragment}`,
  )

  // 2. 占位符只在需要时下发，且要求“只能出现一次”
  const placeholderInSystem = countOccurrences(systemPrompt, PLACEHOLDER)
  if (background || run.selfMode === 'hidden') {
    add(
      'system-prompt-placeholder',
      placeholderInSystem === 0 ? 'pass' : 'fail',
      `隐藏我方时系统提示词不应含占位符，实际 ${placeholderInSystem} 次`,
    )
  } else {
    add(
      'system-prompt-placeholder',
      placeholderInSystem === 1 && systemPrompt.includes('只能出现一次') ? 'pass' : 'fail',
      `占位符 ${placeholderInSystem} 次，且${systemPrompt.includes('只能出现一次') ? '有' : '缺少'}“只能出现一次”约束`,
    )
  }

  // 3. 我方外貌资料不得进入系统提示词
  add(
    'user-appearance-not-leaked',
    !systemPrompt.includes(FIXTURE_USER.description) && systemPrompt.includes('除姓名外不提供外貌资料')
      ? 'pass' : 'fail',
    '系统提示词只提供我方姓名，不含外貌描述',
  )

  // 4. 生成结果
  const placeholderInFinal = countOccurrences(finalPrompt, PLACEHOLDER)
  add(
    'prompt-produced',
    finalPrompt ? 'pass' : 'fail',
    finalPrompt ? `最终提示词 ${finalPrompt.length} 字符` : `未产出提示词（通知: ${run.notifications.join(' | ') || '无'}）`,
  )
  add('placeholder-resolved', placeholderInFinal === 0 ? 'pass' : 'fail', `最终提示词残留占位符 ${placeholderInFinal} 次`)
  add(
    'attempts',
    run.attempts.length <= 2 ? 'pass' : 'fail',
    `模型调用 ${run.attempts.length} 次${run.attempts.length > 1 ? '（首次结果被拒后重写）' : ''}`,
  )

  // 5. 入镜片段是否按预期注入
  if (background || run.selfMode === 'hidden') {
    const leaked = SELF_MODES.filter((s) => s.guard[run.style]).filter((s) => finalPrompt.includes(s.guard[run.style]))
    add('guard-applied', leaked.length === 0 && !!finalPrompt ? 'pass' : (finalPrompt ? 'fail' : 'warn'),
      leaked.length === 0 ? '未注入任何我方构图片段' : `不应出现却出现: ${leaked.map((s) => s.value).join(',')}`)
  } else {
    const sig = selfDef.guard[run.style]
    const occurrences = countOccurrences(finalPrompt, sig)
    add('guard-applied', occurrences === 1 ? 'pass' : 'fail', `固定构图片段出现 ${occurrences} 次: ${sig}`)
  }

  // 6. 输出协议（与 resolvePromptStyle 对应的风格）
  if (finalPrompt) {
    if (run.style === 'natural') {
      const words = finalPrompt.match(/[A-Za-z][A-Za-z'-]*/g)?.length ?? 0
      add('style-protocol', words >= 60 && words <= 220 ? 'pass' : 'warn',
        `自然语言风格，英文词数 ${words}（要求 90–180）`)
      add('no-tag-vocabulary', /best quality|masterpiece|highres/i.test(finalPrompt) ? 'fail' : 'pass',
        '自然语言风格不应出现绘画标签词')
    } else {
      const parts = finalPrompt.split(',').filter((part) => part.trim()).length
      add('style-protocol', /^best quality,\s*masterpiece,\s*highres/i.test(finalPrompt) && parts >= 10 ? 'pass' : 'fail',
        `标签风格，逗号项 ${parts}，前缀${/^best quality,\s*masterpiece,\s*highres/i.test(finalPrompt) ? '正确' : '缺失'}`)
    }
    add('no-cjk', /[\u3400-\u9fff]/.test(finalPrompt) ? 'fail' : 'pass', '提示词应为英文，不含中文字符')
    add('no-tag-literals', /<\s*\/?\s*(prompt|thought)\b/i.test(finalPrompt) ? 'fail' : 'pass', '不应残留 XML 标签字面量')
    add('no-names', finalPrompt.includes(FIXTURE_CHARACTER.name) || finalPrompt.includes(FIXTURE_USER.name) ? 'fail' : 'pass',
      '不应出现角色/用户名代替外貌描述')
  }

  // 7. 尺寸映射（近景/全身竖版、空镜横版；ComfyUI 交给工作流）
  const expected = expectedSize(run.style, run.mode)
  const actual = (run.generateOptions as { size?: string } | undefined)?.size
  add('size-mapping', actual === expected ? 'pass' : 'fail', `期望 ${String(expected)}，实际 ${String(actual)}`)

  return checks
}

// ===================== 内容评审（同一模型离线复核） =====================

const JUDGE_SYSTEM = `你是严格的图像提示词合规评审员。用户会给你一段 JSON，其中包含：画面重点(mode)及其意图、我方入镜(self_mode)及其规则、固定注入的我方构图片段(guard，若存在)、场景事实(scene_facts)、角色稳定外貌(character_appearance)与待评审的英文提示词(prompt)。

评审要点：
1. single_subject：对方角色是否为唯一清晰主体；除 guard 描述的受限前景元素外，不得出现第二个完整人物、第二张脸、我方肢体或倒影。
2. self_rule：是否遵守我方入镜规则。hidden 时画面中不得有任何我方痕迹；silhouette/translucent/pov 只允许 guard 所描述的受限元素，不得被扩写成 seated figure、半透明人体、第二人物等。guard 由程序固定注入，其措辞本身合规，不要因为 guard 的存在而扣分，只需检查 guard 之外是否还有违规内容。
3. framing：是否符合画面重点。closeup 应为近景/半身；full 应完整呈现全身；interaction 应体现与画外/弱化我方的互动且对方仍占主要画面；background 必须完全没有人物、肢体、倒影或人形轮廓；moment 应定格最新对话结尾的具体一刻。
4. scene_fidelity：是否体现场景事实中的关键要素（至少 3 项，且不得与最新对话矛盾）。
5. checklist：逐项判断是否覆盖 character_appearance（稳定外貌）、expression（神态/视线）、pose（姿势/重心）、hands（双手动作）、clothing（具体衣物与状态）、composition_light（构图/景深/光源/色温）六项。
6. no_meta：是否纯英文提示词，无角色姓名、无中文、无解释性文字、无标题或标签字面量。

只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：
{"single_subject":true,"self_rule":"pass","framing":"pass","scene_fidelity":"pass","checklist":{"appearance":true,"expression":true,"pose":true,"hands":true,"clothing":true,"composition_light":true},"no_meta":true,"verdict":"pass","issues":["..."]}
其中 self_rule/framing/scene_fidelity 取 "pass" 或 "fail"；verdict 在所有项通过时为 "pass"，否则为 "fail"；issues 用中文列出具体问题，无问题则为空数组。`

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

async function judgeRun(
  options: CliOptions,
  callModel: ReturnType<typeof createModelCaller>,
  run: RunResult,
): Promise<JudgeVerdict> {
  const modeDef = MODES.find((m) => m.value === run.mode)!
  const selfDef = SELF_MODES.find((s) => s.value === run.selfMode)!
  const payload = {
    mode: `${run.mode} (${modeDef.label})`,
    mode_intent: modeDef.intent,
    self_mode: `${run.selfMode} (${selfDef.label})`,
    self_rule: run.mode === 'background' ? BACKGROUND_RULE_FRAGMENT : selfDef.intent,
    guard: run.mode === 'background' || run.selfMode === 'hidden' ? null : selfDef.guard[run.style],
    scene_facts: SCENE_FACTS,
    character_appearance: FIXTURE_CHARACTER.description,
    prompt: run.finalPrompt,
  }

  // 评审是结构化长输出，被截断/空响应都只是传输问题：重试而不是记为解析失败。
  // maxTokens 逐次上调：聚合端点可能忽略 thinking:disabled，推理会吃满预算导致空内容。
  let raw = ''
  let parsed: Record<string, unknown> | null = null
  for (let attempt = 0; attempt < 4 && !parsed; attempt++) {
    raw = await callModel({
      systemPrompt: JUDGE_SYSTEM,
      userContent: JSON.stringify(payload, null, 2),
      temperature: 0,
      maxTokens: 2000 * (attempt + 1),
      label: `judge-${run.style}-${run.mode}-${run.selfMode}-a${attempt}`,
    })
    parsed = extractJson(raw)
  }
  const verdict: JudgeVerdict = {
    parsed: !!parsed,
    raw: parsed ? '' : raw.slice(0, 800),
    singleSubject: typeof parsed?.single_subject === 'boolean' ? parsed.single_subject : undefined,
    selfRule: typeof parsed?.self_rule === 'string' ? parsed.self_rule : undefined,
    framing: typeof parsed?.framing === 'string' ? parsed.framing : undefined,
    sceneFidelity: typeof parsed?.scene_fidelity === 'string' ? parsed.scene_fidelity : undefined,
    checklist: parsed?.checklist && typeof parsed.checklist === 'object' ? parsed.checklist as Record<string, boolean> : undefined,
    noMeta: typeof parsed?.no_meta === 'boolean' ? parsed.no_meta : undefined,
    verdict: typeof parsed?.verdict === 'string' ? parsed.verdict : undefined,
    issues: Array.isArray(parsed?.issues) ? parsed.issues.map(String) : undefined,
  }
  return verdict
}

// ===================== 契约检查（不调用模型） =====================

interface ContractCheck {
  name: string
  pass: boolean
  detail: string
}

/**
 * background 与任何非 hidden 组合都会在命令内被归一为 hidden：
 * 用桩函数捕获系统提示词即可验证，无需真实模型调用。
 */
async function contractChecks(): Promise<ContractCheck[]> {
  const results: ContractCheck[] = []
  const { imagineCommand } = await import('../src/commands/builtin/imagine')
  const captured: string[] = []
  const baseCtx = {
    character: FIXTURE_CHARACTER,
    addImageMessage: async () => {},
    notify: () => {},
    callAiHelper: async (systemPrompt: string) => {
      captured.push(systemPrompt)
      return '' // 直接判定失败，避免任何模型调用
    },
    getRecentMessages: () => FIXTURE_MESSAGES,
    getActiveImageGen: () => ({ name: 'comfyui', provider: 'comfyui' as const, model: '', apiKey: '', baseUrl: '', workflowName: 'image_z_image_turbo', workflow: '{}' }),
    beginImageGeneration: () => 'eval-job',
    updateImageGeneration: () => {},
    finishImageGeneration: () => {},
    userName: FIXTURE_USER.name,
    userProfile: FIXTURE_USER,
  }

  for (const self of SELF_MODES) {
    captured.length = 0
    await imagineCommand.execute(['--mode', 'background', '--self', self.value], baseCtx as never)
    const prompt = captured[0] ?? ''
    const ok = prompt.includes(BACKGROUND_RULE_FRAGMENT) && !prompt.includes(PLACEHOLDER)
    results.push({
      name: `background+${self.value} 归一为 hidden`,
      pass: ok,
      detail: ok ? '系统提示词使用空镜规则且不注入占位符' : '未按空镜规则装配',
    })
  }

  // 非法/缺省参数回退
  captured.length = 0
  await imagineCommand.execute(['--mode', 'invalid', '--self', 'nonsense'], baseCtx as never)
  const fallback = captured[0] ?? ''
  results.push({
    name: '非法参数回退默认组合',
    pass: fallback.includes(MODES[0].subjectFragment) && fallback.includes(SELF_MODES[0].ruleFragment),
    detail: '非法 mode/self 回退为 moment + hidden',
  })

  return results
}

// ===================== 主流程 =====================

function parseArgs(argv: string[]): CliOptions {
  const get = (name: string, fallback?: string) => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
  }
  const keyFile = get('key-file')
  const apiKey = process.env.IMAGINE_EVAL_API_KEY
    || (keyFile && existsSync(keyFile) ? readFileSync(keyFile, 'utf-8').trim() : '')
  if (!apiKey) {
    throw new Error('缺少密钥：请设置 IMAGINE_EVAL_API_KEY 或使用 --key-file <path>')
  }
  const styleArg = get('style', 'both')
  const styles: Style[] = styleArg === 'both' ? ['natural', 'tags'] : [styleArg as Style]
  if (styles.some((s) => s !== 'natural' && s !== 'tags')) throw new Error(`未知 --style: ${styleArg}`)

  return {
    baseUrl: get('base-url', process.env.IMAGINE_EVAL_BASE_URL || 'https://api.openai.com/v1')!,
    model: get('model', process.env.IMAGINE_EVAL_MODEL || 'gpt-4o-mini')!,
    judgeModel: get('judge-model', process.env.IMAGINE_EVAL_JUDGE_MODEL || get('model', process.env.IMAGINE_EVAL_MODEL || 'gpt-4o-mini'))!,
    apiKey,
    styles,
    reps: Number(get('reps', '1')),
    concurrency: Number(get('concurrency', '2')),
    judge: (get('judge', 'on') || 'on') !== 'off',
    outDir: resolve(get('out', join(tmpdir(), `imagine-eval-${Date.now()}`))!),
    only: argv.reduce<string[]>((acc, arg, index) => {
      if (arg === '--only' && argv[index + 1]) acc.push(...argv[index + 1].split(',').map((s) => s.trim()).filter(Boolean))
      return acc
    }, []),
    append: argv.includes('--append'),
    rejudge: argv.includes('--rejudge'),
    judgeOnly: argv.includes('--judge-only'),
  }
}

/** 分批跑：按「风格/模式/入镜」键合并新旧结果，同一组合的后续批次覆盖前一批。 */
function mergeRuns(existing: RunResult[], incoming: RunResult[]): RunResult[] {
  const keyOf = (r: RunResult) => `${r.style}|${r.mode}|${r.selfMode}|${r.rep}`
  const merged = new Map<string, RunResult>()
  for (const run of existing) merged.set(keyOf(run), run)
  for (const run of incoming) merged.set(keyOf(run), run)
  return Array.from(merged.values()).sort((a, b) => {
    const styleOrder = ['natural', 'tags']
    if (a.style !== b.style) return styleOrder.indexOf(a.style) - styleOrder.indexOf(b.style)
    if (a.mode !== b.mode) return MODES.findIndex((m) => m.value === a.mode) - MODES.findIndex((m) => m.value === b.mode)
    return SELF_MODES.findIndex((s) => s.value === a.selfMode) - SELF_MODES.findIndex((s) => s.value === b.selfMode)
  })
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await task(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function renderReport(options: CliOptions, runs: RunResult[], contracts: ContractCheck[]): string {
  const lines: string[] = []
  const allChecks = runs.flatMap((r) => r.checks)
  const failures = allChecks.filter((c) => c.level === 'fail')
  const warnings = allChecks.filter((c) => c.level === 'warn')
  const judged = runs.filter((r) => r.judge?.parsed)
  const judgeFails = judged.filter((r) => r.judge?.verdict !== 'pass')

  lines.push('# /imagine 提示词生成评测（自动生成）')
  lines.push('')
  lines.push(`- 时间：${new Date().toISOString()}`)
  lines.push(`- 生成模型：\`${options.model}\` @ \`${options.baseUrl}\``)
  lines.push(`- 评审模型：\`${options.judgeModel}\``)
  lines.push(`- 风格：${options.styles.join(' / ')}；重复次数：${options.reps}`)
  lines.push(`- 组合数：${runs.length}；结构化校验：${allChecks.length - failures.length - warnings.length} 通过 / ${failures.length} 失败 / ${warnings.length} 警告`)
  lines.push(`- 上游空响应重试：${transportRetries} 次（端点抖动，已在传输层吸收）`)
  lines.push(`- 内容评审：${judged.length} 条完成，${judgeFails.length} 条未通过`)
  lines.push('')
  lines.push('## 矩阵结果')
  lines.push('')
  lines.push('| 风格 | 画面重点 | 我方入镜 | 调用次数 | 最终提示词 | 结构化校验 | 评审 | 问题 |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const run of runs) {
    const fails = run.checks.filter((c) => c.level === 'fail')
    const warns = run.checks.filter((c) => c.level === 'warn')
    const judgeState = run.judge
      ? (run.judge.parsed ? (run.judge.verdict === 'pass' ? '✅' : '❌') : '⚠️解析失败')
      : '—'
    lines.push(`| ${run.style} | ${run.mode} | ${run.selfMode} | ${run.attempts.length} | ${run.finalPrompt ? `${run.finalPrompt.length} 字符` : '未产出'} | ${fails.length === 0 ? (warns.length ? `⚠️ ${warns.length} 警告` : '✅') : `❌ ${fails.map((f) => f.id).join(', ')}`} | ${judgeState} | ${(run.judge?.issues ?? []).join('；').replace(/\n/g, ' ').slice(0, 160)} |`)
  }
  lines.push('')
  lines.push('## 结构化校验失败明细')
  lines.push('')
  if (failures.length === 0) lines.push('无。')
  for (const check of failures) lines.push(`- ${check.id}: ${check.detail}`)
  if (warnings.length > 0) {
    lines.push('')
    lines.push('## 警告')
    lines.push('')
    for (const check of warnings) lines.push(`- ${check.id}: ${check.detail}`)
  }
  lines.push('')
  lines.push('## 契约检查（不调用模型）')
  lines.push('')
  for (const contract of contracts) lines.push(`- ${contract.pass ? '✅' : '❌'} ${contract.name}：${contract.detail}`)
  lines.push('')
  lines.push('## 最终提示词完整清单')
  for (const run of runs) {
    lines.push('')
    lines.push(`### ${run.style} / ${run.mode} / ${run.selfMode}`)
    lines.push('')
    lines.push(`> 调用 ${run.attempts.length} 次，耗时 ${run.durationMs}ms，尺寸 ${String((run.generateOptions as { size?: string } | undefined)?.size ?? '工作流默认')}`)
    lines.push('')
    lines.push('```')
    lines.push(run.finalPrompt || '(未产出)')
    lines.push('```')
    for (const attempt of run.attempts) {
      if (attempt.error) lines.push(`- 第 ${attempt.index + 1} 次调用异常：${attempt.error}`)
    }
  }
  return lines.join('\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const callModel = createModelCaller(options)
  const callJudge = createModelCaller(options, options.judgeModel)
  mkdirSync(options.outDir, { recursive: true })
  if (process.env.IMAGINE_EVAL_DEBUG_HTTP) installHttpDebug(options.outDir)

  const resultsPath = join(options.outDir, 'results.json')
  const loadExisting = (options.append || options.judgeOnly) && existsSync(resultsPath)
  const existing: RunResult[] = loadExisting
    ? (JSON.parse(readFileSync(resultsPath, 'utf-8')) as { runs?: RunResult[] }).runs ?? []
    : []
  const existingContracts = loadExisting
    ? (JSON.parse(readFileSync(resultsPath, 'utf-8')) as { contracts?: ContractCheck[] }).contracts ?? []
    : []
  const contracts = existingContracts.length > 0 ? existingContracts : await contractChecks()

  const combos = options.judgeOnly ? [] : buildCombos(options)
  const jobs: Array<{ style: Style; mode: GenMode; selfMode: SelfMode; rep: number }> = []
  for (const style of options.styles) {
    for (const combo of combos) {
      for (let rep = 0; rep < options.reps; rep++) jobs.push({ style, ...combo, rep })
    }
  }

  let done = 0
  // 生成阶段必须串行：命令通过全局 window.api 调用生图，并发会让多个组合互相覆盖捕获器。
  const incoming = await mapWithConcurrency(jobs, 1, async (job) => {
    process.stdout.write(`\r[${++done}/${jobs.length}] ${job.style} ${job.mode}:${job.selfMode} r${job.rep} ...`)
    const run = await runOnce(options, callModel, job.style, job.mode, job.selfMode, job.rep)
    const state = run.finalPrompt ? (run.checks.some((c) => c.level === 'fail') ? 'FAIL' : 'ok') : 'NO-PROMPT'
    process.stdout.write(`\r[${done}/${jobs.length}] ${job.style} ${job.mode}:${job.selfMode} r${job.rep} ${state}            \n`)
    return run
  })

  const runs = options.append ? mergeRuns(existing, incoming) : incoming

  if (options.judge) {
    if (options.rejudge) for (const run of runs) delete run.judge
    // 解析失败（空响应/截断）与未评审一样都需要重跑，否则会留下空洞结论
    const pending = runs.filter((r) => r.finalPrompt && (!r.judge || !r.judge.parsed))
    let judged = 0
    await mapWithConcurrency(pending, options.concurrency, async (run) => {
      process.stdout.write(`\r[评审 ${++judged}/${pending.length}] ${run.style} ${run.mode}:${run.selfMode} ...            \n`)
      try {
        run.judge = await judgeRun(options, callJudge, run)
      } catch (err) {
        run.judge = { parsed: false, raw: err instanceof Error ? err.message : String(err) }
      }
      return run
    })
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    model: options.model,
    baseUrl: options.baseUrl,
    styles: options.styles,
    reps: options.reps,
    fixture: { character: FIXTURE_CHARACTER, user: FIXTURE_USER, messages: FIXTURE_MESSAGES, sceneFacts: SCENE_FACTS },
    contracts,
    runs,
  }
  writeFileSync(join(options.outDir, 'results.json'), JSON.stringify(artifact, null, 2), 'utf-8')
  writeFileSync(join(options.outDir, 'report.md'), renderReport(options, runs, contracts), 'utf-8')

  const failures = runs.flatMap((r) => r.checks).filter((c) => c.level === 'fail')
  const judgeFails = runs.filter((r) => r.judge?.parsed && r.judge.verdict !== 'pass')
  console.log(`\n产物目录: ${options.outDir}`)
  console.log(`结构化失败: ${failures.length}；评审未通过: ${judgeFails.length}；契约检查失败: ${contracts.filter((c) => !c.pass).length}`)
  // 显式退出：tsx 在 Windows 上关闭 keep-alive 套接字时会触发 libuv 断言，覆盖真实退出码
  process.exit(failures.length > 0 || contracts.some((c) => !c.pass) ? 1 : 0)
}

main().catch((err) => {
  console.error(`\n运行失败: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(2)
})
