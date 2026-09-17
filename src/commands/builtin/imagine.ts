import type { CommandDef } from '../registry'
import type { Character } from '../../../shared/types'
import type { ActiveImageGenProfile } from '../../store/useSettingsStore'
import { extractTaggedResult } from '../../components/chat/aiInputHelper'
import { stripThought } from '../../utils/messagePostProcess'

type GenMode = 'moment' | 'closeup' | 'full' | 'interaction' | 'background'
type SelfMode = 'hidden' | 'silhouette' | 'translucent' | 'pov'
type PromptStyle = 'natural' | 'tags'
const SELF_COMPOSITION_PLACEHOLDER = '{{SELF_COMPOSITION}}'

const MODE_ALIASES: Record<string, GenMode> = {
  now: 'moment',
  moment: 'moment',
  face: 'closeup',
  closeup: 'closeup',
  character: 'full',
  full: 'full',
  interaction: 'interaction',
  background: 'background',
}

function parseOptions(args: string[]): { mode: GenMode; selfMode: SelfMode; prompt: string } {
  let mode: GenMode = 'moment'
  let selfMode: SelfMode = 'hidden'
  const promptParts: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      mode = MODE_ALIASES[args[i + 1].toLowerCase()] ?? 'moment'
      i++
    } else if (args[i] === '--self' && args[i + 1]) {
      const candidate = args[i + 1].toLowerCase() as SelfMode
      if (['hidden', 'silhouette', 'translucent', 'pov'].includes(candidate)) selfMode = candidate
      i++
    } else {
      promptParts.push(args[i])
    }
  }
  return { mode, selfMode: mode === 'background' ? 'hidden' : selfMode, prompt: promptParts.join(' ').trim() }
}

/** 根据配置名称、模型和工作流内容自动判断，不增加用户配置项。 */
function resolvePromptStyle(config: ActiveImageGenProfile | null): PromptStyle {
  if (!config) return 'tags'
  const fingerprint = [config.name, config.model, config.workflowName, config.workflow]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  return config.provider === 'openai' || /z[_ -]?image|flux/.test(fingerprint) ? 'natural' : 'tags'
}

function modeSubject(mode: GenMode): string {
  switch (mode) {
    case 'closeup':
      return '对方近景：以脸部、眼神、细微表情、上半身姿态和手部动作为重点，但仍保留能说明剧情的环境线索。'
    case 'full':
      return '对方全身：完整呈现从头到脚的服装、重心、四肢姿势、正在进行的动作以及与环境的空间关系。'
    case 'interaction':
      return '互动构图：表现对方正在与镜头外或弱化的我方互动；对方必须是占据主要画面面积的唯一清晰主体。'
    case 'background':
      return '环境空镜：只描绘地点、时间、天气、光线、物件痕迹和氛围，不出现任何人物、肢体、倒影或人形轮廓。'
    default:
      return '剧情瞬间：定格最新对话结尾正在发生的具体一刻，优先表现对方的神态、姿势、动作和当前服装。'
  }
}

function selfPresenceInstruction(selfMode: SelfMode): string {
  switch (selfMode) {
    case 'silhouette':
      return `对方角色仍是唯一清晰主体。不要自行描述我方人物、轮廓或外貌，也不要使用 figure、person、silhouette、transparent、translucent 等词。请在最终提示词需要前景构图的位置原样放入 ${SELF_COMPOSITION_PLACEHOLDER}，且只能出现一次；程序会把它替换成安全的近镜头肩部边缘构图。`
    case 'translucent':
      return `对方角色仍是唯一清晰主体。不要自行扩写我方人物或外貌，请在最终提示词需要边缘陪衬的位置原样放入 ${SELF_COMPOSITION_PLACEHOLDER}，且只能出现一次；程序会替换成受控的半透明边缘线条。`
    case 'pov':
      return `采用我方第一人称视角，对方角色是唯一清晰人物。不要自行描述我方身体，请在最终提示词的构图位置原样放入 ${SELF_COMPOSITION_PLACEHOLDER}，且只能出现一次；程序会替换成受控的第一人称镜头约束。`
    default:
      return '我方角色完全不出现在画面中：不生成第二个人、第二张脸、我方肢体、倒影或影子；对方角色是唯一清晰主体。'
  }
}

function buildSystemPrompt(
  mode: GenMode,
  character: Character,
  style: PromptStyle,
  selfMode: SelfMode,
  userProfile?: { name: string; description?: string; persona?: string },
): string {
  const backgroundOnly = mode === 'background'
  const outputFormat = style === 'natural'
    ? `使用英文自然语言写成一个连贯、具体的段落，约 90–180 个英文单词。不要使用 best quality、masterpiece、highres 等标签。`
    : `使用英文逗号分隔的绘画标签，按“主体数量与身份 → 外貌 → 神态与视线 → 姿势与双手动作 → 服装状态 → 环境与构图 → 光线与材质”的顺序输出。以 best quality, masterpiece, highres 开头。`
  const subjectChecklist = backgroundOnly
    ? `逐项落实当前环境的地点结构、时间、天气、主要物件、使用痕迹、光源方向、色温、景深和氛围。`
    : `必须逐项落实对方角色的：
1. 稳定外貌：年龄感、脸型、发型发色、眼睛、体型；
2. 神态：眼神方向、眉眼变化、嘴部状态、可见情绪及强度；
3. 姿势：头部角度、躯干朝向、站坐躺状态、身体重心、四肢位置；
4. 动作：双手分别在做什么、正在触碰或握住什么、动作进行到哪一步；
5. 穿着：具体衣物、颜色、材质、配饰，以及褶皱、松紧、凌乱、潮湿或破损等服装状态；
6. 画面：对方与道具和环境的空间关系、镜头景别、拍摄角度、构图、景深、光源方向、色温与氛围。`
  return `你是专业的剧情画面导演和图片提示词生成器。请把对话结尾转化为能够直接用于生图模型的英文提示词。

【画面目标】
${modeSubject(mode)}

【事实优先级】
最新对话是当前场景的最高优先级事实来源。角色卡只用于脸型、发型、年龄感、体型等稳定身份特征；地点、服装、姿势、动作、表情、时间与光线必须采用最新对话末尾状态。不要退回初始介绍画面，也不要凭空添加对话中没有依据的第二个清晰人物。

【强制视觉清单】
${subjectChecklist}

【我方入镜规则】
${backgroundOnly ? '环境空镜中不允许出现任何人物、肢体、倒影或人形轮廓。' : selfPresenceInstruction(selfMode)}

【输出规则】
${outputFormat}
不要复述剧情，不要使用角色姓名代替外貌描述，不要输出解释、分析、标题、字幕、文字、Logo 或水印。
最终提示词必须且只能放在一组 <prompt>...</prompt> 标签内，标签外不要输出任何内容。

【对方角色资料】
姓名: ${character.name}
${character.description ? `稳定外貌资料: ${character.description}` : ''}
${character.personality ? `性格参考（仅用于推断合理神态，不可替代当前对话）: ${character.personality}` : ''}

【我方角色资料】
姓名: ${userProfile?.name || '用户'}
除姓名外不提供外貌资料，避免生图模型把我方误画成第二个完整人物。`
}

/** tags 风格的标准质量前缀（R3：模型漏写时确定性补齐）。 */
const TAGS_QUALITY_PREFIX = 'best quality, masterpiece, highres'

/**
 * 我方构图不交给文本模型自由发挥：模型只决定占位位置，程序插入经过约束的固定片段。
 * 这样“仅轮廓”不会再次被扩写成 seated figure / semi-transparent silhouette。
 */
function finalizeImagePrompt(
  prompt: string,
  mode: GenMode,
  selfMode: SelfMode,
  style: PromptStyle,
): string {
  // R3：tags 风格结果未以质量前缀开头时自动补齐（此前只在评测里告警，不修改）
  let normalized = prompt
  if (style === 'tags' && !/^best quality\b/i.test(normalized.trim())) {
    normalized = `${TAGS_QUALITY_PREFIX}, ${normalized.trim()}`
  }
  if (mode === 'background' || selfMode === 'hidden') return normalized
  const placeholderCount = normalized.split(SELF_COMPOSITION_PLACEHOLDER).length - 1
  if (placeholderCount !== 1) return ''

  const naturalGuards: Record<Exclude<SelfMode, 'hidden'>, string> = {
    silhouette: 'a cropped featureless dark shoulder-edge shape entering from the lower-left extreme foreground, heavily defocused and occupying less than eight percent of the frame, with no head, face, hands, limbs, torso, clothing details, transparency, reflection, or second background subject',
    translucent: 'a faint translucent contour line confined to the extreme frame edge, occupying less than six percent of the image, without a head, face, anatomy, clothing details, glow, ghostly body, or second background subject',
    pov: 'a strict first-person camera viewpoint with no visible face or body; only when required by the action, a small cropped portion of one hand may enter from the bottom edge without obscuring the main character',
  }
  const tagGuards: Record<Exclude<SelfMode, 'hidden'>, string> = {
    silhouette: 'over-the-shoulder composition, cropped featureless dark shoulder-edge shape, extreme foreground, heavily defocused foreground, under 8 percent of frame, main character solo focus, no second face, no complete second body, no background person',
    translucent: 'faint translucent edge contour, extreme frame edge, under 6 percent of frame, no face, no anatomy, no complete second body, main character solo focus',
    pov: 'first-person viewpoint, main character solo focus, no viewer face, no viewer body, optional cropped hand at bottom edge only, unobstructed subject',
  }
  const guard = style === 'natural' ? naturalGuards[selfMode] : tagGuards[selfMode]
  return normalized.replace(SELF_COMPOSITION_PLACEHOLDER, guard)
}

/** 元信息开头（锚定行首，R3）：模型把分析/自我纠错过程当成了提示词。
 *  注意不得改成全局匹配——anatomically correct 等是常见绘画标签。 */
const META_INFO_PREFIX_RE = new RegExp(
  "^(?:we need|need final|let['’]s|let me|i['’]ll|i will|i would|should we|the user|i need|analysis\\b"
  + '|okay,?\\s+(?:we|the task)|sorry\\b|wait[\\s,]|actually\\b|correct(?:ion)?\\b|rewrite\\b|redo\\b)',
  'i',
)

/** 残缺或多余的尖括号标记（<prompt>、<prong> 等，R3）：不属于最终提示词。 */
const ANGLE_TAG_RE = /<\s*\/?\s*[a-z][a-z0-9_-]*\s*>/i

function isUsableImagePrompt(raw: string, style: PromptStyle): boolean {
  const value = raw.trim()
  if (value.length < 8 || META_INFO_PREFIX_RE.test(value)) {
    return false
  }
  // <prong> 这类残缺标签会原样进入生图模型，一律拒绝
  if (ANGLE_TAG_RE.test(value)) {
    return false
  }

  // 过短的“1girl, smiling”虽然语法有效，但无法承载神态、姿势、双手、服装与构图。
  // 首次返回不够详细时让既有的第二次尝试负责重写，而不是直接浪费一次生图。
  if (style === 'tags') {
    return value.length >= 80 && value.split(',').filter((part) => part.trim()).length >= 10
  }
  const englishWords = value.match(/[A-Za-z][A-Za-z'-]*/g)?.length ?? 0
  return value.length >= 120 && englishWords >= 20
}

/**
 * 取有效段（R3）：多行候选中模型常在最终提示词前输出自述/纠错行
 * （"tag. Let me correct."）。从首个像结果的行为止截取，丢弃其前的内容；
 * 截取到的行若以残缺尖括号片段开头（如 `<prong>best quality, …`）则剥掉，
 * 否则会被 isUsableImagePrompt 的尖括号规则拒掉，实测样本无法恢复。
 */
function extractResultSegment(plain: string, style: PromptStyle): string {
  const lines = plain.split(/\r?\n/)
  const isResultLine = style === 'tags'
    ? (line: string) => /best quality|masterpiece|highres/i.test(line)
    : (line: string) => (line.match(/[A-Za-z][A-Za-z'-]*/g)?.length ?? 0) >= 12
  const startIndex = lines.findIndex((line) => isResultLine(line.trim()))
  if (startIndex < 0) return plain
  const segment = lines.slice(startIndex).join('\n').trim()
  return segment.replace(/^(?:<\s*\/?\s*[a-z][a-z0-9_-]*\s*>\s*)+/i, '').trim()
}

/**
 * 生图提示词优先使用严格 XML 协议；部分模型会直接返回有效提示词，
 * 对这类纯结果做受限回退，同时继续拒绝思考文本和损坏/重复的 prompt 标签。
 */
function parseImagePromptResult(raw: string, style: PromptStyle): string {
  const tagged = extractTaggedResult(raw, 'prompt')
  if (isUsableImagePrompt(tagged, style)) return tagged

  let plain = stripThought(raw || '').trim()
  if (!plain || /<\s*\/?\s*prompt\b/i.test(plain)) return ''

  // 兼容模型把最终提示词放进单个 Markdown 代码块。
  const fenced = plain.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n?```$/)
  if (fenced) plain = fenced[1].trim()

  // 兼容常见的单行结果前缀，但不吞掉后续分析段落。
  plain = plain.replace(
    /^(?:here(?:'s| is)\s+(?:the\s+)?(?:final\s+)?(?:image\s+)?prompt|(?:final\s+)?(?:image\s+)?prompt|提示词)\s*[:：]\s*/i,
    '',
  ).trim()

  plain = extractResultSegment(plain, style)
  return isUsableImagePrompt(plain, style) ? plain : ''
}

/**
 * 模式对应的尺寸覆盖。
 *
 * - comfyui：返回 undefined，尺寸由工作流节点唯一决定；
 * - openai：仅 1024x1792 / 1792x1024 合法，故映射到竖/横版标准尺寸；
 * - 其余（sd-webui 接受任意尺寸）：沿用原来的 512x768 / 768x512。
 */
function getSizeForMode(mode: GenMode, provider?: ActiveImageGenProfile['provider']): string | undefined {
  if (provider === 'comfyui') return undefined
  const vertical = mode === 'closeup' || mode === 'full'
  const horizontal = mode === 'background'
  if (!vertical && !horizontal) return undefined
  if (provider === 'openai') return vertical ? '1024x1792' : '1792x1024'
  return vertical ? '512x768' : '768x512'
}

export const imagineCommand: CommandDef = {
  name: 'imagine',
  aliases: ['img', '生图', '画图'],
  description: '使用 AI 生成图片（无参数时自动结合上下文）',
  usage: '/imagine [描述] 或 /imagine --mode <moment|closeup|full|interaction|background> --self <hidden|silhouette|translucent|pov>',
  args: [{ name: 'prompt', description: '图片描述（可选，不填则自动生成）' }],
  execute: async (args, ctx) => {
    const { mode, selfMode, prompt } = parseOptions(args)
    const activeImageGen = ctx.getActiveImageGen()
    // 生图模型不可用时应在辅助模型生成提示词之前失败，
    // 否则无参数调用会把配置错误误报成“提示词生成失败”。
    if (!activeImageGen) {
      ctx.notify('尚未配置或启用生图模型，请前往「设置 → API → 生图」完成配置')
      return
    }
    const jobId = ctx.beginImageGeneration(prompt ? 'generating' : 'prompting')
    if (!jobId) {
      ctx.notify('当前会话已有生图任务正在进行')
      return
    }

    try {
      let finalPrompt = prompt
      if (!finalPrompt) {
        const style = resolvePromptStyle(activeImageGen)
        const systemPrompt = buildSystemPrompt(mode, ctx.character, style, selfMode, ctx.userProfile)
        const recentMessages = ctx.getRecentMessages(12)
        const userContent = recentMessages.length > 0
          ? `角色关系：\n- 对方角色: ${ctx.character.name}\n- 我方角色: ${ctx.userName || ctx.userProfile?.name || '用户'}\n\n以下对话按时间从旧到新排列，最后三条权重最高，最后一条代表当前时刻：\n\n${recentMessages.map(m => `${m.name}: ${m.content}`).join('\n')}\n\n请定格对话结尾正在发生的具体瞬间。最后发生的地点、服装、动作和情绪优先于角色卡初始设定。先在内部确认对方的神态、视线、身体姿势、双手动作和服装状态是否齐全，再只输出最终 <prompt>。`
          : `角色关系：\n- 对方角色: ${ctx.character.name}\n- 我方角色: ${ctx.userName || ctx.userProfile?.name || '用户'}\n\n（暂无对话历史，请依据角色资料构造不与其冲突的静态画面。）`

        for (let attempt = 0; attempt < 2 && !finalPrompt; attempt++) {
          const attemptPrompt = attempt === 0
            ? systemPrompt
            : `${systemPrompt}\n\nThe previous response was invalid. Return only one <prompt>...</prompt> result with no analysis or commentary.`
          const raw = await ctx.callAiHelper(attemptPrompt, userContent, {
            temperature: attempt === 0 ? 0.5 : 0.2,
            task: 'image_prompt',
            expectedBodyChars: style === 'natural' ? 1200 : 800,
            // R1-A：撞上限时返回已产出正文，由 parseImagePromptResult 兜底解析
          })
          const candidate = parseImagePromptResult(raw, style)
          if (candidate) finalPrompt = finalizeImagePrompt(candidate, mode, selfMode, style)
        }

        if (!finalPrompt) {
          ctx.notify('提示词生成失败，请重试')
          return
        }
        ctx.notify(`提示词: ${finalPrompt.slice(0, 80)}${finalPrompt.length > 80 ? '...' : ''} 正在生成图片`)
      }

      ctx.updateImageGeneration(jobId, 'generating')
      // 尺寸按 provider 归一化：ComfyUI 由工作流决定，OpenAI 只接受标准竖/横版。
      const sizeOverride = getSizeForMode(mode, activeImageGen?.provider)
      const result = await window.api.imageGen.generate(finalPrompt, sizeOverride ? { size: sizeOverride } : undefined)
      if (result.success && result.images?.length) {
        await ctx.addImageMessage(result.images, finalPrompt)
      } else {
        ctx.notify(`生图失败: ${result.error || '未知错误'}`)
      }
    } catch (error) {
      ctx.notify(`生图失败: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      ctx.finishImageGeneration(jobId)
    }
  },
}
