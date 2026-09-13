/**
 * “下一步方向”运行时：发起独立辅助请求 → 严格校验 → 回写消息。
 *
 * 与主回复解耦：主回复流式展示后，本模块异步补齐方向；失败只静默降级，
 * 不影响正文与发送状态（见方案 §4.1 / §10）。
 */
import type { ChatParams, Character, DialogueDirection, GroupMessage, Message, NarrativeMode } from '../../shared/types'
import {
  DIALOGUE_DIRECTION_TEMPERATURE,
  buildDialogueDirectionSystemPrompt,
  buildDialogueDirectionUserPrompt,
  parseDialogueDirections,
  type DirectionGenerationInput,
} from '../../shared/dialogueDirections'
import { BACKGROUND_GENERATION_PROFILES } from '../../shared/backgroundGeneration'
import { resolveRequestBudget } from '../../shared/modelOutputProfile'
import { resolveReasoningGate } from '../../shared/reasoningGate'
import { noteGateRecoveryFailure } from './reasoningGateState'
import { stripThought } from '../utils/messagePostProcess'
import { resolveNarrativeMode } from '../../shared/narrativeMode'
import { resolveDialogueDirectionsEnabled } from '../../shared/dialogueDirections'
import { useSettingsStore } from './useSettingsStore'
import { useCharacterStore } from './useCharacterStore'
import { getDisplayName } from '../utils/variables'
import { logError } from '../lib/logger'
import type { StoreGet, StoreSet } from './chatTypes'
import type { GroupStoreGet, GroupStoreSet } from './groupChatTypes'

/** 每条消息最多保留的最近对话条数（方案 §4.1：最近 4–6 条）。 */
const RECENT_MESSAGE_LIMIT = 6

/** 进行中的方向请求：同一消息只允许一个在途请求，避免重复消耗。 */
const inFlight = new Map<string, string>()
/** 每个消息在途请求的真实 IPC requestId 集合（含重试），用于精确取消。 */
const activeRequestIds = new Map<string, Set<string>>()
/** 每个消息最近一次请求的批次 id，用于丢弃“换一批”快速点击产生的过期结果。 */
const latestRequest = new Map<string, string>()

/** 会话切换或消息失效时取消尚未完成的方向请求。 */
export function cancelDialogueDirectionRequests(messageIds?: readonly string[]): void {
  const targets = messageIds ? [...messageIds] : [...inFlight.keys()]
  for (const messageId of targets) {
    if (!inFlight.has(messageId)) continue
    for (const requestId of activeRequestIds.get(messageId) ?? []) {
      window.api.ai.cancelChat(requestId).catch(() => { /* 请求可能已结束 */ })
    }
    activeRequestIds.delete(messageId)
    inFlight.delete(messageId)
    // 取消同时失效“最近请求”标记：即使响应随后到达也不再回写
    latestRequest.delete(messageId)
  }
}

/** 记录真实 IPC requestId，供取消使用；返回注销函数。 */
function trackRequestId(messageId: string, requestId: string): () => void {
  const ids = activeRequestIds.get(messageId) ?? new Set<string>()
  ids.add(requestId)
  activeRequestIds.set(messageId, ids)
  return () => ids.delete(requestId)
}

function newRequestId(messageId: string, attempt = 0): string {
  return `dialogue-directions-${messageId}-${attempt}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export interface DirectionCallResult {
  text: string
  /** 阶段8（§4.4/§4.7）：主进程下发的结构化终止原因（提前中止时为 reasoning_gate_exceeded） */
  terminationCause?: import('../../shared/types').GenerationTerminationCause
}

/** 非流式辅助请求：方向生成专用，不注入 preset，只用显式温度与预算。 */
function callDirectionHelper(
  requestId: string,
  messages: ChatParams['messages'],
  opts?: { downgradeRetry?: boolean },
): Promise<DirectionCallResult> {
  const settingsStore = useSettingsStore.getState()
  const profile = settingsStore.getActiveProfile()
  if (!profile) return Promise.reject(new Error('未配置 API 连接'))
  const activeModel = settingsStore.settings.activeModel || profile.model

  // W4（主计划 §7.6）：方向退出 1536 直连——后台 'direction' 档案给出期望正文，
  // 统一预算负责换算，off 门控把"关闭推理"的意图正式化（可被探测与提前中止兜底）。
  const directionProfile = BACKGROUND_GENERATION_PROFILES.direction
  const gate = resolveReasoningGate({ model: activeModel, requestedLevel: 'off', enabled: true })
  const budget = resolveRequestBudget({
    model: activeModel,
    hardMaxChars: directionProfile.expectedBodyChars,
    reasoningGate: gate,
  })

  let result = ''
  return new Promise<DirectionCallResult>((resolve, reject) => {
    const cleanup = () => {
      unbindChunk(); unbindDone(); unbindError()
    }
    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      result += data.text
    })
    const unbindDone = window.api.ai.onComplete((payload) => {
      if (payload.requestId !== requestId) return
      cleanup()
      // 阶段7（§7.3）：direction = background 档案，触顶输出按结构不完整处理
      // （解析为空 → 由 requestDialogueDirections 决定"降档重试"或"只补结构"一次）
      if (payload.finishReason === 'length') {
        resolve({ text: '', terminationCause: payload.terminationCause ?? 'provider_length' })
        return
      }
      resolve({ text: stripThought(result), terminationCause: payload.terminationCause })
    })
    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== requestId) return
      cleanup()
      reject(new Error(data.error))
    })

    window.api.ai.chat({
      requestId,
      messages,
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: activeModel,
      temperature: DIALOGUE_DIRECTION_TEMPERATURE,
      topP: 0.9,
      maxTokens: budget.requestMaxTokens,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: false,
      // 旧适配器回退用；门控在场时适配器只消费 reasoningGate（同一产品意图：关闭推理）
      reasoningMode: 'disabled',
      reasoningGate: { level: 'off', knob: gate.knob, tokens: gate.gateTokens },
      // 阶段7（§7.3）：独立 taskType，不混入主对话篇幅统计；降档重试归属原生成轮
      observability: {
        source: 'aux',
        taskType: 'direction',
        ...(opts?.downgradeRetry ? { downgradeRetry: true } : {}),
      },
    } satisfies ChatParams).catch((err) => {
      cleanup()
      reject(err)
    })
  })
}

/** 调用辅助模型并返回方向列表；结构非法时重试一次，第二次仍失败返回空。 */
async function requestDialogueDirections(
  messageId: string,
  input: DirectionGenerationInput,
): Promise<DialogueDirection[]> {
  const systemPrompt = buildDialogueDirectionSystemPrompt(input)
  const userPrompt = buildDialogueDirectionUserPrompt(input)
  const messages: ChatParams['messages'] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]

  const firstId = newRequestId(messageId, 0)
  const untrackFirst = trackRequestId(messageId, firstId)
  const first = await callDirectionHelper(firstId, messages).finally(untrackFirst)
  const parsed = parseDialogueDirections(first.text)
  if (parsed.length > 0) return parsed
  // 请求期间被取消（会话切换 / 消息失效）：不再发起重试
  if (!inFlight.has(messageId)) return []

  // 阶段8（§4.5/§6.4）：首次推理挤占（length + 零正文）允许一次降档重试，
  // 复用同一 prompt 快照；第二次无论再挤占还是结构非法，都不再发起第三次。
  const reasoningExhausted = !first.text.trim()
    && (first.terminationCause === 'reasoning_gate_exceeded' || first.terminationCause === 'provider_length')
  if (reasoningExhausted) {
    const retryId = newRequestId(messageId, 1)
    const untrackRetry = trackRequestId(messageId, retryId)
    const retry = await callDirectionHelper(retryId, messages, { downgradeRetry: true }).finally(untrackRetry)
    const retryParsed = parseDialogueDirections(retry.text)
    if (retryParsed.length > 0) return retryParsed
    // 两次都失败：记录熔断事实（该端点本会话内不可靠，后续请求从更低档起步）
    noteGateRecoveryFailure(directionGateScope())
    return []
  }

  const retryId = newRequestId(messageId, 1)
  const untrackRetry = trackRequestId(messageId, retryId)
  const retry = await callDirectionHelper(retryId, [
    {
      role: 'system',
      content: `${systemPrompt}\n\n上一次输出结构不合法。不要分析或解释，只返回一组 <directions>...</directions> 包裹的合法 JSON 数组。`,
    },
    { role: 'user', content: userPrompt },
  ]).finally(untrackRetry)
  return parseDialogueDirections(retry.text)
}

/** 方向任务的门控熔断作用域（与主对话共享端点级事实） */
function directionGateScope(): { provider: string; baseUrl: string; model: string; task: string } {
  const settingsStore = useSettingsStore.getState()
  const profile = settingsStore.getActiveProfile()
  return {
    provider: profile?.provider ?? '',
    baseUrl: profile?.baseUrl ?? '',
    model: settingsStore.settings.activeModel || profile?.model || '',
    task: 'direction',
  }
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
  if (inFlight.has(messageId)) return []

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

  inFlight.set(messageId, messageId)
  latestRequest.set(messageId, messageId)

  try {
    const directions = await requestDialogueDirections(messageId, input)
    // 过期结果（用户已点“换一批”或已发下一条消息）直接丢弃
    if (latestRequest.get(messageId) !== messageId) return []
    if (directions.length === 0) return []
    await persistSingleDirections(set, get, messageId, directions)
    return directions
  } catch (error) {
    logError('DialogueDirections:single', error)
    return []
  } finally {
    if (inFlight.get(messageId) === messageId) {
      inFlight.delete(messageId)
      activeRequestIds.delete(messageId)
      latestRequest.delete(messageId)
    }
  }
}

/** 把方向写回消息（内存 + 持久化）。调用方负责校验方向非空。 */
export async function persistSingleDirections(
  set: StoreSet,
  get: StoreGet,
  messageId: string,
  directions: DialogueDirection[],
): Promise<void> {
  const current = get().messages.find((message) => message.id === messageId)
  if (!current) return
  // 正文在请求期间被替换或清空（重生成/Swipe/续写）：方向已失效，放弃回写
  if (!(current.content || '').trim()) return
  const updated: Message = {
    ...current,
    dialogueDirections: directions,
    dialogueDirectionsGeneratedAt: Date.now(),
  }
  set((state) => ({ messages: state.messages.map((message) => (message.id === messageId ? updated : message)) }))
  await window.api.chat.saveMessage(updated).catch((e) => logError('DialogueDirections:save', e))
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
  if (inFlight.has(messageId)) return []

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
      return getDisplayName(character)
    }),
    latestReply: stripThought(target.content || ''),
    worldState: worldState ?? session?.memoryCurrentState,
  })

  inFlight.set(messageId, messageId)
  latestRequest.set(messageId, messageId)

  try {
    const directions = await requestDialogueDirections(messageId, input)
    if (latestRequest.get(messageId) !== messageId) return []
    if (directions.length === 0) return []
    await persistGroupDirections(set, get, messageId, directions)
    return directions
  } catch (error) {
    logError('DialogueDirections:group', error)
    return []
  } finally {
    if (inFlight.get(messageId) === messageId) {
      inFlight.delete(messageId)
      activeRequestIds.delete(messageId)
      latestRequest.delete(messageId)
    }
  }
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
    return next
  })
  const clearedById = new Map(cleared.map((message) => [message.id, message]))
  set((state) => ({
    messages: state.messages.map((message) => clearedById.get(message.id) ?? message),
  }))
  for (const message of cleared) {
    await window.api.chat.saveMessage(message).catch((e) => logError('DialogueDirections:clear', e))
  }
}

/** 群聊侧的发送后清理；语义与单聊一致。 */
export async function clearGroupDialogueDirections(
  set: GroupStoreSet,
  get: GroupStoreGet,
  groupId: string,
  sessionId: string,
): Promise<void> {
  const targets = get().messages.filter(
    (message) => (message.dialogueDirections?.length ?? 0) > 0,
  )
  if (targets.length === 0) return

  cancelDialogueDirectionRequests(targets.map((message) => message.id))

  const cleared = targets.map((message) => {
    const next = { ...message }
    delete next.dialogueDirections
    delete next.dialogueDirectionsGeneratedAt
    return next
  })
  const clearedById = new Map(cleared.map((message) => [message.id, message]))
  set((state) => ({
    messages: state.messages.map((message) => clearedById.get(message.id) ?? message),
  }))
  for (const message of cleared) {
    await window.api.group.saveMessage(groupId, sessionId, message)
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
  cancelDialogueDirectionRequests([latest.id])
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

  cancelDialogueDirectionRequests([latest.id])
  await generateGroupDialogueDirections(set, get, {
    messageId: latest.id,
    character: speaker,
    userName: opts.userName ?? (useSettingsStore.getState().settings.userName || '用户'),
  })
}

/** 群聊方向回写（内存 + 持久化）。 */
export async function persistGroupDirections(
  set: GroupStoreSet,
  get: GroupStoreGet,
  messageId: string,
  directions: DialogueDirection[],
): Promise<void> {
  const state = get()
  const current = state.messages.find((message) => message.id === messageId)
  if (!current || !state.currentGroup || !state.currentSessionId) return
  if (!(current.content || '').trim()) return
  const updated: GroupMessage = {
    ...current,
    dialogueDirections: directions,
    dialogueDirectionsGeneratedAt: Date.now(),
  }
  set((s) => ({ messages: s.messages.map((message) => (message.id === messageId ? updated : message)) }))
  await window.api.group.saveMessage(state.currentGroup.id, state.currentSessionId, updated)
    .catch((e) => logError('DialogueDirections:saveGroup', e))
}
