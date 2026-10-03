import { featureSource, featureSessionRef, matchesFeatureSource, featureFingerprint, groupFeatureScope, type FeatureOwner } from '../../shared/featureSource'
import { beginFeatureTask, cancelFeatureTasks, finishFeatureTask, requestFeatureText, type FeatureTask } from './featureTasks'
/**
 * “下一步方向”运行时：发起独立辅助请求 → 严格校验 → 回写消息。
 *
 * 与主回复解耦：主回复流式展示后，本模块异步补齐方向；失败只静默降级，
 * 不影响正文与发送状态（见方案 §4.1 / §10）。
 */
import type { ChatParams, Character, DialogueDirection, GroupMessage, NarrativeMode } from '../../shared/types'
import {
  DIALOGUE_DIRECTION_TEMPERATURE,
  buildDialogueDirectionSystemPrompt,
  buildDialogueDirectionUserPrompt,
  parseDialogueDirections,
  type DirectionGenerationInput,
} from '../../shared/dialogueDirections'
import { BACKGROUND_GENERATION_PROFILES } from '../../shared/backgroundGeneration'
import { resolveCachedRendererGenerationTaskBudget } from './generationTaskBudget'
import { noteGateRecoveryFailure } from './reasoningGateState'
import { stripThought } from '../../shared/chat-core/messagePostProcess'
import { resolveNarrativeMode } from '../../shared/narrativeMode'
import { resolveDialogueDirectionsEnabled } from '../../shared/dialogueDirections'
import { useSettingsStore, type ActiveProfile } from './useSettingsStore'
import { useCharacterStore } from './useCharacterStore'
import { getDisplayName } from '../../shared/chat-core/variables'
import { logError } from '../lib/logger'
import type { StoreGet, StoreSet } from '../features/chat/chatStoreTypes'
import type { GroupStoreGet, GroupStoreSet } from './groupChatTypes'

/** 每条消息最多保留的最近对话条数（方案 §4.1：最近 4–6 条）。 */
const RECENT_MESSAGE_LIMIT = 6

/** 可以按 owner 精确取消；未指定 owner 保留既有全局取消入口。 */
export function cancelDialogueDirectionRequests(messageIds?: readonly string[], owner?: FeatureOwner): void {
  cancelFeatureTasks(owner, messageIds, 'direction')
}

export interface DirectionCallResult {
  text: string
  /** 阶段8（§4.4/§4.7）：主进程下发的结构化终止原因（提前中止时为 reasoning_gate_exceeded） */
  terminationCause?: import('../../shared/types').GenerationTerminationCause
}

/** 专用提示、连接快照和任务身份在重试之间保持不变。 */
async function callDirectionHelper(profile: ActiveProfile, task: FeatureTask, messages: ChatParams['messages'], opts?: { downgradeRetry?: boolean }): Promise<DirectionCallResult> {
  const budget = resolveCachedRendererGenerationTaskBudget({ profile, model: profile.model, task: 'direction',
    expectedBodyChars: BACKGROUND_GENERATION_PROFILES.direction.expectedBodyChars, usageTaskType: 'direction' })
  const { text, completion } = await requestFeatureText(task, {
    ...profile, requestId: `${task.id}-${opts?.downgradeRetry ? 'downgrade' : Math.random().toString(36).slice(2)}`,
    messages, temperature: DIALOGUE_DIRECTION_TEMPERATURE, topP: 0.9, maxTokens: budget.requestMaxTokens,
    frequencyPenalty: 0, presencePenalty: 0, stream: false, reasoningGate: budget.reasoningGate,
    observability: { source: 'aux', taskType: 'direction', ...(opts?.downgradeRetry ? { downgradeRetry: true } : {}) },
  })
  return { text: completion.finishReason && completion.finishReason !== 'stop' ? '' : stripThought(text),
    terminationCause: completion.terminationCause ?? (completion.finishReason === 'length' ? 'provider_length' : undefined) }
}

/** 调用辅助模型并返回方向列表；结构非法时重试一次，第二次仍失败返回空。 */
async function requestDialogueDirections(
  task: FeatureTask,
  input: DirectionGenerationInput,
): Promise<DialogueDirection[]> {
  const profile = useSettingsStore.getState().getActiveProfile()
  if (!profile) throw new Error('未配置 API 连接')
  const systemPrompt = buildDialogueDirectionSystemPrompt(input)
  const userPrompt = buildDialogueDirectionUserPrompt(input)
  const messages: ChatParams['messages'] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]

  const first = await callDirectionHelper(profile, task, messages)
  const parsed = parseDialogueDirections(first.text)
  if (parsed.length > 0) return parsed
  // 请求期间被取消（会话切换 / 消息失效）：不再发起重试
  if (task.controller.signal.aborted) return []

  // 阶段8（§4.5/§6.4）：首次推理挤占（length + 零正文）允许一次降档重试，
  // 复用同一 prompt 快照；第二次无论再挤占还是结构非法，都不再发起第三次。
  const reasoningExhausted = !first.text.trim()
    && (first.terminationCause === 'reasoning_gate_exceeded' || first.terminationCause === 'provider_length')
  if (reasoningExhausted) {
    const retry = await callDirectionHelper(profile, task, messages, { downgradeRetry: true })
    const retryParsed = parseDialogueDirections(retry.text)
    if (retryParsed.length > 0) return retryParsed
    // 两次都失败：记录熔断事实（该端点本会话内不可靠，后续请求从更低档起步）
    noteGateRecoveryFailure({ provider: profile.provider, baseUrl: profile.baseUrl, model: profile.model, task: 'direction' })
    return []
  }

  const retry = await callDirectionHelper(profile, task, [
    {
      role: 'system',
      content: `${systemPrompt}\n\n上一次输出结构不合法。不要分析或解释，只返回一组 <directions>...</directions> 包裹的合法 JSON 数组。`,
    },
    { role: 'user', content: userPrompt },
  ])
  return parseDialogueDirections(retry.text)
}

/** 单聊与群聊共用的方向请求参数（角色、世界状态、最近对话、叙事模式快照）。 */
interface DirectionContext {
  character: Character
  userName: string
  charName: string
  narrativeMode: NarrativeMode
  recentMessages: Array<{ speaker: string; content: string }>
  latestReply: string
  worldState?: string
}

function buildInput(context: DirectionContext): DirectionGenerationInput {
  return {
    userName: context.userName,
    charName: context.charName,
    characterDescription: context.character.description ?? '',
    narrativeMode: context.narrativeMode,
    recentMessages: context.recentMessages,
    latestReply: context.latestReply,
    worldState: context.worldState,
  }
}

function recentDialogue(
  messages: Array<{ role?: string; characterId?: string; speakerKind?: string; content: string; narrativeMode?: NarrativeMode }>,
  index: number,
  resolveSpeaker: (message: { role?: string; characterId?: string; speakerKind?: string; content: string }) => string,
): Array<{ speaker: string; content: string }> {
  return messages
    .slice(Math.max(0, index - RECENT_MESSAGE_LIMIT), index)
    .filter((message) => !!stripThought(message.content || '').trim())
    .map((message) => ({
      speaker: resolveSpeaker(message),
      content: stripThought(message.content || '').slice(0, 400),
    }))
}

/**
 * 为单聊的最后一条 AI 消息生成方向并回写持久化。
 * @returns 生成成功返回方向数组；失败/取消/重复请求返回空数组。
 */
export async function generateSingleDialogueDirections(
  set: StoreSet,
  get: StoreGet,
  opts: { messageId: string; character: Character },
): Promise<DialogueDirection[]> {
  const { messageId, character } = opts
  const state = get()
  const index = state.messages.findIndex((message) => message.id === messageId)
  if (index < 0) return []
  const target = state.messages[index]
  if (target.role !== 'assistant' || !(target.content || '').trim()) return []

  const userName = useSettingsStore.getState().settings.userName || '用户'
  const session = state.sessions.find((item) => item.id === target.sessionId)
  const input = buildInput({
    character,
    userName,
    charName: getDisplayName(character),
    // 方向描述“用户下一步可以做什么”，会以当前会话模式发送，因此以会话模式为准；
    // 消息上的快照只在会话缺少该字段时兜底（历史消息的快照可能落后于当前模式）。
    narrativeMode: resolveNarrativeMode(session?.narrativeMode, target.narrativeMode),
    recentMessages: recentDialogue(state.messages, index, (message) => (
      message.role === 'user' ? userName : getDisplayName(character)
    )),
    latestReply: stripThought(target.content || ''),
    worldState: session?.memoryCurrentState,
  })
  const source = featureSource(state.messages, 'whole', featureSessionRef(session, ['narrativeMode', 'personaId', 'memoryCurrentState']))
  const task = beginFeatureTask({ kind: 'single', characterId: target.characterId, sessionId: target.sessionId }, 'direction', source, messageId)
  if (!task) return []
  try {
    const directions = await requestDialogueDirections(task, input)
    if (!directions.length || task.controller.signal.aborted) return []
    return await persistSingleDirections(set, get, messageId, directions, task) ? directions : []
  } catch (error) {
    if (!task.controller.signal.aborted) logError('DialogueDirections:single', error)
    return []
  } finally { finishFeatureTask(task) }
}

/** 把方向写回消息（内存 + 持久化）。调用方负责校验方向非空。 */
export async function persistSingleDirections(
  set: StoreSet, get: StoreGet, messageId: string, directions: DialogueDirection[], task?: FeatureTask,
): Promise<boolean> {
  const current = get().messages.find(m => m.id === messageId)
  const owner = task?.owner ?? (current && { kind: 'single' as const, characterId: current.characterId, sessionId: current.sessionId })
  if (!owner || owner.kind !== 'single' || task?.controller.signal.aborted || (!task && !current?.content.trim())) return false
  const source = task?.source ?? featureSource([current!], 'message')
  const session = get().sessions.find(s => s.id === owner.sessionId)
  const displayed = get().currentSessionId === owner.sessionId || get().messages.some(m => m.sessionId === owner.sessionId)
  if (displayed && !matchesFeatureSource(source, get().messages, session)) return false
  const applied = await window.api.chat.commitFeatureResult(owner.characterId, owner.sessionId,
    { feature: 'direction', taskId: task?.id ?? `direction-save-${Date.now()}-${Math.random()}`, source, messageId, directions })
  if (applied && !task?.controller.signal.aborted && get().messages.some(m => m.sessionId === owner.sessionId)
    && matchesFeatureSource(source, get().messages, get().sessions.find(s => s.id === owner.sessionId))) {
    set(s => ({ messages: s.messages.map(m => m.id === messageId ? { ...m, dialogueDirections: directions, dialogueDirectionsGeneratedAt: Date.now(), dialogueDirectionsSource: source } : m) }))
  }
  return applied
}

/** 群聊中一条有效角色消息的判定：非用户、非自由旁白占位、正文非空。 */
function isGroupReply(message: GroupMessage): boolean {
  if (message.characterId === '__user__' || message.characterId === '__free__') return false
  return !!stripThought(message.content || '').trim()
}

/**
 * 群聊方向生成：为指定角色消息生成方向并回写持久化。
 * 调用方负责判断“已轮到用户”（见 GroupChatPage / checkPollingContinue），
 * 中间轮次的回复不生成方向（方案 §4.4）。
 */
export async function generateGroupDialogueDirections(
  set: GroupStoreSet,
  get: GroupStoreGet,
  opts: {
    messageId: string
    character: Character
    userName: string
    /** 群聊所在会话的世界状态；缺省时从会话读取。 */
    worldState?: string
  },
): Promise<DialogueDirection[]> {
  const { messageId, character, userName, worldState } = opts
  const state = get()
  const index = state.messages.findIndex((message) => message.id === messageId)
  if (index < 0) return []
  const target = state.messages[index]
  if (!isGroupReply(target)) return []

  const session = state.sessions.find((item) => item.id === state.currentSessionId)
  const input = buildInput({
    character,
    userName,
    charName: getDisplayName(character),
    // 同单聊：方向跟随当前会话模式，历史快照仅作兜底
    narrativeMode: resolveNarrativeMode(session?.narrativeMode, target.narrativeMode),
    recentMessages: recentDialogue(state.messages, index, (message) => {
      if (message.characterId === '__user__') return userName
      if (message.speakerKind === 'narrator') return '旁白'
      const speaker = useCharacterStore.getState().characters.find(c => c.id === message.characterId)
      return speaker ? getDisplayName(speaker) : (message.characterId === character.id ? getDisplayName(character) : '未知角色')
    }),
    latestReply: stripThought(target.content || ''),
    worldState: worldState ?? session?.memoryCurrentState,
  })
  if (!state.currentGroup || !state.currentSessionId) return []
  const source = featureSource(state.messages, 'whole', featureSessionRef(session, ['narrativeMode', 'personaId', 'memoryCurrentState']))
  source.groupFingerprint = featureFingerprint(groupFeatureScope(state.currentGroup))
  const task = beginFeatureTask({ kind: 'group', groupId: state.currentGroup.id, sessionId: state.currentSessionId }, 'direction', source, messageId)
  if (!task) return []
  try {
    const directions = await requestDialogueDirections(task, input)
    if (!directions.length || task.controller.signal.aborted) return []
    return await persistGroupDirections(set, get, messageId, directions, task) ? directions : []
  } catch (error) {
    if (!task.controller.signal.aborted) logError('DialogueDirections:group', error)
    return []
  } finally { finishFeatureTask(task) }
}

/**
 * 用户发出新消息后，清空本会话中上一次生成的方向。
 *
 * 方向是“等待用户行动的下一步”建议，只对生成它的那一轮待办有效：
 * 用户一旦发送，旧方向既不再是下一步、点选也会污染新一轮输入，因此整体移除
 * （含持久化，避免重载后重新出现）。状态更新在首个 await 之前同步完成，
 * 保证方向与用户消息同帧消失，不出现残留闪烁。
 */
export async function clearSessionDialogueDirections(
  set: StoreSet,
  get: StoreGet,
  sessionId: string,
): Promise<void> {
  const characterId = get().messages.find(m => m.sessionId === sessionId)?.characterId
  if (characterId) cancelDialogueDirectionRequests(undefined, { kind: 'single', characterId, sessionId })
  const targets = get().messages.filter(
    (message) => message.sessionId === sessionId && (message.dialogueDirections?.length ?? 0) > 0,
  )
  if (targets.length === 0) return

  // 在途请求一并作废：否则响应回来后会写回一条已不该有方向的消息
  cancelDialogueDirectionRequests(targets.map((message) => message.id))

  const cleared = targets.map((message) => {
    const next = { ...message }
    delete next.dialogueDirections
    delete next.dialogueDirectionsGeneratedAt
    delete next.dialogueDirectionsSource
    return next
  })
  const clearedById = new Map(cleared.map((message) => [message.id, message]))
  set((state) => ({
    messages: state.messages.map((message) => clearedById.get(message.id) ?? message),
  }))
  for (const message of cleared) {
    await window.api.chat.commitFeatureResult(message.characterId, sessionId, { feature: 'direction', taskId: `clear-${Date.now()}-${Math.random()}`, source: featureSource([message], 'message'), messageId: message.id, directions: [] }).catch((e) => logError('DialogueDirections:clear', e))
  }
}

/** 群聊侧的发送后清理；语义与单聊一致。 */
export async function clearGroupDialogueDirections(
  set: GroupStoreSet,
  get: GroupStoreGet,
  groupId: string,
  sessionId: string,
): Promise<void> {
  cancelDialogueDirectionRequests(undefined, { kind: 'group', groupId, sessionId })
  const targets = get().messages.filter(
    (message) => (message.dialogueDirections?.length ?? 0) > 0,
  )
  if (targets.length === 0) return

  cancelDialogueDirectionRequests(targets.map((message) => message.id))

  const cleared = targets.map((message) => {
    const next = { ...message }
    delete next.dialogueDirections
    delete next.dialogueDirectionsGeneratedAt
    delete next.dialogueDirectionsSource
    return next
  })
  const clearedById = new Map(cleared.map((message) => [message.id, message]))
  set((state) => ({
    messages: state.messages.map((message) => clearedById.get(message.id) ?? message),
  }))
  for (const message of cleared) {
    await window.api.group.commitFeatureResult(groupId, sessionId, { feature: 'direction', taskId: `clear-${Date.now()}-${Math.random()}`, source: featureSource([message], 'message'), messageId: message.id, directions: [] })
      .catch((e) => logError('DialogueDirections:clearGroup', e))
  }
}

/**
 * 叙事模式切换后，为最新一条带方向的消息按新模式重新生成。
 *
 * 方向是“下一步怎么走”的前瞻建议，不是历史内容：用户切换模式后，下一条消息会以
 * 新模式发送，旧视角的方向会与实际发送内容冲突。因此只刷新最新一条（且已有方向的）
 * 消息；更早消息的方向属于历史，保持不动。
 *
 * 旧方向在新方向到达前保持可见；生成失败时原样保留，不清空、不闪空。
 */
export async function refreshSingleDialogueDirections(
  set: StoreSet,
  get: StoreGet,
  opts: { character: Character },
): Promise<void> {
  const state = get()
  const session = state.sessions.find((item) => item.id === state.currentSessionId)
  if (!resolveDialogueDirectionsEnabled(session)) return

  // 只看最新一条 AI 回复：只有它的方向是可操作的（换一批只对它开放），
  // 更早消息的方向属于历史，不随模式切换改写
  const latest = [...state.messages].reverse().find((message) => message.role === 'assistant')
  if (!latest || (latest.dialogueDirections?.length ?? 0) === 0) return

  // 先取消在途请求：否则 generate 会因“同一消息去重”而直接跳过
  cancelDialogueDirectionRequests([latest.id], { kind: 'single', characterId: latest.characterId, sessionId: latest.sessionId })
  await generateSingleDialogueDirections(set, get, { messageId: latest.id, character: opts.character })
}

/** 群聊侧的叙事模式切换刷新；语义与单聊一致。 */
export async function refreshGroupDialogueDirections(
  set: GroupStoreSet,
  get: GroupStoreGet,
  opts: { userName?: string } = {},
): Promise<void> {
  const state = get()
  const session = state.sessions.find((item) => item.id === state.currentSessionId)
  if (!resolveDialogueDirectionsEnabled(session)) return

  // 同单聊：只看最新一条角色回复，历史方向不改写
  const latest = [...state.messages].reverse().find(
    (message) => message.characterId !== '__user__' && message.characterId !== '__free__',
  )
  if (!latest || (latest.dialogueDirections?.length ?? 0) === 0) return
  const speaker = useCharacterStore.getState().characters.find(
    (character) => character.id === latest.characterId,
  )
  if (!speaker) return

  if (state.currentGroup && state.currentSessionId) cancelDialogueDirectionRequests([latest.id], { kind: 'group', groupId: state.currentGroup.id, sessionId: state.currentSessionId })
  await generateGroupDialogueDirections(set, get, {
    messageId: latest.id,
    character: speaker,
    userName: opts.userName ?? (useSettingsStore.getState().settings.userName || '用户'),
  })
}

/** 群聊方向回写（内存 + 持久化）。 */
export async function persistGroupDirections(
  set: GroupStoreSet, get: GroupStoreGet, messageId: string, directions: DialogueDirection[], task?: FeatureTask,
): Promise<boolean> {
  const state = get(), current = state.messages.find(m => m.id === messageId)
  const owner = task?.owner ?? (state.currentGroup && state.currentSessionId && { kind: 'group' as const, groupId: state.currentGroup.id, sessionId: state.currentSessionId })
  if (!owner || owner.kind !== 'group' || task?.controller.signal.aborted || (!task && !current?.content.trim())) return false
  const source = task?.source ?? featureSource([current!], 'message')
  const displayed = () => get().currentGroup?.id === owner.groupId && get().currentSessionId === owner.sessionId
  const valid = () => matchesFeatureSource(source, get().messages, get().sessions.find(s => s.id === owner.sessionId), get().currentGroup && groupFeatureScope(get().currentGroup!))
  if (displayed() && !valid()) return false
  const applied = await window.api.group.commitFeatureResult(owner.groupId, owner.sessionId,
    { feature: 'direction', taskId: task?.id ?? `direction-save-${Date.now()}-${Math.random()}`, source, messageId, directions })
  if (applied && !task?.controller.signal.aborted && displayed() && valid()) {
    set(s => ({ messages: s.messages.map(m => m.id === messageId ? { ...m, dialogueDirections: directions, dialogueDirectionsGeneratedAt: Date.now(), dialogueDirectionsSource: source } : m) }))
  }
  return applied
}
