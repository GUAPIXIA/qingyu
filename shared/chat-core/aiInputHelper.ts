import type { ChatParams, ProviderType, Preset, Character, Message, NarrativeMode, ContinueIntensity, ContinueLength } from '../types'
import type { ReasoningGateDirective } from '../reasoningGate'
import { resolveGenerationTaskBudget } from '../generationTaskBudget'
import { stripThought } from './messagePostProcess'
import {
  CONTINUE_LENGTH_PARAMS,
  CONTINUE_LENGTH_TOLERANCE,
  resolveContinueIntensity,
  resolveContinueLength,
} from '../continueIntensity'
import { countVisibleCharacters, isCompleteSentence, trimToSentenceBoundary } from '../textMetrics'

/** 续写是否以完整句收尾（供调用方区分“没写完”与“长度越界”）。 */
export { isCompleteSentence } from '../textMetrics'

/**
 * ChatInput 的 AI 辅助逻辑（续写 / 润色）抽取模块。
 * 从 useChatInputState.ts 拆出，保持纯逻辑、可独立测试：
 * - ensureUserPerspective：剥离 AI 以角色视角回复的部分
 * - buildContinueContext：构造续写的上下文消息
 * - callAiHelper：发起一次 AI 辅助请求（依赖注入，无 React 状态）
 */

/** 转义正则特殊字符（构造角色名/用户名匹配时使用） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 后处理：确保输出是用户视角，剥离角色视角内容。
 * 若 AI 以角色名开头回复（含冒号），则提取用户发言部分；找不到用户部分则返回空串。
 */
/**
 * 名字发言行的正则源片段：允许行首缩进与 Markdown 星号装饰（*Aiko* / **Aiko** / ***Aiko***）。
 * lineAnchor 传行首锚（如 '^' 或 '\n'），内部会被包成非捕获组。
 */
function speakerLineSource(name: string, lineAnchor: string): string {
  return `(?:${lineAnchor})[ \\t]*\\*{0,3}${escapeRegExp(name)}\\*{0,3}\\s*[:：]`
}

export function ensureUserPerspective(raw: string, userName: string, charName: string): string {
  let output = raw.trim()
  const charPrefix = new RegExp(`${speakerLineSource(charName, '^')}\\s*`, 'i')
  if (charPrefix.test(output)) {
    // 用户部分可能跨多个段落：捕获到文本结尾（[\s\S]），再截到角色下一次开口为止
    const userLine = new RegExp(`${speakerLineSource(userName, '^|\\n')}\\s*([\\s\\S]*)`, 'i')
    const match = output.match(userLine)
    if (match) {
      const rest = match[1]
      const nextCharLine = new RegExp(speakerLineSource(charName, '\\n'), 'i')
      const stop = rest.search(nextCharLine)
      output = (stop >= 0 ? rest.slice(0, stop) : rest).trim()
    } else {
      return ''
    }
  }
  return output
}

/**
 * 续写输出按叙事身份清洗：代入模式保护用户身份；全局模式的正文属于旁白，
 * 即使以焦点角色名开头也不能当成“替角色发言”删除。
 */
export function normalizeContinueOutput(
  raw: string,
  userName: string,
  charName: string,
  narrativeMode: NarrativeMode,
): string {
  return narrativeMode === 'omniscient'
    ? raw.trim()
    : ensureUserPerspective(raw, userName, charName)
}

/**
 * 从辅助模型响应中提取唯一的业务结果标签。标签位于 thought 内时会先被剥离，
 * 缺失或重复均视为无效，避免把分析、检查清单或提示词本身写入业务数据。
 */
export function extractTaggedResult(raw: string, tag: 'continuation' | 'prompt'): string {
  const content = stripThought(raw || '')
  if (!content) return ''
  const matches = Array.from(content.matchAll(new RegExp(`<\\s*${tag}\\s*>([\\s\\S]*?)<\\s*\\/${tag}\\s*>`, 'gi')))
  if (matches.length !== 1) return ''
  return (matches[0][1] || '').trim()
}

/** 续写必须以中文为主；允许少量英文角色名或专有名词。 */
function isChineseContinuation(text: string): boolean {
  const hanCount = (text.match(/[\u3400-\u9fff]/g) || []).length
  const latinCount = (text.match(/[A-Za-z]/g) || []).length
  return hanCount >= 2 && hanCount * 2 >= latinCount
}

/**
 * 无标签回退路径的更严判据。
 *
 * 标签内正文已遵守协议，容忍“中文正文 + 少量英文专名”（2:1）；
 * 无标签时无法区分“正文”与“英文分析里夹了一句中文”，因此要求中文字符不少于
 * 英文字符，挡住 "Need final only. 应该继续推进剧情。" 这类混合输出。
 */
function isPredominantlyChinese(text: string): boolean {
  const hanCount = (text.match(/[\u3400-\u9fff]/g) || []).length
  const latinCount = (text.match(/[A-Za-z]/g) || []).length
  return hanCount >= 4 && hanCount >= latinCount
}

/**
 * 剥离模型写在正文前的元说明（如“以下是续写：”“好的，我来补写：”）。
 * 只认“短、含元词、以冒号结尾”的整行，避免误删正文（对白里也可能以“好的”开头）。
 */
function stripContinuationPreamble(text: string): string {
  const match = text.match(/^[^\n。！？]{0,24}?(?:续写|补写|正文|内容|如下|接着写)[^\n。！？]{0,12}[：:]\s*\n?/)
  return match ? text.slice(match[0].length).trim() : text
}

/** 去掉可能残留的标签字面量（截断或未包裹时会出现）。 */
function stripTagLiterals(text: string, tag: string): string {
  return text.replace(new RegExp(`<\\s*/?\\s*${tag}\\s*>`, 'gi'), '').trim()
}

/**
 * 提取并校验可安全写回输入框的续写正文。
 *
 * 标签是“信封”而非正确性前提：实测聚合端点常忽略 `thinking: disabled`，
 * 推理内容既占用输出预算、又让模型忘记加标签，但产出的正文本身完全可用。
 * 因此完整标签对优先，缺失时回退到标签内未闭合内容或全文，经元说明剥离后使用；
 * 长度与完整性由 `evaluateContinueLength` 继续把关（截断会走补足修复）。
 */
export function parseContinueResult(
  raw: string,
  userName: string,
  charName: string,
  narrativeMode: NarrativeMode,
): string {
  const content = stripThought(raw || '')
  if (!content) return ''

  const tagged = extractTaggedResult(content, 'continuation')
  let candidate: string
  let fromTag: boolean
  if (tagged) {
    candidate = tagged
    fromTag = true
  } else {
    // 未闭合（被切断）时取开标签之后的部分；完全没有标签则用全文
    const openMatch = content.match(/<\s*continuation\s*>([\s\S]*)$/i)
    candidate = stripContinuationPreamble(stripTagLiterals(openMatch ? openMatch[1] : content, 'continuation'))
    fromTag = false
  }

  // 标签外内容需更严的中文占比判据，避免把“英文分析 + 中文尾巴”当成正文
  const accepted = fromTag ? isChineseContinuation(candidate) : isPredominantlyChinese(candidate)
  if (!accepted) return ''
  const normalized = normalizeContinueOutput(candidate, userName, charName, narrativeMode)
  return normalized && isChineseContinuation(normalized) ? normalized : ''
}

/** 续写解析失败的归因；用于给出可操作的提示，而不是笼统的“无效正文”。 */
export type ContinueFailureKind = 'truncated' | 'invalid-content' | 'empty'

/**
 * 归因续写为何无法使用（2026-09-11 实机实测后修订）：
 * - empty：思考内容之外没有正文——实测聚合端点忽略 `thinking: disabled`，
 *   推理会吃光输出预算，这是“没有正文”的最常见成因；
 * - truncated：写了但没写完（含未闭合标签）；
 * - invalid-content：有内容但不是可用的中文正文（如只回了英文分析）。
 */
export function classifyContinueFailure(raw: string): ContinueFailureKind {
  const content = stripThought(raw || '')
  if (!content.trim()) return 'empty'
  const hasOpen = /<\s*continuation\s*>/i.test(content)
  const hasClose = /<\s*\/\s*continuation\s*>/i.test(content)
  if (hasOpen && !hasClose) return 'truncated'
  return 'invalid-content'
}

/**
 * 解析失败是否值得再试一次格式。
 * 未加标签已由 parseContinueResult 回退接受，因此走到这里只剩“确实拿不到中文正文”
 * 或“内容不完整”，重试一次即可；长度修复由 evaluateContinueLength 另行触发。
 */
export function shouldRetryContinueFormat(raw: string): boolean {
  const kind = classifyContinueFailure(raw)
  return kind !== 'empty'
}

/** 长度校验结论：接受的两种形态（原样 / 句边界收束）与两种修复方向。 */
export type ContinueLengthAction = 'accept' | 'trim' | 'supplement' | 'compress'

export interface ContinueLengthEvaluation {
  /** 本次新增内容的可见字符数 */
  chars: number
  /** 是否以完整句收尾；不完整即视为被 maxTokens 截断 */
  truncated: boolean
  action: ContinueLengthAction
  /** action === 'trim' 时的收束结果（已落在目标区间内） */
  trimmedText?: string
}

/**
 * 生成后长度校验（方案 §6.5）。
 * 判定顺序：明显超长 → 上限 100%–120% 句边界收束 → 截断 → 明显偏短 → 容忍下限 → 接受。
 * 超长优先于截断：对已经超出上限的正文要求“补足”只会更长，应先压缩。
 * “语义完整”用句末标点判定，不额外调用模型。
 */
export function evaluateContinueLength(text: string, length: ContinueLength): ContinueLengthEvaluation {
  const { minChars, maxChars } = CONTINUE_LENGTH_PARAMS[length]
  const chars = countVisibleCharacters(text)
  const truncated = !isCompleteSentence(text)

  if (chars > maxChars * CONTINUE_LENGTH_TOLERANCE.repairCeilingRatio) {
    return { chars, truncated, action: 'compress' }
  }
  if (chars > maxChars) {
    const trimmedText = trimToSentenceBoundary(text, { minChars, maxChars })
    if (trimmedText) return { chars, truncated, action: 'trim', trimmedText }
    return { chars, truncated, action: 'compress' }
  }

  // 被 maxTokens 截断的正文即使字数达标也要补足，不能把半截正文写回输入框
  if (truncated) return { chars, truncated, action: 'supplement' }
  if (chars < minChars * CONTINUE_LENGTH_TOLERANCE.acceptLowerRatio) {
    return { chars, truncated, action: 'supplement' }
  }
  return { chars, truncated, action: 'accept' }
}

/**
 * 修复一次后的宽容判定：仍属轻微越界且句意完整时接受，明显越界返回 false
 * （调用方应保留用户原输入并给出可见反馈）。
 */
export function isAcceptableAfterLengthRepair(text: string, length: ContinueLength): boolean {
  const { minChars, maxChars } = CONTINUE_LENGTH_PARAMS[length]
  if (!isCompleteSentence(text)) return false
  const chars = countVisibleCharacters(text)
  return chars >= minChars * CONTINUE_LENGTH_TOLERANCE.softLowerRatio
    && chars <= maxChars * CONTINUE_LENGTH_TOLERANCE.softUpperRatio
}

/**
 * 长度修复指令：追加到 system 提示词后重新请求一次。
 * 只约束字数与收尾方式——输出上限是统一的失控兜底，不在这里复述具体 token 数。
 */
export function buildLengthRepairInstruction(
  mode: 'supplement' | 'compress',
  length: ContinueLength,
  opts: { chars: number; truncated: boolean },
): string {
  const { minChars, maxChars } = CONTINUE_LENGTH_PARAMS[length]
  if (mode === 'compress') {
    return `上一次输出约 ${opts.chars} 个可见字符，超出本次目标 ${minChars}–${maxChars} 字。请压缩重写：保留关键信息与因果，删去重复、铺陈与次要细节，必须在目标区间内以完整句收尾。`
  }
  const truncatedNote = opts.truncated
    ? '上一次输出未能写完就中断了。'
    : `上一次输出约 ${opts.chars} 个可见字符，低于本次目标 ${minChars}–${maxChars} 字。`
  return `${truncatedNote}请补足到目标区间（${minChars}–${maxChars} 个可见字符），以完整句收尾；不要复述已有内容，也不要增加无关支线。`
}

/**
 * 全局叙事下各强度档位的推进幅度指令。active 档保持强度功能引入前的原文案。
 * 注意：不要写回“1–3 句”等旧硬性长度短语（既有测试断言其不存在）。
 */
function omniscientScopeClause(intensity: ContinueIntensity): string {
  switch (intensity) {
    case 'subtle':
      return '- 只写一处细微的环境、氛围或细节变化，不引入新事件、新角色或新冲突；不替对方角色完成详细反应'
    case 'steady':
      return '- 顺着当前场景与最近矛盾做小幅推进，只加入小阻碍或新信息，不改变当前主线；不替对方角色完成详细反应'
    case 'bold':
      return '- 可引入重大转折、场景切换、时间推进或新的冲突线；不替对方角色完成详细反应'
    default:
      return '- 推动局势发生变化，优先加入事件、压力、线索、阻碍或转折\n- 只提出变化并把故事推到下一个反应点，不展开完整场景，不替对方角色完成详细反应'
  }
}

/** 代入角色模式下各强度档位的补全幅度指令；active 档不加额外约束。 */
function immersiveScopeClause(intensity: ContinueIntensity): string {
  switch (intensity) {
    case 'subtle':
      return '- 只补完当前表达或添加细微变化，不引入新的剧情发展'
    case 'steady':
      return '- 顺着当前意图自然承接，可加入轻微波澜，但不改变当前主线'
    case 'bold':
      return '- 可以引入重大转折、场景变化或新的冲突方向，但保持因果可信'
    default:
      return '- 引入有因果依据的事件、压力或线索，把情节推到下一个反应点'
  }
}

/**
 * 本次新增内容的篇幅目标；长度控制的唯一手段，不参与剧情转折判断。
 * 语义是“续写新增的部分”，不是“合并原文后的最终输入框内容”——
 * 原文已经很长时，靠追加无法让最终内容变短（方案 §6.1）。
 */
function continueLengthClause(length: ContinueLength, hasInput: boolean): string {
  const { minChars, maxChars, structure } = CONTINUE_LENGTH_PARAMS[length]
  const lead = hasInput
    ? '本次只输出直接接在原文之后的新内容，不要复述原文'
    : '本次只输出用户接下来要说的新内容'
  return `- 篇幅由本指令控制：${lead}，写 ${minChars}–${maxChars} 个可见中文字符，${structure}
- 一次把目标篇幅写完，不要只写开头就收尾，也不要大幅超出上限
- 必须在完整句处结束，不要为了凑字数重复信息
- 如果情节已经自然完成，宁可接近下限，也不得增加无关支线`
}

/** 接续点约束：专门防止末尾复读、时序倒置和无输入时绕开当前悬念。 */
function continueContinuityClause(hasInput: boolean): string {
  if (hasInput) {
    return `- 不得重复原文末尾已经出现的词语、动作或句式
- 从完成原文所需的下一个新词或下一句直接写起，确保与原文拼接后语法通顺
- 保持动作与事件时序；不得把尚未发生的动作写成已经完成，也不得凭空倒叙为“刚才已经做过”`
  }
  return `- 优先回应最近一条尚未解决的问题、呼喊、威胁、承诺或悬念，处理后再补充次要细节
- 保持最近对话的时序与因果，不要绕开当前矛盾另起无关话题`
}

/** 构造续写的 systemPrompt（用户视角续写助手） */
export function buildContinueSystemPrompt(
  userName: string,
  charName: string,
  hasInput: boolean,
  narrativeMode: NarrativeMode = 'immersive',
  intensity: ContinueIntensity = 'active',
  length: ContinueLength = 'standard',
): string {
  const lengthClause = continueLengthClause(length, hasInput)
  const continuityClause = continueContinuityClause(hasInput)
  if (narrativeMode === 'omniscient') {
    const task = hasInput
      ? '请续写用户尚未完成的旁白推动，使其成为可直接发送、自然完整的剧情变化。'
      : '请根据最近对话中尚未解决的矛盾，生成可由用户直接发送、自然完整的旁白推动。'
    return `你是用户侧的剧情推进助手。${task}

严格要求：
- 必须使用简体中文输出
- 只以故事外部旁白的身份输出第三人称叙事，以角色名、“他”或“她”指代人物
- 不以 ${charName} 或任何角色的第一人称视角回应，不生成角色对白、角色名前缀或整段对话
- 写到本次剧情推动自然完成；可按叙事节奏分段
- 必须以完整句收尾，不要在动作、对白或因果关系尚未写完时停止
${omniscientScopeClause(intensity)}
${lengthClause}
${continuityClause}
- ${charName} 是当前故事焦点之一，但不要替 ${charName} 说话或完成详细心理与连续动作
- 不替 ${userName} 控制的玩家角色作重大选择，不一次解决当前冲突
- 保持既有时序、因果和叙述风格，不随机引入无关事件
- 不添加标题、“剧情建议”或解释
- 最终正文必须且只能放在一组 <continuation>...</continuation> 标签内，标签外不要输出任何内容`
  }

  const scope = immersiveScopeClause(intensity)
  if (hasInput) {
    return `你是一个角色扮演对话的用户视角续写助手。你的任务是以【用户 ${userName}】的身份和口吻，续写用户未完成的消息。\n\n严格要求：\n- 必须使用简体中文输出\n- 只输出 ${userName} 的话语，绝对不要输出 ${charName} 的话语\n- 不要以 ${charName} 的身份说话或行动\n- 不要包含角色名前缀，直接输出对话内容\n- 保持用户一贯的语气和风格\n${scope}\n${lengthClause}\n${continuityClause}\n- 最终正文必须且只能放在一组 <continuation>...</continuation> 标签内，标签外不要输出任何内容`
  }
  return `你是一个角色扮演对话的用户视角续写助手。你的任务是以【用户 ${userName}】的身份和口吻，生成一条合适的用户回复。\n\n严格要求：\n- 必须使用简体中文输出\n- 只输出 ${userName} 的话语，绝对不要输出 ${charName} 的话语\n- 不要以 ${charName} 的身份说话或行动\n- 不要包含角色名前缀，直接输出对话内容\n- 保持用户一贯的语气和风格\n${scope}\n${lengthClause}\n${continuityClause}\n- 最终正文必须且只能放在一组 <continuation>...</continuation> 标签内，标签外不要输出任何内容`
}

/** 全局叙事末条指令的推进幅度措辞；active 档保持强度功能引入前的原文案。 */
function omniscientTaskInstruction(intensity: ContinueIntensity, hasInput: boolean): string {
  switch (intensity) {
    case 'subtle':
      return hasInput
        ? `请只补写直接接在原文后面的部分，不要复述原文；保持当前走向，仅加入细微变化，写完最后一句：\n`
        : '请基于最近对话保持当前走向，仅加入细微的环境或氛围变化，写完最后一句，不引入新事件'
    case 'steady':
      return hasInput
        ? `请只补写直接接在原文后面的部分，不要复述原文；顺着当前情节做小幅推进，写完最后一句：\n`
        : '请基于最近对话中的矛盾，生成一段小幅推进，写完最后一句，保留角色反应空间'
    case 'bold':
      return hasInput
        ? `请只补写直接接在原文后面的部分，不要复述原文；形成一次幅度较大的剧情转折或场景变化，并写完最后一句：\n`
        : '请基于最近对话中的矛盾，生成一次幅度较大的剧情转折或场景变化，写完最后一句，保留角色反应空间'
    default:
      return hasInput
        ? `请只补写直接接在原文后面的部分，不要复述原文；形成自然完整的剧情推动，并写完最后一句：\n`
        : '请基于最近对话中尚未解决的矛盾，生成自然完整的剧情推动，写完最后一句，只提出变化并保留角色反应空间'
  }
}

/** 构造续写的上下文消息（system + 最近消息 + 续写指令） */
export function buildContinueContext(opts: {
  character: Character
  userName: string
  charName: string
  recentMessages: Message[]
  originalInput: string
  hasInput: boolean
  narrativeMode?: NarrativeMode
  intensity?: ContinueIntensity
  length?: ContinueLength
}): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const { character, userName, charName, recentMessages, originalInput, hasInput, narrativeMode = 'immersive' } = opts
  const intensity = resolveContinueIntensity(opts.intensity)
  const length = resolveContinueLength(opts.length)
  const systemPrompt = buildContinueSystemPrompt(userName, charName, hasInput, narrativeMode, intensity, length)
  const contextMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: `${systemPrompt}\n\n当前角色：${charName}\n角色设定：${character.description || '无'}\n场景：${character.scenario || '无'}` },
  ]
  for (const msg of recentMessages) {
    contextMessages.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      // 历史消息可能携带 <thought> 内心独白（角色第一人称声口）。直接喂给续写会诱导
      // 模型模仿角色视角输出，随后被 ensureUserPerspective 整段清空，表现为
      // “续写未生成可用内容”。续写只需要可见正文。
      content: stripThought(msg.content || ''),
    })
  }
  contextMessages.push({
    role: 'user',
    content: narrativeMode === 'omniscient'
      ? (hasInput
          ? `${omniscientTaskInstruction(intensity, true)}${originalInput}`
          : omniscientTaskInstruction(intensity, false))
      : (hasInput
          ? `请以 ${userName} 的身份续写以下未完成的消息（直接接在后面的部分；不得重复末尾措辞，从下一个必要的新词或下一句写起）：\n${originalInput}`
          : `请以 ${userName} 的身份根据上下文生成一条回复；优先回应最近一条尚未解决的问题或悬念`),
  })
  return contextMessages
}

/** callAiHelper 的依赖（由 hook 侧注入，模块内不接触 React 状态） */
export interface AiHelperCallOptions {
  /** 要发送给模型的完整消息序列。续写依赖最近对话，不能在调用层压缩成首尾两条。 */
  messages: ChatParams['messages']
  temperature?: number
  maxTokens?: number
  onChunk?: (delta: string, full: string) => void
  reasoningGate?: ReasoningGateDirective
  /** 截断时返回已产出正文（仅限解析器自身可容错的辅助调用） */
  profile: { provider: ProviderType; apiKey: string; baseUrl: string }
  activeModel: string
  preset: Preset | null
  /** 活跃请求 ID 集合（用于组件卸载时统一取消） */
  activeRequestIds: Set<string>
}

/**
 * 发起一次 AI 辅助请求（非流式），返回 AI 生成的完整文本。
 * 注册 chunk/done/error 监听，完成后自清理。
 */
export function callAiHelper(opts: AiHelperCallOptions): Promise<string> {
  const { messages, temperature, maxTokens, onChunk, reasoningGate, profile, activeModel, preset, activeRequestIds } = opts
  const automaticPlan = maxTokens == null
    ? resolveGenerationTaskBudget({ task: 'generic', model: activeModel, userHardCap: preset?.maxTokens })
    : null
  let result = ''
  const requestId = `ai-helper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  activeRequestIds.add(requestId)

  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      activeRequestIds.delete(requestId)
      unbindChunk(); unbindDone(); unbindError()
    }
    // 辅助调用的结果会进入输入框或下游服务，绝不允许 thought-only 回退。
    const cleanResult = () => stripThought(result)
    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      result += data.text
      onChunk?.(data.text, cleanResult())
    })
    const unbindDone = window.api.ai.onComplete((payload) => {
      if (payload.requestId !== requestId) return
      cleanup()
      resolve(cleanResult())
    })
    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== requestId) return
      cleanup()
      reject(new Error(data.error))
    })

    const params: ChatParams = {
      requestId,
      messages,
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: activeModel,
      temperature: temperature ?? preset?.temperature ?? 0.5,
      topP: preset?.topP ?? 0.9,
      maxTokens: maxTokens ?? automaticPlan!.requestMaxTokens,
      frequencyPenalty: preset?.frequencyPenalty ?? 0,
      presencePenalty: preset?.presencePenalty ?? 0,
      stream: false,
      reasoningGate: reasoningGate ?? automaticPlan?.reasoningGate,
    }

    window.api.ai.chat(params).catch((err) => {
      cleanup()
      reject(err)
    })
  })
}
