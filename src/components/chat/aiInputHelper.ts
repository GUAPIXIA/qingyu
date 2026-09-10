import type { ChatParams, ProviderType, Preset, Character, Message, NarrativeMode, ContinueIntensity, ContinueLength } from '../../../shared/types'
import { stripThought } from '../../utils/messagePostProcess'
import { resolveContinueIntensity, resolveContinueLength } from '../../../shared/continueIntensity'

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

/** 提取并校验可安全写回输入框的续写正文。 */
export function parseContinueResult(
  raw: string,
  userName: string,
  charName: string,
  narrativeMode: NarrativeMode,
): string {
  const tagged = extractTaggedResult(raw, 'continuation')
  if (!tagged || !isChineseContinuation(tagged)) return ''
  return normalizeContinueOutput(tagged, userName, charName, narrativeMode)
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

/** 最终输入框内容的独立篇幅目标；不参与剧情转折判断。 */
function continueLengthClause(length: ContinueLength, hasInput: boolean): string {
  const target = hasInput ? '以续写合并后的最终输入框内容为目标' : '以生成后的最终输入框内容为目标'
  switch (length) {
    case 'brief':
      return `- ${target}，保持精简，通常为一至两句；若原文已达到目标，只补必要收尾`
    case 'detailed':
      return `- ${target}，充分补充动作、氛围与因果，可写两到三个自然段`
    case 'extended':
      return `- ${target}，允许完整展开细节与过程，可写多个自然段`
    default:
      return `- ${target}，形成一个信息完整、节奏自然的短段落`
  }
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
- ${charName} 是当前故事焦点之一，但不要替 ${charName} 说话或完成详细心理与连续动作
- 不替 ${userName} 控制的玩家角色作重大选择，不一次解决当前冲突
- 保持既有时序、因果和叙述风格；没有输入时优先承接最近未解决的矛盾，不随机引入无关事件
- 不添加标题、“剧情建议”或解释
- 最终正文必须且只能放在一组 <continuation>...</continuation> 标签内，标签外不要输出任何内容`
  }

  const scope = immersiveScopeClause(intensity)
  if (hasInput) {
    return `你是一个角色扮演对话的用户视角续写助手。你的任务是以【用户 ${userName}】的身份和口吻，续写用户未完成的消息。\n\n严格要求：\n- 必须使用简体中文输出\n- 只输出 ${userName} 的话语，绝对不要输出 ${charName} 的话语\n- 不要以 ${charName} 的身份说话或行动\n- 不要包含角色名前缀，直接输出对话内容\n- 保持用户一贯的语气和风格\n${scope}\n${lengthClause}\n- 最终正文必须且只能放在一组 <continuation>...</continuation> 标签内，标签外不要输出任何内容`
  }
  return `你是一个角色扮演对话的用户视角续写助手。你的任务是以【用户 ${userName}】的身份和口吻，生成一条合适的用户回复。\n\n严格要求：\n- 必须使用简体中文输出\n- 只输出 ${userName} 的话语，绝对不要输出 ${charName} 的话语\n- 不要以 ${charName} 的身份说话或行动\n- 不要包含角色名前缀，直接输出对话内容\n- 保持用户一贯的语气和风格\n${scope}\n${lengthClause}\n- 最终正文必须且只能放在一组 <continuation>...</continuation> 标签内，标签外不要输出任何内容`
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
          ? `请以 ${userName} 的身份续写以下未完成的消息（直接接在后面的部分）：\n${originalInput}`
          : `请以 ${userName} 的身份根据上下文生成一条回复`),
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
  reasoningMode?: ChatParams['reasoningMode']
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
  const { messages, temperature, maxTokens, onChunk, reasoningMode, profile, activeModel, preset, activeRequestIds } = opts
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
    const unbindDone = window.api.ai.onDone((doneId) => {
      if (doneId !== requestId) return
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
      maxTokens: maxTokens ?? 800,
      frequencyPenalty: preset?.frequencyPenalty ?? 0,
      presencePenalty: preset?.presencePenalty ?? 0,
      stream: false,
      reasoningMode,
    }

    window.api.ai.chat(params).catch((err) => {
      cleanup()
      reject(err)
    })
  })
}
