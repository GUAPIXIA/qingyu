/**
 * 阶段 6 S6-01(c)：群上下文装配的**确定性文本块**——跨端共享的纯逻辑。
 *
 * 为什么必须共享：成员卡（free 多成员 / mention|polling 发言人聚焦）、用户人设、
 * 历史消息归属标注（用户无前缀 / 角色 `【名】` 前缀）、后历史指令与变量替换的
 * charName 口径，决定「同一段群聊在两端拼出的 prompt 是否逐字相同」。
 * 任何一处措辞漂移都会让同一会话两端输出不同，且无法从结果反查。
 *
 * 出处：从 PC `src/store/groupChatContext.ts#buildGroupChatContext` 的对应段
 * **逐字**抽出（含 scenarioInjectionMode 门控的工作区现行语义）。
 *
 * ⚠️ **PC 接线暂缺（P1-6-2）**：`src/store/groupChatContext.ts` 存在其他 Agent 的
 * 在途修改（scenarioInjectionMode 门控，+11/−2，与成员卡段重叠），本轮不改该文件；
 * PC 仍在内联实现同样逻辑。待在途修改合流后应把内联段替换为本模块调用，
 * 在那之前本模块与 PC 内联实现之间存在**已登记的**漂移风险（fixture 钉住本模块，
 * Kotlin 端由本模块对齐）。
 */

import { replaceVariables } from './variables'

export interface GroupContextMember {
  id: string
  name: string
  description?: string
  personality?: string
  scenario?: string
  systemPrompt?: string
  exampleDialog?: string
  postHistoryInstructions?: string
}

export interface GroupHistoryMessage {
  characterId: string
  content: string
  images?: readonly string[]
}

export interface GroupPersonaInjection {
  enabled?: boolean
  position?: 'system' | 'separate'
  includeDescription?: boolean
  includePersona?: boolean
}

/** 变量替换用的 charName：mention/polling 为目标角色名，free 为成员名「、」连接。 */
export function resolveGroupCharNameForVars(
  targetName: string | undefined,
  members: readonly GroupContextMember[],
): string {
  return targetName || members.map((m) => m.name).join('、')
}

/**
 * 场景注入门控（scenarioInjectionMode）：
 * `off` 从不注入；`first_turn` 仅首轮（用户消息 ≤ 1 条，本轮用户消息已入列）；`always` 总是。
 */
export function resolveShouldSendScenario(
  scenarioInjectionMode: string | null | undefined,
  userMessageCount: number,
): boolean {
  const mode = scenarioInjectionMode ?? 'first_turn'
  return mode !== 'off' && (mode !== 'first_turn' || userMessageCount <= 1)
}

export interface MemberCardsOptions {
  userName: string
  shouldSendScenario: boolean
  /** 世界书 beforeCharacter 段（拼在角色卡前）。 */
  lorebookBefore?: string
  /** 世界书 afterCharacter 段（拼在角色卡后）。 */
  lorebookAfter?: string
  /** 世界书示例前锚点（存在任一锚点时示例集中重排）。 */
  exampleBefore?: readonly string[]
  /** 世界书示例后锚点。 */
  exampleAfter?: readonly string[]
}

/**
 * free（多成员）角色卡块。**返回值自带前导 `\n\n` 与 lorebookBefore**，
 * 与 PC `systemContent +=` 的拼接语义逐字一致。
 */
export function buildFreeMemberCards(
  members: readonly GroupContextMember[],
  opts: MemberCardsOptions,
): string {
  const { userName, shouldSendScenario } = opts
  const lorebookBefore = opts.lorebookBefore ?? ''
  const lorebookAfter = opts.lorebookAfter ?? ''
  const exampleBefore = opts.exampleBefore ?? []
  const exampleAfter = opts.exampleAfter ?? []
  const hasExampleAnchors = exampleBefore.length > 0 || exampleAfter.length > 0

  let out = '\n\n' + lorebookBefore + '以下是所有角色的完整设定：\n'
  for (const m of members) {
    out += `\n--- ${m.name} ---\n`
    if (m.description) out += `描述：${replaceVariables(m.description, userName, m.name)}\n`
    if (m.personality) out += `性格：${replaceVariables(m.personality, userName, m.name)}\n`
    if (shouldSendScenario && m.scenario) out += `场景：${replaceVariables(m.scenario, userName, m.name)}\n`
    if (m.systemPrompt) out += `\n${replaceVariables(m.systemPrompt, userName, m.name)}\n`
    if (!hasExampleAnchors && m.exampleDialog) {
      out += `\n对话示例：\n${replaceVariables(m.exampleDialog, userName, m.name)}\n`
    }
  }
  if (hasExampleAnchors) {
    if (exampleBefore.length > 0) out += '\n' + exampleBefore.join('\n') + '\n'
    for (const m of members) {
      if (m.exampleDialog) out += `\n对话示例（${m.name}）：\n${replaceVariables(m.exampleDialog, userName, m.name)}\n`
    }
    if (exampleAfter.length > 0) out += '\n' + exampleAfter.join('\n') + '\n'
  }
  if (lorebookAfter) out += '\n' + lorebookAfter
  return out
}

/**
 * mention/polling（发言人聚焦）角色卡块。与 free 版的差异（语义钉子）：
 * 示例段**始终**用「对话示例：」（不带成员名），且有示例锚点时由锚点包裹。
 * 返回值自带前导 `\n\n` 与 lorebookBefore。
 */
export function buildTargetMemberCard(
  target: GroupContextMember,
  opts: MemberCardsOptions,
): string {
  const { userName, shouldSendScenario } = opts
  const lorebookBefore = opts.lorebookBefore ?? ''
  const lorebookAfter = opts.lorebookAfter ?? ''
  const exampleBefore = opts.exampleBefore ?? []
  const exampleAfter = opts.exampleAfter ?? []

  let out = `\n\n${lorebookBefore}【当前发言角色：${target.name}】\n`
  if (target.description) out += `描述：${replaceVariables(target.description, userName, target.name)}\n`
  if (target.personality) out += `性格：${replaceVariables(target.personality, userName, target.name)}\n`
  if (shouldSendScenario && target.scenario) out += `场景：${replaceVariables(target.scenario, userName, target.name)}\n`
  if (target.systemPrompt) out += `\n${replaceVariables(target.systemPrompt, userName, target.name)}\n`
  if (exampleBefore.length > 0) out += '\n' + exampleBefore.join('\n') + '\n'
  if (target.exampleDialog) out += `\n对话示例：\n${replaceVariables(target.exampleDialog, userName, target.name)}\n`
  if (exampleAfter.length > 0) out += '\n' + exampleAfter.join('\n') + '\n'
  if (lorebookAfter) out += '\n' + lorebookAfter
  return out
}

/**
 * 用户人设正文（不含 `【用户人设】` 标题——标题由调用方按注入位置补，
 * system 位置前带 `\n`，separate 位置不带）。
 * `includeDescription` / `includePersona` 缺省视为 true（PC `!== false` 语义）。
 */
export function buildGroupUserPersona(input: {
  userName: string
  userDescription?: string
  userPersona?: string
  charNameForVars: string
  injection?: GroupPersonaInjection | null
}): string {
  const injection = input.injection ?? { enabled: true }
  if (!injection.enabled) return ''
  let text = `用户名：${input.userName}\n`
  if (injection.includeDescription !== false && input.userDescription) {
    text += `描述：${replaceVariables(input.userDescription, input.userName, input.charNameForVars)}\n`
  }
  if (injection.includePersona !== false && input.userPersona) {
    text += `性格：${replaceVariables(input.userPersona, input.userName, input.charNameForVars)}\n`
  }
  return text
}

export interface GroupHistoryEntry {
  role: 'user' | 'assistant'
  content: string
  images?: string[]
}

/**
 * 历史消息 → prompt 消息的归属标注（语义钉子）：
 * - 空正文整条跳过；
 * - 用户消息：变量替换后**无名字前缀**，图片随消息；
 * - 角色消息：前缀 `【成员名|未知角色】`，变量替换用该**发言者名**做 charName。
 */
export function mapGroupHistoryMessages(input: {
  messages: readonly GroupHistoryMessage[]
  members: readonly GroupContextMember[]
  userName: string
  charNameForVars: string
}): GroupHistoryEntry[] {
  const out: GroupHistoryEntry[] = []
  for (const m of input.messages) {
    if (!m.content || !m.content.trim()) continue
    const char = input.members.find((c) => c.id === m.characterId)
    const speaker = m.characterId === '__user__' ? input.userName : (char?.name || '未知角色')
    if (m.characterId === '__user__') {
      const entry: GroupHistoryEntry = {
        role: 'user',
        content: replaceVariables(m.content, input.userName, input.charNameForVars),
      }
      if (m.images && m.images.length > 0) entry.images = [...m.images]
      out.push(entry)
    } else {
      out.push({
        role: 'assistant',
        content: `【${speaker}】${replaceVariables(m.content, input.userName, speaker)}`,
      })
    }
  }
  return out
}

/**
 * 后历史指令（postHistoryInstructions）：
 * free = 全部成员逐条拼接（每条后带 `\n`，变量替换用**该成员名**）；
 * mention/polling = 仅目标角色（变量替换用 charNameForVars）。
 * 返回原文（可能带尾部换行）；调用方按 PC 口径 `trim()` 后注入。
 */
export function buildGroupPostHistoryInstructions(input: {
  chatMode: string
  members: readonly GroupContextMember[]
  /** mention/polling 的当前发言角色（free 忽略）。 */
  target?: GroupContextMember | null
  userName: string
  charNameForVars: string
}): string {
  if (input.chatMode === 'free') {
    let text = ''
    for (const m of input.members) {
      if (m.postHistoryInstructions) text += replaceVariables(m.postHistoryInstructions, input.userName, m.name) + '\n'
    }
    return text
  }
  return input.target?.postHistoryInstructions
    ? replaceVariables(input.target.postHistoryInstructions, input.userName, input.charNameForVars)
    : ''
}
