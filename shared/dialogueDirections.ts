import type { ChatSession, DialogueDirection, DialogueTendency, GroupSession, NarrativeMode } from './types'
import { countVisibleCharacters } from './textMetrics'

/**
 * “下一步方向”的共享协议：会话开关解析、输出解析与校验。
 * 桌面端、群聊与桥接层共用同一实现，避免三端各自写一套降级逻辑。
 */

export const DIALOGUE_TENDENCIES: readonly DialogueTendency[] = ['safe', 'explore', 'risky']

/** 单个方向的数量与长度约束（见方案 §4.3）。 */
export const DIALOGUE_DIRECTION_LIMITS = {
  count: 3,
  labelMinChars: 6,
  labelMaxChars: 14,
  contentMinChars: 15,
  contentMaxChars: 60,
} as const

/**
 * 方向生成请求的输出预算：3 组 label+content（最多 3×(14+60) 个可见字符）
 * 加 JSON 结构与标签包裹，按中文最坏 2 token/字并留出余量封顶。
 * 与续写档位同理：预算不足会在结构尾部被切断，反而抬高“格式非法→重试”的失败率。
 */
export const DIALOGUE_DIRECTION_MAX_TOKENS = 640

/** 方向生成请求的采样温度。 */
export const DIALOGUE_DIRECTION_TEMPERATURE = 0.6

export function isDialogueTendency(value: unknown): value is DialogueTendency {
  return typeof value === 'string' && (DIALOGUE_TENDENCIES as readonly string[]).includes(value)
}

/**
 * 会话级开关的兼容解析：优先新字段，其次旧游戏主持字段，最后关闭。
 * 旧会话若开过游戏主持格式，升级后自动启用下一步方向。
 */
export function resolveDialogueDirectionsEnabled(
  session?: Pick<ChatSession | GroupSession, 'dialogueDirectionsEnabled' | 'gameMasterMode'> | null,
): boolean {
  if (!session) return false
  if (typeof session.dialogueDirectionsEnabled === 'boolean') return session.dialogueDirectionsEnabled
  if (typeof session.gameMasterMode === 'boolean') return session.gameMasterMode
  return false
}

/** 空白的兜底描述，允许模型在 JSON 外包裹统一标签。 */
export const DIALOGUE_DIRECTIONS_TAG = 'directions'

/**
 * 从辅助模型响应中提取 `<directions>` 内的 JSON 文本。
 * 缺失或重复标签均判无效，避免把分析过程或提示词当成业务数据。
 * 调用方应先把 thought 块剥离后再传入。
 */
export function extractDirectionsPayload(raw: string): string {
  const matches = Array.from(raw.matchAll(/<\s*directions\s*>([\s\S]*?)<\s*\/\s*directions\s*>/gi))
  if (matches.length !== 1) return ''
  return (matches[0][1] || '').trim()
}

function stripCodeFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1].trim() : text
}

/** 解释性前缀：命中即视为模型把说明当成了选项内容。 */
const EXPLANATORY_PREFIXES = [
  '选项', '建议你', '作为AI', '作为 AI', '以下是', '注意：', '提示：', '说明：',
]

function hasExplanatoryPrefix(text: string): boolean {
  const normalized = text.trim()
  return EXPLANATORY_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

/**
 * 解析并校验方向输出。任一条件不满足即整组作废（不渲染部分选项），
 * 校验项见方案 §4.3：数量、长度、倾向覆盖、重复度与解释性前缀。
 */
export function parseDialogueDirections(raw: string): DialogueDirection[] {
  const payload = stripCodeFence(extractDirectionsPayload(raw))
  if (!payload) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return []
  }
  if (!Array.isArray(parsed) || parsed.length !== DIALOGUE_DIRECTION_LIMITS.count) return []

  const seenTendencies = new Set<DialogueTendency>()
  const seenIds = new Set<string>()
  const directions: DialogueDirection[] = []

  for (const item of parsed) {
    if (!item || typeof item !== 'object') return []
    const { id, label, content, tendency } = item as Record<string, unknown>
    if (typeof label !== 'string' || typeof content !== 'string') return []
    if (!isDialogueTendency(tendency)) return []

    // id 由倾向派生，避免模型自造重复或不稳定的 id
    const resolvedId = typeof id === 'string' && id.trim() ? id.trim() : tendency
    if (seenIds.has(resolvedId) || seenTendencies.has(tendency)) return []
    seenIds.add(resolvedId)
    seenTendencies.add(tendency)

    const trimmedLabel = label.trim()
    const trimmedContent = content.trim()
    const labelChars = countVisibleCharacters(trimmedLabel)
    const contentChars = countVisibleCharacters(trimmedContent)
    if (labelChars < DIALOGUE_DIRECTION_LIMITS.labelMinChars || labelChars > DIALOGUE_DIRECTION_LIMITS.labelMaxChars) return []
    if (contentChars < DIALOGUE_DIRECTION_LIMITS.contentMinChars || contentChars > DIALOGUE_DIRECTION_LIMITS.contentMaxChars) return []
    if (hasExplanatoryPrefix(trimmedLabel) || hasExplanatoryPrefix(trimmedContent)) return []

    directions.push({ id: resolvedId, label: trimmedLabel, content: trimmedContent, tendency })
  }

  if (seenTendencies.size !== DIALOGUE_DIRECTION_LIMITS.count) return []
  if (hasSimilarDirections(directions)) return []

  // 稳定输出顺序，便于界面与测试断言
  return DIALOGUE_TENDENCIES.map((tendency) => directions.find((item) => item.tendency === tendency)!).filter(Boolean)
}

/** 归一化用于重复度比较：去空白、标点与大小写差异。 */
function normalizeForCompare(text: string): string {
  return text.replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】[\]—-]/g, '').toLowerCase()
}

/**
 * 基础重复度判定：三项两两比较，完全同形或字符集合高度重叠视为重复。
 * 不引入向量计算，只做文本归一化。
 */
export function hasSimilarDirections(directions: readonly DialogueDirection[]): boolean {
  const normalized = directions.map((item) => normalizeForCompare(`${item.label}${item.content}`))
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      const a = normalized[i]
      const b = normalized[j]
      if (!a || !b) continue
      if (a === b) return true
      const shorter = a.length <= b.length ? a : b
      const longer = a.length <= b.length ? b : a
      if (shorter.length >= 8 && longer.includes(shorter)) return true
      // 字符集合重叠率：短串字符有 90% 以上出现在长串中视为高度相似
      const chars = new Set(Array.from(longer))
      const overlap = Array.from(shorter).filter((char) => chars.has(char)).length
      if (shorter.length >= 10 && overlap / shorter.length >= 0.9) return true
    }
  }
  return false
}

/** 方向生成器的提示词上下文（见方案 §4.1 的注入边界）。 */
export interface DirectionGenerationInput {
  userName: string
  charName: string
  characterDescription: string
  /** 产生方向的那条消息的叙事模式快照，不是当前会话设置。 */
  narrativeMode: NarrativeMode
  /** 最近若干条有效对话，已按时间正序排列。 */
  recentMessages: Array<{ speaker: string; content: string }>
  /** 产生方向的最新 AI 回复正文。 */
  latestReply: string
  /** 世界状态精简片段；为空时不注入。 */
  worldState?: string
}

/**
 * 构造方向生成的 system 提示词。两种叙事模式分别约束 content 的叙事身份，
 * 不允许把 AI 正文改写成选项格式，也不注入世界书或完整预设。
 */
export function buildDialogueDirectionSystemPrompt(input: DirectionGenerationInput): string {
  const { userName, charName, narrativeMode } = input
  const identity = narrativeMode === 'omniscient'
    ? `当前采用全局叙事：${userName} 是故事外部的旁白、导演与世界推动者，方向内容应写成旁白式的剧情推动或世界变化，使用第三人称，不得写成某个角色的第一人称台词。`
    : `当前采用代入式角色扮演：${userName} 是玩家角色，方向内容应是玩家角色可以说的话或可以尝试的行动，用玩家视角口吻，不得替 ${charName} 或其他角色发言。`

  return `你是剧情推进助手，负责在 AI 回复之后提供 3 个风格不同的「下一步方向」，供用户挑选后继续对话。

${identity}

输出要求：
- 必须使用简体中文
- 只返回一组 <${DIALOGUE_DIRECTIONS_TAG}>...</${DIALOGUE_DIRECTIONS_TAG}> 标签，标签内是合法 JSON 数组，标签外不要输出任何内容
- 数组必须恰好 3 个元素，每个元素包含 id、label、content、tendency 四个字段
- label 是 6–14 个可见字符的短标签，概括这个方向要做什么
- content 是 15–60 个可见字符的可发送文本，用户点选后会直接进入输入框
- tendency 三个值必须各出现一次：safe（稳妥推进，承接主线减少风险）、explore（探索信息，追问观察调查试探）、risky（冒险变化，接受显著风险或改变计划）
- 三个方向必须有实质差异：分别对应 safe / explore / risky，不得只是同一句话的不同措辞
- 只描述接下来可以做什么，不要评价、建议或解释，不要写“选项 A”“建议你”“作为 AI”等前缀
- 不要泄露 ${userName} 的角色尚未知晓的幕后信息`
}

/** 构造方向生成的 user 提示词：最近对话 + 最新回复 + 精简世界状态。 */
export function buildDialogueDirectionUserPrompt(input: DirectionGenerationInput): string {
  const { userName, charName, characterDescription, recentMessages, latestReply, worldState } = input
  const lines: string[] = [
    `当前角色：${charName}`,
    `角色设定：${characterDescription || '无'}`,
  ]
  if (worldState?.trim()) lines.push(`当前世界状态（精简）：${worldState.trim()}`)
  if (recentMessages.length > 0) {
    lines.push('', '最近对话：')
    for (const message of recentMessages) {
      lines.push(`${message.speaker}：${message.content}`)
    }
  }
  lines.push('', `最新一条 AI 回复（${charName}）：`, latestReply.trim())
  lines.push('', `请据此给出 ${userName} 接下来可以选择的 3 个方向。`)
  return lines.join('\n')
}
