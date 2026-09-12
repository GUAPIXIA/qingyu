import type { Character, LorebookTimedEffectsState, Preset } from '../../shared/types'
import { useSettingsStore } from './useSettingsStore'
import { useCharacterStore } from './useCharacterStore'
import { usePersonaStore } from './usePersonaStore'
import {
  lorebookCache,
  executeLorebookRuntime,
  type BudgetLoreItem,
  type LorebookCompressionRequest,
  type LorebookDiagnostics,
} from '../utils/lorebook'
import type { DepthLoreItem } from '../utils/lorebook'
import { emptyLorebookRenderPlan, type LorebookRenderPlan } from '../utils/lorebookRenderer'
import { estimateTokens, getDefaultMaxContext, estimateImageTokens } from '../utils/tokenCounter'
import { replaceVariables } from '../utils/variables'
import { mergeConsecutiveMessages } from '../utils/messagePostProcess'
import { convertMessages } from '../utils/promptConverters'
import { resolveEffectiveTemplate } from '../utils/chatTemplates'
import { fitLayeredMemoryBudget, formatMemoryFacts } from '../utils/memory'
import { expandMacros, buildMacroContext } from '../utils/macros'
import { logInfo, logWarn } from '../lib/logger'
import { DEFAULT_LOREBOOK_RATIO, DEFAULT_LOREBOOK_SCAN_DEPTH, TOKEN_BUDGET_SAFETY, DEFAULT_RESERVED_OUTPUT, resolveLorebookScanDepth } from './chatConstants'
import { markPendingGroupCompression } from './groupStreamController'
import { cropHistory, applyDepthInserts, type DepthInsertItem } from './contextShared'
import type { GroupStoreGet } from './groupChatTypes'
import type { NarrativeMode } from '../../shared/types'
import { buildGroupNarrativeModePrompt, resolveNarrativeMode } from '../../shared/narrativeMode'

/** 群聊上下文组装结果：消息 + 本轮世界书触发键 / 超限压缩请求（调用方写回 store） */
export interface GroupContextBuildResult {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  /** 本次上下文实际采用的叙事模式，供调试界面与跨端测试确认。 */
  narrativeMode: NarrativeMode
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
  opts?: { trackUsage?: boolean; lorebookDiagnosticsMode?: 'live' | 'preview' },
): GroupContextBuildResult {
  const state = get()
  const group = state.currentGroup
  if (!group) return { messages: [], narrativeMode: 'immersive' }

  const charStore = useCharacterStore.getState()
  const settingsStore = useSettingsStore.getState()
  const settings = settingsStore.settings
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

  // 变量替换用的 charName（mention/polling 为目标角色名，free 为成员列表）
  const targetChar = targetCharId ? members.find(m => m.id === targetCharId) : undefined
  const charNameForVars = targetChar?.name || members.map(m => m.name).join('、')
  // 已存在但缺少字段的旧会话固定按 immersive 运行；只有无会话预览才解析群聊/全局默认。
  const narrativeMode = currentSession
    ? resolveNarrativeMode(currentSession.narrativeMode)
    : resolveNarrativeMode(group.defaultNarrativeMode, settings.defaultNarrativeMode)

  let systemContent = ''

  // 群聊 Overview
  systemContent += `你正在参与一个群聊「${group.name}」。本群聊中共有 ${members.length} 个角色参与对话：\n`
  members.forEach((m, i) => {
    const desc = m.description ? ' - ' + m.description.slice(0, 80) : ''
    systemContent += `${i + 1}. 【${m.name}】${desc}\n`
  })
  systemContent += `\n用户「${userName}」也在群聊中。\n`

  // 模式指令
  switch (group.chatMode) {
    case 'mention':
      systemContent += '\n【对话规则】用户通过 @角色名 指定回复对象。只有被点名的角色才需要回复。回复时请以该角色的第一人称视角发言，不要替其他角色说话。\n'
      break
    case 'polling':
      systemContent += '\n【对话规则】当前采用自动轮询模式。每次只轮到一位角色发言。请以该角色的第一人称视角回复，不要替其他角色或用户发言。\n'
      break
    case 'free':
      systemContent += '\n【对话规则】你可以让多个角色参与对话。如果多个角色需要发言，请用「【角色名】」标注每段发言的发言人。\n'
      break
  }

  // 心理描写格式
  if (settings.enableThoughtFormat !== false) {
    systemContent += '\n【输出格式】如果需要描写角色内心活动或心理,请将心理描写放在 <thought>...</thought> 标签内。\n'
  }

  // ===== Token 预算框架（与单聊路径一致）=====
  const profile = settingsStore.getActiveProfile()
  const model = profile?.model || settings.activeModel || 'gpt-4o-mini'
  const maxContext = profile?.maxContext || preset?.maxContext || getDefaultMaxContext(model)
  const reservedOutput = preset?.maxTokens ?? DEFAULT_RESERVED_OUTPUT
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

    const lorebookRatio = settings.lorebookRatio ?? DEFAULT_LOREBOOK_RATIO
    const lorebookBudget = Math.floor(budgetBase * Math.min(Math.max(lorebookRatio, 0.05), 1))

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
  if (group.chatMode === 'free') {
    systemContent += '\n\n' + lorebookBefore + '以下是所有角色的完整设定：\n'
    const hasExampleAnchors = lorebookRenderPlan.beforeExamples.length > 0
      || lorebookRenderPlan.afterExamples.length > 0
    members.forEach(m => {
      systemContent += `\n--- ${m.name} ---\n`
      if (m.description) systemContent += `描述：${replaceVariables(m.description, userName, m.name)}\n`
      if (m.personality) systemContent += `性格：${replaceVariables(m.personality, userName, m.name)}\n`
      if (m.scenario) systemContent += `场景：${replaceVariables(m.scenario, userName, m.name)}\n`
      if (m.systemPrompt) systemContent += `\n${replaceVariables(m.systemPrompt, userName, m.name)}\n`
      if (!hasExampleAnchors && m.exampleDialog) {
        systemContent += `\n对话示例：\n${replaceVariables(m.exampleDialog, userName, m.name)}\n`
      }
    })
    if (hasExampleAnchors) {
      if (lorebookRenderPlan.beforeExamples.length > 0) {
        systemContent += '\n' + lorebookRenderPlan.beforeExamples.join('\n') + '\n'
      }
      members.forEach((member) => {
        if (member.exampleDialog) {
          systemContent += `\n对话示例（${member.name}）：\n${replaceVariables(member.exampleDialog, userName, member.name)}\n`
        }
      })
      if (lorebookRenderPlan.afterExamples.length > 0) {
        systemContent += '\n' + lorebookRenderPlan.afterExamples.join('\n') + '\n'
      }
    }
    if (lorebookAfter) systemContent += '\n' + lorebookAfter
  } else if (targetCharId) {
    const target = members.find(m => m.id === targetCharId)
    if (target) {
      systemContent += `\n\n${lorebookBefore}【当前发言角色：${target.name}】\n`
      if (target.description) systemContent += `描述：${replaceVariables(target.description, userName, target.name)}\n`
      if (target.personality) systemContent += `性格：${replaceVariables(target.personality, userName, target.name)}\n`
      if (target.scenario) systemContent += `场景：${replaceVariables(target.scenario, userName, target.name)}\n`
      if (target.systemPrompt) systemContent += `\n${replaceVariables(target.systemPrompt, userName, target.name)}\n`
      if (lorebookRenderPlan.beforeExamples.length > 0) {
        systemContent += '\n' + lorebookRenderPlan.beforeExamples.join('\n') + '\n'
      }
      if (target.exampleDialog) systemContent += `\n对话示例：\n${replaceVariables(target.exampleDialog, userName, target.name)}\n`
      if (lorebookRenderPlan.afterExamples.length > 0) {
        systemContent += '\n' + lorebookRenderPlan.afterExamples.join('\n') + '\n'
      }
      if (lorebookAfter) systemContent += '\n' + lorebookAfter
    }
  }

  // 用户人设注入（可配置：开关 / 位置 / 字段，与单聊一致）
  const personaInjection = settings.personaInjection
    ?? { enabled: true, position: 'system' as const, includeDescription: true, includePersona: true }
  let personaText = ''
  if (personaInjection.enabled) {
    personaText += `用户名：${userName}\n`
    if (personaInjection.includeDescription !== false && userDescription) {
      personaText += `描述：${replaceVariables(userDescription, userName, charNameForVars)}\n`
    }
    if (personaInjection.includePersona !== false && userPersona) {
      personaText += `性格：${replaceVariables(userPersona, userName, charNameForVars)}\n`
    }
    if (personaText && personaInjection.position === 'system') {
      systemContent += '\n【用户人设】\n' + personaText
    }
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

  // ===== 历史消息（Token 预算裁剪）=====
  let usedTokens = estimateTokens(systemContent, model)

  // 预计算后历史指令并预留 token 预算（避免裁剪后注入导致超限）
  let postHistoryText = ''
  if (group.chatMode === 'free') {
    for (const m of members) {
      if (m.postHistoryInstructions) {
        postHistoryText += replaceVariables(m.postHistoryInstructions, userName, m.name) + '\n'
      }
    }
  } else if (targetChar?.postHistoryInstructions) {
    postHistoryText = replaceVariables(targetChar.postHistoryInstructions, userName, charNameForVars)
  }
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
    const covered = !!currentSession.compressedSummary
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
  recentMessages.forEach(m => {
    // M-23 修复：过滤空 content 消息（空占位/__free__ 错误消息）——
    // 空 assistant 消息进上下文会干扰模型输出格式（单聊有对等过滤）
    if (!m.content || !m.content.trim()) return
    const char = members.find(c => c.id === m.characterId)
    const speaker = m.characterId === '__user__'
      ? userName
      : (char?.name || '未知角色')

    if (m.characterId === '__user__') {
      historyContext.push({
        role: 'user',
        content: replaceVariables(m.content, userName, charNameForVars),
        // 用户消息图片 → vision 模型识别（角色消息无图片回传）
        ...(m.images?.length ? { images: m.images } : {}),
      })
    } else {
      historyContext.push({
        role: 'assistant',
        content: `【${speaker}】${replaceVariables(m.content, userName, speaker)}`,
      })
    }
  })

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
    lorebookTriggeredIds,
    lorebookCompressions,
    lorebookCompressionCacheHitKeys,
    lorebookTimedEffects,
    lorebookDiagnostics,
  }
}
