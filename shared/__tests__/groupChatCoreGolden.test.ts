/**
 * 阶段 6 S6-01：群聊调度 / free 拆分 / 派生记忆失效 的跨语言 golden 生成器与一致性守卫。
 *
 * 目的：Kotlin 侧（Android）必须与 TypeScript 侧（PC）对**同一份输入**给出
 * **同一份结构化输出**。本测试用 TS 实现（oracle，即 PC 生产代码调用的
 * `shared/chat-core/groupScheduling.ts` / `groupFreeSplit.ts` / `derivedMemory.ts`）
 * 计算输出并落盘为 golden JSON；Kotlin `ChatGroupSchedulingGoldenTest` /
 * `ChatGroupFreeSplitGoldenTest` / `ChatMemoryInvalidationGoldenTest` 读取同一份
 * JSON 断言相等。
 *
 * 模式（与 `shared/__tests__/chatCoreGolden.test.ts` 一致）：
 * - 设 `CHAT_CORE_UPDATE_FIXTURES=1` 时（重）生成 golden；
 * - 默认只读校验：TS 实现发生变化而 fixture 未同步时本测试先变红，
 *   迫使「改契约或同时改两端」，而不是让 Kotlin 静默漂移。
 *
 * 全量生成命令：
 *   $env:CHAT_CORE_UPDATE_FIXTURES=1; pnpm exec vitest run shared/__tests__/groupChatCoreGolden.test.ts
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  nextGroupRound,
  detectMentionedMembers,
  resolveGroupSpeakerPlan,
  planGroupPollingContinue,
  resolvePollingIntervalMs,
  planAutoMemoryTrigger,
} from '../chat-core/groupScheduling'
import { splitFreeReply } from '../chat-core/groupFreeSplit'
import { planDerivedMemoryInvalidation, derivedMemoryResetPatch } from '../chat-core/derivedMemory'
import {
  resolveGroupCharNameForVars,
  resolveShouldSendScenario,
  buildFreeMemberCards,
  buildTargetMemberCard,
  buildGroupUserPersona,
  mapGroupHistoryMessages,
  buildGroupPostHistoryInstructions,
  type GroupContextMember,
} from '../chat-core/groupContextBlocks'
import { buildGroupRosterIntro, buildGroupTurnRulesPrompt } from '../groupChatPrompt'
import {
  buildNarrativeModePrompt,
  buildGroupNarrativeModePrompt,
  DEFAULT_OMNISCIENT_NARRATIVE_RULES,
} from '../narrativeMode'

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'cross-platform', 'chat-core')
const UPDATE = process.env.CHAT_CORE_UPDATE_FIXTURES === '1'

/** fixture 不可往返守卫（与 chatCoreGolden 同口径：拒绝 NaN/Infinity/数组 undefined）。 */
function assertJsonRoundTrippable(value: unknown, path: string, insideArray: boolean): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`fixture 不可往返：${path} 是非有限数（${value}）。请改用哨兵字符串或移除该用例。`)
    }
    return
  }
  if (value === undefined) {
    if (insideArray) {
      throw new Error(`fixture 不可往返：${path} 是数组中的 undefined（会变成 null）。请显式写 null 或移除该元素。`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonRoundTrippable(item, `${path}[${index}]`, true))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertJsonRoundTrippable(item, `${path}.${key}`, false)
    }
  }
}

function writeFixture(name: string, data: unknown): void {
  assertJsonRoundTrippable(data, name, false)
  // 两次求值逐字节相同（防实现里混入时间戳/随机数）
  expect(JSON.stringify(data), `${name} 的输出不确定（两次求值不一致）`).toBe(JSON.stringify(data))
  const file = join(FIXTURE_DIR, `${name}.json`)
  if (UPDATE) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    return
  }
  if (!existsSync(file)) {
    throw new Error(`缺少 golden fixture：${file}\n首次生成请运行：$env:CHAT_CORE_UPDATE_FIXTURES=1; pnpm exec vitest run shared/__tests__/groupChatCoreGolden.test.ts`)
  }
  expect(data, `fixture ${name}.json 与 TS 实现不一致（改契约请重新生成）`).toEqual(JSON.parse(readFileSync(file, 'utf8')))
}

// ---------------------------------------------------------------- 用例定义（固定输入）

const MEMBERS = [
  { id: 'char-a', name: '小A' },
  { id: 'char-b', name: '小B' },
  { id: 'char-c', name: '小C' },
  { id: 'char-sub', name: '小' },
  { id: 'char-en', name: 'AbC' },
  { id: 'char-dot', name: 'A.B' },
]
const THREE_IDS = ['char-a', 'char-b', 'char-c']

const NEXT_ROUND_CASES = [
  { label: '空会话从第 1 轮开始', rounds: [], expected: 1 },
  { label: '轮次取最大值加一', rounds: [1, 2, 5], expected: 6 },
  { label: '负轮次不压低下限', rounds: [-3, -1], expected: 1 },
  { label: '单条消息', rounds: [4], expected: 5 },
]

const MENTION_CASES = [
  { label: '单个 @提及 命中成员', content: '@小A 你说', memberIds: THREE_IDS, expected: ['char-a'] },
  {
    label: '多个 @提及 按成员顺序返回（不是正文顺序）',
    content: '@小B 和 @小A 都说说',
    memberIds: THREE_IDS,
    expected: ['char-a', 'char-b'],
  },
  {
    label: '子串语义：@小A 同时命中成员「小」与「小A」',
    content: '@小A 你好',
    memberIds: ['char-sub', 'char-a', 'char-b'],
    expected: ['char-sub', 'char-a'],
  },
  { label: '@提及 大小写敏感', content: '@abc 你好', memberIds: ['char-en'], expected: [] },
  { label: '无 @提及 返回空', content: '大家怎么看', memberIds: THREE_IDS, expected: [] },
  { label: '同一成员重复提及只记一次', content: '@小A @小A', memberIds: THREE_IDS, expected: ['char-a'] },
  { label: '非成员名字不计', content: '@小D 你在吗', memberIds: THREE_IDS, expected: [] },
]

const SPEAKER_PLAN_CASES = [
  {
    label: 'mention 指定目标直接回复',
    input: { chatMode: 'mention', memberIds: THREE_IDS, currentSpeakerIndex: 0, targetCharId: 'char-b' },
    expected: { kind: 'single', speakerId: 'char-b', speakerIndex: 1, via: 'target' },
  },
  {
    label: 'mention 无目标回落 currentSpeakerIndex 轮转',
    input: { chatMode: 'mention', memberIds: THREE_IDS, currentSpeakerIndex: 2, targetCharId: null },
    expected: { kind: 'single', speakerId: 'char-c', speakerIndex: 2, via: 'round_robin' },
  },
  {
    label: 'polling 忽略显式目标、一律轮转',
    input: { chatMode: 'polling', memberIds: THREE_IDS, currentSpeakerIndex: 0, targetCharId: 'char-b' },
    expected: { kind: 'single', speakerId: 'char-a', speakerIndex: 0, via: 'round_robin' },
  },
  {
    label: 'polling 轮转按成员数取模',
    input: { chatMode: 'polling', memberIds: THREE_IDS, currentSpeakerIndex: 4 },
    expected: { kind: 'single', speakerId: 'char-b', speakerIndex: 1, via: 'round_robin' },
  },
  {
    label: '负索引保持 JS 取模语义、视为无发言者',
    input: { chatMode: 'polling', memberIds: THREE_IDS, currentSpeakerIndex: -1 },
    expected: { kind: 'error', reason: 'no_speaker' },
  },
  {
    label: '空成员表视为无发言者',
    input: { chatMode: 'polling', memberIds: [], currentSpeakerIndex: 0 },
    expected: { kind: 'error', reason: 'no_speaker' },
  },
  {
    label: 'mention 目标已被删除报 speaker_missing',
    input: {
      chatMode: 'mention',
      memberIds: THREE_IDS,
      currentSpeakerIndex: 0,
      targetCharId: 'char-gone',
      knownCharacterIds: THREE_IDS,
    },
    expected: { kind: 'error', reason: 'speaker_missing' },
  },
  {
    label: '未提供角色库时不做存在性校验（调用方兜底）',
    input: { chatMode: 'mention', memberIds: THREE_IDS, currentSpeakerIndex: 0, targetCharId: 'char-x' },
    expected: { kind: 'single', speakerId: 'char-x', speakerIndex: -1, via: 'target' },
  },
  {
    label: 'free 模式无固定发言者',
    input: { chatMode: 'free', memberIds: THREE_IDS, currentSpeakerIndex: 0, targetCharId: 'char-b' },
    expected: { kind: 'free' },
  },
  {
    label: '未知模式走自由发言（与 PC 分支一致）',
    input: { chatMode: 'nomination', memberIds: THREE_IDS, currentSpeakerIndex: 0 },
    expected: { kind: 'free' },
  },
]

const U = { characterId: '__user__', round: 1 }
const FREE = { characterId: '__free__', round: 1 }
const A1 = { characterId: 'char-a', round: 1 }
const A1_B1 = { characterId: 'char-b', round: 1 }
const C2 = { characterId: 'char-c', round: 2 }

const POLLING_CONTINUE_CASES = [
  {
    label: '达到 maxRounds（distinct AI 轮次）交还用户',
    input: { messages: [U, A1], memberIds: THREE_IDS, maxRounds: 1 },
    expected: { continue: false, reason: 'max_rounds' },
  },
  {
    label: '未达上限排定下一位成员',
    input: { messages: [U, A1], memberIds: THREE_IDS, maxRounds: 3 },
    expected: { continue: true, nextCharId: 'char-b', nextSpeakerIndex: 1 },
  },
  {
    label: '轮转到末尾循环回首位',
    input: { messages: [U, A1, A1_B1, C2], memberIds: THREE_IDS, maxRounds: 10 },
    expected: { continue: true, nextCharId: 'char-a', nextSpeakerIndex: 0 },
  },
  {
    label: '用户消息的轮次不计入 AI 轮数',
    input: {
      messages: [{ characterId: '__user__', round: 1 }, { characterId: '__user__', round: 2 }, { characterId: 'char-a', round: 3 }],
      memberIds: THREE_IDS,
      maxRounds: 2,
    },
    expected: { continue: true, nextCharId: 'char-b', nextSpeakerIndex: 1 },
  },
  {
    label: '同一轮多条角色消息只计一轮（distinct）',
    input: { messages: [A1, { characterId: 'char-a', round: 1 }], memberIds: THREE_IDS, maxRounds: 2 },
    expected: { continue: true, nextCharId: 'char-b', nextSpeakerIndex: 1 },
  },
  {
    label: '无角色消息停止接力',
    input: { messages: [U, FREE], memberIds: THREE_IDS, maxRounds: 5 },
    expected: { continue: false, reason: 'no_last_speaker' },
  },
  {
    label: '__free__ 占位不算角色发言',
    input: { messages: [U, FREE], memberIds: THREE_IDS, maxRounds: 5 },
    expected: { continue: false, reason: 'no_last_speaker' },
  },
  {
    label: '__narrator__ 算角色发言但不在成员表、停止接力',
    input: { messages: [U, { characterId: '__narrator__', round: 1 }], memberIds: THREE_IDS, maxRounds: 5 },
    expected: { continue: false, reason: 'speaker_not_member' },
  },
  {
    label: '发言者已被移出成员表停止接力（不写错归属）',
    input: { messages: [U, { characterId: 'char-gone', round: 1 }], memberIds: THREE_IDS, maxRounds: 5 },
    expected: { continue: false, reason: 'speaker_not_member' },
  },
]

const POLLING_INTERVAL_CASES = [
  { label: '缺省 2000ms', speakerInterval: null, expected: 2000 },
  { label: '0 视为缺省', speakerInterval: 0, expected: 2000 },
  { label: '下限 500ms', speakerInterval: 300, expected: 500 },
  { label: '边界 500ms', speakerInterval: 500, expected: 500 },
  { label: '用户配置 3000ms', speakerInterval: 3000, expected: 3000 },
  { label: '负值按下限', speakerInterval: -5, expected: 500 },
]

const IDS_5 = ['m1', 'm2', 'm3', 'm4', 'm5']
const AUTO_MEMORY_CASES = [
  {
    label: '未启用记忆不触发',
    input: { memoryEnabled: false, memoryMode: 'auto', autoMemoryInterval: 1, memoryLastMessageId: null, messageIds: ['m1'] },
    expected: false,
  },
  {
    label: '手动模式不触发',
    input: { memoryEnabled: true, memoryMode: 'manual', autoMemoryInterval: 1, memoryLastMessageId: null, messageIds: ['m1'] },
    expected: false,
  },
  {
    label: '无游标按全量计数、达到默认间隔 10 触发',
    input: {
      memoryEnabled: true,
      memoryMode: 'auto',
      autoMemoryInterval: null,
      memoryLastMessageId: null,
      messageIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10'],
    },
    expected: true,
  },
  {
    label: '无游标未达标不触发',
    input: {
      memoryEnabled: true,
      memoryMode: 'auto',
      autoMemoryInterval: null,
      memoryLastMessageId: null,
      messageIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'],
    },
    expected: false,
  },
  {
    label: '游标后未总结数达标触发',
    input: { memoryEnabled: true, memoryMode: 'auto', autoMemoryInterval: 2, memoryLastMessageId: 'm3', messageIds: IDS_5 },
    expected: true,
  },
  {
    label: '游标后未总结数不足不触发',
    input: { memoryEnabled: true, memoryMode: 'auto', autoMemoryInterval: 3, memoryLastMessageId: 'm3', messageIds: IDS_5 },
    expected: false,
  },
  {
    label: '游标丢失按全量计数（不误判为 0）',
    input: { memoryEnabled: true, memoryMode: 'auto', autoMemoryInterval: 2, memoryLastMessageId: 'm-gone', messageIds: ['m1', 'm2', 'm3'] },
    expected: true,
  },
  {
    label: 'interval 0 回落默认 10',
    input: { memoryEnabled: true, memoryMode: 'auto', autoMemoryInterval: 0, memoryLastMessageId: null, messageIds: IDS_5 },
    expected: false,
  },
]

const FREE_SPLIT_CASES = [
  {
    label: '全知叙事不拆分（【判定】类标记不被分段器误识别）',
    input: {
      content: '【判定】局势升级\n【可选行动】观望',
      memberIds: ['char-a', 'char-b'],
      narrativeMode: 'omniscient',
    },
    expected: {
      kind: 'narrator',
      messages: [{ characterId: 'char-a', content: '【判定】局势升级\n【可选行动】观望' }],
    },
  },
  {
    label: '全知叙事空正文占位',
    input: { content: '', memberIds: ['char-a', 'char-b'], narrativeMode: 'omniscient' },
    expected: { kind: 'narrator', messages: [{ characterId: 'char-a', content: '(无回复)' }] },
  },
  {
    label: '全知叙事无成员归属 __narrator__',
    input: { content: '旁白正文', memberIds: [], narrativeMode: 'omniscient' },
    expected: { kind: 'narrator', messages: [{ characterId: '__narrator__', content: '旁白正文' }] },
  },
  {
    label: '基本按【角色名】拆分',
    input: { content: '【小A】第一段\n【小B】第二段', memberIds: ['char-a', 'char-b'], narrativeMode: 'immersive' },
    expected: {
      kind: 'segments',
      messages: [{ characterId: 'char-a', content: '第一段' }, { characterId: 'char-b', content: '第二段' }],
    },
  },
  {
    label: '首个标记前的旁白并入首段',
    input: { content: '开场旁白\n【小A】第一段\n【小B】第二段', memberIds: ['char-a', 'char-b'], narrativeMode: 'immersive' },
    expected: {
      kind: 'segments',
      messages: [{ characterId: 'char-a', content: '开场旁白\n\n第一段' }, { characterId: 'char-b', content: '第二段' }],
    },
  },
  {
    label: '标记之间的旁白归上一段',
    input: { content: '【小A】一\n中间旁白\n【小B】二', memberIds: ['char-a', 'char-b'], narrativeMode: 'immersive' },
    expected: {
      kind: 'segments',
      messages: [{ characterId: 'char-a', content: '一\n中间旁白' }, { characterId: 'char-b', content: '二' }],
    },
  },
  {
    label: '尾段标记后的文本归尾段',
    input: { content: '【小A】一\n【小B】二\n尾声', memberIds: ['char-a', 'char-b'], narrativeMode: 'immersive' },
    expected: {
      kind: 'segments',
      messages: [{ characterId: 'char-a', content: '一' }, { characterId: 'char-b', content: '二\n尾声' }],
    },
  },
  {
    label: '未识别角色旁注归属首成员',
    input: { content: '【小D】幽灵发言', memberIds: ['char-a', 'char-b'], narrativeMode: 'immersive' },
    expected: {
      kind: 'segments',
      messages: [{ characterId: 'char-a', content: '⚠️ 未识别角色「小D」: 幽灵发言' }],
    },
  },
  {
    label: '未识别角色紧跟首成员时并入同条',
    input: { content: '【小A】一\n【小D】幽灵', memberIds: ['char-a', 'char-b'], narrativeMode: 'immersive' },
    expected: {
      kind: 'segments',
      messages: [{ characterId: 'char-a', content: '一\n\n⚠️ 未识别角色「小D」: 幽灵' }],
    },
  },
  {
    label: '未识别角色在其他成员发言后新建首成员消息',
    input: { content: '【小B】一\n【小D】幽灵', memberIds: ['char-a', 'char-b'], narrativeMode: 'immersive' },
    expected: {
      kind: 'segments',
      messages: [
        { characterId: 'char-b', content: '一' },
        { characterId: 'char-a', content: '⚠️ 未识别角色「小D」: 幽灵' },
      ],
    },
  },
  {
    label: '识别到但正文为空的段直接丢弃',
    input: { content: '【小A】\n【小B】二', memberIds: ['char-a', 'char-b'], narrativeMode: 'immersive' },
    expected: { kind: 'segments', messages: [{ characterId: 'char-b', content: '二' }] },
  },
  {
    label: '未识别且正文为空的段丢弃且无旁注',
    input: { content: '【小A】\n【小D】\n【小B】二', memberIds: ['char-a', 'char-b'], narrativeMode: 'immersive' },
    expected: { kind: 'segments', messages: [{ characterId: 'char-b', content: '二' }] },
  },
  {
    label: '角色名大小写与首尾空格归一后匹配',
    input: { content: '【 小a 】你好', memberIds: ['char-a'], narrativeMode: 'immersive' },
    expected: { kind: 'segments', messages: [{ characterId: 'char-a', content: '你好' }] },
  },
  {
    label: '成员名含正则元字符按字面匹配',
    input: { content: '【A.B】字面匹配', memberIds: ['char-dot'], narrativeMode: 'immersive' },
    expected: { kind: 'segments', messages: [{ characterId: 'char-dot', content: '字面匹配' }] },
  },
  {
    label: '同名多段顺序保留',
    input: { content: '【小A】一\n【小A】二', memberIds: ['char-a'], narrativeMode: 'immersive' },
    expected: {
      kind: 'segments',
      messages: [{ characterId: 'char-a', content: '一' }, { characterId: 'char-a', content: '二' }],
    },
  },
  {
    label: '全部段为空时产生空消息列表（占位由调用方移除）',
    input: { content: '【小A】', memberIds: ['char-a'], narrativeMode: 'immersive' },
    expected: { kind: 'segments', messages: [] },
  },
  {
    label: '无任何标记回落首成员',
    input: { content: '普通独白', memberIds: ['char-a', 'char-b'], narrativeMode: 'immersive' },
    expected: { kind: 'fallback', messages: [{ characterId: 'char-a', content: '普通独白' }] },
  },
  {
    label: '无标记空正文占位回落首成员',
    input: { content: '', memberIds: ['char-a', 'char-b'], narrativeMode: null },
    expected: { kind: 'fallback', messages: [{ characterId: 'char-a', content: '(无回复)' }] },
  },
  {
    label: '无标记且无成员归属 __free__',
    input: { content: '独白', memberIds: [], narrativeMode: 'immersive' },
    expected: { kind: 'fallback', messages: [{ characterId: '__free__', content: '独白' }] },
  },
]

/** 派生记忆快照全键模板（两端按同一键集读取，缺失键按 null/空处理）。 */
function session(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    memory: null,
    memoryCurrentState: null,
    memoryFacts: [],
    memoryFactHistory: [],
    factsVectors: [],
    memoryLastMessageId: null,
    memoryVersion: null,
    compressedSummary: null,
    memoryFactParseFailureCount: null,
    memoryFactRetryAfterVersion: null,
    ...partial,
  }
}

const INVALIDATION_CASES = [
  {
    label: '无派生数据保留（清空无效化对象）',
    input: { variant: 'group', session: session({}), messageIds: ['m1', 'm2'], changedMessageId: 'm2' },
    expected: { action: 'keep' },
  },
  {
    label: 'clearChat（changedMessageId 为空）全量失效',
    input: {
      variant: 'group',
      session: session({ memory: '摘要', memoryVersion: 2 }),
      messageIds: ['m1', 'm2'],
      changedMessageId: null,
    },
    expected: { action: 'invalidate', expectedVersion: 2, patch: derivedMemoryResetPatch() },
  },
  {
    label: '无检查点（游标空）全量失效',
    input: {
      variant: 'group',
      session: session({ memory: '摘要', memoryVersion: 2 }),
      messageIds: ['m1', 'm2'],
      changedMessageId: 'm2',
    },
    expected: { action: 'invalidate', expectedVersion: 2, patch: derivedMemoryResetPatch() },
  },
  {
    label: 'memoryVersion 0 视为无检查点全量失效',
    input: {
      variant: 'group',
      session: session({ memory: 'x', memoryVersion: 0, memoryLastMessageId: 'm1' }),
      messageIds: ['m1', 'm2'],
      changedMessageId: 'm1',
    },
    expected: { action: 'invalidate', expectedVersion: 0, patch: derivedMemoryResetPatch() },
  },
  {
    label: '变更在游标之后保留派生记忆',
    input: {
      variant: 'group',
      session: session({ memory: '摘要', memoryVersion: 3, memoryLastMessageId: 'm2' }),
      messageIds: ['m1', 'm2', 'm3', 'm4'],
      changedMessageId: 'm4',
    },
    expected: { action: 'keep' },
  },
  {
    label: '变更在游标之前全量失效',
    input: {
      variant: 'group',
      session: session({ memory: '摘要', memoryVersion: 3, memoryLastMessageId: 'm3' }),
      messageIds: ['m1', 'm2', 'm3', 'm4'],
      changedMessageId: 'm1',
    },
    expected: { action: 'invalidate', expectedVersion: 3, patch: derivedMemoryResetPatch() },
  },
  {
    label: '变更等于游标全量失效（游标消息被改写）',
    input: {
      variant: 'group',
      session: session({ memory: '摘要', memoryVersion: 3, memoryLastMessageId: 'm3' }),
      messageIds: ['m1', 'm2', 'm3', 'm4'],
      changedMessageId: 'm3',
    },
    expected: { action: 'invalidate', expectedVersion: 3, patch: derivedMemoryResetPatch() },
  },
  {
    label: '游标消息丢失保守全量失效',
    input: {
      variant: 'group',
      session: session({ memory: '摘要', memoryVersion: 2, memoryLastMessageId: 'm-gone' }),
      messageIds: ['m1', 'm2'],
      changedMessageId: 'm2',
    },
    expected: { action: 'invalidate', expectedVersion: 2, patch: derivedMemoryResetPatch() },
  },
  {
    label: '变更消息丢失保守全量失效',
    input: {
      variant: 'group',
      session: session({ memory: '摘要', memoryVersion: 2, memoryLastMessageId: 'm2' }),
      messageIds: ['m1', 'm2'],
      changedMessageId: 'm-gone',
    },
    expected: { action: 'invalidate', expectedVersion: 2, patch: derivedMemoryResetPatch() },
  },
  {
    label: 'factsVectors 非空视为派生数据',
    input: {
      variant: 'group',
      session: session({ factsVectors: [[0.1, 0.2]], memoryVersion: 1, memoryLastMessageId: 'm1' }),
      messageIds: ['m1', 'm2'],
      changedMessageId: 'm1',
    },
    expected: { action: 'invalidate', expectedVersion: 1, patch: derivedMemoryResetPatch() },
  },
  {
    label: 'compressedSummary 视为派生数据',
    input: {
      variant: 'group',
      session: session({ compressedSummary: '早期摘要', memoryVersion: 0 }),
      messageIds: ['m1'],
      changedMessageId: 'm1',
    },
    expected: { action: 'invalidate', expectedVersion: 0, patch: derivedMemoryResetPatch() },
  },
  {
    label: '（语义钉子）事实解析退避计数计入单聊派生数据',
    input: {
      variant: 'chat',
      session: session({ memoryFactParseFailureCount: 1 }),
      messageIds: ['m1', 'm2'],
      changedMessageId: 'm2',
    },
    expected: { action: 'invalidate', expectedVersion: 0, patch: derivedMemoryResetPatch() },
  },
  {
    label: '（语义钉子）事实解析退避计数不计入群聊派生数据',
    input: {
      variant: 'group',
      session: session({ memoryFactParseFailureCount: 1 }),
      messageIds: ['m1', 'm2'],
      changedMessageId: 'm2',
    },
    expected: { action: 'keep' },
  },
]

// ---------------------------------------------------------------- golden 生成/校验

describe('group-chat golden（阶段 6 S6-01）', () => {
  it('group-scheduling：轮次/提及/发言计划/轮询续排/自动记忆', () => {
    const data = {
      version: 1,
      oracle: 'shared/chat-core/groupScheduling.ts',
      members: MEMBERS,
      nextRoundCases: NEXT_ROUND_CASES.map((c) => ({
        label: c.label,
        input: { rounds: c.rounds },
        expected: nextGroupRound(c.rounds),
      })),
      mentionCases: MENTION_CASES.map((c) => ({
        label: c.label,
        input: { content: c.content, memberIds: c.memberIds },
        expected: detectMentionedMembers(
          c.content,
          c.memberIds.map((id) => MEMBERS.find((m) => m.id === id)!).filter(Boolean),
        ),
      })),
      speakerPlanCases: SPEAKER_PLAN_CASES.map((c) => ({
        label: c.label,
        input: c.input,
        expected: resolveGroupSpeakerPlan(c.input),
      })),
      pollingContinueCases: POLLING_CONTINUE_CASES.map((c) => ({
        label: c.label,
        input: c.input,
        expected: planGroupPollingContinue(c.input),
      })),
      pollingIntervalCases: POLLING_INTERVAL_CASES.map((c) => ({
        label: c.label,
        input: { speakerInterval: c.speakerInterval },
        expected: resolvePollingIntervalMs(c.speakerInterval),
      })),
      autoMemoryCases: AUTO_MEMORY_CASES.map((c) => ({
        label: c.label,
        input: c.input,
        expected: planAutoMemoryTrigger(c.input),
      })),
    }
    // 期望值与用例内声明一致（防 oracle 改动后用例注释撒谎）
    NEXT_ROUND_CASES.forEach((c) => expect(nextGroupRound(c.rounds), c.label).toBe(c.expected))
    MENTION_CASES.forEach((c) => expect(
      detectMentionedMembers(c.content, c.memberIds.map((id) => MEMBERS.find((m) => m.id === id)!).filter(Boolean)),
      c.label,
    ).toEqual(c.expected))
    SPEAKER_PLAN_CASES.forEach((c) => expect(resolveGroupSpeakerPlan(c.input), c.label).toEqual(c.expected))
    POLLING_CONTINUE_CASES.forEach((c) => expect(planGroupPollingContinue(c.input), c.label).toEqual(c.expected))
    POLLING_INTERVAL_CASES.forEach((c) => expect(resolvePollingIntervalMs(c.speakerInterval), c.label).toBe(c.expected))
    AUTO_MEMORY_CASES.forEach((c) => expect(planAutoMemoryTrigger(c.input), c.label).toBe(c.expected))
    writeFixture('group-scheduling', data)
  })

  it('group-free-split：free 多角色拆分与归属', () => {
    const data = {
      version: 1,
      oracle: 'shared/chat-core/groupFreeSplit.ts',
      members: MEMBERS,
      splitCases: FREE_SPLIT_CASES.map((c) => {
        const members = c.input.memberIds.map((id) => MEMBERS.find((m) => m.id === id)!).filter(Boolean)
        const result = splitFreeReply({ content: c.input.content, members, narrativeMode: c.input.narrativeMode })
        expect(result, c.label).toEqual(c.expected)
        return {
          label: c.label,
          input: { content: c.input.content, memberIds: c.input.memberIds, narrativeMode: c.input.narrativeMode },
          expected: result,
        }
      }),
    }
    writeFixture('group-free-split', data)
  })

  it('memory-invalidation：派生记忆检查点失效决策', () => {
    const data = {
      version: 1,
      oracle: 'shared/chat-core/derivedMemory.ts',
      invalidationCases: INVALIDATION_CASES.map((c) => {
        const result = planDerivedMemoryInvalidation({
          variant: c.input.variant as 'chat' | 'group',
          session: c.input.session,
          messageIds: c.input.messageIds,
          changedMessageId: c.input.changedMessageId,
        })
        expect(result, c.label).toEqual(c.expected)
        return { label: c.label, input: c.input, expected: result }
      }),
    }
    writeFixture('memory-invalidation', data)
  })

  it('group-prompts：群提示词段（roster/turnRules/叙事约束）', () => {
    const rosterCases = [
      { label: '三成员含描述截断', groupName: '合成群聊', members: MEMBERS.slice(0, 3).map((m) => ({ name: m.name, description: `${m.name}的描述` })), userName: '用户' },
      { label: '无描述成员', groupName: '无名群', members: [{ name: '小A' }, { name: '小B' }], userName: '旅人' },
      { label: '超长描述截到 80 字', groupName: '长文群', members: [{ name: '小A', description: 'x'.repeat(120) }], userName: 'u' },
      { label: '空群', groupName: '空群', members: [], userName: 'u' },
    ]
    const narrativeCases: Array<{ label: string; args: [string, string, string, string, string?] }> = [
      { label: 'immersive + mention（带焦点）', args: ['immersive', '用户', '小A', 'mention'] },
      { label: 'immersive + polling（带焦点）', args: ['immersive', '用户', '小B', 'polling'] },
      { label: 'immersive + free（多成员限知）', args: ['immersive', '用户', '小A、小B', 'free'] },
      { label: 'omniscient + mention', args: ['omniscient', '用户', '小A', 'mention'] },
      { label: 'omniscient + free（对白只能作引语）', args: ['omniscient', '用户', '小A、小B', 'free'] },
      { label: 'omniscient + polling 且无焦点名', args: ['omniscient', '用户', '', 'polling'] },
      { label: 'omniscient 自定义规则（{{user}}/{{char}} 变量）', args: ['omniscient', '旅人', '苏晚', 'mention', '自定义全局规则：{{user}} 与 {{char}}。'] },
    ]
    const data = {
      version: 1,
      oracle: 'shared/groupChatPrompt.ts + shared/narrativeMode.ts',
      turnRulesCases: ['mention', 'polling', 'free'].map((mode) => ({
        label: `turnRules/${mode}`,
        input: { chatMode: mode },
        expected: buildGroupTurnRulesPrompt(mode as 'mention' | 'polling' | 'free'),
      })),
      rosterCases: rosterCases.map((c) => ({
        label: c.label,
        input: c,
        expected: buildGroupRosterIntro(c.groupName, c.members, c.userName),
      })),
      singleNarrativeCases: (['immersive', 'omniscient'] as const).map((mode) => ({
        label: `singleNarrative/${mode}`,
        input: { mode, userName: '用户', characterName: '苏晚' },
        expected: buildNarrativeModePrompt(mode, '用户', '苏晚'),
      })),
      groupNarrativeCases: narrativeCases.map((c) => ({
        label: c.label,
        input: {
          mode: c.args[0],
          userName: c.args[1],
          focusName: c.args[2],
          chatMode: c.args[3],
          omniscientRules: c.args[4] ?? null,
        },
        expected: buildGroupNarrativeModePrompt(
          c.args[0] as 'immersive' | 'omniscient',
          c.args[1],
          c.args[2],
          c.args[3] as 'mention' | 'polling' | 'free',
          c.args[4],
        ),
      })),
      defaultOmniscientRules: DEFAULT_OMNISCIENT_NARRATIVE_RULES,
    }
    writeFixture('group-prompts', data)
  })

  it('group-context-blocks：成员卡/人设/历史归属/后历史指令', () => {
    const fullMember = (id: string, name: string): GroupContextMember => ({
      id,
      name,
      description: `${name}是{{user}}的伙伴。`,
      personality: `${name}性格沉稳。`,
      scenario: `场景：与{{user}}同行。`,
      systemPrompt: `（${name}的系统提示，{{char}}）`,
      exampleDialog: '{{user}}：在吗？\n{{char}}：在。',
      postHistoryInstructions: `（${name}的后历史指令）`,
    })
    const members: GroupContextMember[] = [
      fullMember('char-a', '小A'),
      fullMember('char-b', '小B'),
      { id: 'char-c', name: '小C' },
    ]

    const shouldSendCases = [
      { label: 'first_turn 首轮注入', input: { mode: 'first_turn', userMessageCount: 1 }, expected: true },
      { label: 'first_turn 非首轮不注入', input: { mode: 'first_turn', userMessageCount: 2 }, expected: false },
      { label: 'always 总是注入', input: { mode: 'always', userMessageCount: 5 }, expected: true },
      { label: 'off 从不注入', input: { mode: 'off', userMessageCount: 1 }, expected: false },
      { label: '缺省按 first_turn', input: { mode: null, userMessageCount: 1 }, expected: true },
    ]

    const freeCardCases = [
      { label: 'free 全字段无锚点', opts: { userName: '用户', shouldSendScenario: true } },
      { label: 'free 场景被门控', opts: { userName: '用户', shouldSendScenario: false } },
      {
        label: 'free 示例锚点重排（示例集中到锚点间、带成员名）',
        opts: { userName: '用户', shouldSendScenario: true, exampleBefore: ['<示例前锚点>'], exampleAfter: ['<示例后锚点>'] },
      },
      {
        label: 'free 世界书前后段包裹',
        opts: { userName: '用户', shouldSendScenario: true, lorebookBefore: '<世界书前>', lorebookAfter: '<世界书后>' },
      },
    ]
    const targetCardCases = [
      { label: 'target 全字段无锚点', opts: { userName: '用户', shouldSendScenario: true } },
      {
        label: 'target 锚点包裹且示例始终无成员名',
        opts: { userName: '用户', shouldSendScenario: true, exampleBefore: ['<前>'], exampleAfter: ['<后>'], lorebookAfter: '<世界书后>' },
      },
      { label: 'target 场景被门控', opts: { userName: '用户', shouldSendScenario: false } },
    ]
    const personaCases = [
      { label: '全字段注入', input: { userName: '用户', userDescription: '旅行者', userPersona: '果敢', charNameForVars: '小A', injection: null } },
      { label: '关闭注入', input: { userName: '用户', userDescription: '旅行者', userPersona: '果敢', charNameForVars: '小A', injection: { enabled: false } } },
      { label: '只出用户名', input: { userName: '用户', charNameForVars: '小A、小B', injection: { enabled: true, includeDescription: false, includePersona: false } } },
      { label: 'include 缺省视为 true', input: { userName: '旅人', userDescription: '{{user}}的档案', userPersona: '冷静', charNameForVars: '小A', injection: { enabled: true } } },
    ]
    const historyCases = [
      {
        label: '归属标注全语义（用户无前缀+图片、角色带名前缀、未知角色、空正文跳过、变量按发言者替换）',
        input: {
          messages: [
            { characterId: '__user__', content: '{{user}}来了', images: ['img1'] },
            { characterId: 'char-a', content: '{{char}}在此' },
            { characterId: 'char-gone', content: '游离发言' },
            { characterId: 'char-b', content: '   ' },
          ],
          memberIds: ['char-a', 'char-b', 'char-c'],
          userName: '旅人',
          charNameForVars: '小A、小B',
        },
      },
    ]
    const postHistoryCases = [
      { label: 'free 拼接全部成员（各带尾换行）', input: { chatMode: 'free', memberIds: ['char-a', 'char-b', 'char-c'], target: null, userName: '用户', charNameForVars: '小A、小B' } },
      { label: 'mention 只用目标角色（变量按 charNameForVars）', input: { chatMode: 'mention', memberIds: ['char-a', 'char-b', 'char-c'], target: 'char-a', userName: '用户', charNameForVars: '小A' } },
      { label: '目标无后历史指令返回空', input: { chatMode: 'polling', memberIds: ['char-c'], target: 'char-c', userName: '用户', charNameForVars: '小C' } },
    ]

    const data = {
      version: 1,
      oracle: 'shared/chat-core/groupContextBlocks.ts',
      members,
      charNameForVarsCases: [
        { label: '有目标用目标名', input: { targetName: '小A', memberIds: ['char-a', 'char-b'] }, expected: resolveGroupCharNameForVars('小A', members.slice(0, 2)) },
        { label: '无目标用成员名、连接', input: { targetName: null, memberIds: ['char-a', 'char-b'] }, expected: resolveGroupCharNameForVars(undefined, members.slice(0, 2)) },
      ],
      shouldSendScenarioCases: shouldSendCases.map((c) => ({
        label: c.label,
        input: c.input,
        expected: resolveShouldSendScenario(c.input.mode, c.input.userMessageCount),
      })),
      freeMemberCardCases: freeCardCases.map((c) => ({
        label: c.label,
        input: { memberIds: ['char-a', 'char-b', 'char-c'], opts: c.opts },
        expected: buildFreeMemberCards(members, c.opts),
      })),
      targetMemberCardCases: targetCardCases.map((c) => ({
        label: c.label,
        input: { targetId: 'char-a', opts: c.opts },
        expected: buildTargetMemberCard(members[0], c.opts),
      })),
      userPersonaCases: personaCases.map((c) => ({
        label: c.label,
        input: c.input,
        expected: buildGroupUserPersona(c.input as Parameters<typeof buildGroupUserPersona>[0]),
      })),
      historyCases: historyCases.map((c) => ({
        label: c.label,
        input: c.input,
        expected: mapGroupHistoryMessages({
          messages: c.input.messages,
          members: c.input.memberIds.map((id) => members.find((m) => m.id === id)!).filter(Boolean),
          userName: c.input.userName,
          charNameForVars: c.input.charNameForVars,
        }),
      })),
      postHistoryCases: postHistoryCases.map((c) => ({
        label: c.label,
        input: c.input,
        expected: buildGroupPostHistoryInstructions({
          chatMode: c.input.chatMode,
          members: c.input.memberIds.map((id) => members.find((m) => m.id === id)!).filter(Boolean),
          target: c.input.target ? members.find((m) => m.id === c.input.target)! : null,
          userName: c.input.userName,
          charNameForVars: c.input.charNameForVars,
        }),
      })),
    }
    writeFixture('group-context-blocks', data)
  })
})
