import { featureSource, featureSessionRef, validCompression, compressionVersion , featureFingerprint, groupFeatureScope } from '../../shared/featureSource'
import type { Character, LorebookTimedEffectsState, Preset, ResponsePolicy } from '../../shared/types'
import type { RequestBudget } from '../../shared/modelOutputProfile'
import { useSettingsStore } from './useSettingsStore'
import { useCharacterStore } from './useCharacterStore'
import { usePersonaStore } from './usePersonaStore'
import { lorebookCache } from '../features/lorebook/lorebookCache'
import {
  executeLorebookRuntime,
  type BudgetLoreItem,
  type LorebookCompressionRequest,
  type LorebookDiagnostics,
} from '../../shared/chat-core/lorebook'
import type { DepthLoreItem } from '../../shared/chat-core/lorebook'
import { emptyLorebookRenderPlan, type LorebookRenderPlan } from '../../shared/chat-core/lorebookRenderer'
import { estimateTokens, estimateImageTokens } from '../../shared/chat-core/tokenCounter'
import { replaceVariables } from '../../shared/chat-core/variables'
import { mergeConsecutiveMessages } from '../../shared/chat-core/messagePostProcess'
import { convertMessages } from '../../shared/chat-core/promptConverters'
import { resolveEffectiveTemplate } from '../../shared/chat-core/chatTemplates'
import { fitLayeredMemoryBudget, formatMemoryFacts } from '../../shared/chat-core/memory'
import { expandMacros, buildMacroContext } from '../../shared/chat-core/macros'
import { logInfo, logWarn } from '../lib/logger'
import { DEFAULT_LOREBOOK_SCAN_DEPTH, TOKEN_BUDGET_SAFETY, resolveLorebookScanDepth } from '../../shared/chat-core/chatConstants'
import { markPendingGroupCompression } from '../features/group-chat/requestRunner'
import { cropHistory, applyDepthInserts, type DepthInsertItem } from '../../shared/chat-core/contextShared'
import type { GroupStoreGet } from '../features/group-chat/groupChatTypes'
import type { NarrativeMode } from '../../shared/types'
import { buildGroupNarrativeModePrompt, resolveNarrativeMode } from '../../shared/narrativeMode'
import { buildGroupRosterIntro, buildGroupTurnRulesPrompt } from '../../shared/groupChatPrompt'
// 阶段 6 S6-01(c)（P1-6-2 闭合）：成员卡/人设/历史归属/后历史/场景门控等确定性文本块
// 收敛到共享模块——fixture oracle 就是这份实现（group-context-blocks.json / group-context.json）。
import {
  buildFreeMemberCards,
  buildTargetMemberCard,
  buildGroupUserPersona,
  mapGroupHistoryMessages,
  buildGroupPostHistoryInstructions,
  resolveGroupCharNameForVars,
  resolveShouldSendScenario,
} from '../../shared/chat-core/groupContextBlocks'
import { buildThoughtContractBody } from '../../shared/thoughtContract'
import { resolveGroupRequestPlan } from './groupRequestPlan'
import { withReasoningSamples } from './usageProfileCache'
import { withReasoningGate } from './reasoningGateState'
import { enabledProfileOverride, resolveEffectiveContextLimit } from '../../shared/modelOutputProfile'

/** 群聊上下文组装结果：消息 + 本轮世界书触发键 / 超限压缩请求（调用方写回 store） */
export interface GroupContextBuildResult {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  /** 本次上下文实际采用的叙事模式，供调试界面与跨端测试确认。 */
  narrativeMode: NarrativeMode
  responsePolicy: ResponsePolicy
  requestBudget: RequestBudget
  requestMaxTokens: number
  lorebookTriggeredIds?: string[]
  /** 世界书超限压缩请求（阶段三：调用方异步 AI 压缩后写入会话缓存） */
  lorebookCompressions?: LorebookCompressionRequest[]
  lorebookCompressionCacheHitKeys?: string[]
  lorebookTimedEffects?: LorebookTimedEffectsState
  lorebookDiagnostics?: LorebookDiagnostics
}

/**
 * 构建群聊发送给 AI 的完整上下文。
 * 从 useGroupChatStore.buildGroupContext 抽出，依赖通过 get 注入。
 */
export function buildGroupChatContext(
  get: GroupStoreGet,
  targetCharId?: string,
  preset?: Preset | null,
  opts?: { trackUsage?: boolean; lorebookDiagnosticsMode?: 'live' | 'preview'; spatialContext?: import('../../shared/spatial').SpatialGroupContext | null; configuration?: import('../../shared/chatConnection').ChatConfigurationSnapshot },
): GroupContextBuildResult {
  const state = get()
  const group = state.currentGroup
  const settingsStore = useSettingsStore.getState()
  const settings = opts?.configuration?.settings ?? settingsStore.settings
  const profile = opts?.configuration ? opts.configuration.profile : settingsStore.getActiveProfile()
  const model = settings.activeModel || profile?.model || 'gpt-4o-mini'
  const requestPlan = resolveGroupRequestPlan({
    model,
    messages: state.messages,
    preset,
    defaultResponseLength: settings.defaultResponseLength,
    profileOverride: enabledProfileOverride(profile?.capabilityOverride),
    // W1（主计划 §7.3）：同步读取发送前预取的近期推理样本（无样本时退回档案默认余量）
    ...withReasoningSamples(profile, model),
    ...withReasoningGate(profile, model),
  })
  if (!group) {
    return {
      messages: [],
      narrativeMode: 'immersive',
      responsePolicy: requestPlan.responsePolicy,
      requestBudget: requestPlan.requestBudget,
      requestMaxTokens: requestPlan.requestMaxTokens,
    }
  }

  const charStore = useCharacterStore.getState()
  const { sessions, currentSessionId } = get()
  const currentSession = sessions.find(s => s.id === currentSessionId)
  const sessionPersonaId = currentSession?.personaId === undefined
    ? settings.defaultPersonaId
    : currentSession.personaId
  const sessionPersona = sessionPersonaId
    ? usePersonaStore.getState().getPersona(sessionPersonaId)
    : undefined
  const canUseGlobalPersonaFields = !!sessionPersonaId && settings.activePersonaId === sessionPersonaId
  const userName = (
    sessionPersona?.name
    ?? (canUseGlobalPersonaFields ? settings.userName : '')
  ) || '用户'
  const userDescription = sessionPersona?.description
    ?? (canUseGlobalPersonaFields ? settings.userDescription : '')
  const userPersona = sessionPersona?.persona
    ?? (canUseGlobalPersonaFields ? settings.userPersona : '')
  const members = group.memberIds
    .map(id => charStore.characters.find(c => c.id === id))
    .filter(Boolean) as Character[]
  // 与单聊一致：本轮用户消息已经入列，用户消息不超过 1 条即为会话首轮。
  const shouldSendScenario = resolveShouldSendScenario(
    settings.scenarioInjectionMode,
    state.messages.filter(m => m.characterId === '__user__').length,
  )

  // 变量替换用的 charName（mention/polling 为目标角色名，free 为成员列表）
  const targetChar = targetCharId ? members.find(m => m.id === targetCharId) : undefined
  const charNameForVars = resolveGroupCharNameForVars(targetChar?.name, members)
  // 已存在但缺少字段的旧会话固定按 immersive 运行；只有无会话预览才解析群聊/全局默认。
  const narrativeMode = currentSession
    ? resolveNarrativeMode(currentSession.narrativeMode)
    : resolveNarrativeMode(group.defaultNarrativeMode, settings.defaultNarrativeMode)

  // 群聊 Overview + 模式指令（点名/轮询规则与桥接端共用 shared/groupChatPrompt，free 为桌面版规则）
  let systemContent = buildGroupRosterIntro(group.name, members, userName)

  const turnRules = buildGroupTurnRulesPrompt(group.chatMode)
  systemContent += turnRules || '\n【对话规则】你可以让多个角色参与对话。如果多个角色需要发言，请用「【角色名】」标注每段发言的发言人。\n'

  // 心理描写格式
  // 阶段7（§5.1）：与单聊共用同一 thought 契约来源；群聊思考主体始终绑定当前发言角色（speaker）
  if (settings.enableThoughtFormat !== false) {
    const focusName = targetChar ? `「${targetChar.translatedContent?.name || targetChar.name}」` : ''
    systemContent += '\n【输出格式】' + buildThoughtContractBody({ narrativeMode, subjectName: focusName }) + '\n'
  }

  // ===== Token 预算框架（与单聊路径一致）=====
  const maxContext = resolveEffectiveContextLimit({
    model,
    profileMaxContext: profile?.maxContext,
    presetMaxContext: preset?.maxContext,
    capabilityOverride: profile?.capabilityOverride,
  })
  const reservedOutput = requestPlan.requestMaxTokens
  // 下限保护：maxTokens 配置过大时至少保留 25% 上下文预算
  const budgetBase = Math.max(
    Math.floor((maxContext - reservedOutput) * TOKEN_BUDGET_SAFETY),
    Math.floor(maxContext * 0.25),
  )

  // 分层长期记忆：当前状态优先，其次相关事实，最后是时间线。
  if (currentSession?.memoryEnabled) {
    const memoryBudget = Math.min(800, Math.floor(budgetBase * 0.1))
    // P0-2：语义检索命中时仅注入相关事实，否则全量；透传语义分
    const semanticFacts = get()._semanticFactsHits
    const factsForInject = semanticFacts.length > 0
      ? semanticFacts.map((hit) => typeof hit === 'string' ? hit : hit.text)
      : (currentSession.memoryFacts ?? [])
    const semanticScores = semanticFacts.length > 0
      ? semanticFacts.map((hit) => typeof hit === 'string' ? 0 : hit.score)
      : null
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
      logInfo('buildGroupContext', `记忆检索降级 fallback：按 importance+recency 排序（facts=${factsForInject.length}）`)
    }
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

  // 群聊自定义 systemPrompt（含变量替换）
  if (group.systemPrompt) {
    systemContent += '\n' + replaceVariables(group.systemPrompt, userName, charNameForVars) + '\n'
  }

  // ===== 世界书注入（递归扫描 + 正则 + 变量替换 + at_depth 深度注入）=====
  let lorebookBefore = ''
  let lorebookAfter = ''
  let lorebookAtEnd = ''
  let atDepthItems: DepthLoreItem[] = []
  // 本轮触发的世界书条目 key（阶段二B recency 窗口更新用）
  let lorebookTriggeredIds: string[] | undefined
  // 世界书超限压缩请求（阶段三）
  let lorebookCompressions: LorebookCompressionRequest[] | undefined
  let lorebookCompressionCacheHitKeys: string[] | undefined
  let lorebookTimedEffects: LorebookTimedEffectsState | undefined
  let lorebookDiagnostics: LorebookDiagnostics | undefined
  let lorebookRenderPlan: LorebookRenderPlan = emptyLorebookRenderPlan()

  // 收集所有世界书 ID（群聊级 + 角色绑定）
  const allLorebookIds = new Set<string>(group.lorebookIds)
  members.forEach(m => {
    if (m.boundLorebookIds) {
      m.boundLorebookIds.forEach(id => allLorebookIds.add(id))
    }
  })

  if (allLorebookIds.size > 0) {
    // 可配置扫描深度（H-16 同款修复：reduce 初始值误用固定值 10 会等价于 max(配置, 10)，
    // 用户调小配置（如 2/4）被静默抬回；先收集有效配置，空才回退默认）
    const scanDepth = resolveLorebookScanDepth(
      [...allLorebookIds].flatMap((id) => {
        const lorebook = lorebookCache.get(id)
        return lorebook ? [lorebook.scanDepth, ...lorebook.entries.map((entry) => entry.scanDepth)] : []
      }),
      DEFAULT_LOREBOOK_SCAN_DEPTH,
    )

    // 扫描文本包含角色名前缀，使以角色名为关键词的世界书条目也能被触发
    const scanMessages = (scanDepth === 0 ? [] : state.messages.slice(-scanDepth)).map(m => {
      if (m.characterId === '__user__') return m.content
      const c = members.find(mc => mc.id === m.characterId)
      return `【${c?.name || '未知角色'}】${m.content}`
    })
    const scanText = scanMessages.join(' ')

    const lorebookBudget = budgetBase

    const result = executeLorebookRuntime({
      lorebooks: lorebookCache.getAll([...allLorebookIds]),
      scanText,
      scanMessages,
      userName,
      charName: charNameForVars,
      characterNames: members.map((member) => member.name),
      characterTags: members.flatMap((member) => member.tags ?? []),
      generationType: 'normal',
      messageCount: state.messages.length,
      timedEffects: currentSession?.lorebookTimedEffects,
      budget: lorebookBudget,
      model,
      semanticItems: get()._semanticLoreHits as BudgetLoreItem[],
      // 语义触发不可用时对仅语义条目告警（含未启用 / 未配置两种情况；
      // 本轮已有语义命中时视为可用，避免误告警）
      semanticEnabled: get()._semanticLoreAvailable ?? ((get()._semanticLoreHits as BudgetLoreItem[]).length > 0 || !!(
        settings.semanticTrigger?.enabled
        && settings.semanticTrigger.model?.trim()
        && (settings.semanticTrigger.provider === 'local' || settings.semanticTrigger.baseUrl?.trim())
      )),
      // 阶段二B：受控实体词表补充（成员名 + tags；条目 keywords 与 charName 在工具内始终参与）
      entityVocabulary: [...members.map(m => m.name), ...members.flatMap(m => m.tags ?? [])],
      recentTriggeredIds: currentSession?.recentTriggeredIds,
      // 阶段三：超限压缩缓存（命中时以缓存摘要替代被丢弃条目集合）
      compressionCache: currentSession?.lorebookCompressionCache,
      diagnosticsMode: opts?.lorebookDiagnosticsMode,
    })
    lorebookTriggeredIds = result.triggeredEntryKeys
    lorebookCompressions = result.compressionRequests
    lorebookCompressionCacheHitKeys = result.compressionCacheHitKeys
    lorebookTimedEffects = result.timedEffects
    lorebookDiagnostics = result.diagnostics
    lorebookRenderPlan = result.renderPlan

    if (opts?.lorebookDiagnosticsMode !== 'preview' && result.droppedCount > 0) {
      logInfo('buildGroupContext', `世界书预算裁剪：触发 ${result.triggeredCount} 条，丢弃 ${result.droppedCount} 条（常驻 ${result.alwaysDropped ?? 0} / 条件 ${result.conditionalDropped ?? 0} / 细节 ${result.detailDropped ?? 0}，预算 ${lorebookBudget} tokens）`)
    }
    if (opts?.lorebookDiagnosticsMode !== 'preview' && (result.alwaysDropped ?? 0) > 0) {
      logWarn('buildGroupContext', `常驻世界书条目超出预算硬上限（40%），${result.alwaysDropped} 条被截断：请精简常驻内容或调高世界书预算比例`)
    }
    if (opts?.lorebookDiagnosticsMode !== 'preview' && (result.bookBudgetDropped ?? 0) > 0) {
      logInfo('buildGroupContext', `世界书书级 tokenBudget 超限：${result.bookBudgetDropped} 条被丢弃（激活世界书自带预算上限）`)
    }

    if (lorebookRenderPlan.beforeCharacter.length > 0) {
      lorebookBefore = lorebookRenderPlan.beforeCharacter.join('\n') + '\n'
    }
    if (lorebookRenderPlan.afterCharacter.length > 0) {
      lorebookAfter = lorebookRenderPlan.afterCharacter.join('\n')
    }
    if (lorebookRenderPlan.promptEnd.length > 0) {
      lorebookAtEnd = '\n\n' + lorebookRenderPlan.promptEnd.join('\n')
    }
    if (lorebookRenderPlan.chat.length > 0) {
      atDepthItems = lorebookRenderPlan.chat
    }
  }

  // 完整角色设定（mention/polling 时为目标角色；free 时为所有角色）
  // 文本块收敛到共享模块（含示例锚点重排与世界书前后段包裹的语义钉子）
  const memberCardsOptions = {
    userName,
    shouldSendScenario,
    lorebookBefore,
    lorebookAfter,
    exampleBefore: lorebookRenderPlan.beforeExamples,
    exampleAfter: lorebookRenderPlan.afterExamples,
  }
  if (group.chatMode === 'free') {
    systemContent += buildFreeMemberCards(members, memberCardsOptions)
  } else if (targetCharId) {
    const target = members.find(m => m.id === targetCharId)
    if (target) {
      systemContent += buildTargetMemberCard(target, memberCardsOptions)
    }
  }

  // 用户人设注入（可配置：开关 / 位置 / 字段，与单聊一致；正文收敛到共享模块）
  const personaInjection = settings.personaInjection
    ?? { enabled: true, position: 'system' as const, includeDescription: true, includePersona: true }
  const personaText = buildGroupUserPersona({
    userName,
    userDescription,
    userPersona,
    charNameForVars,
    injection: personaInjection,
  })
  if (personaText && personaInjection.position === 'system') {
    systemContent += '\n【用户人设】\n' + personaText
  }

  // 世界书 at_end 条目
  if (lorebookAtEnd) {
    systemContent += lorebookAtEnd
  }

  // 预设 systemPrompt 和 jailbreak（在 token 预算裁剪前注入，确保计入上下文长度）
  if (preset?.systemPrompt) {
    systemContent += '\n\n' + replaceVariables(preset.systemPrompt, userName, charNameForVars)
  }
  if (preset?.jailbreak && preset.jailbreak.trim()) {
    systemContent += '\n\n' + replaceVariables(preset.jailbreak, userName, charNameForVars)
  }

  // 最终行为约束：与 chatMode 正交，并在桌面端与桥接端复用同一共享构建函数。
  const narrativePrompt = buildGroupNarrativeModePrompt(
    narrativeMode,
    userName,
    charNameForVars || '当前角色',
    group.chatMode,
    settings.omniscientNarrativeRules,
  )
  systemContent += '\n\n' + narrativePrompt

  const spatial = opts?.spatialContext
  if (spatial && currentSession?.spatialContextEnabled !== false) {
    if (spatial.groupId !== group.id || spatial.sessionId !== currentSessionId || spatial.targetCharacterId !== targetCharId || spatial.narrativeMode !== narrativeMode || JSON.stringify(spatial.memberIds) !== JSON.stringify(group.memberIds) || (currentSession?.spatialWorldId && spatial.version.worldId !== currentSession.spatialWorldId) || (currentSession?.spatialRuntimeId && spatial.version.runtimeId !== currentSession.spatialRuntimeId)) throw new Error('群聊画板读取范围已变化，请重新发送')
    if (narrativeMode === 'immersive' && spatial.characterOffstage) throw new Error('该角色在画板中明确不参与对话')
    const available = budgetBase - estimateTokens(systemContent, model) - 256
    const text = estimateTokens(spatial.text, model) <= available ? spatial.text : spatial.minimalText
    if (estimateTokens(text, model) > available) throw new Error('群聊上下文无法容纳必要的位置关系，请精简设定后重试')
    systemContent += '\n\n' + text
  }

  // ===== 历史消息（Token 预算裁剪）=====
  let usedTokens = estimateTokens(systemContent, model)

  // 预计算后历史指令并预留 token 预算（避免裁剪后注入导致超限；拼接收敛到共享模块）
  const postHistoryText = buildGroupPostHistoryInstructions({
    chatMode: group.chatMode,
    members,
    target: targetChar ?? null,
    userName,
    charNameForVars,
  })
  if (postHistoryText) {
    usedTokens += estimateTokens(postHistoryText, model)
  }
  usedTokens += [...lorebookRenderPlan.chat, ...lorebookRenderPlan.authorsNoteBottom]
    .reduce((sum, item) => sum + estimateTokens(typeof item === 'string' ? item : item.content, model), 0)
  // 图片 token 预算：群聊用户消息的图片按固定估算值计入
  const historyImageTokens = state.messages.reduce(
    (s, m) => s + (m.characterId === '__user__' ? estimateImageTokens(m.images?.length ?? 0) : 0),
    0,
  )
  usedTokens += historyImageTokens

  // 按 token 预算裁剪历史消息（共享工具，含被裁剪范围记录）
  const { recent: recentMessages, droppedStartTs, droppedEndTs, droppedTokens, droppedEndIndex } = cropHistory(
    state.messages, usedTokens, budgetBase, model,
  )

  // 上下文溢出压缩（P0-1）：有压缩摘要则注入；否则若裁剪量超阈值，标记异步压缩
  const compression = settings.contextCompression ?? { enabled: true, minDropTokens: 2000 }
  let compressedSummaryInjected = ''
  // 群聊长期时间线已存在时，压缩摘要会与其重复，直接跳过。
  const hasTimelineMemory = Boolean(currentSession?.memory?.trim())
  if (compression.enabled && !hasTimelineMemory && droppedTokens > 0 && currentSession) {
    const covered = validCompression(currentSession, state.messages, groupFeatureScope(group)) && !!currentSession.compressedSummary
      && !!currentSession.compressedRange
      && droppedStartTs >= currentSession.compressedRange.startTs
      && droppedEndTs <= currentSession.compressedRange.endTs
    if (currentSession.compressedSummary && covered) {
      compressedSummaryInjected = currentSession.compressedSummary
    } else if (opts?.trackUsage !== false && droppedTokens >= (compression.minDropTokens ?? 2000)) {
      markPendingGroupCompression({
        groupId: group.id,
        sessionId: get().currentSessionId ?? '',
        droppedText: droppedEndIndex >= 0
          ? state.messages.slice(0, droppedEndIndex + 1).map((m) => {
              if (m.characterId === '__user__' || m.characterId === '__free__') {
                return `${userName}: ${m.content}`
              }
              const c = members.find((mc) => mc.id === m.characterId)
              return `【${c?.name || '未知角色'}】${m.content}`
            }).join('\n')
          : '',
        droppedStartTs,
        droppedEndTs,
        source: { ...featureSource(state.messages.filter(m => m.timestamp >= droppedStartTs && m.timestamp <= droppedEndTs), 'range', featureSessionRef(currentSession)),
          range: { startTs: droppedStartTs, endTs: droppedEndTs }, groupFingerprint: featureFingerprint(groupFeatureScope(group)), },
        expectedCompression: compressionVersion(currentSession),
      })
    }
  }

  const context: { role: 'system' | 'user' | 'assistant'; content: string; keepSeparate?: boolean }[] = [
    // 宏展开（群聊名 / 预设 / 人设 / 世界书 at_end / 角色设定均支持）
    { role: 'system', content: expandMacros(systemContent, buildMacroContext(state.messages.map((m) => ({
      role: (m.characterId === '__user__' || m.characterId === '__free__') ? 'user' as const : 'assistant' as const,
      content: m.content,
    })), {
      userName,
      charName: charNameForVars,
      groupName: group.name,
    })) },
  ]

  for (const content of lorebookRenderPlan.authorsNoteTop) {
    context.push({ role: 'system', content, keepSeparate: true })
  }

  // 用户人设 separate 模式：独立 system 消息
  if (personaText && personaInjection.position === 'separate') {
    context.push({ role: 'system', content: '【用户人设】\n' + personaText, keepSeparate: true })
  }

  const historyContext: { role: 'system' | 'user' | 'assistant'; content: string; keepSeparate?: boolean }[] = []
  // 上下文溢出压缩摘要：置于历史段最前
  if (compressedSummaryInjected) {
    historyContext.push({
      role: 'system',
      content: '【早期对话压缩摘要】\n' + compressedSummaryInjected,
      keepSeparate: true,
    })
  }
  // 历史归属标注收敛到共享模块（M-23 空正文过滤 / 用户无前缀带图片 / 角色【名】前缀）
  for (const entry of mapGroupHistoryMessages({ messages: recentMessages, members, userName, charNameForVars })) {
    historyContext.push({
      role: entry.role,
      content: entry.content,
      // 用户消息图片 → vision 模型识别（角色消息无图片回传）
      ...(entry.images?.length ? { images: entry.images } : {}),
    })
  }

  // at_depth 世界书按深度注入历史消息段（共享工具）
  const depthInserts: DepthInsertItem[] =
    atDepthItems.map((i) => ({ content: i.content, depth: i.depth, order: i.order, role: i.role }))
  lorebookRenderPlan.authorsNoteBottom.forEach((content, index) => {
    depthInserts.push({ content, depth: 0, order: -2_000 + index })
  })
  const depthInjected = applyDepthInserts(
    historyContext,
    depthInserts,
    (content) => ({ role: 'system' as const, content, keepSeparate: true }),
    (content, role) => ({ role: (role ?? 'system') as 'system', content, keepSeparate: true }),
  )

  // 后历史指令（mention/polling 模式注入目标角色，free 模式注入所有成员，复用预计算结果）
  if (postHistoryText.trim()) {
    depthInjected.push({ role: 'system', content: postHistoryText.trim() })
  }

  // Instruct 模板：appendAssistantPrefix 时追加空 assistant 消息
  const instructTemplate = resolveEffectiveTemplate(
    preset?.contextTemplate,
    profile?.provider || 'openai',
    model,
    profile?.useInstructTemplate,
  )
  if (instructTemplate?.appendAssistantPrefix && charNameForVars) {
    depthInjected.push({ role: 'assistant', content: '' })
  }

  // 后处理：合并连续消息 + 按 provider 格式转换
  let processedContext = mergeConsecutiveMessages([...context, ...depthInjected])
  const provider = profile?.provider || 'openai'
  processedContext = convertMessages(provider, processedContext, {
    charName: charNameForVars || '角色',
    userName,
  })

  void opts
  return {
    messages: processedContext,
    narrativeMode,
    responsePolicy: requestPlan.responsePolicy,
    requestBudget: requestPlan.requestBudget,
    requestMaxTokens: requestPlan.requestMaxTokens,
    lorebookTriggeredIds,
    lorebookCompressions,
    lorebookCompressionCacheHitKeys,
    lorebookTimedEffects,
    lorebookDiagnostics,
  }
}
