/**
 * 阶段 6 S6-01：群聊发言调度与消息归属——**跨端共享的纯逻辑**（领域状态机核心）。
 *
 * 为什么必须共享：mention/polling/free 三种发言模式决定「用户发言后谁回复、
 * 自动接力排到谁、何时交还用户、消息归属给哪个角色」。两端若各自实现，
 * 同一段群聊会在两端得到不同的发言计划与消息归属，直接违反阶段 6 §3
 * 「群聊三模式对同一 fixture 产生相同发言计划与上下文」。
 *
 * 抽到 shared 后，fixture 的 oracle 就是生产代码真正调用的这份实现
 * （PC：`src/store/useGroupChatStore.ts` / `src/store/groupStreamController.ts`）。
 *
 * 语义钉子（历史行为，禁止"顺手修复"）：
 * - `currentSpeakerIndex % memberIds.length` 必须保持 JS 取模语义（负索引越界 → 无发言者）；
 * - polling 的 `maxRounds` 按「会话内不同 AI 轮次总数」计数，不是每条用户消息的接力上限；
 * - mention 模式的 `@名字` 是**子串**匹配（`@小A` 命中成员名 `小A`，`@小AB` 也会命中），
 *   与 UI 的 @ 选择器（不写入正文）是两条独立通道。
 */

/** 与 `shared/groupChatPrompt.ts` 的 GroupChatMode 同值；此处独立声明避免循环依赖。 */
export type GroupChatMode = 'mention' | 'polling' | 'free'

export interface GroupScheduleMember {
  id: string
  name: string
}

export interface GroupScheduleMessageRef {
  characterId: string
  round: number
}

/** 下一轮编号：`max(rounds, 0) + 1`（空会话为 1）。 */
export function nextGroupRound(rounds: readonly number[]): number {
  let max = 0
  for (const round of rounds) {
    if (round > max) max = round
  }
  return max + 1
}

/**
 * @提及检测：正文里出现 `@成员名` 子串的成员 id（按成员顺序）。
 * 匹配的是**原始输入**（PC 在正则处理前采样），大小写敏感。
 */
export function detectMentionedMembers(
  content: string,
  members: readonly GroupScheduleMember[],
): string[] {
  const mentioned: string[] = []
  for (const member of members) {
    if (content.includes('@' + member.name)) mentioned.push(member.id)
  }
  return mentioned
}

export type GroupSpeakerPlan =
  | { kind: 'single'; speakerId: string; speakerIndex: number; via: 'target' | 'round_robin' }
  | { kind: 'free' }
  | { kind: 'error'; reason: 'no_speaker' | 'speaker_missing' }

export interface GroupSpeakerPlanInput {
  chatMode: GroupChatMode | string
  memberIds: readonly string[]
  currentSpeakerIndex: number
  /** mention 模式由输入区指定的回复目标（@选择器/下拉/首成员）；polling 模式忽略。 */
  targetCharId?: string | null
  /** 角色库中仍存在的角色 id；缺省表示调用方自行校验存在性。 */
  knownCharacterIds?: readonly string[] | null
}

/**
 * 一条用户消息之后的发言计划：
 * - mention：回复 `targetCharId`；无目标时回落到 `currentSpeakerIndex` 轮转（与 PC 一致）；
 * - polling：一律按 `currentSpeakerIndex` 轮转（显式目标被忽略）；
 * - free（及未知模式）：一次生成、多角色拆分，无固定发言者。
 */
export function resolveGroupSpeakerPlan(input: GroupSpeakerPlanInput): GroupSpeakerPlan {
  const { chatMode, memberIds, currentSpeakerIndex } = input
  // PC 把「非 mention/polling」都走自由发言分支，未知模式同样如此
  if (chatMode !== 'mention' && chatMode !== 'polling') return { kind: 'free' }

  let speakerId: string | undefined = input.targetCharId ?? undefined
  let via: 'target' | 'round_robin' = 'target'
  if (chatMode === 'polling' || !speakerId) {
    via = 'round_robin'
    // JS 取模语义：除数为 0 得 NaN，负数保持负号 → 均视为越界（无发言者）
    const speakerIdx = currentSpeakerIndex % memberIds.length
    speakerId = Number.isFinite(speakerIdx) ? memberIds[speakerIdx] : undefined
  }
  if (!speakerId) return { kind: 'error', reason: 'no_speaker' }
  if (input.knownCharacterIds && !input.knownCharacterIds.includes(speakerId)) {
    return { kind: 'error', reason: 'speaker_missing' }
  }
  return { kind: 'single', speakerId, speakerIndex: memberIds.indexOf(speakerId), via }
}

export type GroupPollingContinuePlan =
  | { continue: true; nextCharId: string; nextSpeakerIndex: number }
  | { continue: false; reason: 'max_rounds' | 'no_last_speaker' | 'speaker_not_member' }

/**
 * polling 自动接力的续排计划：
 * - 轮数按**会话内非用户消息的 distinct round 数**计（`__free__` 不算角色发言，`__narrator__` 算）；
 * - 下一发言者 = 最后一条角色消息的发言者在成员表中的下一位（循环）；
 * - 上限/无角色消息/发言者已不在成员表 → 停止，交还用户。
 */
export function planGroupPollingContinue(input: {
  messages: readonly GroupScheduleMessageRef[]
  memberIds: readonly string[]
  maxRounds: number
}): GroupPollingContinuePlan {
  const characterMessages = input.messages.filter(
    (m) => m.characterId !== '__user__' && m.characterId !== '__free__',
  )
  const rounds = new Set<number>()
  for (const m of characterMessages) rounds.add(m.round)
  if (rounds.size >= input.maxRounds) return { continue: false, reason: 'max_rounds' }

  const lastCharMsg = characterMessages.length > 0 ? characterMessages[characterMessages.length - 1] : null
  if (!lastCharMsg) return { continue: false, reason: 'no_last_speaker' }

  const currentIdx = input.memberIds.indexOf(lastCharMsg.characterId)
  if (currentIdx < 0) return { continue: false, reason: 'speaker_not_member' }
  const nextIdx = (currentIdx + 1) % input.memberIds.length
  return { continue: true, nextCharId: input.memberIds[nextIdx], nextSpeakerIndex: nextIdx }
}

/** polling 接力间隔：`max(500, speakerInterval || 2000)` 毫秒。 */
export function resolvePollingIntervalMs(speakerInterval?: number | null): number {
  return Math.max(500, speakerInterval || 2000)
}

/**
 * 自动记忆触发判定（PC `checkAutoMemory`）：
 * 仅 memoryEnabled 且 memoryMode='auto'；按「游标之后未总结的消息数」与
 * `autoMemoryInterval || 10` 比较，游标缺失按全量计数（编辑/时钟变化不误判）。
 */
export function planAutoMemoryTrigger(input: {
  memoryEnabled?: boolean | null
  memoryMode?: string | null
  autoMemoryInterval?: number | null
  memoryLastMessageId?: string | null
  messageIds: readonly string[]
}): boolean {
  if (!input.memoryEnabled || input.memoryMode !== 'auto') return false
  const interval = input.autoMemoryInterval || 10
  const cursor = input.memoryLastMessageId ?? null
  const cursorIndex = cursor ? input.messageIds.indexOf(cursor) : -1
  const unsummarizedCount = cursorIndex >= 0
    ? input.messageIds.length - cursorIndex - 1
    : input.messageIds.length
  return unsummarizedCount >= interval
}
