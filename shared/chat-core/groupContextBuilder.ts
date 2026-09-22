/**
 * 阶段 6 S6-01(c)：**群聊上下文完整装配**——跨端共享的纯逻辑（oracle）。
 *
 * 出处：PC `src/store/groupChatContext.ts#buildGroupChatContext` 的组装顺序
 * **逐步逐字**抽出（步骤 1–19：roster → turnRules → thought → 分层记忆 →
 * 群 systemPrompt → 世界书段 → 成员卡 → 用户人设 → at_end → 预设 → 叙事约束 →
 * 历史裁剪 → 压缩摘要 → 归属映射 → 深度插入 → 后历史 → instruct 前缀 → 合并/转换 → 宏）。
 *
 * 与 PC 的两点**刻意差异**（不影响组装语义）：
 * 1. 世界书 `executeLorebookRuntime` 的执行不在本函数内——触发/预算/掷骰由
 *    `shared/chat-core/lorebook.ts` 与 Kotlin `ChatLorebookRuntime` 各自已有跨语言
 *    golden 覆盖，这里只接收**已渲染的 render plan 段**并按 PC 位置拼装；
 * 2. 请求预算计划（resolveGroupRequestPlan）不在本函数内——由调用方先算好
 *    `requestMaxTokens` 传入（与 PC 的 reservedOutput 同义）。
 *
 * ⚠️ **PC 接线暂缺（P1-6-2 同源）**：`src/store/groupChatContext.ts` 有他方在途修改
 * 重叠，本轮不改该文件；fixture 钉住本实现，Kotlin 端由本实现对齐。
 */

import type { MemoryFactRecord } from '../types'
import { buildGroupRosterIntro, buildGroupTurnRulesPrompt } from '../groupChatPrompt'
import { buildGroupNarrativeModePrompt, resolveNarrativeMode } from '../narrativeMode'
import { buildThoughtContractBody } from '../thoughtContract'
import { replaceVariables } from './variables'
import { expandMacros, buildMacroContext } from './macros'
import { mergeConsecutiveMessages } from './messagePostProcess'
import { convertMessages } from './promptConverters'
import { resolveEffectiveTemplate } from './chatTemplates'
import { fitLayeredMemoryBudget, formatMemoryFacts } from './memory'
import { estimateTokens, estimateImageTokens } from './tokenCounter'
import { cropHistory, applyDepthInserts, type DepthInsertItem } from './contextShared'
import { TOKEN_BUDGET_SAFETY } from './chatConstants'
import {
  buildFreeMemberCards,
  buildTargetMemberCard,
  buildGroupUserPersona,
  mapGroupHistoryMessages,
  buildGroupPostHistoryInstructions,
  resolveGroupCharNameForVars,
  resolveShouldSendScenario,
  type GroupContextMember,
  type GroupPersonaInjection,
} from './groupContextBlocks'

/** 参与裁剪与归属映射的群消息最小结构。 */
export interface GroupContextMessage {
  characterId: string
  content: string
  images?: string[]
  timestamp: number
}

/** 世界书已渲染段（executeLorebookRuntime 的 render plan 输入面）。 */
export interface GroupLorebookPlan {
  beforeCharacter?: string[]
  afterCharacter?: string[]
  beforeExamples?: string[]
  afterExamples?: string[]
  promptEnd?: string[]
  authorsNoteTop?: string[]
  authorsNoteBottom?: string[]
  /** at_depth 深度注入项。 */
  chat?: Array<{ content: string; depth?: number; order?: number; role?: 'system' | 'user' | 'assistant' }>
}

export interface GroupContextPersona {
  name?: string
  description?: string
  persona?: string
}

export interface GroupContextBuildInput {
  group: {
    name: string
    chatMode: string
    systemPrompt?: string
    defaultNarrativeMode?: string
  }
  /** 成员按 memberIds 顺序（轮转顺序）；free 用全部，mention/polling 只注入 targetId。 */
  members: GroupContextMember[]
  /** mention/polling 的当前发言角色 id；free 为 null。 */
  targetId?: string | null
  session?: {
    personaId?: string | null
    narrativeMode?: string
    memoryEnabled?: boolean
    memory?: string
    memoryCurrentState?: string
    memoryFacts?: MemoryFactRecord[]
    compressedSummary?: string | null
    compressedRange?: { startTs: number; endTs: number } | null
  } | null
  messages: GroupContextMessage[]
  /** 已解析的用户身份字段（解析语义见 `resolveGroupPersonaFields`，单独 fixture 钉住）。 */
  userName: string
  userDescription?: string
  userPersona?: string
  personaInjection?: GroupPersonaInjection | null
  settings: {
    defaultNarrativeMode?: string
    enableThoughtFormat?: boolean
    omniscientNarrativeRules?: string
    scenarioInjectionMode?: string
    contextCompression?: { enabled?: boolean; minDropTokens?: number } | null
  }
  /** 语义检索命中的事实（有命中时只注入命中；无命中注入全量 memoryFacts）。 */
  semanticFacts?: Array<{ text: string; score: number } | string>
  preset?: {
    systemPrompt?: string
    jailbreak?: string
    contextTemplate?: string
  } | null
  profile?: {
    provider?: string
    useInstructTemplate?: boolean
  } | null
  model: string
  maxContext: number
  /** 请求输出预留（调用方经 resolveGroupRequestPlan 预算链得出；与 PC reservedOutput 同义）。 */
  requestMaxTokens: number
  lorebookPlan?: GroupLorebookPlan | null
  /** false 时不产出 pendingCompression（preview 口径）。 */
  trackUsage?: boolean
}

export type GroupContextMessageOut = {
  role: 'system' | 'user' | 'assistant'
  content: string
  images?: string[]
  keepSeparate?: boolean
}

export interface GroupContextBuildResult {
  messages: GroupContextMessageOut[]
  narrativeMode: string
  pendingCompression?: {
    droppedText: string
    droppedStartTs: number
    droppedEndTs: number
  }
}

/**
 * 用户身份解析（PC `buildGroupChatContext` 91–105 的会话身份/全局身份回退语义）：
 * - 会话显式 `personaId = null` → 不用身份（空名回退「用户」）；
 * - 会话未设置（undefined）→ 回退全局默认人设；
 * - 只有全局默认人设就是当前激活人设时才允许使用全局 userName/描述/性格字段。
 */
export function resolveGroupPersonaFields(input: {
  sessionPersonaId: string | null | undefined
  sessionPersonaIdDefined: boolean
  sessionPersona?: GroupContextPersona | null
  defaultPersonaId?: string | null
  activePersonaId?: string | null
  globalUserName?: string
  globalUserDescription?: string
  globalUserPersona?: string
}): { userName: string; userDescription: string; userPersona: string } {
  const sessionPersonaId = input.sessionPersonaIdDefined
    ? input.sessionPersonaId
    : input.defaultPersonaId
  const canUseGlobalPersonaFields = !!sessionPersonaId && input.activePersonaId === sessionPersonaId
  const userName = (
    input.sessionPersona?.name
    ?? (canUseGlobalPersonaFields ? (input.globalUserName ?? '') : '')
  ) || '用户'
  const userDescription = input.sessionPersona?.description
    ?? (canUseGlobalPersonaFields ? (input.globalUserDescription ?? '') : '')
  const userPersona = input.sessionPersona?.persona
    ?? (canUseGlobalPersonaFields ? (input.globalUserPersona ?? '') : '')
  return { userName, userDescription, userPersona }
}

/** PC 桌面 free 模式的【对话规则】兜底文案（turnRules 为空时使用；与桥接版有意不同）。 */
const FREE_DESKTOP_TURN_RULES =
  '\n【对话规则】你可以让多个角色参与对话。如果多个角色需要发言，请用「【角色名】」标注每段发言的发言人。\n'

export function buildGroupContextMessagesFromData(
  input: GroupContextBuildInput,
): GroupContextBuildResult {
  const { group, members, messages, settings } = input
  const plan = input.lorebookPlan ?? {}
  const model = input.model
  const target = input.targetId ? members.find((m) => m.id === input.targetId) : undefined
  const userName = input.userName
  const charNameForVars = resolveGroupCharNameForVars(target?.name, members)
  const userMessageCount = messages.filter((m) => m.characterId === '__user__').length
  const shouldSendScenario = resolveShouldSendScenario(settings.scenarioInjectionMode, userMessageCount)
  // 叙事模式：有会话用会话值（单候选回退 immersive）；无会话按群默认 → 全局默认
  const narrativeMode = input.session
    ? resolveNarrativeMode(input.session.narrativeMode)
    : resolveNarrativeMode(group.defaultNarrativeMode, settings.defaultNarrativeMode)

  // ---- 1–2. roster + 轮次规则 ----
  let systemContent = buildGroupRosterIntro(
    group.name,
    members.map((m) => ({ name: m.name, description: m.description })),
    userName,
  )
  const turnRules = buildGroupTurnRulesPrompt(group.chatMode as 'mention' | 'polling' | 'free')
  systemContent += turnRules || FREE_DESKTOP_TURN_RULES

  // ---- 3. thought 契约（思考主体恒绑定当前发言角色） ----
  if (settings.enableThoughtFormat !== false) {
    const focusName = target ? `「${target.translatedName || target.name}」` : ''
    systemContent += '\n【输出格式】' + buildThoughtContractBody({ narrativeMode, subjectName: focusName }) + '\n'
  }

  // ---- Token 预算框架（与单聊路径一致） ----
  const reservedOutput = input.requestMaxTokens
  const budgetBase = Math.max(
    Math.floor((input.maxContext - reservedOutput) * TOKEN_BUDGET_SAFETY),
    Math.floor(input.maxContext * 0.25),
  )

  // ---- 4. 分层长期记忆（当前状态 → 关键事实 → 时间线） ----
  if (input.session?.memoryEnabled) {
    const memoryBudget = Math.min(800, Math.floor(budgetBase * 0.1))
    const semanticFacts = input.semanticFacts ?? []
    const factsForInject: MemoryFactRecord[] = semanticFacts.length > 0
      ? semanticFacts.map((hit) => (typeof hit === 'string' ? hit : hit.text))
      : (input.session.memoryFacts ?? [])
    const semanticScores = semanticFacts.length > 0
      ? semanticFacts.map((hit) => (typeof hit === 'string' ? 0 : hit.score))
      : null
    const fitted = fitLayeredMemoryBudget(
      input.session.memoryCurrentState,
      input.session.memory || '',
      factsForInject,
      memoryBudget,
      estimateTokens,
      model,
      semanticScores,
    )
    if (fitted.currentState) {
      systemContent += '\n\n【当前状态】\n' + fitted.currentState
    }
    const memoryFactsText = formatMemoryFacts(fitted.facts)
    if (memoryFactsText) {
      systemContent += '\n\n【关键事实】\n' + memoryFactsText
    }
    if (fitted.timeline) {
      systemContent += '\n\n【群聊时间线】\n' + fitted.timeline
    }
  }

  // ---- 5. 群自定义 systemPrompt ----
  if (group.systemPrompt) {
    systemContent += '\n' + replaceVariables(group.systemPrompt, userName, charNameForVars) + '\n'
  }

  // ---- 6. 世界书段位置（执行在上游；此处只按 PC 位置拼装） ----
  const lorebookBefore = (plan.beforeCharacter ?? []).length > 0
    ? (plan.beforeCharacter ?? []).join('\n') + '\n'
    : ''
  const lorebookAfter = (plan.afterCharacter ?? []).length > 0
    ? (plan.afterCharacter ?? []).join('\n')
    : ''
  const lorebookAtEnd = (plan.promptEnd ?? []).length > 0
    ? '\n\n' + (plan.promptEnd ?? []).join('\n')
    : ''
  const atDepthItems = plan.chat ?? []

  // ---- 7. 成员卡（free 多成员 / 发言人聚焦） ----
  const cardsOpts = {
    userName,
    shouldSendScenario,
    lorebookBefore,
    lorebookAfter,
    exampleBefore: plan.beforeExamples ?? [],
    exampleAfter: plan.afterExamples ?? [],
  }
  if (group.chatMode === 'free') {
    systemContent += buildFreeMemberCards(members, cardsOpts)
  } else if (target) {
    systemContent += buildTargetMemberCard(target, cardsOpts)
  }

  // ---- 8. 用户人设 ----
  const personaText = buildGroupUserPersona({
    userName,
    userDescription: input.userDescription,
    userPersona: input.userPersona,
    charNameForVars,
    injection: input.personaInjection,
  })
  if (personaText && (input.personaInjection?.position ?? 'system') === 'system') {
    systemContent += '\n【用户人设】\n' + personaText
  }

  // ---- 9. 世界书 at_end ----
  if (lorebookAtEnd) {
    systemContent += lorebookAtEnd
  }

  // ---- 10. 预设 systemPrompt / jailbreak ----
  if (input.preset?.systemPrompt) {
    systemContent += '\n\n' + replaceVariables(input.preset.systemPrompt, userName, charNameForVars)
  }
  if (input.preset?.jailbreak && input.preset.jailbreak.trim()) {
    systemContent += '\n\n' + replaceVariables(input.preset.jailbreak, userName, charNameForVars)
  }

  // ---- 11. 最终叙事约束（与 chatMode 正交） ----
  systemContent += '\n\n' + buildGroupNarrativeModePrompt(
    narrativeMode,
    userName,
    charNameForVars || '当前角色',
    group.chatMode as 'mention' | 'polling' | 'free',
    settings.omniscientNarrativeRules,
  )

  // ---- 12–13. 历史预算与裁剪 ----
  let usedTokens = estimateTokens(systemContent, model)
  const postHistoryText = buildGroupPostHistoryInstructions({
    chatMode: group.chatMode,
    members,
    target: target ?? null,
    userName,
    charNameForVars,
  })
  if (postHistoryText) {
    usedTokens += estimateTokens(postHistoryText, model)
  }
  usedTokens += [...(plan.chat ?? []), ...(plan.authorsNoteBottom ?? [])]
    .reduce((sum, item) => sum + estimateTokens(typeof item === 'string' ? item : item.content, model), 0)
  const historyImageTokens = messages.reduce(
    (s, m) => s + (m.characterId === '__user__' ? estimateImageTokens(m.images?.length ?? 0) : 0),
    0,
  )
  usedTokens += historyImageTokens

  const { recent: recentMessages, droppedStartTs, droppedEndTs, droppedTokens, droppedEndIndex } = cropHistory(
    messages, usedTokens, budgetBase, model,
  )

  // ---- 14. 上下文溢出压缩摘要 ----
  const compression = settings.contextCompression ?? { enabled: true, minDropTokens: 2000 }
  let compressedSummaryInjected = ''
  let pendingCompression: GroupContextBuildResult['pendingCompression']
  const hasTimelineMemory = Boolean(input.session?.memory?.trim())
  if (compression.enabled !== false && !hasTimelineMemory && droppedTokens > 0 && input.session) {
    const covered = !!input.session.compressedSummary
      && !!input.session.compressedRange
      && droppedStartTs >= input.session.compressedRange.startTs
      && droppedEndTs <= input.session.compressedRange.endTs
    if (input.session.compressedSummary && covered) {
      compressedSummaryInjected = input.session.compressedSummary
    } else if (input.trackUsage !== false && droppedTokens >= (compression.minDropTokens ?? 2000)) {
      pendingCompression = {
        droppedText: droppedEndIndex >= 0
          ? messages.slice(0, droppedEndIndex + 1).map((m) => {
              if (m.characterId === '__user__') return `${userName}: ${m.content}`
              const c = members.find((mc) => mc.id === m.characterId)
              return `【${c?.name || '未知角色'}】${m.content}`
            }).join('\n')
          : '',
        droppedStartTs,
        droppedEndTs,
      }
    }
  }

  // ---- 15. 上下文数组：system（宏展开） → 作者注顶 → 人设 separate → 压缩摘要 → 历史 ----
  const context: GroupContextMessageOut[] = [
    {
      role: 'system',
      content: expandMacros(systemContent, buildMacroContext(
        messages.map((m) => ({
          role: (m.characterId === '__user__') ? 'user' as const : 'assistant' as const,
          content: m.content,
        })),
        { userName, charName: charNameForVars, groupName: group.name },
      )),
    },
  ]
  for (const content of plan.authorsNoteTop ?? []) {
    context.push({ role: 'system', content, keepSeparate: true })
  }
  if (personaText && input.personaInjection?.position === 'separate') {
    context.push({ role: 'system', content: '【用户人设】\n' + personaText, keepSeparate: true })
  }

  const historyContext: GroupContextMessageOut[] = []
  if (compressedSummaryInjected) {
    historyContext.push({
      role: 'system',
      content: '【早期对话压缩摘要】\n' + compressedSummaryInjected,
      keepSeparate: true,
    })
  }
  for (const entry of mapGroupHistoryMessages({
    messages: recentMessages.map((m) => ({ characterId: m.characterId, content: m.content, images: m.images })),
    members,
    userName,
    charNameForVars,
  })) {
    historyContext.push({
      role: entry.role,
      content: entry.content,
      ...(entry.images && entry.images.length > 0 ? { images: entry.images } : {}),
    })
  }

  // ---- 16. 深度插入（at_depth 世界书 + 作者注底 depth 0） ----
  const depthInserts: DepthInsertItem[] = atDepthItems.map((i) => ({
    content: i.content,
    depth: i.depth ?? 0,
    order: i.order ?? 0,
    role: i.role,
  }))
  ;(plan.authorsNoteBottom ?? []).forEach((content, index) => {
    depthInserts.push({ content, depth: 0, order: -2_000 + index })
  })
  const depthInjected = applyDepthInserts(
    historyContext,
    depthInserts,
    (content) => ({ role: 'system' as const, content, keepSeparate: true }),
    (content, role) => ({ role: (role ?? 'system') as 'system', content, keepSeparate: true }),
  )

  // ---- 17. 后历史指令 ----
  if (postHistoryText.trim()) {
    depthInjected.push({ role: 'system', content: postHistoryText.trim() })
  }

  // ---- 18. instruct 模板 assistant 前缀 ----
  const instructTemplate = resolveEffectiveTemplate(
    input.preset?.contextTemplate,
    input.profile?.provider || 'openai',
    model,
    input.profile?.useInstructTemplate,
  )
  if (instructTemplate?.appendAssistantPrefix && charNameForVars) {
    depthInjected.push({ role: 'assistant', content: '' })
  }

  // ---- 19. 合并连续消息 + 按 provider 转换 ----
  const provider = input.profile?.provider || 'openai'
  let processedContext = mergeConsecutiveMessages([...context, ...depthInjected])
  processedContext = convertMessages(provider, processedContext, {
    charName: charNameForVars || '角色',
    userName,
  })

  return {
    messages: processedContext,
    narrativeMode,
    ...(pendingCompression ? { pendingCompression } : {}),
  }
}
