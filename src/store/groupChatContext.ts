import type { Character, Preset } from '../../shared/types'
import { useSettingsStore } from './useSettingsStore'
import { useCharacterStore } from './useCharacterStore'
import { lorebookCache, triggerLorebooks, mergeSemanticHits } from '../utils/lorebook'
import type { DepthLoreItem } from '../utils/lorebook'
import { estimateTokens, getDefaultMaxContext, estimateImageTokens } from '../utils/tokenCounter'
import { replaceVariables } from '../utils/variables'
import { mergeConsecutiveMessages } from '../utils/messagePostProcess'
import { convertMessages } from '../utils/promptConverters'
import { resolveEffectiveTemplate } from '../utils/chatTemplates'
import { fitLayeredMemoryBudget, formatMemoryFacts } from '../utils/memory'
import { expandMacros, buildMacroContext } from '../utils/macros'
import { logInfo } from '../lib/logger'
import { DEFAULT_LOREBOOK_RATIO, TOKEN_BUDGET_SAFETY, DEFAULT_RESERVED_OUTPUT } from './chatConstants'
import { markPendingGroupCompression } from './groupStreamController'
import { cropHistory, applyDepthInserts, type DepthInsertItem } from './contextShared'
import type { GroupStoreGet } from './groupChatTypes'

/**
 * 构建群聊发送给 AI 的完整上下文。
 * 从 useGroupChatStore.buildGroupContext 抽出，依赖通过 get 注入。
 */
export function buildGroupChatContext(
  get: GroupStoreGet,
  targetCharId?: string,
  preset?: Preset | null,
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const state = get()
  const group = state.currentGroup
  if (!group) return []

  const charStore = useCharacterStore.getState()
  const settingsStore = useSettingsStore.getState()
  const settings = settingsStore.settings
  const userName = settings.userName || '用户'
  const members = group.memberIds
    .map(id => charStore.characters.find(c => c.id === id))
    .filter(Boolean) as Character[]

  // 变量替换用的 charName（mention/polling 为目标角色名，free 为成员列表）
  const targetChar = targetCharId ? members.find(m => m.id === targetCharId) : undefined
  const charNameForVars = targetChar?.name || members.map(m => m.name).join('、')

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
  const { sessions, currentSessionId } = get()
  const currentSession = sessions.find(s => s.id === currentSessionId)
  if (currentSession?.memoryEnabled) {
    const memoryBudget = Math.min(800, Math.floor(budgetBase * 0.1))
    // P0-2：语义检索命中时仅注入相关事实，否则全量
    const semanticFacts = get()._semanticFactsHits
    const factsForInject = semanticFacts.length > 0 ? semanticFacts : (currentSession.memoryFacts ?? [])
    const fitted = fitLayeredMemoryBudget(
      currentSession.memoryCurrentState,
      currentSession.memory || '',
      factsForInject,
      memoryBudget,
      estimateTokens,
      model,
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

  // 群聊自定义 systemPrompt（含变量替换）
  if (group.systemPrompt) {
    systemContent += '\n' + replaceVariables(group.systemPrompt, userName, charNameForVars) + '\n'
  }

  // ===== 世界书注入（递归扫描 + 正则 + 变量替换 + at_depth 深度注入）=====
  let lorebookBefore = ''
  let lorebookAfter = ''
  let lorebookAtEnd = ''
  let atDepthItems: DepthLoreItem[] = []

  // 收集所有世界书 ID（群聊级 + 角色绑定）
  const allLorebookIds = new Set<string>(group.lorebookIds)
  members.forEach(m => {
    if (m.boundLorebookIds) {
      m.boundLorebookIds.forEach(id => allLorebookIds.add(id))
    }
  })

  if (allLorebookIds.size > 0) {
    // 可配置扫描深度
    const scanDepth = [...allLorebookIds]
      .map(id => lorebookCache.get(id)?.scanDepth)
      .filter((d): d is number => typeof d === 'number' && d > 0)
      .reduce((max, d) => Math.max(max, d), 10)

    // 扫描文本包含角色名前缀，使以角色名为关键词的世界书条目也能被触发
    const scanText = state.messages.slice(-scanDepth).map(m => {
      if (m.characterId === '__user__') return m.content
      const c = members.find(mc => mc.id === m.characterId)
      return `【${c?.name || '未知角色'}】${m.content}`
    }).join(' ')

    const lorebookRatio = settings.lorebookRatio ?? DEFAULT_LOREBOOK_RATIO
    const lorebookBudget = Math.floor(budgetBase * Math.min(Math.max(lorebookRatio, 0.05), 1))

    const result = mergeSemanticHits(
      triggerLorebooks({
        lorebooks: lorebookCache.getAll([...allLorebookIds]),
        scanText,
        userName,
        charName: charNameForVars,
        budget: lorebookBudget,
        model,
      }),
      get()._semanticLoreHits,
      lorebookBudget,
      model,
    )

    if (result.droppedCount > 0) {
      logInfo('buildGroupContext', `世界书预算裁剪：触发 ${result.triggeredCount} 条，丢弃 ${result.droppedCount} 条（预算 ${lorebookBudget} tokens）`)
    }

    if (result.beforeChar.length > 0) {
      lorebookBefore = result.beforeChar.join('\n') + '\n'
    }
    if (result.afterChar.length > 0) {
      lorebookAfter = result.afterChar.join('\n')
    }
    if (result.atEnd.length > 0) {
      lorebookAtEnd = '\n\n' + result.atEnd.join('\n')
    }
    if (result.atDepth.length > 0) {
      atDepthItems = result.atDepth
    }
  }

  // 完整角色设定（mention/polling 时为目标角色；free 时为所有角色）
  if (group.chatMode === 'free') {
    systemContent += '\n\n' + lorebookBefore + '以下是所有角色的完整设定：\n'
    members.forEach(m => {
      systemContent += `\n--- ${m.name} ---\n`
      if (m.description) systemContent += `描述：${replaceVariables(m.description, userName, m.name)}\n`
      if (m.personality) systemContent += `性格：${replaceVariables(m.personality, userName, m.name)}\n`
      if (m.scenario) systemContent += `场景：${replaceVariables(m.scenario, userName, m.name)}\n`
      if (m.systemPrompt) systemContent += `\n${replaceVariables(m.systemPrompt, userName, m.name)}\n`
      if (m.exampleDialog) systemContent += `\n对话示例：\n${replaceVariables(m.exampleDialog, userName, m.name)}\n`
    })
    if (lorebookAfter) systemContent += '\n' + lorebookAfter
  } else if (targetCharId) {
    const target = members.find(m => m.id === targetCharId)
    if (target) {
      systemContent += `\n\n${lorebookBefore}【当前发言角色：${target.name}】\n`
      if (target.description) systemContent += `描述：${replaceVariables(target.description, userName, target.name)}\n`
      if (target.personality) systemContent += `性格：${replaceVariables(target.personality, userName, target.name)}\n`
      if (target.scenario) systemContent += `场景：${replaceVariables(target.scenario, userName, target.name)}\n`
      if (target.systemPrompt) systemContent += `\n${replaceVariables(target.systemPrompt, userName, target.name)}\n`
      if (target.exampleDialog) systemContent += `\n对话示例：\n${replaceVariables(target.exampleDialog, userName, target.name)}\n`
      if (lorebookAfter) systemContent += '\n' + lorebookAfter
    }
  }

  // 用户人设注入（可配置：开关 / 位置 / 字段，与单聊一致）
  const personaInjection = settings.personaInjection
    ?? { enabled: true, position: 'system' as const, includeDescription: true, includePersona: true }
  let personaText = ''
  if (personaInjection.enabled) {
    personaText += `用户名：${userName}\n`
    if (personaInjection.includeDescription !== false && settings.userDescription) {
      personaText += `描述：${replaceVariables(settings.userDescription, userName, charNameForVars)}\n`
    }
    if (personaInjection.includePersona !== false && settings.userPersona) {
      personaText += `性格：${replaceVariables(settings.userPersona, userName, charNameForVars)}\n`
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
  // 预留作者注释（middle/bottom 在历史段内注入）
  const anConfig = settings.authorNote
  if (anConfig?.enabled && anConfig.text?.trim() && anConfig.position !== 'top') {
    usedTokens += estimateTokens(replaceVariables(anConfig.text.trim(), userName, charNameForVars), model)
  }
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
    } else if (droppedTokens >= (compression.minDropTokens ?? 2000)) {
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

  // 用户人设 separate 模式：独立 system 消息
  if (personaText && personaInjection.position === 'separate') {
    context.push({ role: 'system', content: '【用户人设】\n' + personaText, keepSeparate: true })
  }

  // ===== 作者注释（Author's Note，群聊仅全局级，anConfig 已在预算预留处声明）=====
  let anText = ''
  if (anConfig?.enabled && anConfig.text?.trim()) {
    anText = expandMacros(replaceVariables(anConfig.text.trim(), userName, charNameForVars), buildMacroContext(state.messages.map((m) => ({
      role: (m.characterId === '__user__' || m.characterId === '__free__') ? 'user' as const : 'assistant' as const,
      content: m.content,
    })), {
      userName,
      charName: charNameForVars,
      groupName: group.name,
    }))
  }
  // top：紧跟系统提示注入（keepSeparate：避免被 merge 合并进系统提示）
  if (anText && anConfig!.position === 'top') {
    context.push({ role: 'system', content: anText, keepSeparate: true })
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

  // at_depth 世界书 + 作者注释（middle/bottom）统一按深度注入历史消息段（共享工具）
  const depthInserts: DepthInsertItem[] =
    atDepthItems.map((i) => ({ content: i.content, depth: i.depth, order: i.order }))
  if (anText && anConfig!.position !== 'top') {
    const anDepth = anConfig!.position === 'middle' ? Math.max(0, anConfig!.depth) : 0
    depthInserts.push({ content: anText, depth: anDepth, order: -1 })
  }
  const depthInjected = applyDepthInserts(
    historyContext,
    depthInserts,
    (content) => ({ role: 'system' as const, content, keepSeparate: true }),
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

  return processedContext
}
