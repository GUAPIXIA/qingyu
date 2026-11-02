/**
 * 群聊初始化生成器（方案 v2 §5.4）。
 *
 * 职责：取当前对话连接 → 构建提示词 → 走功能任务底座（取消/空闲超时/观测）→
 * 解析校验 → 返回结果。**不写库**：共同场景由调用方 `saveGroup`，系统开场由调用方
 * `insertNarrationMessage` 插入。
 *
 * 返回 `null` 表示用户取消（与失败抛错区分）；失败向上抛可读错误，由弹窗 toast。
 */
import { nanoid } from 'nanoid'
import type { Character, ChatParams, GroupChat } from '../../../shared/types'
import { featureSource, type FeatureOwner } from '../../../shared/featureSource'
import {
  buildGroupOpeningSystemPrompt,
  buildGroupOpeningUserPrompt,
  buildGroupPreambleSystemPrompt,
  buildGroupPreambleUserPrompt,
  GROUP_PREAMBLE_TEMPERATURE,
  GROUP_PREAMBLE_TOP_P,
  normalizeGroupOpening,
  parseGroupPreamble,
  type GroupPreambleInput,
  type GroupPreambleMemberInput,
} from '../../../shared/groupInitPreamble'
import { beginFeatureTask, cancelFeatureTasks, finishFeatureTask, requestFeatureText } from '../../store/featureTasks'
import { resolveRendererGenerationTaskBudget } from '../../store/generationTaskBudget'
import { useSettingsStore } from '../../store/useSettingsStore'
import { usePersonaStore } from '../../store/usePersonaStore'
import { useGroupChatStore } from '../../store/useGroupChatStore'

export interface GroupInitRunnerOptions {
  group: GroupChat
  sessionId: string
  members: Character[]
  /** 流式正文回调（重试时会从新请求重新累积，UI 需整体替换而非追加） */
  onProgress?: (text: string) => void
  /**
   * 每次用户点击生成传入新的 attemptId：`beginFeatureTask` 对同 owner/feature/source
   * 的进行中任务会返回 null（见 `src/store/featureTasks.ts`），重开弹窗前必须能区分。
   */
  attemptId?: string
  /** 用户上下文覆盖（默认按会话人设/全局设置解析，与群聊上下文同口径） */
  userName?: string
  userDescription?: string
  userPersona?: string
}

export interface GeneratedGroupPreamble {
  scene: string
  conflicts: string[]
  model?: string
}

export interface GeneratedGroupOpening {
  text: string
  model?: string
}

interface ResolvedUserContext {
  userName: string
  userDescription?: string
  userPersona?: string
}

function resolveUserContext(opts: GroupInitRunnerOptions): ResolvedUserContext {
  if (opts.userName !== undefined) {
    return {
      userName: opts.userName.trim() || '用户',
      ...(opts.userDescription !== undefined ? { userDescription: opts.userDescription } : {}),
      ...(opts.userPersona !== undefined ? { userPersona: opts.userPersona } : {}),
    }
  }
  try {
    const settings = useSettingsStore.getState().settings
    const session = useGroupChatStore.getState().sessions.find((item) => item.id === opts.sessionId)
    const sessionPersonaId = session?.personaId === undefined ? settings.defaultPersonaId : session.personaId
    const persona = sessionPersonaId ? usePersonaStore.getState().getPersona(sessionPersonaId) : undefined
    const canUseGlobalPersonaFields = !!sessionPersonaId && settings.activePersonaId === sessionPersonaId
    return {
      userName: (persona?.name ?? (canUseGlobalPersonaFields ? settings.userName : '')) || '用户',
      userDescription: persona?.description ?? (canUseGlobalPersonaFields ? settings.userDescription : ''),
      userPersona: persona?.persona ?? (canUseGlobalPersonaFields ? settings.userPersona : ''),
    }
  } catch {
    return { userName: '用户' }
  }
}

function toMemberInputs(members: Character[]): GroupPreambleMemberInput[] {
  return members.map((member) => ({
    name: member.name,
    description: member.description,
    personality: member.personality,
    scenario: member.scenario,
    tags: member.tags,
  }))
}

function buildInput(opts: GroupInitRunnerOptions, user: ResolvedUserContext): GroupPreambleInput {
  return {
    groupName: opts.group.name,
    chatMode: opts.group.chatMode,
    userName: user.userName,
    ...(user.userDescription ? { userDescription: user.userDescription } : {}),
    ...(user.userPersona ? { userPersona: user.userPersona } : {}),
    members: toMemberInputs(opts.members),
  }
}

function requireProfile() {
  const profile = useSettingsStore.getState().getActiveProfile()
  if (!profile) throw new Error('请先在「模型 → 对话 API」配置 API 连接')
  return profile
}

function featureOwner(opts: GroupInitRunnerOptions): FeatureOwner {
  return { kind: 'group', groupId: opts.group.id, sessionId: opts.sessionId }
}

/** 取消进行中的群聊初始化生成（弹窗关闭/群切换/会话切换时调用）。 */
export function cancelGroupInitGeneration(groupId: string, sessionId: string): void {
  const owner: FeatureOwner = { kind: 'group', groupId, sessionId }
  cancelFeatureTasks(owner, undefined, 'group_init')
  cancelFeatureTasks(owner, undefined, 'group_opening')
}

function taskErrorMessage(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * 生成群聊共同场景前置设定；结构不合法时最多一次“只补结构”重试，第二次仍失败抛错。
 */
export async function generateGroupPreamble(opts: GroupInitRunnerOptions): Promise<GeneratedGroupPreamble | null> {
  const profile = requireProfile()
  const input = buildInput(opts, resolveUserContext(opts))
  const systemPrompt = buildGroupPreambleSystemPrompt(input)
  const userPrompt = buildGroupPreambleUserPrompt(input)
  const task = beginFeatureTask(featureOwner(opts), 'group_init', featureSource([], 'whole'), undefined,
    opts.attemptId ?? nanoid())
  if (!task) throw new Error('已有生成任务在进行，请稍候再试')
  try {
    const budget = await resolveRendererGenerationTaskBudget({
      profile,
      model: profile.model,
      task: 'group_init',
      inputChars: systemPrompt.length + userPrompt.length,
      usageTaskType: 'group_init',
    })
    const request = (messages: ChatParams['messages'], onProgress?: (text: string) => void) => requestFeatureText(task, {
      ...profile,
      requestId: task.id,
      messages,
      temperature: GROUP_PREAMBLE_TEMPERATURE,
      topP: GROUP_PREAMBLE_TOP_P,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: true,
      maxTokens: budget.requestMaxTokens,
      reasoningGate: budget.reasoningGate,
      adaptiveOutputBudget: budget.adaptiveOutputBudget,
    }, onProgress)

    const first = await request([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], opts.onProgress)
    if (task.controller.signal.aborted) return null
    if (first.completion.finishReason && first.completion.finishReason !== 'stop') {
      throw new Error('前置设定生成未完整结束，请重试')
    }
    let parsed = parseGroupPreamble(first.text)
    if (!parsed) {
      const repair = await request([
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `${userPrompt}\n\n上一次输出不符合要求：请只输出一个 <conflicts> 块（可省略）和一个 <scene> 块；`
            + 'scene 用【时间】【地点】【世界与规则】【当前情境】四节书写，150–1200 字；不要输出任何其他内容。',
        },
      ], opts.onProgress)
      if (task.controller.signal.aborted) return null
      if (repair.completion.finishReason && repair.completion.finishReason !== 'stop') {
        throw new Error('前置设定生成未完整结束，请重试')
      }
      parsed = parseGroupPreamble(repair.text)
    }
    if (!parsed) throw new Error('AI 输出结构不合规，请重新生成或手写')
    return { ...parsed, model: profile.model }
  } catch (error) {
    if (task.controller.signal.aborted) return null
    throw taskErrorMessage(error)
  } finally {
    finishFeatureTask(task)
  }
}

/**
 * 生成系统开场旁白；失败不自动重试（由弹窗提供“重试”按钮），返回 null 表示取消。
 */
export async function generateGroupOpening(
  opts: GroupInitRunnerOptions & { scene: string },
): Promise<GeneratedGroupOpening | null> {
  const scene = opts.scene?.trim()
  if (!scene) throw new Error('缺少共同场景，无法生成系统开场')
  const profile = requireProfile()
  const input = { ...buildInput(opts, resolveUserContext(opts)), scene }
  const systemPrompt = buildGroupOpeningSystemPrompt(input)
  const userPrompt = buildGroupOpeningUserPrompt(input)
  const task = beginFeatureTask(featureOwner(opts), 'group_opening', featureSource([], 'whole'), undefined,
    opts.attemptId ?? nanoid())
  if (!task) throw new Error('已有生成任务在进行，请稍候再试')
  try {
    const budget = await resolveRendererGenerationTaskBudget({
      profile,
      model: profile.model,
      task: 'group_opening',
      inputChars: systemPrompt.length + userPrompt.length,
      usageTaskType: 'group_opening',
    })
    const { text, completion } = await requestFeatureText(task, {
      ...profile,
      requestId: task.id,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: GROUP_PREAMBLE_TEMPERATURE,
      topP: GROUP_PREAMBLE_TOP_P,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: true,
      maxTokens: budget.requestMaxTokens,
      reasoningGate: budget.reasoningGate,
      adaptiveOutputBudget: budget.adaptiveOutputBudget,
    }, opts.onProgress)
    if (task.controller.signal.aborted) return null
    if (completion.finishReason && completion.finishReason !== 'stop') {
      throw new Error('开场旁白生成未完整结束，请重试')
    }
    const normalized = normalizeGroupOpening(text)
    if (!normalized) throw new Error('AI 输出结构不合规，请重试')
    return { text: normalized, model: profile.model }
  } catch (error) {
    if (task.controller.signal.aborted) return null
    throw taskErrorMessage(error)
  } finally {
    finishFeatureTask(task)
  }
}
