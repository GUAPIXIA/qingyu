/**
 * 阶段 0b：上下文组装纯模块（方案「安卓伴侣端方案」§7 阶段 0b）。
 *
 * 从 src/store/chatContext.ts 的 buildChatContext 迁移而来：
 * - 不再接收 get/set（store 方法引用），改为接收 ContextDataProvider 拉取的
 *   ContextBuildData（数据访问层，阶段 0a）；
 * - 纯函数、无 store 依赖，渲染层与主进程桥接层共用同一入口，
 *   从根上消除"两端行为漂移"（配合防漂移快照测试）；
 * - 返回 { messages, lastContextUsage, pendingCompression? }：
 *   lastContextUsage / pendingCompression 由调用方写回 store（本模块不触碰 store）。
 *
 * 行为对齐：逻辑逐行迁移自 buildChatContext（get()/set()/useSettingsStore/lorebookCache
 * 引用替换为 data 字段），仅 markPendingCompression 改为返回待处理项。
 */

import type { ChatParams, Character, LorebookTimedEffectsState, NarrativeMode, ResponseLengthMode, ResponsePolicy, Settings } from '../types'
import type { ContextBuildData, SemanticLoreHit } from '../contextTypes'
import { buildNarrativeModePrompt, resolveNarrativeMode } from '../narrativeMode'
import { buildThoughtContractBody } from '../thoughtContract'
import { collectRecentAssistantChars, detectUserLengthIntent, resolveResponsePolicy, resolveSceneFactor } from '../responsePolicy'
import type { RequestBudget } from '../modelOutputProfile'
import { resolveGenerationTaskBudget } from '../generationTaskBudget'
import { estimateTokens, getDefaultMaxContext, estimateImageTokens } from './tokenCounter'
import { replaceVariables } from './variables'
import { resolveEffectiveTemplate } from './chatTemplates'
import { mergeConsecutiveMessages } from './messagePostProcess'
import { convertMessages } from './promptConverters'
import { fitLayeredMemoryBudget, formatMemoryFacts, memoryFactToText } from './memory'
import { expandMacros, buildMacroContext } from './macros'
import {
  executeLorebookRuntime,
  type LorebookCompressionRequest,
  type LorebookDiagnostics,
  type LorebookScoredEntrySnapshot,
} from './lorebook'
import { emptyLorebookRenderPlan, type LorebookRenderPlan } from './lorebookRenderer'
import { logInfo, logWarn } from './logging'
import {
  DEFAULT_LOREBOOK_RATIO,
  DEFAULT_LOREBOOK_SCAN_DEPTH,
  resolveLorebookScanDepth,
  TOKEN_BUDGET_SAFETY,
} from './chatConstants'
import { cropHistory, applyDepthInserts, type DepthInsertItem } from './contextShared'
import type { ContextMessage } from './chatTypes'
import {
  createContextShadowCollector,
  formatContextShadowSummary,
  type ContextShadowNote,
  type ContextShadowReport,
} from './contextShadow'
import type { ContextCandidateKind } from './contextCandidates'
import { allocateContextCandidates } from './contextCandidates'
import {
  buildMemoryCandidateSet,
  buildMemoryShadowReport,
  formatMemoryShadowSummary,
  materializeMemoryInjection,
  type MemoryCandidateSet,
  type MemoryInjectionStats,
  type MemoryShadowReport,
} from './memoryCandidates'
import {
  buildWorldbookCandidateSet,
  buildWorldbookShadowReport,
  formatWorldbookShadowSummary,
  summarizeWorldbookInjection,
  type WorldbookCandidateSet,
  type WorldbookShadowReport,
} from './worldbookCandidates'
import {
  auditMessagesAsSerializedInput,
  formatHistoryDegradationSummary,
  planHistoryDegradation,
  type HistoryDegradationPlan,
} from './historyDegradation'
import type { SerializedInputAudit } from './inputAudit'

/** 组装选项（对齐原 buildChatContext 的 opts） */
export interface BuildOptions {
  continuation?: boolean
  /** 续写既有消息时使用该消息记录的模式，避免会话切换后改变叙事身份。 */
  narrativeMode?: NarrativeMode
  generationType?: 'normal' | 'continue' | 'impersonate' | 'swipe' | 'regenerate' | 'quiet'
  lorebookDiagnosticsMode?: 'live' | 'preview'
  /**
   * W7（主计划 §7.9）：上下文候选影子运行。**W11 后默认关闭**——生产不再记录分类影子；
   * 仅显式 `'shadow'` 用于测试/诊断（§7.14 第 3 条：删除完成使命的默认 shadow 记录）。
   * `'off'` 等价缺省，保留兼容。
   */
  shadow?: 'shadow' | 'off'
}

/** 待异步执行的上下文压缩任务（原 markPendingCompression 的入参） */
export interface PendingCompression {
  characterId: string
  sessionId: string
  droppedText: string
  droppedStartTs: number
  droppedEndTs: number
}

/** 组装结果：消息 + 用量记录 + 可选压缩任务 + 世界书触发键/压缩请求（均由调用方写回 store） */
export interface BuildResult {
  messages: ContextMessage[]
  lastContextUsage: { used: number; max: number }
  /** 本轮篇幅策略（session > preset > auto 解析结果，阶段二提示注入复用） */
  responsePolicy: ResponsePolicy
  /**
   * 本轮请求 max_tokens：与上下文预算的输出预留同源（resolveChatRequestPlan 单次计算），
   * 调用方必须直接使用该值，禁止按 preset.maxTokens 二次推导。
   */
  requestMaxTokens: number
  /** 本轮请求预算明细（正文预算 / 推理余量 / 风险提示，供诊断与界面提示） */
  requestBudget: RequestBudget
  /** S5：本轮识别出的用户篇幅要求（写入观测，便于核对误判） */
  responseIntent: ResponseLengthMode | null
  /** S5：自动模式场景系数（未参与计算时为 1） */
  sceneFactor: number
  /** 本次上下文实际采用的叙事模式，供调试界面展示。 */
  narrativeMode: NarrativeMode
  pendingCompression?: PendingCompression
  /** 本轮触发的世界书条目 key（阶段二B recency 窗口更新用） */
  lorebookTriggeredIds?: string[]
  /** 世界书超限压缩请求（阶段三：调用方异步 AI 压缩后写入会话缓存） */
  lorebookCompressions?: LorebookCompressionRequest[]
  lorebookCompressionCacheHitKeys?: string[]
  lorebookTimedEffects?: LorebookTimedEffectsState
  lorebookDiagnostics?: LorebookDiagnostics
  /**
   * W7（§7.9）：本轮上下文影子分配差异（只含分类计数与 token，不含任何正文）。
   * `shadow: 'off'` 或缺省关闭时为 undefined；调用方按需写入观测/诊断，不参与注入决策。
   */
  contextShadow?: ContextShadowReport
  /**
   * W8（§7.10，G1 后接管）：本轮记忆注入统计（候选分配）。
   * 只含分层计数与 token，不含记忆正文。
   */
  memoryShadow?: MemoryShadowReport
  /**
   * W9（§7.11）：世界书逐条评分影子（既有固定比例 vs always→mandatory + 统一剩余预算）。
   * 不含条目正文；生产注入仍由 `executeLorebookRuntime` 分桶瀑布决定。
   */
  worldbookShadow?: WorldbookShadowReport
  /**
   * W9（§7.11）：历史分级降级影子（摘要替代 → 再删原文）。
   * 不改 `cropHistory` 产出的 messages。
   */
  historyDegradation?: HistoryDegradationPlan
  /**
   * W9（§7.11/§5.6）：序列化后输入审计（当前为估算视图，`serialized:false`）。
   * 超限只报告，不在本层裁剪。
   */
  inputAudit?: SerializedInputAudit
}

/**
 * 主对话输出约束（阶段二「替换主对话提示约束」）：
 * 用"一个互动回合"的语义停止规则取代固定 2–6 段、每轮必有对白、动作必加星号等机械协议。
 * 篇幅数字来自 ResponsePolicy（阶段一），只作为软目标——语义完整和自然收尾优先，不为凑字数重复。
 * 展示样式（星号、说话人前缀）由渲染层负责，不再要求模型手写。
 */
export function buildMainChatOutputPrompt(policy: ResponsePolicy): string {
  const beatText = policy.maxNewBeats <= 1 ? '一个' : '两个'
  return `【本轮回应范围】
- 只完成一个自然互动回合：先回应最近输入，再最多推进${beatText}主要事件、信息或情绪变化。
- 推进到需要用户回应、选择或行动的位置就停止；不要连续代写下一轮，也不要自动写完整个场景。
- 本轮正文通常为 ${policy.preferredMinChars}–${policy.preferredMaxChars} 个可见字符；语义完整和自然收尾优先，不为凑字数重复。
- 不得与最近对话的既有事实、已完成动作或已说过的信息矛盾或重复；新引入的信息要能从当前场景自然推出。
- 接近篇幅上限时停止引入新信息，完成当前句，并在完整对白、动作或观察后结束。
- 除非用户明确要求，不做总结、尾声、未来预告，也不同时开启第二条支线。

【正文结构】
- 按说话、动作或叙事焦点的自然变化分段；短回应可以只有一个段落。
- 对白使用中文引号；动作和环境用普通叙述段落。不要为了排版重复角色名。
- 不输出标题、列表、代码块、创作说明或写作计划。
- 不把角色心理活动混入正文；启用 <thought> 时严格遵循单独的内心想法契约。`
}

/**
 * 解析本轮篇幅策略与请求输出预算（阶段一「对话输出弹性约束」）。
 *
 * 唯一推导入口：上下文构建的输出预留与实际请求的 max_tokens 必须共用同一结果，
 * 禁止调用方按 preset.maxTokens 二次推导。
 * 优先级（S5）：用户本轮明确要求 > 会话篇幅 > 预设提示 > 自动（含场景系数）。
 */
export interface ChatRequestPlan {
  responsePolicy: ResponsePolicy
  requestBudget: RequestBudget
  requestMaxTokens: number
  /** S5：本轮用户文本中识别出的篇幅要求（未识别为 null） */
  responseIntent: ResponseLengthMode | null
  /** S5：自动模式场景系数（非 auto 模式不参与计算） */
  sceneFactor: number
}

export function resolveChatRequestPlan(data: ContextBuildData): ChatRequestPlan {
  const settings = data.settings.settings
  const profile = data.settings.profile
  // 模型解析与实际请求一致（activeModel 优先，切换档案时二者本就同步）
  const model = settings.activeModel || profile?.model || 'gpt-4o-mini'
  const session = data.chat.sessions.find((s) => s.id === data.chat.currentSessionId)
  // S5：本轮意图取最新一条用户消息；场景系数只依赖确定事件（首轮/明确转场/短问句）
  const latestUserText = [...data.chat.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const hasAssistantReply = data.chat.messages.some((m) => m.role === 'assistant' && !!m.content?.trim())
  const responseIntent = detectUserLengthIntent(latestUserText)
  const sceneFactor = resolveSceneFactor({ latestUserText, hasAssistantReply })
  const responsePolicy = resolveResponsePolicy({
    sessionMode: session?.responseLengthMode,
    presetHint: data.preset?.responseLengthHint,
    userIntent: responseIntent,
    sceneFactor,
    recentAssistantVisibleChars: collectRecentAssistantChars(data.chat.messages),
  })
  const requestBudget = resolveGenerationTaskBudget({
    task: 'main',
    model,
    expectedBodyChars: responsePolicy.hardMaxChars,
    userHardCap: data.preset?.maxTokens,
    // W1（主计划 §7.3）：按端点/model/task 回读的近期推理样本（缺省 = 档案默认余量）
    ...(data.reasoningSamples?.length ? { recentReasoningTokens: data.reasoningSamples } : {}),
    // 阶段8（§4.2）：门控在场时推理项取 gateTokens（可信 = 承诺值；不可信/无门控 = 保守余量）
    ...(data.reasoningGate ? { reasoningGate: data.reasoningGate } : {}),
  })
  return {
    responsePolicy,
    requestBudget,
    requestMaxTokens: requestBudget.requestMaxTokens,
    responseIntent,
    sceneFactor,
  }
}

/**
 * W8 接管：对记忆候选跑一次确定性分配并返回入选 id（与物化同源）。
 */
function allocateMemorySelectedIds(plan: MemoryCandidateSet, budgetTokens: number): string[] {
  return allocateContextCandidates(plan.candidates, { budgetTokens }).selectedIds
}

/**
 * 从数据快照组装发送给 AI 的完整上下文。
 * 与迁移前 buildChatContext 行为逐字段一致（防漂移快照测试锁定）。
 */
export function buildContextMessagesFromData(
  data: ContextBuildData,
  opts?: BuildOptions,
): BuildResult {
  const settings: Settings = data.settings.settings
  const profile = data.settings.profile
  const character = data.character ?? ({} as Character)
  const preset = data.preset
  const userName = settings.userName || '用户'
  // 模型解析与实际请求一致（activeModel 优先，切换档案时二者本就同步）。
  // W7 起在函数入口解析：影子采集的 token 估算与后续预算共用同一模型口径。
  const model = settings.activeModel || profile?.model || 'gpt-4o-mini'

  // ===== W7/W11：影子默认关闭；仅 opts.shadow === 'shadow' 时采集 =====
  // 采集器不持有消息数组、不返回任何要发送的文本，因此不可能改变 messages / maxTokens。
  const shadow = opts?.shadow === 'shadow'
    ? createContextShadowCollector({ model })
    : null
  const noteShadow = (kind: ContextCandidateKind, id: string, note: ContextShadowNote): void => {
    shadow?.note(kind, id, note)
  }

  // 修复 #8: 保留图片消息（content 为空但有 images 时不丢弃）
  const messages = data.chat.messages.filter(
    (m) => (m.content || (m.images && m.images.length > 0)) && m.role !== 'system',
  )
  const context: ContextMessage[] = []
  const { sessions, currentSessionId } = data.chat
  const currentSession = sessions.find(s => s.id === currentSessionId)
  // 旧会话缺少字段时固定按 immersive 运行，避免后来修改默认值导致旧故事静默换模式。
  // 无当前会话的预览/测试场景才使用角色与全局默认值。
  const sessionNarrativeMode = currentSession
    ? resolveNarrativeMode(currentSession.narrativeMode)
    : resolveNarrativeMode(character.defaultNarrativeMode, settings.defaultNarrativeMode)
  const narrativeMode = resolveNarrativeMode(opts?.narrativeMode, sessionNarrativeMode)

  // ===== System Prompt 构建 =====
  const charNameForVars = character.translatedContent?.name || character.name
  let systemContent = replaceVariables(
    character.systemPrompt || preset?.systemPrompt || '你是一个沉浸式互动叙事助手。请根据角色与世界设定持续创作，保持人物和情节的一致性。',
    userName,
    charNameForVars,
  )
  noteShadow('protocol', 'protocol:system-prompt', {
    text: systemContent, mandatory: true, stablePrefix: true,
  })

  // jailbreak 改为可选（修复 #32）：只在 preset 有 jailbreak 且非空时附加
  if (preset?.jailbreak && preset.jailbreak.trim()) {
    const jailbreakText = replaceVariables(preset.jailbreak, userName, charNameForVars)
    systemContent += '\n\n' + jailbreakText
    noteShadow('protocol', 'protocol:jailbreak', {
      text: jailbreakText, mandatory: true, stablePrefix: true,
    })
  }

  // 叙事模式是独立于角色卡和预设的最终行为约束，确保自定义预设也能正确切换。
  const narrativeModePrompt = buildNarrativeModePrompt(
    narrativeMode,
    userName,
    charNameForVars,
    settings.omniscientNarrativeRules,
  )
  systemContent += '\n\n' + narrativeModePrompt
  noteShadow('protocol', 'protocol:narrative-mode', {
    text: narrativeModePrompt, mandatory: true, stablePrefix: true,
  })

  // 用户人设注入（可配置：开关 / 位置 / 字段，对齐 ST 的 persona placement）
  const personaInjection = settings.personaInjection
    ?? { enabled: true, position: 'system' as const, includeDescription: true, includePersona: true }
  let personaText = ''
  if (personaInjection.enabled) {
    personaText += '用户名：' + userName
    if (personaInjection.includeDescription !== false && settings.userDescription) {
      personaText += '\n描述：' + replaceVariables(settings.userDescription, userName, charNameForVars)
    }
    if (personaInjection.includePersona !== false && settings.userPersona) {
      personaText += '\n性格：' + replaceVariables(settings.userPersona, userName, charNameForVars)
    }
    if (personaText && personaInjection.position === 'system') {
      systemContent += '\n\n【用户人设】\n' + personaText
    }
  }
  if (personaText) {
    noteShadow('character', 'character:user-persona', {
      text: personaText, relevance: 0.6, recency: 1, importance: 0.7, continuity: 0.8,
      origin: `persona:${personaInjection.position}`,
    })
  }

  // 心理描写输出格式（修复 #33）：可配置，默认开启
  // 阶段7（§5.1）：thought 角色第一人称契约固化进共享提示来源，单聊与群聊不得各自漂移
  // 两种叙事模式都必须点名思考主体：全局叙事下焦点角色即当前聊天角色，避免模型写成旁白视角
  const enableThoughtFormat = preset?.enableThoughtFormat ?? (settings.enableThoughtFormat !== false)
  if (enableThoughtFormat) {
    const thoughtContractBody = buildThoughtContractBody({
      narrativeMode,
      subjectName: narrativeMode === 'omniscient' ? `「${charNameForVars}」` : charNameForVars,
    })
    systemContent += '\n\n【输出格式要求】\n' + thoughtContractBody
    noteShadow('protocol', 'protocol:thought-system', {
      text: thoughtContractBody, mandatory: true, stablePrefix: true,
    })
  }

  // ===== Token 预算框架 =====
  // budgetBase = (maxContext − 输出预留) × 安全余量；世界书预算取其一定比例，剩余给历史
  // 输出预留：阶段一起由篇幅策略 + 模型能力档案单次计算（resolveChatRequestPlan），
  // 与实际请求的 max_tokens 同源；不再对 DeepSeek V4 固定放大到 8192。
  // 模型解析与实际请求一致（activeModel 优先，切换档案时二者本就同步）
  const maxContext = profile?.maxContext || preset?.maxContext || getDefaultMaxContext(model)
  const plan = resolveChatRequestPlan(data)
  const reservedOutput = plan.requestMaxTokens
  // 下限保护：maxTokens 配置过大时至少保留 25% 上下文预算
  const budgetBase = Math.max(
    Math.floor((maxContext - reservedOutput) * TOKEN_BUDGET_SAFETY),
    Math.floor(maxContext * 0.25),
  )

  // ===== W8 接管（§7.10，G1 通过后）：候选动态分配取代 fitLayeredMemoryBudget 固定上限 =====
  // 注入顺序仍：当前状态 → 关键事实 → 时间线。分配预算 = budgetBase（统一输入池，无 800/10% 专属上限）。
  // 分配/物化异常：回落 fitLayeredMemoryBudget(min(800, budgetBase*0.1))，存储永不删除。
  let memoryShadowPlan: MemoryCandidateSet | null = null
  let memoryShadowExisting: MemoryInjectionStats | null = null
  let memoryTakeoverSelectedIds: ReadonlySet<string> | null = null
  if (currentSession?.memoryEnabled) {
    const memoryBudget = Math.min(800, Math.floor(budgetBase * 0.1))
    const semanticFacts = data.chat.semanticFactsHits
    const factsForInject = semanticFacts.length > 0
      ? semanticFacts.map((hit) => typeof hit === 'string' ? hit : hit.text)
      : (currentSession.memoryFacts ?? [])
    const semanticScores = semanticFacts.length > 0
      ? semanticFacts.map((hit) => typeof hit === 'string' ? 0 : hit.score)
      : null

    let injected = false
    try {
      const plan = buildMemoryCandidateSet({
        currentState: currentSession.memoryCurrentState,
        timeline: currentSession.memory || '',
        facts: factsForInject,
        semanticScores,
        model,
      })
      const selectedIds = allocateMemorySelectedIds(plan, budgetBase)
      const materialized = materializeMemoryInjection(
        plan,
        selectedIds,
        {
          currentState: currentSession.memoryCurrentState,
          facts: factsForInject,
          timeline: currentSession.memory || '',
          semanticScores,
          model,
        },
      )
      if (materialized.currentState) {
        systemContent += '\n\n【当前状态】\n' + materialized.currentState
      }
      const factsText = formatMemoryFacts(materialized.facts)
      if (factsText) {
        systemContent += '\n\n【关键事实】\n' + factsText
      }
      if (materialized.timeline) {
        systemContent += '\n\n【对话时间线】\n' + materialized.timeline
      }
      memoryShadowPlan = plan
      memoryTakeoverSelectedIds = new Set(selectedIds)
      const selectedSet = memoryTakeoverSelectedIds
      const timelineSelected = plan.candidates.filter(
        (c) => selectedSet.has(c.id) && c.origin === 'memory:timeline',
      )
      memoryShadowExisting = {
        capTokens: budgetBase,
        stateTokens: materialized.currentState ? estimateTokens(materialized.currentState, model) : 0,
        factCount: materialized.facts.length,
        factTokens: materialized.facts.reduce((sum, f) => sum + estimateTokens(memoryFactToText(f), model), 0),
        timelineChunkCount: timelineSelected.length,
        timelineTokens: timelineSelected.reduce((sum, c) => sum + c.estimatedTokens, 0),
        totalTokens: timelineSelected.reduce(
          (sum, c) => sum + c.estimatedTokens,
          (materialized.currentState ? estimateTokens(materialized.currentState, model) : 0)
            + materialized.facts.reduce((s, f) => s + estimateTokens(memoryFactToText(f), model), 0),
        ),
        retrievalMode: materialized.retrievalMode,
      }
      injected = true
    } catch (error) {
      injected = false
      logWarn('buildContext', `记忆候选注入失败，回落 fitLayeredMemoryBudget：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!injected) {
      // 回滚路径：固定上限分层预算（§7.10 第 2 条）
      const fitted = fitLayeredMemoryBudget(
        currentSession.memoryCurrentState,
        currentSession.memory || '',
        factsForInject,
        memoryBudget,
        estimateTokens,
        model,
        semanticScores,
      )
      if (fitted.retrievalMode === 'fallback' && factsForInject.length > 0) {
        logInfo('buildContext', `记忆检索降级 fallback：向量缺失/语义为空，按 importance+recency 排序（facts=${factsForInject.length}）`)
      }
      if (fitted.currentState) {
        systemContent += '\n\n【当前状态】\n' + fitted.currentState
      }
      const factsText = formatMemoryFacts(fitted.facts)
      if (factsText) {
        systemContent += '\n\n【关键事实】\n' + factsText
      }
      if (fitted.timeline) {
        systemContent += '\n\n【对话时间线】\n' + fitted.timeline
      }
      if (shadow) {
        const fallbackPlan = buildMemoryCandidateSet({
          currentState: fitted.currentState,
          timeline: fitted.timeline,
          facts: fitted.facts,
          semanticScores: null,
          model,
        })
        for (const candidate of fallbackPlan.candidates) shadow.noteCandidate(candidate)
        memoryShadowPlan = fallbackPlan
        memoryShadowExisting = {
          capTokens: memoryBudget,
          stateTokens: fallbackPlan.described.stateTokens,
          factCount: fallbackPlan.described.factCount,
          factTokens: fallbackPlan.described.factTokens,
          timelineChunkCount: fallbackPlan.described.timelineChunkCount,
          timelineTokens: fallbackPlan.described.timelineTokens,
          totalTokens: fallbackPlan.described.totalTokens,
          retrievalMode: fitted.retrievalMode,
        }
      }
    } else if (shadow && memoryShadowPlan && memoryTakeoverSelectedIds) {
      // 接管后：登记**实际注入**的候选到影子采集器（existing = 本轮注入）
      for (const candidate of memoryShadowPlan.candidates) {
        if (memoryTakeoverSelectedIds.has(candidate.id)) shadow.noteCandidate(candidate)
      }
    }
  }

  // ===== 角色设定 + 世界书 =====
  // M-28 修复：角色设定段统一用 charNameForVars（译名优先）——此前 systemPrompt/jailbreak/persona
  // 用译名、description/personality/scenario 用原名，模型收到的角色自称自相矛盾
  let charDesc = ''
  if (character.description) charDesc += replaceVariables(character.description, userName, charNameForVars) + '\n'
  if (character.personality) charDesc += '性格：' + replaceVariables(character.personality, userName, charNameForVars) + '\n'
  if (character.scenario) charDesc += '场景：' + replaceVariables(character.scenario, userName, charNameForVars) + '\n'
  // W7 影子：角色核心（不含世界书 before/after_character——那两段在下方按桶单独登记，避免重复计数）
  if (charDesc) {
    noteShadow('character', 'character:core', {
      text: charDesc, mandatory: true, stablePrefix: true,
    })
  }

  // 世界书注入（支持多个世界书合并 + 递归扫描 + at_depth 深度注入）
  const lorebookIds = data.chat.activeLorebookIds
  // at_depth 条目：历史消息构建后按深度插入（初始为空）
  let atDepthItems: { content: string; depth: number; order: number; role?: 'system' | 'user' | 'assistant' }[] = []
  // 本轮触发的世界书条目 key（recency 窗口更新用）
  let lorebookTriggeredIds: string[] | undefined
  // 世界书超限压缩请求（阶段三）
  let lorebookCompressions: LorebookCompressionRequest[] | undefined
  let lorebookCompressionCacheHitKeys: string[] | undefined
  let lorebookTimedEffects: LorebookTimedEffectsState | undefined
  let lorebookDiagnostics: LorebookDiagnostics | undefined
  let lorebookRenderPlan: LorebookRenderPlan = emptyLorebookRenderPlan()
  /** W9：逐条评分快照（无正文），供世界书候选影子 */
  let lorebookScoredSnapshots: LorebookScoredEntrySnapshot[] | undefined
  if (lorebookIds.length > 0) {
    // 修复 #28: 扫描深度可配置（取激活世界书中的最大值，无配置时用默认）
    // H-16 修复：reduce 初始值此前误用 DEFAULT（10），等价于 max(配置, 10)，
    // 用户调小配置（如 2/4）被静默抬回 10，条目过度触发。先收集配置值、空才回退默认。
    const scanDepth = resolveLorebookScanDepth(
      lorebookIds.flatMap((id) => {
        const lorebook = data.lorebooks.find((candidate) => candidate.id === id)
        return lorebook ? [lorebook.scanDepth, ...lorebook.entries.map((entry) => entry.scanDepth)] : []
      }),
      DEFAULT_LOREBOOK_SCAN_DEPTH,
    )

    const scanMessages = (scanDepth === 0 ? [] : messages.slice(-scanDepth)).map((m) => m.content)
    const scanText = scanMessages.join(' ')

    const lorebookRatio = settings.lorebookRatio ?? DEFAULT_LOREBOOK_RATIO
    // W9 接管（§7.11 第 3/7 条，G1 通过后）：删除固定比例——世界书与其余块共享 budgetBase，
    // 历史由 cropHistory 吃剩余。lorebookRatio 仍可读（设置兼容），不再参与生产预算。
    void lorebookRatio
    const lorebookBudget = budgetBase

    // data.lorebooks 为激活世界书全量（书级/条目级 enabled 由统一执行器内部过滤）；
    // 语义命中为 BudgetLoreItem 形状（携带 score/key 参与统一评分）
    const result = executeLorebookRuntime({
      lorebooks: data.lorebooks,
      scanText,
      scanMessages,
      userName,
      charName: character.name,
      characterNames: [character.name, charNameForVars],
      characterTags: character.tags,
      generationType: opts?.generationType ?? (opts?.continuation ? 'continue' : 'normal'),
      messageCount: messages.length,
      timedEffects: currentSession?.lorebookTimedEffects,
      budget: lorebookBudget,
      model,
      semanticItems: data.chat.semanticLoreHits,
      // 语义触发不可用时对仅语义条目告警（含未启用 / 未配置两种情况；
      // 本轮已有语义命中时视为可用，避免误告警）
      semanticEnabled: data.chat.semanticLoreAvailable ?? (data.chat.semanticLoreHits.length > 0 || !!(
        settings.semanticTrigger?.enabled
        && settings.semanticTrigger.model?.trim()
        && (settings.semanticTrigger.provider === 'local' || settings.semanticTrigger.baseUrl?.trim())
      )),
      // 阶段二B：受控实体词表补充（角色 tags；条目 keywords 与 charName 在工具内始终参与）
      entityVocabulary: character.tags,
      recentTriggeredIds: currentSession?.recentTriggeredIds,
      // 阶段三：超限压缩缓存（命中时以缓存摘要替代被丢弃条目集合）
      compressionCache: currentSession?.lorebookCompressionCache,
      diagnosticsMode: opts?.lorebookDiagnosticsMode,
    })

    if (opts?.lorebookDiagnosticsMode !== 'preview' && result.droppedCount > 0) {
      logInfo('buildContext', `世界书预算裁剪：触发 ${result.triggeredCount} 条，丢弃 ${result.droppedCount} 条（常驻 ${result.alwaysDropped ?? 0} / 条件 ${result.conditionalDropped ?? 0} / 细节 ${result.detailDropped ?? 0}，预算 ${lorebookBudget} tokens）`)
    }
    if (opts?.lorebookDiagnosticsMode !== 'preview' && (result.alwaysDropped ?? 0) > 0) {
      logWarn('buildContext', `常驻世界书条目超出预算硬上限（40%），${result.alwaysDropped} 条被截断：请精简常驻内容`)
    }
    if (opts?.lorebookDiagnosticsMode !== 'preview' && (result.bookBudgetDropped ?? 0) > 0) {
      logInfo('buildContext', `世界书书级 tokenBudget 超限：${result.bookBudgetDropped} 条被丢弃（激活世界书自带预算上限）`)
    }

    lorebookRenderPlan = result.renderPlan
    // before_character: 排列在 charDesc 之前
    if (lorebookRenderPlan.beforeCharacter.length > 0) {
      charDesc = lorebookRenderPlan.beforeCharacter.join('\n') + '\n' + charDesc
    }
    // after_character: 排列在 charDesc 之后
    if (lorebookRenderPlan.afterCharacter.length > 0) {
      charDesc = charDesc + lorebookRenderPlan.afterCharacter.join('\n')
    }
    // prompt_end（含 outlet/custom 的显式 fallback）：追加到 systemContent 末尾
    if (lorebookRenderPlan.promptEnd.length > 0) {
      systemContent += '\n\n' + lorebookRenderPlan.promptEnd.join('\n')
    }
    // chat depth: 延迟到历史消息构建后注入
    if (lorebookRenderPlan.chat.length > 0) {
      atDepthItems = lorebookRenderPlan.chat
    }
    // 阶段二B：透出本轮触发键，调用方更新会话 recency 窗口
    lorebookTriggeredIds = result.triggeredEntryKeys
    // 阶段三：透出超限压缩请求，调用方异步 AI 压缩
    lorebookCompressions = result.compressionRequests
    lorebookCompressionCacheHitKeys = result.compressionCacheHitKeys
    lorebookTimedEffects = result.timedEffects
    lorebookDiagnostics = result.diagnostics
    lorebookScoredSnapshots = result.scoredEntrySnapshots
  }

  // ===== W9 影子：世界书逐条评分候选（always→mandatory + 统一剩余预算） =====
  // 有 scoredEntrySnapshots 时用真实条目评分；无世界书激活时跳过。
  // 桶级占位保留为快照缺失时的回退，保证分类 token/数量差异仍可解释。
  let worldbookPlan: WorldbookCandidateSet | null = null
  let worldbookExistingCap = 0
  /** W9：历史分级降级影子（摘要替代 → 再删原文） */
  let historyDegradationPlan: HistoryDegradationPlan | null = null
  if (shadow) {
    const lorebookRatio = settings.lorebookRatio ?? DEFAULT_LOREBOOK_RATIO
    worldbookExistingCap = Math.floor(budgetBase * Math.min(Math.max(lorebookRatio, 0.05), 1))
    if (lorebookScoredSnapshots && lorebookScoredSnapshots.length > 0) {
      worldbookPlan = buildWorldbookCandidateSet(lorebookScoredSnapshots)
      // 现有实现实际注入的一侧：逐条进入采集器（与候选同口径分类差异）
      for (const snapshot of lorebookScoredSnapshots) {
        if (!snapshot.kept) continue
        noteShadow('worldbook', `worldbook:${snapshot.key}`, {
          tokens: snapshot.tokens,
          mandatory: snapshot.priority === 'always',
          stablePrefix: snapshot.position !== 'at_depth',
          relevance: snapshot.score,
          recency: 0.5,
          importance: snapshot.priority === 'always' ? 0.9 : snapshot.priority === 'detail' ? 0.35 : 0.55,
          continuity: snapshot.priority === 'always' ? 0.7 : 0.45,
          dedupeKey: `lore:${snapshot.key}`,
          origin: snapshot.position === 'before_char'
            ? 'worldbook:before_character'
            : snapshot.position === 'after_char'
              ? 'worldbook:after_character'
              : snapshot.position === 'at_depth'
                ? `worldbook:chat_depth:${snapshot.depth ?? 0}`
                : 'worldbook:prompt_end',
        })
      }
    } else {
      // W7 桶级占位回退（无逐条快照时）
      const lorebookBucketSpecs: Array<[string, string[], number, number, number]> = [
        ['before_character', lorebookRenderPlan.beforeCharacter, 0.55, 0.8, 0.5],
        ['after_character', lorebookRenderPlan.afterCharacter, 0.55, 0.8, 0.5],
        ['prompt_end', lorebookRenderPlan.promptEnd, 0.55, 0.6, 0.5],
        ['authors_note_top', lorebookRenderPlan.authorsNoteTop, 0.5, 0.6, 0.5],
        ['authors_note_bottom', lorebookRenderPlan.authorsNoteBottom, 0.5, 0.6, 0.5],
        ['before_examples', lorebookRenderPlan.beforeExamples, 0.45, 0.4, 0.4],
        ['after_examples', lorebookRenderPlan.afterExamples, 0.45, 0.4, 0.4],
      ]
      for (const [bucket, items, relevance, importance, continuity] of lorebookBucketSpecs) {
        if (items.length === 0) continue
        noteShadow('worldbook', `worldbook:${bucket}`, {
          text: items.join('\n'),
          relevance,
          recency: 0.5,
          importance,
          continuity,
          origin: `worldbook:${bucket}`,
        })
      }
      if (lorebookRenderPlan.chat.length > 0) {
        noteShadow('worldbook', 'worldbook:chat_depth', {
          text: lorebookRenderPlan.chat.map((item) => item.content).join('\n'),
          relevance: 0.45,
          recency: 0.5,
          importance: 0.5,
          continuity: 0.3,
          origin: 'worldbook:chat_depth',
        })
      }
    }
  }

  if (charDesc) systemContent += '\n\n【角色设定】\n' + charDesc

  // 宏展开（预设 / 人设 / 世界书 at_end / 角色设定均支持 {{time}} {{random:}} 等）
  const macroCtx = buildMacroContext(messages, {
    userName,
    charName: charNameForVars,
    originalCharName: character.name,
  })
  systemContent = expandMacros(systemContent, macroCtx)

  context.push({ role: 'system', content: systemContent })

  for (const content of lorebookRenderPlan.authorsNoteTop) {
    context.push({ role: 'system', content, keepSeparate: true })
  }

  // 用户人设 separate 模式：独立 system 消息（keepSeparate 避免被合并进相邻消息）
  if (personaText && personaInjection.position === 'separate') {
    context.push({ role: 'system', content: '【用户人设】\n' + personaText, keepSeparate: true })
  }

  // ===== 作者注释（Author's Note）=====
  // 作者注释属于角色卡；enabled 且文本非空才注入
  const anConfig = character.authorNote
  let anText = ''
  if (anConfig?.enabled && anConfig.text?.trim()) {
    anText = expandMacros(replaceVariables(anConfig.text.trim(), userName, charNameForVars), macroCtx)
  }

  // top：紧跟系统提示注入（keepSeparate：避免被 merge 合并进系统提示）
  if (anText && anConfig!.position === 'top') {
    context.push({ role: 'system', content: anText, keepSeparate: true })
  }
  if (anText) {
    noteShadow('character', `character:author-note-${anConfig!.position}`, {
      text: anText, relevance: 0.7, recency: 1, importance: 0.8, continuity: 0.7,
    })
  }

  // 对话示例位置与发送模式配置（预设级可覆盖全局）
  const exampleDialogPosition = settings.exampleDialogPosition || 'after_system'
  const exampleDialogMode = (preset?.exampleDialogMode ?? settings.exampleDialogMode) || 'always'
  // 首轮 = 用户消息不超过 1 条（含刚发送的这条）
  const isFirstTurn = messages.filter(m => m.role === 'user').length <= 1
  const shouldSendExample = !!character.exampleDialog
    && exampleDialogMode !== 'off'
    && (exampleDialogMode !== 'first_turn' || isFirstTurn)
  const exampleDialogContent = shouldSendExample
    ? '【对话示例】\n' + replaceVariables(character.exampleDialog!, userName, charNameForVars)
    : ''
  if (exampleDialogContent) {
    noteShadow('example', 'example:dialog', {
      text: exampleDialogContent,
      relevance: 0.5,
      recency: 1,
      importance: 0.6,
      continuity: 0.6,
      origin: `example:${exampleDialogPosition}`,
    })
  }

  // 如果示例位置是 after_system（默认），在这里插入
  if (exampleDialogPosition === 'after_system') {
    for (const content of lorebookRenderPlan.beforeExamples) {
      context.push({ role: 'system', content, keepSeparate: true })
    }
    if (exampleDialogContent) context.push({ role: 'system', content: exampleDialogContent })
    for (const content of lorebookRenderPlan.afterExamples) {
      context.push({ role: 'system', content, keepSeparate: true })
    }
  }

  // ===== 历史消息 =====
  let usedTokens = context.reduce((sum, c) => sum + estimateTokens(c.content, model), 0)

  // 预留 postHistoryInstructions（历史之后才注入，需先计入预算，参考群聊路径做法）
  const postHistoryText = character.postHistoryInstructions
    ? replaceVariables(character.postHistoryInstructions, userName, charNameForVars)
    : ''
  if (postHistoryText) usedTokens += estimateTokens(postHistoryText, model)
  // W7 影子：尾部/后置协议块（与系统提示中的同一份正文格式文本确实被注入两次，按实际计数）
  if (postHistoryText) {
    noteShadow('protocol', 'protocol:post-history', {
      text: postHistoryText, mandatory: true, stablePrefix: false,
    })
  }
  const bodyFormatBase = buildMainChatOutputPrompt(plan.responsePolicy)
  const bodyFormatText = enableThoughtFormat
    ? `${bodyFormatBase}\n\n【内心想法契约】\n${buildThoughtContractBody({
        narrativeMode,
        subjectName: narrativeMode === 'omniscient' ? '' : charNameForVars,
      })}`
    : bodyFormatBase
  usedTokens += estimateTokens(bodyFormatText, model)
  noteShadow('protocol', 'protocol:body-format-tail', {
    text: bodyFormatText, mandatory: true, stablePrefix: false,
  })
  // 预留作者注释（middle/bottom 在历史段内注入，需计入预算）
  if (anText && anConfig!.position !== 'top') {
    usedTokens += estimateTokens(anText, model)
  }
  // 预留 after_history 示例对话（同理）
  if (exampleDialogPosition === 'after_history' && exampleDialogContent) {
    usedTokens += estimateTokens(exampleDialogContent, model)
  }
  // chat depth 与 authors_note_bottom 尚未加入 context，裁剪历史前先预留。
  usedTokens += [...lorebookRenderPlan.chat, ...lorebookRenderPlan.authorsNoteBottom]
    .reduce((sum, item) => sum + estimateTokens(typeof item === 'string' ? item : item.content, model), 0)

  // 按 token 预算裁剪历史消息（共享工具，含被裁剪范围记录）
  const historyImageTokens = messages.reduce(
    (s, m) => s + (m.role === 'user' ? estimateImageTokens(m.images?.length ?? 0) : 0),
    0,
  )
  usedTokens += historyImageTokens
  const { recent: recentMessages, droppedStartTs, droppedEndTs, droppedTokens, droppedEndIndex } = cropHistory(
    messages, usedTokens, budgetBase, model,
  )

  // 上下文溢出压缩（P0-1）：有压缩摘要则注入；否则若裁剪量超阈值，标记异步压缩
  const compression = settings.contextCompression ?? { enabled: true, minDropTokens: 2000 }
  let compressedSummaryInjected = ''
  let pendingCompression: PendingCompression | undefined
  // 长期时间线已覆盖更早历史时，不再注入或重复生成压缩摘要。
  const hasTimelineMemory = Boolean(currentSession?.memory?.trim())
  if (compression.enabled && !hasTimelineMemory && droppedTokens > 0 && currentSession) {
    const covered = !!currentSession.compressedSummary
      && !!currentSession.compressedRange
      && droppedStartTs >= currentSession.compressedRange.startTs
      && droppedEndTs <= currentSession.compressedRange.endTs
    if (currentSession.compressedSummary && covered) {
      // 已被压缩覆盖：注入摘要（历史段之前）
      compressedSummaryInjected = currentSession.compressedSummary
    } else if (droppedTokens >= (compression.minDropTokens ?? 2000)) {
      // 标记压缩任务，流式完成后异步执行（原 markPendingCompression，改由调用方处理）
      pendingCompression = {
        characterId: character.id,
        sessionId: data.chat.currentSessionId ?? '',
        droppedText: droppedEndIndex >= 0
          ? messages.slice(0, droppedEndIndex + 1).map((m) =>
              `${m.role === 'user' ? userName : charNameForVars}: ${m.content}`
            ).join('\n')
          : '',
        droppedStartTs,
        droppedEndTs,
      }
    }
  }

  // 历史消息段（单独构建，供 at_depth 世界书在中间插入）
  const historySegment: ContextMessage[] = []
  // 上下文溢出压缩摘要：置于历史段最前（keepSeparate 避免被合并）
  if (compressedSummaryInjected) {
    historySegment.push({
      role: 'system',
      content: '【早期对话压缩摘要】\n' + compressedSummaryInjected,
      keepSeparate: true,
    })
  }
  for (const msg of recentMessages) {
    const isUser = msg.role === 'user'
    historySegment.push({
      role: isUser ? 'user' : 'assistant',
      content: msg.content,
      // 用户消息携带图片（data URL）→ 发给 vision 模型识别；
      // assistant 消息的 images 是生图产物，不回传给 AI
      ...(isUser && msg.images?.length ? { images: msg.images } : {}),
    })
  }

  // W7 影子：历史段（保留下来的消息）逐条登记；图片按既有 IMAGE_TOKEN_ESTIMATE 计入同一候选。
  // 近因按"距末尾的位置"归一化，使最近连续对话落入第 2 顺位（§5.5 第 2 条）。
  if (shadow) {
    if (compressedSummaryInjected) {
      noteShadow('history', 'history:compressed-summary', {
        text: compressedSummaryInjected, relevance: 0.5, recency: 0.2, importance: 0.6, continuity: 0.3,
      })
    }
    const historyCount = recentMessages.length
    recentMessages.forEach((msg, index) => {
      const imageTokens = msg.role === 'user' ? estimateImageTokens(msg.images?.length ?? 0) : 0
      const recency = historyCount <= 1 ? 1 : (index + 1) / historyCount
      noteShadow('history', `history:msg:${msg.id}`, {
        tokens: estimateTokens(msg.content || '', model) + imageTokens,
        dedupeKey: `msg:${msg.id}`,
        relevance: 0.7,
        recency,
        importance: 0.6,
        continuity: 0.9,
        origin: imageTokens > 0 ? 'history:user+images' : `history:${msg.role}`,
      })
    })
    // W9 影子：历史分级降级（摘要替代 → 再删原文）；不改 messages
    historyDegradationPlan = planHistoryDegradation({
      messages,
      // usedTokens 此刻已含历史裁剪前占用；crop 结果直接复用，避免口径漂移
      usedTokens,
      budgetTokens: budgetBase,
      model,
      compressedSummary: compressedSummaryInjected || currentSession?.compressedSummary || null,
      compressedRange: currentSession?.compressedRange
        ? {
            startTs: currentSession.compressedRange.startTs,
            endTs: currentSession.compressedRange.endTs,
          }
        : null,
      crop: {
        recent: recentMessages,
        droppedTokens,
        droppedEndIndex,
        droppedStartTs,
        droppedEndTs,
      },
    })
  }

  // at_depth 世界书 + 作者注释（middle/bottom）统一按深度注入历史消息段（共享工具）
  const depthInserts: DepthInsertItem[] =
    atDepthItems.map((i) => ({ content: i.content, depth: i.depth, order: i.order, role: i.role }))
  lorebookRenderPlan.authorsNoteBottom.forEach((content, index) => {
    depthInserts.push({ content, depth: 0, order: -2_000 + index })
  })
  if (anText && anConfig!.position !== 'top') {
    // bottom = 末尾（depth 0）；middle = 按配置深度；同深度下 AN 排在世界书前
    const anDepth = anConfig!.position === 'middle' ? Math.max(0, anConfig!.depth) : 0
    depthInserts.push({ content: anText, depth: anDepth, order: -1 })
  }
  const depthInjected = applyDepthInserts(
    historySegment,
    depthInserts,
    (content) => ({ role: 'system' as const, content, keepSeparate: true }),
    (content, role) => ({
      role: (role ?? 'system') as 'system' | 'user' | 'assistant',
      content,
      keepSeparate: true,
    }),
  )

  context.push(...depthInjected)

  // 如果示例位置是 after_history，在这里插入
  if (exampleDialogPosition === 'after_history') {
    for (const content of lorebookRenderPlan.beforeExamples) {
      context.push({ role: 'system', content, keepSeparate: true })
    }
    if (exampleDialogContent) context.push({ role: 'system', content: exampleDialogContent })
    for (const content of lorebookRenderPlan.afterExamples) {
      context.push({ role: 'system', content, keepSeparate: true })
    }
  }

  // 历史之后再次固定本轮回应范围与正文结构（阶段二语义停止规则），
  // 避免长对话中的旧输出样式压过系统格式要求。
  // keepSeparate 防止与相邻 system 消息合并，便于各 provider 保留最后约束的边界。
  context.push({
    role: 'system',
    content: bodyFormatText,
    keepSeparate: true,
  })

  // 修复 #27: postHistoryInstructions 应该放在历史消息之后（Author's Note 位置）
  if (postHistoryText) {
    context.push({
      role: 'system',
      content: postHistoryText,
    })
  }

  // ===== 续写模式 =====
  // 在 merge/convert 之前注入续写指令，保证指令经过完整消息管线（provider 格式转换）
  if (opts?.continuation) {
    const continuationInstruction = '请直接接续上一段内容的结尾继续写作，保持相同的风格、语气和叙事视角。不要重复已有内容，直接输出续写部分。'
    context.push({
      role: 'user',
      content: continuationInstruction,
    })
    noteShadow('protocol', 'protocol:continuation', {
      text: continuationInstruction, mandatory: true, stablePrefix: false,
    })
  }

  // Assistant Prefix：在上下文末尾添加空的 assistant 消息，引导模型输出格式
  // 对于 instruct 模式且 appendAssistantPrefix=true 的情况，添加角色名前缀
  // 续写模式跳过：空 prefix 会被 merge 进续写指令之后，干扰续写引导
  const instructTemplate = resolveEffectiveTemplate(
    preset?.contextTemplate,
    profile?.provider || 'openai',
    model,
    profile?.useInstructTemplate,
  )
  if (!opts?.continuation && instructTemplate?.appendAssistantPrefix && charNameForVars) {
    context.push({
      role: 'assistant',
      content: '',  // 空内容，让模型续写
    })
  }

  // 消息后处理：合并连续相同角色消息
  let processedContext = mergeConsecutiveMessages(context)

  // 根据提供商转换消息格式（Claude/Gemini 需要特殊处理）
  const provider = profile?.provider || 'openai'
  processedContext = convertMessages(provider, processedContext, { charName: charNameForVars, userName })

  // ===== W7（§7.9）影子结果：只记录分类 token/数量差异，不参与任何注入决策 =====
  // 采集与分配异常一律不回传错误（`degraded` 标记），生成链路不受影响。
  const contextShadow = shadow?.collect({ budgetTokens: budgetBase, reportedUsageTokens: usedTokens })
  if (contextShadow && !contextShadow.degraded && opts?.lorebookDiagnosticsMode !== 'preview') {
    logInfo('buildContext', `上下文影子分配：${formatContextShadowSummary(contextShadow)}`)
  }

  // ===== W8 接管后记忆专项影子：plan=全量候选，existing=本轮实际注入 =====
  const memoryShadow: MemoryShadowReport | undefined = shadow && memoryShadowPlan && memoryShadowExisting
    ? buildMemoryShadowReport({
        plan: memoryShadowPlan,
        existing: memoryShadowExisting,
        budgetTokens: budgetBase,
        competitors: shadow.collectedCandidates().filter(
          (candidate) => candidate.kind !== 'memory' && candidate.kind !== 'current-state',
        ),
      })
    : undefined
  if (memoryShadow && !memoryShadow.degraded && opts?.lorebookDiagnosticsMode !== 'preview') {
    logInfo('buildContext', `记忆影子分配：${formatMemoryShadowSummary(memoryShadow)}`)
  }

  // ===== W9（§7.11）世界书专项影子：既有固定比例 vs always→mandatory + 统一剩余预算 =====
  const worldbookShadow: WorldbookShadowReport | undefined = shadow && worldbookPlan && lorebookScoredSnapshots
    ? buildWorldbookShadowReport({
        plan: worldbookPlan,
        existing: summarizeWorldbookInjection(lorebookScoredSnapshots, worldbookExistingCap),
        budgetTokens: budgetBase,
        competitors: shadow.collectedCandidates().filter(
          (candidate) => candidate.kind !== 'worldbook',
        ),
      })
    : undefined
  if (worldbookShadow && !worldbookShadow.degraded && opts?.lorebookDiagnosticsMode !== 'preview') {
    logInfo('buildContext', `世界书影子分配：${formatWorldbookShadowSummary(worldbookShadow)}`)
  }

  // ===== W9（§7.11）历史分级降级影子：摘要替代 → 再删原文 =====
  const historyDegradation = historyDegradationPlan ?? undefined
  if (historyDegradation && !historyDegradation.degraded && opts?.lorebookDiagnosticsMode !== 'preview') {
    logInfo('buildContext', `历史降级影子：${formatHistoryDegradationSummary(historyDegradation)}`)
  }

  // ===== W9（§7.11/§5.6）序列化后输入审计（估算视图；超限只报告，不裁剪） =====
  const inputAudit = shadow
    ? auditMessagesAsSerializedInput(processedContext, {
        provider,
        model,
        reservedOutputTokens: reservedOutput,
        contextLimit: maxContext,
      })
    : undefined
  if (inputAudit && opts?.lorebookDiagnosticsMode !== 'preview') {
    // 日志串只含数值口径（formatInputAuditSummary 不含正文/端点）
    logInfo('buildContext', `输入审计（估算）：${[
      `input=${inputAudit.inputTokens}`,
      `reserved=${inputAudit.reservedOutputTokens}`,
      `safety=${inputAudit.protocolSafetyTokens}`,
      `total=${inputAudit.totalTokens}/${inputAudit.contextLimit}`,
      `over=${inputAudit.overBudget ? 1 : 0}`,
      `accounting=${inputAudit.accountingConfidence}`,
    ].join(' ')}`)
  }

  // 记录上下文用量（P1-3：上限预警）
  return {
    messages: processedContext,
    lastContextUsage: { used: usedTokens, max: budgetBase },
    responsePolicy: plan.responsePolicy,
    requestMaxTokens: plan.requestMaxTokens,
    requestBudget: plan.requestBudget,
    responseIntent: plan.responseIntent,
    sceneFactor: plan.sceneFactor,
    narrativeMode,
    pendingCompression,
    lorebookTriggeredIds,
    lorebookCompressions,
    lorebookCompressionCacheHitKeys,
    lorebookTimedEffects,
    lorebookDiagnostics,
    ...(contextShadow ? { contextShadow } : {}),
    ...(memoryShadow ? { memoryShadow } : {}),
    ...(worldbookShadow ? { worldbookShadow } : {}),
    ...(historyDegradation ? { historyDegradation } : {}),
    ...(inputAudit ? { inputAudit } : {}),
  }
}

/** 从数据快照组装 ChatParams（不含识图模型切换——vision 覆盖由调用方按需处理） */
export function buildChatParamsFromData(
  data: ContextBuildData,
  messages: ContextMessage[],
  opts?: {
    /** 调用方从 BuildResult 透传的本轮请求预算（同一次计算结果）；缺省时按同一入口重新解析 */
    requestMaxTokens?: number
    /** 观测来源：桥接端生成（默认）或辅助测试生成（预设页测试） */
    source?: 'bridge' | 'aux'
  },
): ChatParams {
  const settings = data.settings.settings
  const profile = data.settings.profile
  const preset = data.preset

  // 模型解析与实际请求一致（activeModel 优先，切换档案时二者本就同步）
  const model = settings.activeModel || profile?.model || 'gpt-4o-mini'
  const instructTemplate = resolveEffectiveTemplate(
    preset?.contextTemplate,
    profile?.provider || 'openai',
    model,
    profile?.useInstructTemplate,
  )
  const plan = resolveChatRequestPlan(data)

  return {
    requestId: '', // 由调用方注入
    messages,
    provider: (profile?.provider || 'openai') as ChatParams['provider'],
    apiKey: profile?.apiKey ?? '',
    baseUrl: profile?.baseUrl ?? '',
    model,
    temperature: preset?.temperature ?? 0.8,
    topP: preset?.topP ?? 0.95,
    maxTokens: opts?.requestMaxTokens ?? plan.requestMaxTokens,
    frequencyPenalty: preset?.frequencyPenalty ?? 0,
    presencePenalty: preset?.presencePenalty ?? 0,
    stream: settings.streamOutput,
    instructTemplate,
    // 阶段8（§4.3）：门控指令由预算结果反推（tokens 即本轮推理预留），与 PC 同口径
    ...(plan.requestBudget?.gate
      ? {
          reasoningGate: {
            level: plan.requestBudget.gate.level,
            knob: plan.requestBudget.gate.knob,
            tokens: plan.requestBudget.reasoningReserve,
          },
        }
      : {}),
    // 阶段0观测元数据：随请求透传给主进程记录（不影响请求行为）
    observability: {
      source: opts?.source ?? 'bridge',
      responseLengthMode: plan.responsePolicy.mode,
      hardMaxChars: plan.responsePolicy.hardMaxChars,
      // S5：记录意图识别与场景系数，便于核对误判（未启用时不下发）
      ...(plan.responseIntent ? { responseIntent: plan.responseIntent } : {}),
      sceneFactor: plan.sceneFactor,
      characterId: data.character?.id,
      sessionId: data.chat.currentSessionId ?? undefined,
    },
  }
}

export type { SemanticLoreHit }
