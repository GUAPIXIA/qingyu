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

import type { ChatParams, Character, Settings } from '../../shared/types'
import type { ContextBuildData, SemanticLoreHit } from '../../shared/contextTypes'
import { estimateTokens, getDefaultMaxContext, estimateImageTokens } from '../utils/tokenCounter'
import { replaceVariables } from '../utils/variables'
import { resolveEffectiveTemplate } from '../utils/chatTemplates'
import { mergeConsecutiveMessages } from '../utils/messagePostProcess'
import { convertMessages } from '../utils/promptConverters'
import { fitLayeredMemoryBudget, formatMemoryFacts } from '../utils/memory'
import { expandMacros, buildMacroContext } from '../utils/macros'
import { triggerLorebooks, mergeSemanticHits, type BudgetLoreItem } from '../utils/lorebook'
import { logInfo } from '../lib/logger'
import {
  DEFAULT_LOREBOOK_SCAN_DEPTH,
  DEFAULT_LOREBOOK_RATIO,
  DEFAULT_RESERVED_OUTPUT,
  TOKEN_BUDGET_SAFETY,
} from '../store/chatConstants'
import { cropHistory, applyDepthInserts, type DepthInsertItem } from '../store/contextShared'
import type { ContextMessage } from '../store/chatTypes'

/** 组装选项（对齐原 buildChatContext 的 opts） */
export interface BuildOptions {
  continuation?: boolean
}

/** 待异步执行的上下文压缩任务（原 markPendingCompression 的入参） */
export interface PendingCompression {
  characterId: string
  sessionId: string
  droppedText: string
  droppedStartTs: number
  droppedEndTs: number
}

/** 组装结果：消息 + 用量记录 + 可选压缩任务（均由调用方写回 store） */
export interface BuildResult {
  messages: ContextMessage[]
  lastContextUsage: { used: number; max: number }
  pendingCompression?: PendingCompression
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

  // 修复 #8: 保留图片消息（content 为空但有 images 时不丢弃）
  const messages = data.chat.messages.filter(
    (m) => (m.content || (m.images && m.images.length > 0)) && m.role !== 'system',
  )
  const context: ContextMessage[] = []

  // ===== System Prompt 构建 =====
  const charNameForVars = character.translatedContent?.name || character.name
  let systemContent = replaceVariables(
    character.systemPrompt || preset?.systemPrompt || '你是一个角色扮演助手。请根据角色设定进行沉浸式对话，保持角色性格的一致性。',
    userName,
    charNameForVars,
  )

  // jailbreak 改为可选（修复 #32）：只在 preset 有 jailbreak 且非空时附加
  if (preset?.jailbreak && preset.jailbreak.trim()) {
    systemContent += '\n\n' + replaceVariables(preset.jailbreak, userName, charNameForVars)
  }

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

  // 心理描写输出格式（修复 #33）：改为可配置，默认开启
  const enableThoughtFormat = preset?.enableThoughtFormat ?? (settings.enableThoughtFormat !== false)
  if (enableThoughtFormat) {
    systemContent += '\n\n【输出格式要求】\n请先在 <thought>...</thought> 标签内输出角色的内心想法和心理活动，然后再输出角色的实际对话和行动。两部分必须分开。'
  }

  // ===== Token 预算框架 =====
  // budgetBase = (maxContext − 输出预留) × 安全余量；世界书预算取其一定比例，剩余给历史
  const model = profile?.model || settings.activeModel || 'gpt-4o-mini'
  const maxContext = profile?.maxContext || preset?.maxContext || getDefaultMaxContext(model)
  const reservedOutput = preset?.maxTokens ?? DEFAULT_RESERVED_OUTPUT
  // 下限保护：maxTokens 配置过大时至少保留 25% 上下文预算
  const budgetBase = Math.max(
    Math.floor((maxContext - reservedOutput) * TOKEN_BUDGET_SAFETY),
    Math.floor(maxContext * 0.25),
  )

  // 分层长记忆注入：当前状态优先，其次相关事实，最后是时间线。
  const { sessions, currentSessionId } = data.chat
  const currentSession = sessions.find(s => s.id === currentSessionId)
  if (currentSession?.memoryEnabled) {
    const memoryBudget = Math.min(800, Math.floor(budgetBase * 0.1))
    // P0-2：语义检索命中时仅注入相关事实，否则全量；透传语义分到预算层
    const semanticFacts = data.chat.semanticFactsHits
    const factsForInject = semanticFacts.length > 0 ? semanticFacts : (currentSession.memoryFacts ?? [])
    const semanticScores = semanticFacts.length > 0 ? semanticFacts.map(() => 0.9) : null
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
  }

  // ===== 角色设定 + 世界书 =====
  // M-28 修复：角色设定段统一用 charNameForVars（译名优先）——此前 systemPrompt/jailbreak/persona
  // 用译名、description/personality/scenario 用原名，模型收到的角色自称自相矛盾
  let charDesc = ''
  if (character.description) charDesc += replaceVariables(character.description, userName, charNameForVars) + '\n'
  if (character.personality) charDesc += '性格：' + replaceVariables(character.personality, userName, charNameForVars) + '\n'
  if (character.scenario) charDesc += '场景：' + replaceVariables(character.scenario, userName, charNameForVars) + '\n'

  // 世界书注入（支持多个世界书合并 + 递归扫描 + at_depth 深度注入）
  const lorebookIds = data.chat.activeLorebookIds
  // at_depth 条目：历史消息构建后按深度插入（初始为空）
  let atDepthItems: { content: string; depth: number; order: number }[] = []
  if (lorebookIds.length > 0) {
    // 修复 #28: 扫描深度可配置（取激活世界书中的最大值，无配置时用默认）
    // H-16 修复：reduce 初始值此前误用 DEFAULT（10），等价于 max(配置, 10)，
    // 用户调小配置（如 2/4）被静默抬回 10，条目过度触发。先收集配置值、空才回退默认。
    const depths = lorebookIds
      .map(id => data.lorebooks.find((lb) => lb.id === id)?.scanDepth)
      .filter((d): d is number => typeof d === 'number' && d > 0)
    const scanDepth = depths.length > 0
      ? depths.reduce((max, d) => Math.max(max, d), 0)
      : DEFAULT_LOREBOOK_SCAN_DEPTH

    const scanText = messages.slice(-scanDepth).map((m) => m.content).join(' ')

    const lorebookRatio = settings.lorebookRatio ?? DEFAULT_LOREBOOK_RATIO
    const lorebookBudget = Math.floor(budgetBase * Math.min(Math.max(lorebookRatio, 0.05), 1))

    // data.lorebooks 为激活世界书全量（书级/条目级 enabled 由 triggerLorebooks 内部过滤，
    // 与迁移前 lorebookCache.getAll 语义一致）；语义命中为 BudgetLoreItem 形状
    const result = mergeSemanticHits(
      triggerLorebooks({
        lorebooks: data.lorebooks,
        scanText,
        userName,
        charName: character.name,
        budget: lorebookBudget,
        model,
      }),
      data.chat.semanticLoreHits as unknown as BudgetLoreItem[],
      lorebookBudget,
      model,
    )

    if (result.droppedCount > 0) {
      logInfo('buildContext', `世界书预算裁剪：触发 ${result.triggeredCount} 条，丢弃 ${result.droppedCount} 条（预算 ${lorebookBudget} tokens）`)
    }

    // before_char: 排列在 charDesc 之前
    if (result.beforeChar.length > 0) {
      charDesc = result.beforeChar.join('\n') + '\n' + charDesc
    }
    // after_char: 排列在 charDesc 之后
    if (result.afterChar.length > 0) {
      charDesc = charDesc + result.afterChar.join('\n')
    }
    // at_end: 追加到 systemContent 末尾
    if (result.atEnd.length > 0) {
      systemContent += '\n\n' + result.atEnd.join('\n')
    }
    // at_depth: 延迟到历史消息构建后注入
    if (result.atDepth.length > 0) {
      atDepthItems = result.atDepth
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

  // 用户人设 separate 模式：独立 system 消息（keepSeparate 避免被合并进相邻消息）
  if (personaText && personaInjection.position === 'separate') {
    context.push({ role: 'system', content: '【用户人设】\n' + personaText, keepSeparate: true })
  }

  // ===== 作者注释（Author's Note）=====
  // 角色级优先，回退全局；enabled 且文本非空才注入
  const anConfig = character.authorNote ?? settings.authorNote
  let anText = ''
  if (anConfig?.enabled && anConfig.text?.trim()) {
    anText = expandMacros(replaceVariables(anConfig.text.trim(), userName, charNameForVars), macroCtx)
  }

  // top：紧跟系统提示注入（keepSeparate：避免被 merge 合并进系统提示）
  if (anText && anConfig!.position === 'top') {
    context.push({ role: 'system', content: anText, keepSeparate: true })
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

  // 如果示例位置是 after_system（默认），在这里插入
  if (exampleDialogPosition === 'after_system' && exampleDialogContent) {
    context.push({ role: 'system', content: exampleDialogContent })
  }

  // ===== 历史消息 =====
  let usedTokens = context.reduce((sum, c) => sum + estimateTokens(c.content, model), 0)

  // 预留 postHistoryInstructions（历史之后才注入，需先计入预算，参考群聊路径做法）
  const postHistoryText = character.postHistoryInstructions
    ? replaceVariables(character.postHistoryInstructions, userName, charNameForVars)
    : ''
  if (postHistoryText) usedTokens += estimateTokens(postHistoryText, model)
  // 预留作者注释（middle/bottom 在历史段内注入，需计入预算）
  if (anText && anConfig!.position !== 'top') {
    usedTokens += estimateTokens(anText, model)
  }
  // 预留 after_history 示例对话（同理）
  if (exampleDialogPosition === 'after_history' && exampleDialogContent) {
    usedTokens += estimateTokens(exampleDialogContent, model)
  }

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

  // at_depth 世界书 + 作者注释（middle/bottom）统一按深度注入历史消息段（共享工具）
  const depthInserts: DepthInsertItem[] =
    atDepthItems.map((i) => ({ content: i.content, depth: i.depth, order: i.order }))
  if (anText && anConfig!.position !== 'top') {
    // bottom = 末尾（depth 0）；middle = 按配置深度；同深度下 AN 排在世界书前
    const anDepth = anConfig!.position === 'middle' ? Math.max(0, anConfig!.depth) : 0
    depthInserts.push({ content: anText, depth: anDepth, order: -1 })
  }
  const depthInjected = applyDepthInserts(
    historySegment,
    depthInserts,
    (content) => ({ role: 'system' as const, content, keepSeparate: true }),
  )

  context.push(...depthInjected)

  // 如果示例位置是 after_history，在这里插入
  if (exampleDialogPosition === 'after_history' && exampleDialogContent) {
    context.push({ role: 'system', content: exampleDialogContent })
  }

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
    context.push({
      role: 'user',
      content: '请直接接续上一段内容的结尾继续写作，保持相同的风格、语气和叙事视角。不要重复已有内容，直接输出续写部分。',
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

  // 记录上下文用量（P1-3：上限预警）
  return {
    messages: processedContext,
    lastContextUsage: { used: usedTokens, max: budgetBase },
    pendingCompression,
  }
}

/** 从数据快照组装 ChatParams（不含识图模型切换——vision 覆盖由调用方按需处理） */
export function buildChatParamsFromData(
  data: ContextBuildData,
  messages: ContextMessage[],
  opts?: BuildOptions,
): ChatParams {
  const settings = data.settings.settings
  const profile = data.settings.profile
  const preset = data.preset

  const model = profile?.model || settings.activeModel || 'gpt-4o-mini'
  const instructTemplate = resolveEffectiveTemplate(
    preset?.contextTemplate,
    profile?.provider || 'openai',
    model,
    profile?.useInstructTemplate,
  )
  void opts

  return {
    requestId: '', // 由调用方注入
    messages,
    provider: (profile?.provider || 'openai') as ChatParams['provider'],
    apiKey: profile?.apiKey ?? '',
    baseUrl: profile?.baseUrl ?? '',
    model,
    temperature: preset?.temperature ?? 0.8,
    topP: preset?.topP ?? 0.95,
    maxTokens: preset?.maxTokens ?? 1024,
    frequencyPenalty: preset?.frequencyPenalty ?? 0,
    presencePenalty: preset?.presencePenalty ?? 0,
    stream: settings.streamOutput,
    instructTemplate,
  }
}

export type { SemanticLoreHit }
