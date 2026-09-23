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
 * - D2 已拍板：polling 的 `maxRounds` 是「每次接力（burst）的 AI 轮次上限」——自最近一条
 *   用户消息以来的 AI 轮次数达到 `maxRounds` 即停止本段接力；新用户消息开启新段、计数重置
 *   （不再是会话内 distinct AI 轮次总数）。
 * - D3 已拍板：mention 模式的 `@名字` 改为**词边界**匹配（`@小A` 命中成员名 `小A`，但
 *   `@小AB` 不命中 `小A`、`email@test.com` 不命中 `test`），与 UI 的 @ 选择器（不写入正文）
 *   仍是两条独立通道；正文 @ 只做高亮（mentionedCharacterIds），**不决定发言人**。
 * - D10 已拍板：free 整段重生按「整轮 free 段」识别（见 resolveGroupFreeSegment）。
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

/** D10 已拍板：free 整段识别用的消息引用（比 GroupScheduleMessageRef 多一个消息 id）。 */
export interface GroupSegmentMessageRef {
  id: string
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
 * D3 已拍板：正文 `@名字` 的词边界定义——「名字字符」= 中文/字母/数字/下划线。
 * `@名字` 前后紧邻名字字符即视为更长名字/更长单词的一部分，不命中。
 */
const MENTION_NAME_CHAR_CLASS = '\\p{L}\\p{N}_'

/** D3 已拍板：成员名按字面匹配，正则特殊字符先转义（如成员名 `A.B` 不得命中 `AXB`）。 */
export function escapeGroupMemberName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * D3 已拍板：`@名字` 词边界命中判定（大小写敏感，匹配原始输入）：
 * - 词尾：`@名字` 之后不能再跟名字字符（`@小明` 不命中成员「小明明」，反之亦然）；
 * - 词首：`@` 之前若是名字字符则不命中（`email@test.com` 不命中成员 `test`、中缀
 *   `a@小明` 不命中成员「小明」）；`@` 前是非名字字符（含 `@@小明`）或位于串首即命中。
 */
export function matchGroupMentionToken(content: string, name: string): boolean {
  if (!name) return false
  const pattern = new RegExp(
    `(?<![${MENTION_NAME_CHAR_CLASS}])@${escapeGroupMemberName(name)}(?![${MENTION_NAME_CHAR_CLASS}])`,
    'u',
  )
  return pattern.test(content)
}

/**
 * @提及检测：正文里出现 `@成员名` 词边界的成员 id（按成员顺序）。
 * 匹配的是**原始输入**（PC 在正则处理前采样），大小写敏感。
 * D3 已拍板：正文 @ 不决定发言人——本结果只用于气泡高亮（mentionedCharacterIds），
 * 发言计划仍只吃 UI 的 targetCharId/mentionOverrideId。
 */
export function detectMentionedMembers(
  content: string,
  members: readonly GroupScheduleMember[],
): string[] {
  const mentioned: string[] = []
  for (const member of members) {
    if (matchGroupMentionToken(content, member.name)) mentioned.push(member.id)
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
 * D2 已拍板：「连续 N 轮」按**每次接力（burst）**计数——自最近一条用户消息（`__user__`，
 * 无论用户手打还是系统/命令触发）以来的 AI 轮次数；新用户消息开启新段、计数从 0 起，
 * 跨用户消息自动重置。
 * 「轮」沿用既有定义：一个成员一轮发言 = 一个 distinct round；`__free__` 不算角色发言。
 * 流式生成中途的半截轮次（占位消息已带 round）按 1 轮计。
 */
export function countGroupBurstRounds(messages: readonly GroupScheduleMessageRef[]): number {
  let burstStart = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].characterId === '__user__') {
      burstStart = i + 1
      break
    }
  }
  const rounds = new Set<number>()
  for (let i = burstStart; i < messages.length; i++) {
    const m = messages[i]
    if (m.characterId === '__user__' || m.characterId === '__free__') continue
    rounds.add(m.round)
  }
  return rounds.size
}

/**
 * polling 自动接力的续排计划：
 * - D2 已拍板：轮数按**每次接力（burst）**计——自最近一条用户消息以来的 distinct AI 轮次数
 *   （`__free__` 不算角色发言，`__narrator__` 算）；达到 `maxRounds` 停止本段接力，
 *   新用户消息开启新段、计数重置（见 countGroupBurstRounds）；
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
  // D2 已拍板：每次接力（burst）计数，不再是会话总轮次
  if (countGroupBurstRounds(input.messages) >= input.maxRounds) return { continue: false, reason: 'max_rounds' }

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

/**
 * D10 已拍板：free 整段（整轮）识别。
 *
 * 识别依据（读 `groupStreamController.ts` 的 `splitAndSaveMessages` 拆分结构确认）：
 * 一次 free 生成拆分出的多条成员消息**共享同一 `round`、同批追加**，没有独立批次标记；
 * 历史 `__free__` 占位消息（P0-07 前落盘）本身就是一段 free 生成。而 mention/polling 的
 * 一轮至多一条角色消息（用户消息与其回复共享该 round，自动接力的轮各自独立 round）。
 *
 * 因此判定规则（命中其一即视为 free 整段）：
 * - 目标消息是历史 `__free__` 占位 → 整段 = 同 round 的非用户消息（含自身）；
 * - 同 round 的非用户消息 ≥ 2 条 → free 拆分段的充分特征，整段 = 这些消息；
 * - 群当前为 free 模式 → 单条段（无标记回落首成员/单段拆分）同样按 free 整段处理。
 *
 * 返回整段消息 id（保持消息流顺序）；不属于 free 段返回 null（走单成员重生）。
 * `__user__` 永不入段（用户消息不可重生）。
 */
export function resolveGroupFreeSegment(
  messages: readonly GroupSegmentMessageRef[],
  targetId: string,
  chatMode: GroupChatMode | string,
): string[] | null {
  const target = messages.find((m) => m.id === targetId)
  if (!target || target.characterId === '__user__') return null
  const sameRound = messages.filter(
    (m) => m.round === target.round && m.characterId !== '__user__',
  )
  const isLegacyFreeBody = target.characterId === '__free__'
  const isSplitSegment = sameRound.length >= 2
  const isFreeModeSingle = chatMode === 'free'
  if (!isLegacyFreeBody && !isSplitSegment && !isFreeModeSingle) return null
  return sameRound.map((m) => m.id)
}
