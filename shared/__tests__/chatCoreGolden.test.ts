/**
 * 阶段 4 S4-01：跨语言 chat-core golden fixture 生成器与一致性守卫。
 *
 * 目的：Kotlin 侧（Android）必须与 TypeScript 侧（PC）对**同一份输入**给出
 * **同一份结构化输出**。本测试用 TS 实现（oracle）计算输出并落盘为 golden JSON，
 * Kotlin `ChatCoreGoldenTest` 读取同一份 JSON 断言相等。
 *
 * 模式（与阶段 1 `shared/fixtures/canonical/golden-cases.json` 一致）：
 * - 设 `CHAT_CORE_UPDATE_FIXTURES=1` 时（重）生成 golden；
 * - 默认只读校验：TS 实现发生变化而 fixture 未同步时本测试先变红，
 *   迫使「改契约或同时改两端」，而不是让 Kotlin 静默漂移。
 *
 * 全量生成命令：
 *   $env:CHAT_CORE_UPDATE_FIXTURES=1; pnpm exec vitest run shared/__tests__/chatCoreGolden.test.ts
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { replaceVariables, getDisplayName } from '../chat-core/variables'
import { expandMacros, hasMacro, buildMacroContext } from '../chat-core/macros'
import {
  safeRegExp,
  ruleMatchesScope,
  ruleMatchesStage,
  ruleTriggers,
  applyRuleOnce,
  applyRegexRules,
  applyOutputRegexRules,
  findStopIndex,
  truncateAtStop,
  collectStopStrings,
} from '../chat-core/regex'
import {
  convertToOpenAI,
  convertToClaude,
  convertToGemini,
  convertMessages,
  addAssistantPrefix,
} from '../chat-core/promptConverters'
import { cropHistory, applyDepthInserts } from '../chat-core/contextShared'
import { auditSerializedInput, MAX_INPUT_REALLOCATIONS } from '../chat-core/inputAudit'
import {
  planHistoryDegradation,
  formatHistoryDegradationSummary,
} from '../chat-core/historyDegradation'
import {
  CONTEXT_CANDIDATE_KINDS,
  CANDIDATE_SCORE_WEIGHTS,
  KIND_BASE_TIER,
  RECENT_HISTORY_RECENCY,
  HIGH_RELEVANCE_THRESHOLD,
  normalizeContextCandidate,
  candidateScore,
  candidateTier,
  rankCandidates,
  dedupeCandidates,
  summarizeCandidates,
  allocateContextCandidates,
  type ContextCandidate,
} from '../chat-core/contextCandidates'
import {
  WORLDBOOK_ALWAYS_IMPORTANCE,
  WORLDBOOK_CONDITIONAL_IMPORTANCE,
  WORLDBOOK_DETAIL_IMPORTANCE,
  normalizeWorldbookScore,
  worldbookOrigin,
  buildWorldbookCandidateSet,
  summarizeWorldbookInjection,
  buildWorldbookShadowReport,
  formatWorldbookShadowSummary,
} from '../chat-core/worldbookCandidates'
import {
  countVisibleChars,
  median,
  collectRecentAssistantChars,
  detectUserLengthIntent,
  resolveSceneFactor,
  resolveResponseLengthMode,
  resolveResponsePolicy,
  RESPONSE_LENGTH_RANGES,
  RESPONSE_LENGTH_LABELS,
  AUTO_HARD_MAX_CHARS,
  AUTO_DEFAULT_BASELINE_CHARS,
  AUTO_TARGET_MIN_CHARS,
  AUTO_TARGET_MAX_CHARS,
  AUTO_BASELINE_WINDOW,
  AUTO_TARGET_PARAGRAPHS,
  AUTO_MAX_NEW_BEATS,
} from '../responsePolicy'
import {
  buildMainChatOutputPrompt,
  buildContextMessagesFromData,
  resolveChatRequestPlan,
} from '../chat-core/contextBuilder'
import type { BuildOptions } from '../chat-core/contextBuilder'
import type { ContextBuildData } from '../contextTypes'
import {
  escapeMarkdownContent,
  exportRoleLabel,
  exportSessionJson,
  exportSessionMarkdown,
} from '../chat-core/sessionExport'
import { buildMessageTranslationSystemPrompt } from '../translationPrompt'
import {
  DEFAULT_CONTINUE_INTENSITY,
  DEFAULT_CONTINUE_LENGTH,
  CONTINUE_INTENSITY_PARAMS,
  CONTINUE_LENGTH_PARAMS,
  CONTINUE_LENGTH_TOLERANCE,
} from '../continueIntensity'
import {
  ensureUserPerspective,
  normalizeContinueOutput,
  extractTaggedResult,
  parseContinueResult,
  classifyContinueFailure,
  shouldRetryContinueFormat,
  evaluateContinueLength,
  isAcceptableAfterLengthRepair,
  buildLengthRepairInstruction,
  buildContinueSystemPrompt,
  buildContinueContext,
} from '../chat-core/aiInputHelper'
import {
  appendRegeneratedCandidate,
  rotateSwipe,
  candidatePosition,
} from '../chat-core/swipeCandidates'
import {
  DIALOGUE_TENDENCIES,
  DIALOGUE_DIRECTION_LIMITS,
  DIALOGUE_DIRECTION_TEMPERATURE,
  DIALOGUE_DIRECTIONS_TAG,
  resolveDialogueDirectionsEnabled,
  extractDirectionsPayload,
  parseDialogueDirections,
  hasSimilarDirections,
  buildDialogueDirectionSystemPrompt,
  buildDialogueDirectionUserPrompt,
} from '../dialogueDirections'
import {
  allocateGlobalBudgetByBooks,
  buildCompressionKey,
  upsertCompressionCache,
  touchCompressionCache,
  hashString,
  fitLorebookBudgetByPriority,
  enforceBookBudgets,
} from '../chat-core/lorebook'
import {
  stripMarkdownNoise,
  escapeRegExp,
  keywordMatch,
  semanticScoreByOverlap,
  shouldUseOverlapApprox,
  extractEntities,
  checkEntityBoost,
  scoreItems,
  executeLorebookRuntime,
  appendRecentTriggeredIds,
} from '../chat-core/lorebook'
import { LOREBOOK_SCORE_WEIGHTS, LOREBOOK_RECENCY_WINDOW } from '../chat-core/chatConstants'
import type { LoreEntry } from '../types'
import { cosineSimilarity, l2Normalize, dotProduct, topKSimilar } from '../chat-core/vector'
import { LOCAL_MODEL_RETRIEVAL_PROFILES } from '../../electron/services/localModels/catalog'
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  REMOTE_INDEX_CHUNK_CHARS,
  mapFactSearchHits,
  isSemanticEligible,
  vectorSpaceFromConfig,
  isVectorIndexCompatible,
  resolveSemanticThreshold,
  isEmbeddingConfigured,
} from '../chat-core/embeddingPolicy'
import {
  isLoreEntrySemanticEligible,
  buildLoreEntryEmbeddingDocument,
  diffLoreEntryEmbeddingIds,
  splitEmbeddingDocument,
  mergeEmbeddingChunkVectors,
} from '../lorebookEmbedding'
import { LOREBOOK_PRIORITY_BUDGET } from '../chat-core/chatConstants'
import type { Character, DialogueDirection, LorebookCompressionCacheEntry, Message, Preset, SessionPreview, Settings } from '../types'
import {
  observationTerminationCause,
  terminationCauseFromFinishReason,
  effectiveFinishReasonForCause,
  terminationPromptWithContent,
  terminationPromptWithoutContent,
  contentFilterPreservesBody,
  createGenerationTerminationLatch,
} from '../generationTermination'
import type { AIFinishReason, GenerationTerminationCause } from '../types'
import {
  PROTOCOL_RESERVE_TOKENS,
  DEFAULT_AUTOMATIC_OUTPUT_LIMIT,
  DEFAULT_AUTOMATIC_REASONING_RESERVE,
  BODY_RESERVE_MULTIPLIER,
  BODY_RESERVE_OVERHEAD_TOKENS,
  MIN_USABLE_BODY_TOKENS,
  getModelOutputProfile,
  resolveModelOutputProfile,
  percentile90,
  resolveReasoningReserve,
  resolveUserHardCap,
  enabledProfileOverride,
  resolveEffectiveContextLimit,
  formatRequestBudgetRisk,
  resolveRequestBudget,
} from '../modelOutputProfile'
import type {
  ModelProfileUserOverride,
  ModelCapabilityCorrection,
  RequestBudgetInput,
} from '../modelOutputProfile'
import {
  LOW_GATE_TOKENS,
  GATE_PROBE_MAX_SAMPLES,
  levelToTokens,
  nextLowerGateLevel,
  selectGateKnob,
  resolveReasoningGate,
  resolveDefaultGateLevel,
  mergeGateProbe,
  clampGateBudgetForBody,
} from '../reasoningGate'
import type {
  GateProbe,
  GateProbeUpdate,
  ReasoningGateLevel,
  ReasoningGateResolveInput,
} from '../reasoningGate'
import {
  expandAdaptiveOutputBudget,
  resolveGenerationTaskBodyChars,
  resolveGenerationTaskBudget,
} from '../generationTaskBudget'
import type {
  AdaptiveOutputBudget,
  GenerationTask,
  GenerationTaskBudgetInput,
} from '../generationTaskBudget'
import { createDomainError, sanitizeErrorMessage } from '../chat-core/errors'
import type { DomainErrorCode } from '../chat-core/errors'
import {
  MAX_MEMORY_FACTS,
  MAX_MEMORY_FACT_HISTORY,
  parseMemoryResult,
  memoryFactToText,
  formatMemoryFacts,
  applyMemoryFactChanges,
  applyFactProposals,
  computeRecencyScore,
  scoreAndRankFacts,
  selectFactsByBudget,
  fitLayeredMemoryBudget,
} from '../chat-core/memory'
import type { FactProposal, MemoryFact, MemoryFactChange, MemoryFactRecord } from '../types'
import { TOKEN_BUDGET_SAFETY, IMAGE_TOKEN_ESTIMATE } from '../chat-core/chatConstants'
import {
  mergeConsecutiveMessages,
  strictAlternatingMessages,
  semiStrictMessages,
  normalizeRoleplayDialoguePrefixes,
  extractThought,
  stripThought,
  stripThoughtTags,
  trimContinuationSeam,
  trimContinuationOverlap,
} from '../chat-core/messagePostProcess'
import {
  DEFAULT_NARRATIVE_MODE,
  NARRATIVE_MODE_OPTIONS,
  isNarrativeMode,
  resolveNarrativeMode,
  getNarrativeModeLabel,
  buildNarrativeModePrompt,
  getNarrativeMemoryGuidance,
} from '../narrativeMode'
import { THOUGHT_CONTRACT_CLAUSES, buildThoughtContractBody } from '../thoughtContract'
import {
  BUILTIN_TEMPLATE_NAMES,
  getTemplateByName,
  getInstructTemplate,
  resolveEffectiveTemplate,
  applyInstructTemplate,
} from '../chat-core/chatTemplates'
import {
  MEMORY_TIMELINE_TARGET_CHUNK_TOKENS,
  MEMORY_TIMELINE_MAX_CHUNK_TOKENS,
  MEMORY_TIMELINE_MAX_CHUNKS,
  MEMORY_STATE_SCORES,
  MEMORY_TIMELINE_RELEVANCE,
  MEMORY_TIMELINE_IMPORTANCE,
  MEMORY_FACT_CONTINUITY,
  splitTimelineIntoChunks,
  buildMemoryCandidateSet,
  selectMemoryCandidates,
  buildMemoryShadowReport,
  formatMemoryShadowSummary,
  materializeMemoryInjection,
} from '../chat-core/memoryCandidates'
import type { MemoryCandidateInput, MemoryCandidateSet, MemoryInjectionStats } from '../chat-core/memoryCandidates'
import {
  SENTENCE_END_CHARS,
  countVisibleCharacters,
  isCompleteSentence,
  trimToSentenceBoundary,
  tailSample,
  TAIL_SAMPLE_MAX_CHARS,
  analyzeTextClosure,
} from '../textMetrics'
import {
  finalizeAssistantOutput,
  buildRepairContext,
  mergeTailRepair,
} from '../assistantOutputFinalizer'
import {
  runGeneratedReplyPipeline,
  finalizeGenerationTerminalResult,
} from '../chat-core/generatedReplyPipeline'
import type { NarrativeMode } from '../types'
import { estimateTokens, estimateImageTokens, formatTokens } from '../chat-core/tokenCounter'
import {
  tokenizeLexicalText,
  LexicalRetrievalProvider,
  reciprocalRankFusion,
} from '../chat-core/lorebookRetrieval'
import { renderLorebookItems } from '../chat-core/lorebookRenderer'
import {
  MEMORY_SUMMARY_INPUT_TOKEN_BUDGET,
  MEMORY_SUMMARY_MIN_INPUT_TOKEN_BUDGET,
  MEMORY_SUMMARY_OVERLAP_COUNT,
  resolveMemorySummaryInputBudget,
  fitOversizedMemoryMessage,
  buildMemorySummaryWindow,
} from '../chat-core/memoryWindow'
import type { Lorebook } from '../../shared/types'
import type { LorebookInsertionV2 } from '../../shared/lorebook/domain/v2'
import type { RegexRule } from '../../shared/types'

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'cross-platform', 'chat-core')
const UPDATE = process.env.CHAT_CORE_UPDATE_FIXTURES === '1'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  images?: string[]
  keepSeparate?: boolean
}

/**
 * `promptConverters` / `messagePostProcess` 内部声明的是**私有** `ChatMessage`
 * （带 `[key: string]: unknown` 索引签名），模块外无法引用。
 * 契约层面两端结构等价，这里用一次显式断言记录「跨模块调用同一消息模型」这一事实，
 * 避免 TS 把两个同名私有类型判为不兼容。
 */
function converter<T>(fn: (...args: never[]) => unknown): (messages: ChatMessage[]) => T[] {
  return fn as unknown as (messages: ChatMessage[]) => T[]
}

function converterWith<T>(fn: (...args: never[]) => unknown): (messages: ChatMessage[], extra: unknown) => T[] {
  return fn as unknown as (messages: ChatMessage[], extra: unknown) => T[]
}

/**
 * fixture 的**可往返**守卫。
 *
 * JSON 无法表示 `NaN`/`Infinity`/`undefined`，但三种情况的后果不同：
 * - **非有限数**：会被写成 `null`，而 `toEqual` 不认为 `NaN` 等于 `null` → **真实不稳定**，直接拒绝；
 * - **数组元素为 `undefined`**：会被写成 `null`，同样不被 `toEqual` 忽略 → **真实不稳定**，直接拒绝；
 * - **对象属性为 `undefined`**：`JSON.stringify` 直接丢掉该键，而 `toEqual` 恰好忽略
 *   「有键但值为 undefined」与「没有该键」的差别 → 夹具仍稳定，故**允许**
 *   （下游 Kotlin 读取缺失键与 null 的行为一致）。
 *
 * 同类不稳定在多个模块上重复出现过（记忆候选、输入审计、上下文候选、世界书、
 * 百分位样本、语义分数字典），逐次修个案治不了根，因此在**写入前**直接拒绝前两类。
 */
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
  const file = join(FIXTURE_DIR, `${name}.json`)
  if (UPDATE) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    return
  }
  if (!existsSync(file)) {
    throw new Error(`缺少 golden fixture：${file}\n首次生成请运行：$env:CHAT_CORE_UPDATE_FIXTURES=1; pnpm exec vitest run shared/__tests__/chatCoreGolden.test.ts`)
  }
  expect(data, `fixture ${name}.json 与 TS 实现不一致（改契约请重新生成）`).toEqual(JSON.parse(readFileSync(file, 'utf8')))
}

/** 构造符合 RegexRule 的最小对象（缺省字段用生产者默认值）。 */
function rule(partial: Partial<RegexRule> & { pattern: string }): RegexRule {
  return {
    id: 'r',
    name: 'r',
    replacement: '',
    enabled: true,
    scope: 'output',
    ...partial,
  } as RegexRule
}

// ---------------------------------------------------------------- 用例定义（固定输入）

const VARIABLE_CASES = [
  { text: '{{user}} 对 {{char}} 说', userName: '小明', charName: '苏晚', original: undefined },
  { text: '{{USER}} 与 {{CHAR}}', userName: 'a', charName: 'b', original: undefined },
  { text: '原名 {{original}}', userName: 'u', charName: '译名', original: 'Original' },
  { text: '', userName: 'u', charName: 'c', original: undefined },
  { text: '没有变量的文本', userName: 'u', charName: 'c', original: undefined },
  { text: '{{user}}{{char}}{{original}}', userName: '', charName: '', original: undefined },
  { text: '嵌套 {{{{user}}}}', userName: 'u', charName: 'c', original: undefined },
]

const MACRO_CONTEXT = {
  userName: '小明',
  charName: '苏晚',
  originalCharName: 'Su Wan',
  groupName: '四人组',
  lastMessage: '最后一条消息',
  lastUserMessage: '最后一条用户消息',
}

const MACRO_CASES = [
  '{{user}} 和 {{char}}',
  '{{original}}',
  '{{group}}',
  '{{lastMessage}}|{{lastUserMessage}}',
  '{{newline}}',
  '{{unknown}} 保持原样',
  '{{ random:唯一选项 }}',
  '{{random:早安|晚安}}',
  '{{newline:}}',
  '{{char:ignored}}',
  '{ {user} }',
  '{{user',
  '{{user}}',
  '文本无宏',
  '',
  '{{USER}}',
  '{{id}} 长度不定',
]

const REGEX_RULES: RegexRule[] = [
  rule({ id: 'r1', pattern: '\\*\\*(.+?)\\*\\*', replacement: '$1', flags: 'g', scope: 'output' }),
  rule({ id: 'r2', pattern: 'foo', replacement: 'bar', flags: 'gi', scope: 'input' }),
  rule({ id: 'r3', pattern: 'bar', replacement: 'baz', flags: 'g', scope: 'both' }),
  rule({
    id: 'r4',
    pattern: '秘密',
    replacement: '[已隐藏]',
    scope: 'output',
    triggerPattern: '包含触发词',
    triggerFlags: 'i',
  }),
  rule({ id: 'r5', pattern: 'markdown', replacement: 'MD', scope: 'output', stage: 'markdown' }),
  rule({ id: 'r6', pattern: 'x', replacement: 'y', scope: 'output', enabled: false }),
  rule({ id: 'r7', pattern: '坏[', replacement: 'z', scope: 'output' }),
  rule({ id: 'r8', pattern: 'a', replacement: 'b', scope: 'output', stopStrings: ['END', '  END  ', 'STOP', ''] }),
  rule({ id: 'r9', pattern: 'c', replacement: 'd', scope: 'output', stage: 'markdown', stopStrings: ['IGNORED'] }),
  rule({ id: 'r10', pattern: '长停', replacement: '', scope: 'both', stopStrings: ['尾巴'] }),
]

const REGEX_TEXTS = [
  '**加粗** 与 foo 与 秘密 与 markdown',
  '包含触发词里面有秘密',
  '没有触发词但有秘密',
  '**未闭合 加粗',
  'foo foo FOO',
  'markdown markdown',
  '普通文本没有规则命中',
  '',
]

const REGEX_STOP_CASES = [
  { text: '前段 END 后段', stops: ['END', 'STOP'] },
  { text: '前段 STOP 后段', stops: ['END', 'STOP'] },
  { text: '前段 STOP 后面还有 END', stops: ['END', 'STOP'] },
  { text: '无终止符', stops: ['END'] },
  { text: '尾巴在最后', stops: ['尾巴'] },
  { text: '末尾有空白   ', stops: ['空白'] },
  { text: '', stops: ['END'] },
  { text: '文本', stops: [] },
]

const CONVERTER_MESSAGE_SETS: ChatMessage[][] = [  [
    { role: 'system', content: 'S1' },
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'U2' },
  ],
  [
    { role: 'system', content: 'S1' },
    { role: 'system', content: 'S2' },
    { role: 'user', content: 'U1' },
    { role: 'user', content: 'U2' },
    { role: 'assistant', content: 'A1' },
  ],
  [
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
  ],
  [
    { role: 'assistant', content: 'A1' },
  ],
  [
    { role: 'user', content: 'U1', images: ['img:1'] },
    { role: 'user', content: 'U2', images: ['img:2', 'img:3'] },
  ],
  [],
  [
    { role: 'system', content: 'keep', keepSeparate: true },
    { role: 'user', content: 'U1' },
    { role: 'system', content: 'injected', keepSeparate: true },
    { role: 'assistant', content: 'A1' },
  ],
]

const DIALOGUE_CASES = [
  { text: '“我没应。”\n他说。', name: '苏晚', mode: 'immersive' as const },
  { text: '“我没应。”苏晚顿了顿。', name: '苏晚', mode: 'immersive' as const },
  { text: '「你好」\n“第二行”', name: '苏晚', mode: 'immersive' as const },
  { text: '“我不补”', name: '苏晚', mode: 'omniscient' as const },
  { text: '  “带缩进”  ', name: '苏晚', mode: 'immersive' as const },
  { text: '普通叙述没有引号', name: '苏晚', mode: 'immersive' as const },
  { text: '<thought>内心“不补”</thought>\n“外面补”', name: '苏晚', mode: 'immersive' as const },
  { text: '“名字在行内”苏晚说', name: '苏晚', mode: 'immersive' as const },
  { text: '', name: '苏晚', mode: 'immersive' as const },
  { text: '“空名字”', name: '   ', mode: 'immersive' as const },
]

const THOUGHT_CASES = [
  '正文<thought>内心</thought>结尾',
  '<thought>只有思考</thought>',
  '正文</thought>',
  '<thought>未闭合',
  '<thought>A</thought>中间<thought>B</thought>',
  '\\</ thought >容忍',
  '<thought class="x">带属性</thought>',
  '无思考标签',
  '',
  '<thinking>供应商推理</thinking>正文',
  '<thought>一</thought><thought>二</thought>',
  '尾随空白   <thought> t </thought>   ',
]

const SEAM_CASES = [
  { prev: '外面下着雨，我推开', next: '我推开门走了出去' },
  { prev: '今天其实', next: '今天其实很好' },
  { prev: '楼下的', next: '楼下的猫叫了' },
  { prev: '你的', next: '你的东西' },
  { prev: 'abc', next: 'abc' },
  { prev: '', next: '内容' },
  { prev: '内容', next: '' },
  { prev: '结尾。', next: '  开头' },
  { prev: '一二三四五六七八九十', next: '八九十继续' },
  { prev: '短', next: '短' },
]

const TOKEN_CASES = [
  { text: '你好世界', model: 'gpt-4o' },
  { text: 'hello world', model: 'gpt-4o' },
  { text: '你好 hello，世界 world！', model: 'claude-3-5-sonnet' },
  { text: '你好 hello，世界 world！', model: 'gemini-1.5-pro' },
  { text: '你好 hello，世界 world！', model: undefined },
  { text: '', model: 'gpt-4o' },
  { text: `中文标点，。！？；：""''（）【】《》、 和空格`, model: 'gpt-4o' },
  // 引号分类必须可观测：ASCII 直引号属标点（0.25/个），中文引号属「英文类」（1/3.4 个）。
  // 上面那条用例虽含直引号，但 4 个字符的错分类恰好落在同一个 ceil 内，不足以发现分歧；
  // 下面几条把差异放大到必然越界。
  { text: '"'.repeat(40), model: 'gpt-4o' },
  { text: "'".repeat(40), model: 'gpt-4o' },
  { text: '“中文引号”与‘单引号’', model: 'gpt-4o' },
  { text: `混合："直引号" 与“弯引号”`, model: 'gpt-4o' },
  // 非 ASCII 空白属标点（JS \s 含 U+3000/U+00A0；JVM 默认 \s 不含）
  { text: '全角\u3000空格与\u00a0不换行空格', model: 'gpt-4o' },
  { text: '🙂 emoji 与 汉字', model: 'gpt-4o' },
  { text: 'a'.repeat(500), model: 'gpt-4o' },
]

// ---------------------------------------------------------------- 世界书检索/渲染

/**
 * 语料刻意覆盖：中英混合、单字查询、Hangul/Katakana、代码块与 URL 清洗、
 * 停用书/停用条目的排除、以及无 runtime.title 时按内容指纹建索引的分支。
 */
const RETRIEVAL_CORPUS: Lorebook[] = [
  {
    id: 'book-city',
    name: '城市设定',
    description: '',
    enabled: true,
    scanDepth: 4,
    runtime: { schemaVersion: 2, revision: 3 },
    entries: [
      {
        id: 'e-rain',
        keywords: ['下雨', '雨夜'],
        content: '这座城市入夜后总会下起小雨，路灯在积水里碎成一片金色。',
        position: 'before_char',
        order: 10,
        probability: 100,
        enabled: true,
        runtime: { insertion: { kind: 'prompt', anchor: 'before_character' }, retrieval: 'keyword', title: '雨夜街景' },
      },
      {
        id: 'e-cat',
        keywords: ['猫', '流浪猫'],
        content: '巷口有只三花猫，雨天会躲在旧书店的雨棚下面。',
        position: 'after_char',
        order: 20,
        probability: 100,
        enabled: true,
      },
      {
        id: 'e-disabled',
        keywords: ['禁用条目'],
        content: '这条内容不应出现在任何检索结果里。',
        position: 'before_char',
        order: 30,
        probability: 100,
        enabled: false,
      },
    ],
  },
  {
    id: 'book-tech',
    name: 'Tech notes',
    description: '',
    enabled: true,
    scanDepth: 2,
    entries: [
      {
        id: 'e-bm25',
        keywords: ['BM25', 'retrieval'],
        content: 'BM25 combines term frequency with inverse document frequency and length normalization.',
        position: 'before_char',
        order: 5,
        probability: 100,
        enabled: true,
      },
      {
        id: 'e-vector',
        keywords: ['vector', 'embedding'],
        content: 'Vector search uses cosine similarity over embeddings; reciprocal rank fusion merges channels.',
        position: 'before_char',
        order: 6,
        probability: 100,
        enabled: true,
      },
      {
        id: 'e-empty',
        keywords: ['empty'],
        content: '   ',
        position: 'before_char',
        order: 7,
        probability: 100,
        enabled: true,
      },
    ],
  },
  {
    id: 'book-mixed',
    name: '混合脚本',
    description: '',
    enabled: true,
    scanDepth: 2,
    entries: [
      {
        id: 'e-hangul',
        keywords: ['서울'],
        content: '서울의 밤은 조용하다 그리고 비가 온다.',
        position: 'before_char',
        order: 1,
        probability: 100,
        enabled: true,
      },
      {
        id: 'e-kana',
        keywords: ['さくら'],
        content: 'さくらの花びらが風に舞う。カタカナもテストする。',
        position: 'before_char',
        order: 2,
        probability: 100,
        enabled: true,
      },
    ],
  },
  {
    id: 'book-disabled',
    name: '停用书',
    description: '',
    enabled: false,
    scanDepth: 2,
    entries: [
      {
        id: 'e-never',
        keywords: ['绝不会命中'],
        content: '整本书被停用，内容不应进入索引。',
        position: 'before_char',
        order: 1,
        probability: 100,
        enabled: true,
      },
    ],
  },
]

const TOKENIZE_CASES = [
  '下雨的夜晚',
  '我',
  'a',
  'BM25 retrieval',
  '你好 world 123',
  '서울의 밤',
  'さくらとカタカナ',
  '```code block``` 与 https://example.com/x 之后',
  '，。！？ 标点',
  'ＡＢＣ 全角',
  '',
]

const RETRIEVAL_QUERIES = [
  { query: '下雨' },
  { query: '雨夜街景' },
  { query: '猫' },
  { query: 'BM25 retrieval' },
  { query: 'vector embedding fusion' },
  { query: '서울' },
  { query: 'さくら' },
  { query: '完全没有出现的词' },
  { query: '下雨', topK: 1 },
  { query: '雨夜街景 猫', threshold: 0.5 },
  { query: '禁用条目' },
  { query: '' },
]

const FUSION_CASES: Array<{
  channels: Parameters<typeof reciprocalRankFusion>[0]
  options?: Parameters<typeof reciprocalRankFusion>[1]
}> = [
  {
    channels: {
      keyword: [
        { key: 'k1', score: 10 },
        { key: 'k2', score: 8 },
      ],
      lexical: [
        { key: 'k2', score: 0.9 },
        { key: 'k3', score: 0.5 },
      ],
      vector: [
        { key: 'k3', score: 0.8 },
        { key: 'k1', score: 0.4 },
      ],
    },
  },
  {
    channels: { keyword: [{ key: 'only', score: 1 }] },
  },
  {
    channels: {},
  },
  {
    channels: { lexical: [{ key: 'a', score: 0.1 }, { key: 'b', score: 0.1 }] },
    options: { k: 1, weights: { keyword: 5, lexical: 2, vector: 0 } },
  },
]

const RENDER_CASES: Array<Array<{ content: string; order: number; insertion: LorebookInsertionV2; key?: string }>> = [
  [
    { content: '角色之前', order: 1, insertion: { kind: 'prompt', anchor: 'before_character' }, key: 'a' },
    { content: '角色之后', order: 2, insertion: { kind: 'prompt', anchor: 'after_character' }, key: 'b' },
    { content: '示例前', order: 3, insertion: { kind: 'prompt', anchor: 'before_examples' }, key: 'c' },
    { content: '示例后', order: 4, insertion: { kind: 'prompt', anchor: 'after_examples' }, key: 'd' },
    { content: '注释顶', order: 5, insertion: { kind: 'prompt', anchor: 'authors_note_top' }, key: 'e' },
    { content: '注释底', order: 6, insertion: { kind: 'prompt', anchor: 'authors_note_bottom' }, key: 'f' },
    { content: '提示末尾', order: 7, insertion: { kind: 'prompt', anchor: 'prompt_end' }, key: 'g' },
  ],
  [
    { content: '深度注入', order: 1, insertion: { kind: 'chat', depth: 2, role: 'system' }, key: 'deep' },
    { content: '默认角色深度注入', order: 2, insertion: { kind: 'chat', depth: 0 }, key: 'deep2' },
    { content: '负数深度钳制', order: 3, insertion: { kind: 'chat', depth: -2.7, role: 'user' }, key: 'neg' },
  ],
  [
    { content: '命名出口', order: 1, insertion: { kind: 'outlet', name: 'sidebar' }, key: 'o1' },
    { content: '空名出口', order: 2, insertion: { kind: 'outlet', name: '   ' }, key: 'o2' },
    { content: '同名出口追加', order: 3, insertion: { kind: 'outlet', name: 'sidebar' }, key: 'o3' },
  ],
  [
    {
      content: '自定义插入',
      order: 1,
      insertion: { kind: 'custom', source: 'plugin-x', value: { a: 1, b: ['x'] } },
      key: 'c1',
    },
  ],
  [],
]

// ---------------------------------------------------------------- 长记忆窗口

/**
 * `NaN` / `Infinity` 不能直接进 JSON（`JSON.stringify` 写 `null`，`JSON.parse` 读回 `null`），
 * 会让「特殊值」用例在重新生成后自相矛盾。这里改用字符串哨兵，两端各自解析，
 * 保证 golden 只包含 JSON 原生值。
 */
function toSentinel(value: number): number | string {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Number.POSITIVE_INFINITY) return 'Infinity'
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity'
  return value
}

const MEMORY_BUDGET_CASES = [
  { maxContext: 8192, systemPromptTokens: 1200, reservedOutputTokens: 800 },
  { maxContext: 32768, systemPromptTokens: 2000, reservedOutputTokens: 4000 },
  { maxContext: 128000, systemPromptTokens: 1000, reservedOutputTokens: 1000 },
  { maxContext: 0, systemPromptTokens: 0, reservedOutputTokens: 0 },
  { maxContext: -1, systemPromptTokens: -5, reservedOutputTokens: -5 },
  { maxContext: 2048, systemPromptTokens: 0, reservedOutputTokens: 0 },
  { maxContext: 4096.9, systemPromptTokens: 100.9, reservedOutputTokens: 50.9 },
  { maxContext: Number.NaN, systemPromptTokens: Number.POSITIVE_INFINITY, reservedOutputTokens: Number.NaN },
  { maxContext: 600, systemPromptTokens: 100, reservedOutputTokens: 100 },
]

const MEMORY_OVERSIZED_CASES = [
  { text: '短消息', tokenBudget: 100 },
  { text: '这是一条很长很长的消息'.repeat(50), tokenBudget: 60 },
  { text: 'a'.repeat(400), tokenBudget: 20 },
  { text: '中'.repeat(300), tokenBudget: 5 },
  { text: '边界'.repeat(20), tokenBudget: 1 },
]

const MEMORY_MESSAGES = [
  { id: 'm1', content: '第一条消息' },
  { id: 'm2', content: '第二条消息，稍微长一点用于占位' },
  { id: 'm3', content: '第三条' },
  { id: 'm4', content: '第四条消息内容' },
  { id: 'm5', content: '第五条消息' },
  { id: 'm6', content: '第六条消息，再来一些文字' },
  { id: 'm7', content: '第七条' },
]

const MEMORY_WINDOW_CASES: Array<{
  cursorId?: string
  options?: { tokenBudget?: number; overlapCount?: number }
}> = [
  {},
  { cursorId: 'm1' },
  { cursorId: 'm4' },
  { cursorId: 'm7' },
  { cursorId: 'not-exist' },
  { cursorId: null as unknown as string },
  { cursorId: 'm4', options: { tokenBudget: 1 } },
  { cursorId: 'm4', options: { tokenBudget: 10 } },
  { cursorId: 'm4', options: { tokenBudget: 30, overlapCount: 0 } },
  { cursorId: 'm4', options: { tokenBudget: 30, overlapCount: 3 } },
  { cursorId: 'm4', options: { overlapCount: -1 } },
]

// ---------------------------------------------------------------- 上下文裁剪/注入/审计

const CONTEXT_CROP_CASES: Array<{
  corpus: Array<{ id: string; content: string; images?: string[]; timestamp: number }>
  usedTokens: number
  budgetBase: number
  model: string
}> = [
  {
    corpus: [
      { id: 'h1', content: '第一条', timestamp: 10 },
      { id: 'h2', content: '第二条消息内容', timestamp: 20 },
      { id: 'h3', content: '第三条', timestamp: 30 },
      { id: 'h4', content: '第四条消息内容比较长一些', timestamp: 40 },
    ],
    usedTokens: 0,
    budgetBase: 1000,
    model: 'gpt-4o',
  },
  {
    corpus: [
      { id: 'h1', content: '第一条', timestamp: 10 },
      { id: 'h2', content: '第二条消息内容', timestamp: 20 },
      { id: 'h3', content: '第三条', timestamp: 30 },
      { id: 'h4', content: '第四条消息内容比较长一些', timestamp: 40 },
    ],
    usedTokens: 0,
    budgetBase: 10,
    model: 'gpt-4o',
  },
  {
    corpus: [
      { id: 'h1', content: '第一条', timestamp: 10 },
      { id: 'h2', content: '第二条消息内容', timestamp: 20 },
      { id: 'h3', content: '第三条', timestamp: 30 },
      { id: 'h4', content: '带图消息', images: ['a', 'b', 'c'], timestamp: 40 },
    ],
    usedTokens: 0,
    budgetBase: 400,
    model: 'claude-3-5-sonnet',
  },
  {
    corpus: [
      { id: 'h1', content: '中文内容，。！', timestamp: 10 },
      { id: 'h2', content: 'english content here', timestamp: 20 },
    ],
    usedTokens: 50,
    budgetBase: 60,
    model: 'gpt-4o',
  },
  { corpus: [], usedTokens: 0, budgetBase: 100, model: 'gpt-4o' },
  {
    corpus: [{ id: 'only', content: '唯一一条但超预算', timestamp: 5 }],
    usedTokens: 0,
    budgetBase: 1,
    model: 'gpt-4o',
  },
]

const DEPTH_INSERT_CASES: Array<{
  history: string[]
  inserts: Array<{ content: string; depth: number; order: number; role?: 'system' | 'user' | 'assistant' }>
}> = [
  { history: ['h1', 'h2', 'h3'], inserts: [] },
  { history: ['h1', 'h2', 'h3'], inserts: [{ content: 'i0', depth: 0, order: 1 }] },
  {
    history: ['h1', 'h2', 'h3'],
    inserts: [
      { content: 'deep', depth: 2, order: 1 },
      { content: 'same-depth-a', depth: 1, order: 2 },
      { content: 'same-depth-b', depth: 1, order: 1 },
    ],
  },
  {
    history: ['h1', 'h2'],
    inserts: [
      { content: 'withRole', depth: 1, order: 1, role: 'user' },
      { content: 'over', depth: 99, order: 1 },
    ],
  },
  { history: [], inserts: [{ content: 'only', depth: 0, order: 1 }] },
  {
    history: ['h1', 'h2', 'h3'],
    inserts: [
      { content: 'neg', depth: -3, order: 1 },
      { content: 'neg2', depth: -3, order: 2 },
    ],
  },
]

const AUDIT_CASES: Array<{
  provider: string
  model: string
  parts: Array<{ id: string; role: 'system' | 'user' | 'assistant' | 'tool'; tokens: number; confidence: 'exact' | 'provider-reported' | 'estimated' }>
  reservedOutputTokens: number
  contextLimit: number
  protocolSafetyRatio?: number
  serialized?: boolean
}> = [
  {
    provider: 'openai',
    model: 'gpt-4o',
    parts: [
      { id: 'p0:system', role: 'system', tokens: 1200, confidence: 'estimated' },
      { id: 'p1:user', role: 'user', tokens: 300, confidence: 'estimated' },
    ],
    reservedOutputTokens: 800,
    contextLimit: 8192,
  },
  {
    provider: 'openai',
    model: 'gpt-4o',
    parts: [
      { id: 'p0:system', role: 'system', tokens: 100, confidence: 'exact' },
      { id: 'p1:user', role: 'user', tokens: 100, confidence: 'provider-reported' },
    ],
    reservedOutputTokens: 100,
    contextLimit: 1000,
    serialized: true,
  },
  { provider: 'x', model: 'm', parts: [], reservedOutputTokens: 0, contextLimit: 0 },
  {
    provider: 'x',
    model: 'm',
    parts: [{ id: 'bad-role', role: 'tool', tokens: -5, confidence: 'estimated' }],
    reservedOutputTokens: Number.NaN,
    contextLimit: 100,
  },
  {
    provider: 'x',
    model: 'm',
    parts: [{ id: 'p', role: 'user', tokens: 10, confidence: 'estimated' }],
    reservedOutputTokens: 10,
    contextLimit: 200,
    protocolSafetyRatio: 0,
  },
  {
    provider: 'x',
    model: 'm',
    parts: [],
    reservedOutputTokens: 0,
    contextLimit: 0,
    serialized: true,
  },
  {
    provider: 'x',
    model: 'm',
    parts: [
      { id: 'a', role: 'assistant', tokens: 10, confidence: 'exact' },
      { id: 'b', role: 'tool', tokens: 20, confidence: 'exact' },
      { id: 'c', role: 'user', tokens: 30, confidence: 'exact' },
      { id: 'd', role: 'system', tokens: 40, confidence: 'exact' },
    ],
    reservedOutputTokens: 5,
    contextLimit: 500,
    serialized: true,
  },
]

const HISTORY_CORPUS = [
  { content: '旧消息一', timestamp: 100 },
  { content: '旧消息二，稍长一些', timestamp: 200 },
  { content: '新消息一', timestamp: 300 },
  { content: '新消息二', timestamp: 400 },
]

const HISTORY_CASES: Array<{
  usedTokens: number
  budgetTokens: number
  model?: string
  compressedSummary?: string | null
  compressedRange?: { startTs: number; endTs: number } | null
}> = [
  { usedTokens: 0, budgetTokens: 1000, model: 'gpt-4o' },
  { usedTokens: 0, budgetTokens: 8, model: 'gpt-4o' },
  {
    usedTokens: 0,
    budgetTokens: 8,
    model: 'gpt-4o',
    compressedSummary: '这是对旧对话的压缩摘要。',
    compressedRange: { startTs: 0, endTs: 500 },
  },
  {
    usedTokens: 0,
    budgetTokens: 8,
    model: 'gpt-4o',
    compressedSummary: '摘要不覆盖',
    compressedRange: { startTs: 150, endTs: 250 },
  },
  { usedTokens: 0, budgetTokens: 8, model: 'gpt-4o', compressedSummary: null, compressedRange: null },
  { usedTokens: 0, budgetTokens: 8, model: 'gpt-4o', compressedSummary: '   ', compressedRange: { startTs: 0, endTs: 500 } },
  { usedTokens: 0, budgetTokens: 1000, model: 'gpt-4o', compressedSummary: '无裁剪但有摘要', compressedRange: { startTs: 0, endTs: 500 } },
  { usedTokens: 0, budgetTokens: Number.NaN, model: 'gpt-4o' },
]

// ---------------------------------------------------------------- 上下文候选与分配

/**
 * 候选构造器：fixture 用例刻意省略部分字段（null/缺省）来覆盖净化兜底，
 * 因此这里补齐 PC 接口的必填项，缺省值与 `normalizeContextCandidate` 的语义一致。
 */
function cand(partial: {
  id?: string
  kind: string
  estimatedTokens: number
  mandatory?: boolean
  stablePrefix?: boolean
  relevance?: number
  recency?: number
  importance?: number
  continuity?: number
  dedupeKey?: string
  originalOrder: number
  origin?: string
}): ContextCandidate {
  return {
    mandatory: false,
    stablePrefix: false,
    relevance: 0,
    recency: 0,
    importance: 0,
    continuity: 0,
    ...partial,
  } as ContextCandidate
}

/** 单个候选的规范化/评分/顺位（含越界数值与缺字段的兜底）。 */
const CANDIDATE_CASES: ContextCandidate[] = [
  cand({ id: 'c1', kind: 'protocol', estimatedTokens: 100, mandatory: true, stablePrefix: true, relevance: 1, recency: 1, importance: 1, continuity: 1, originalOrder: 0 }),
  cand({ id: 'c2', kind: 'character', estimatedTokens: 50, relevance: 0.5, recency: 0.1, importance: 0.9, continuity: 0.2, originalOrder: 1 }),
  cand({ id: 'c3', kind: 'history', estimatedTokens: 30, recency: 0.5, relevance: 0.4, importance: 0.1, continuity: 0.8, originalOrder: 2 }),
  cand({ id: 'c4', kind: 'history', estimatedTokens: 30, recency: 0.49, relevance: 0.4, importance: 0.1, continuity: 0.8, originalOrder: 3 }),
  cand({ id: 'c5', kind: 'memory', estimatedTokens: 40, relevance: 0.5, recency: 0.2, importance: 0.6, continuity: 0.3, originalOrder: 4 }),
  cand({ id: 'c6', kind: 'memory', estimatedTokens: 40, relevance: 0.49, recency: 0.2, importance: 0.6, continuity: 0.3, originalOrder: 5 }),
  // 未知 kind / 空 id / 越界数值：验证净化兜底。
  // 注意：不能用 `NaN` 做输入——`normalizeContextCandidate` 对 continuity 不做净化，
  // NaN 会原样写进 fixture 变成 `null`，导致 golden 自相矛盾。用极大值覆盖「>1 截到 1」分支。
  cand({ id: 'c7', kind: 'unknown-kind', estimatedTokens: 10, relevance: 0.5, originalOrder: 6 }),
  cand({ id: '   ', kind: 'example', estimatedTokens: 10.4, relevance: -1, recency: 99, importance: 2, continuity: 1e9, originalOrder: 7 }),
  cand({ id: 'c8', kind: 'worldbook', estimatedTokens: -5, relevance: 0.5, recency: 0.5, importance: 0.5, continuity: 0.5, originalOrder: 8 }),
  cand({ id: 'c9', kind: 'group-state', estimatedTokens: 20, relevance: 0.3, recency: 0.3, importance: 0.3, continuity: 0.3, originalOrder: 9, dedupeKey: 'fact:1' }),
  cand({ id: 'c10', kind: 'current-state', estimatedTokens: 20, relevance: 0.9, recency: 0.9, importance: 0.9, continuity: 0.9, originalOrder: 10, dedupeKey: 'fact:1' }),
]

/** 用于排序/去重/汇总的候选组。 */
const CANDIDATE_GROUPS: ContextCandidate[][] = [
  CANDIDATE_CASES,
  [
    // 同分：靠 originalOrder 与 id 决定顺序
    cand({ id: 'b', kind: 'history', estimatedTokens: 10, relevance: 0.5, recency: 0.5, importance: 0.5, continuity: 0.5, originalOrder: 5 }),
    cand({ id: 'a', kind: 'history', estimatedTokens: 10, relevance: 0.5, recency: 0.5, importance: 0.5, continuity: 0.5, originalOrder: 5 }),
    cand({ id: 'c', kind: 'history', estimatedTokens: 10, relevance: 0.5, recency: 0.5, importance: 0.5, continuity: 0.5, originalOrder: 3 }),
  ],
  [
    // dedupeKey：保留排序最靠前者
    cand({ id: 'dup-low', kind: 'memory', estimatedTokens: 10, relevance: 0.1, importance: 0.1, originalOrder: 1, dedupeKey: 'k' }),
    cand({ id: 'dup-high', kind: 'memory', estimatedTokens: 10, relevance: 1, importance: 1, originalOrder: 2, dedupeKey: 'k' }),
    cand({ id: 'no-key', kind: 'memory', estimatedTokens: 10, relevance: 0.5, importance: 0.5, originalOrder: 3 }),
  ],
  [],
]

const ALLOCATION_CASES: Array<{
  groupIndex: number
  group: ContextCandidate[]
  options: { budgetTokens: number; reservedTokens?: number }
}> = [
  { groupIndex: 0, group: CANDIDATE_CASES, options: { budgetTokens: 1000 } },
  { groupIndex: 0, group: CANDIDATE_CASES, options: { budgetTokens: 200 } },
  { groupIndex: 0, group: CANDIDATE_CASES, options: { budgetTokens: 200, reservedTokens: 150 } },
  { groupIndex: 0, group: CANDIDATE_CASES, options: { budgetTokens: 50 } },
  { groupIndex: 0, group: CANDIDATE_CASES, options: { budgetTokens: 0 } },
  { groupIndex: 0, group: CANDIDATE_CASES, options: { budgetTokens: -10, reservedTokens: -5 } },
  { groupIndex: 1, group: CANDIDATE_GROUPS[1], options: { budgetTokens: 25 } },
  { groupIndex: 2, group: CANDIDATE_GROUPS[2], options: { budgetTokens: 100 } },
  { groupIndex: 3, group: [], options: { budgetTokens: 100 } },
]

// ---------------------------------------------------------------- 世界书候选与影子报告

/** 构造运行时条目快照（只填被测字段）。 */
function snap(partial: {
  key: string
  score?: number
  priority?: 'always' | 'conditional' | 'detail'
  position?: 'before_char' | 'after_char' | 'at_depth' | 'at_end'
  depth?: number
  order?: number
  tokens?: number
  kept?: boolean
  usedSummary?: boolean
  ignoreBudget?: boolean
}) {
  return {
    priority: 'conditional' as const,
    position: 'at_end' as const,
    order: 0,
    tokens: 0,
    kept: false,
    ...partial,
  }
}

const WORLDBOOK_SCORE_CASES = [0.5, 0, -1, 1, 1.5, 0.999999, Number.POSITIVE_INFINITY, Number.NaN]

const WORLDBOOK_ORIGIN_CASES = [
  snap({ key: 'k1', position: 'before_char' }),
  snap({ key: 'k2', position: 'after_char' }),
  snap({ key: 'k3', position: 'at_depth', depth: 3 }),
  snap({ key: 'k4', position: 'at_depth' }),
  snap({ key: 'k5', position: 'at_end' }),
]

const WORLDBOOK_SET_CASES = [
  [
    snap({ key: 'a', priority: 'always', position: 'before_char', order: 2, tokens: 100, score: 0.9 }),
    snap({ key: 'b', priority: 'conditional', position: 'after_char', order: 1, tokens: 50, score: 0.4 }),
    snap({ key: 'c', priority: 'detail', position: 'at_depth', depth: 1, order: 1, tokens: 30, score: 0.7 }),
    // 同 order：按 key 升序
    snap({ key: 'aa', priority: 'detail', position: 'at_end', order: 1, tokens: 20 }),
  ],
  [
    // tokens 为 0 且非 ignoreBudget：跳过；ignoreBudget 时保留
    snap({ key: 'zero', tokens: 0 }),
    snap({ key: 'zero-ignore', tokens: 0, ignoreBudget: true }),
    snap({ key: 'negative', tokens: -5 }),
    snap({ key: 'fraction', tokens: 10.9 }),
    // 极大但有限：快照字段会原样进 fixture，非有限值（Infinity/NaN）会被 JSON 写成 null，
    // 导致重新生成后自相矛盾，因此这里用 1e9 覆盖「大值向下取整」路径。
    snap({ key: 'huge', tokens: 1e9 }),
  ],
  [],
  [snap({ key: '', tokens: 10 })],
  [
    // priority 缺省 -> conditional
    snap({ key: 'no-priority', tokens: 15, score: 0.3 }),
  ],
]

const WORLDBOOK_INJECTION_CASES = [
  {
    legacyCapTokens: 300,
    snapshots: [
      snap({ key: 'a', priority: 'always', tokens: 100, kept: true }),
      snap({ key: 'b', priority: 'conditional', tokens: 50, kept: true, usedSummary: true }),
      snap({ key: 'c', priority: 'detail', tokens: 30, kept: false }),
      snap({ key: 'd', priority: 'always', tokens: 80, kept: false }),
      snap({ key: 'e', tokens: 20, kept: true }),
    ],
  },
  { legacyCapTokens: -50, snapshots: [snap({ key: 'x', tokens: -1, kept: true })] },
  { legacyCapTokens: 0, snapshots: [] },
  { legacyCapTokens: 120.9, snapshots: [snap({ key: 'f', tokens: 10.9, kept: true })] },
]

const WORLDBOOK_SHADOW_CASES: Array<{
  snapshots: ReturnType<typeof snap>[]
  legacyCapTokens: number
  budgetTokens: number
  competitors?: ContextCandidate[]
}> = [
  {
    legacyCapTokens: 100,
    budgetTokens: 500,
    snapshots: [
      snap({ key: 'a', priority: 'always', position: 'before_char', tokens: 100, score: 0.9, kept: true }),
      snap({ key: 'b', priority: 'conditional', position: 'before_char', tokens: 150, score: 0.6, kept: true }),
      snap({ key: 'c', priority: 'detail', position: 'at_depth', depth: 2, tokens: 300, score: 0.2, kept: false }),
    ],
  },
  {
    // 预算很紧：detail 被挤掉，always 靠 mandatory 保留
    legacyCapTokens: 100,
    budgetTokens: 120,
    snapshots: [
      snap({ key: 'a', priority: 'always', position: 'before_char', tokens: 100, score: 0.9, kept: true }),
      snap({ key: 'b', priority: 'conditional', position: 'before_char', tokens: 150, score: 0.6, kept: true }),
    ],
  },
  {
    // always 单独即超预算 -> mandatoryOverBudget
    legacyCapTokens: 50,
    budgetTokens: 40,
    snapshots: [snap({ key: 'a', priority: 'always', tokens: 100, kept: true })],
  },
  {
    // 有竞争对手：统一池里世界书被挤出
    legacyCapTokens: 200,
    budgetTokens: 150,
    snapshots: [
      snap({ key: 'a', priority: 'conditional', tokens: 100, score: 0.9, kept: true }),
      snap({ key: 'b', priority: 'detail', tokens: 100, score: 0.3, kept: false }),
    ],
    competitors: [
      cand({ id: 'character:core', kind: 'character', estimatedTokens: 100, mandatory: true, importance: 1, originalOrder: 0 }),
      cand({ id: 'history:recent', kind: 'history', estimatedTokens: 40, recency: 0.9, relevance: 0.9, importance: 0.5, continuity: 0.9, originalOrder: 1 }),
    ],
  },
  { legacyCapTokens: 0, budgetTokens: 0, snapshots: [] },
]

// ---------------------------------------------------------------- 回复篇幅策略

const RESPONSE_VISIBLE_CHAR_CASES = [
  '普通正文',
  '',
  '带 <thought>内心想法不应该计入</thought> 正文',
  '<thought>a</thought><thought>b</thought>',
  '含 空格\t与\n换行',
  '**加粗** 与 “引号”',
  '<THOUGHT>大写标签</THOUGHT>正文',
  '未闭合 <thought>abc',
  '全角　空格',
]

const RESPONSE_MEDIAN_CASES: number[][] = [
  [],
  [5],
  [1, 2],
  [1, 2, 3],
  [3, 1, 2],
  [1, 2, 3, 4],
  [10, 20, 31],
  [Number.NaN, 5, 7],
  [Number.POSITIVE_INFINITY],
  [0, 0],
]

const RESPONSE_COLLECT_CASES: Array<{
  messages: Array<{ role: string; content?: string | null }>
  window?: number
}> = [
  {
    messages: [
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '答案一' },
      { role: 'user', content: '追问' },
      { role: 'assistant', content: '答案二更长一些' },
    ],
  },
  { messages: [], window: 3 },
  { messages: [{ role: 'assistant', content: null }], window: 3 },
  {
    messages: [
      { role: 'assistant', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'assistant', content: 'c' },
      { role: 'assistant', content: 'd' },
      { role: 'assistant', content: 'e' },
      { role: 'assistant', content: 'f' },
    ],
    window: 3,
  },
]

const RESPONSE_INTENT_CASES: Array<string | null> = [
  '简短回答我',
  '简洁点',
  '精简一下',
  '言简意赅',
  '长话短说',
  '简单说说',
  '简单一点讲',
  '请回答一句',
  '回答一句话',
  '用一句话概括',
  '1句话说明',
  '短一点说',
  '少一些写',
  '别写太长',
  '不要太长',
  '无需太多',
  '详细说说',
  '写得详细一点',
  '再详细一些',
  '展开一点',
  '扩写一下',
  '具体说说',
  '多写一点',
  '描写细致一点',
  '写长一点',
  // 不应触发：普通叙述
  '这本书写得很详细',
  '我要详细的资料',
  '今天天气不错',
  '',
  null,
  '   ',
  // 同时命中两组：brief 优先
  '简短一点，但详细说说场景',
]

const RESPONSE_SCENE_CASES: Array<{ latestUserText: string | null; hasAssistantReply: boolean }> = [
  { latestUserText: '【场景】新的城市', hasAssistantReply: true },
  { latestUserText: '场景切换了', hasAssistantReply: true },
  { latestUserText: '转场到教室', hasAssistantReply: true },
  { latestUserText: '换个地方吧', hasAssistantReply: true },
  { latestUserText: '你好', hasAssistantReply: false },
  { latestUserText: '你好', hasAssistantReply: true },
  { latestUserText: '在吗？', hasAssistantReply: true },
  { latestUserText: '这是一个超过十二个字符的长问句吗？', hasAssistantReply: true },
  { latestUserText: '  问 ？', hasAssistantReply: true },
  { latestUserText: '', hasAssistantReply: true },
  { latestUserText: null, hasAssistantReply: true },
  // 场景切换优先于首轮判断
  { latestUserText: '【地点】码头', hasAssistantReply: false },
]

/**
 * 篇幅模式测试输入：刻意包含非法值（`'invalid'` / `'nonsense'`）来覆盖「无效值回退下一优先级」，
 * 因此类型上放宽为 `string` 并显式断言，避免为了通过类型检查而删掉这些用例。
 */
type LengthModeInput = Parameters<typeof resolveResponseLengthMode>[0]
const asModeInput = (c: {
  sessionMode?: string | null
  presetHint?: string | null
  defaultMode?: string | null
  userIntent?: string | null
}): LengthModeInput => c as unknown as LengthModeInput

const RESPONSE_MODE_CASES: Array<{
  sessionMode?: string | null
  presetHint?: string | null
  defaultMode?: string | null
  userIntent?: string | null
}> = [
  {},
  { userIntent: 'brief' },
  { userIntent: 'auto', sessionMode: 'detailed' },
  { userIntent: 'invalid', sessionMode: 'brief' },
  { sessionMode: 'auto', presetHint: 'detailed' },
  { presetHint: 'balanced' },
  { defaultMode: 'brief' },
  { sessionMode: 'nonsense' },
  { sessionMode: 'detailed', presetHint: 'brief', defaultMode: 'balanced' },
  { userIntent: null, sessionMode: null, presetHint: null, defaultMode: null },
]

const RESPONSE_POLICY_CASES: Array<{
  sessionMode?: string | null
  presetHint?: string | null
  defaultMode?: string | null
  userIntent?: string | null
  recentAssistantVisibleChars?: number[]
  sceneFactor?: number
}> = [
  { sessionMode: 'brief' },
  { sessionMode: 'balanced' },
  { sessionMode: 'detailed' },
  { presetHint: 'brief' },
  { defaultMode: 'detailed' },
  { userIntent: 'brief', sessionMode: 'detailed' },
  // auto 分支
  { sessionMode: 'auto' },
  { sessionMode: 'auto', recentAssistantVisibleChars: [100, 200, 300] },
  { sessionMode: 'auto', recentAssistantVisibleChars: [100, 200], sceneFactor: 1.25 },
  { sessionMode: 'auto', recentAssistantVisibleChars: [100, 200], sceneFactor: 0.85 },
  { sessionMode: 'auto', sceneFactor: 0.1 },
  { sessionMode: 'auto', sceneFactor: 5 },
  { sessionMode: 'auto', sceneFactor: Number.NaN },
  { sessionMode: 'auto', recentAssistantVisibleChars: [0] },
  { sessionMode: 'auto', recentAssistantVisibleChars: [10000] },
  { sessionMode: 'auto', recentAssistantVisibleChars: [500, 500, 500], sceneFactor: 2 },
]

// ---------------------------------------------------------------- 生成终止与域错误

const OBSERVATION_CASES: Array<{
  outcome: 'completed' | 'truncated' | 'user_cancelled' | 'error'
  finishReason: AIFinishReason
  errorKind?: string
  cancelReason?: 'user' | 'timeout' | 'stop_string'
}> = [
  { outcome: 'completed', finishReason: 'stop' },
  { outcome: 'completed', finishReason: 'length' },
  { outcome: 'completed', finishReason: 'content_filter' },
  { outcome: 'completed', finishReason: 'tool_calls' },
  { outcome: 'completed', finishReason: 'cancelled' },
  { outcome: 'completed', finishReason: 'network_error' },
  { outcome: 'completed', finishReason: 'unknown' },
  { outcome: 'truncated', finishReason: 'stop' },
  { outcome: 'user_cancelled', finishReason: 'cancelled' },
  { outcome: 'user_cancelled', finishReason: 'cancelled', cancelReason: 'timeout' },
  { outcome: 'user_cancelled', finishReason: 'cancelled', cancelReason: 'stop_string' },
  { outcome: 'error', finishReason: 'stop', errorKind: 'aborted' },
  { outcome: 'error', finishReason: 'stop', errorKind: 'aborted', cancelReason: 'timeout' },
  { outcome: 'error', finishReason: 'stop', errorKind: 'timeout' },
  { outcome: 'error', finishReason: 'stop', errorKind: 'network' },
  { outcome: 'error', finishReason: 'stop', errorKind: 'content_filter' },
  { outcome: 'error', finishReason: 'stop', errorKind: 'reasoning_budget_exhausted' },
  { outcome: 'error', finishReason: 'stop', errorKind: 'length_limit' },
  { outcome: 'error', finishReason: 'content_filter', errorKind: 'other' },
  { outcome: 'error', finishReason: 'network_error', errorKind: 'other' },
]

const FINISH_REASONS: Array<AIFinishReason | undefined> = [
  'stop',
  'length',
  'content_filter',
  'tool_calls',
  'cancelled',
  'network_error',
  'unknown',
  undefined,
]

const EFFECTIVE_CAUSE_CASES: Array<{ cause: GenerationTerminationCause; providerFinishReason: AIFinishReason }> = [
  { cause: 'transport_error', providerFinishReason: 'stop' },
  { cause: 'idle_timeout', providerFinishReason: 'stop' },
  { cause: 'protocol_error', providerFinishReason: 'stop' },
  { cause: 'provider_stop', providerFinishReason: 'length' },
  { cause: 'provider_length', providerFinishReason: 'stop' },
  { cause: 'reasoning_gate_exceeded', providerFinishReason: 'stop' },
  { cause: 'provider_content_filter', providerFinishReason: 'stop' },
  { cause: 'provider_tool_calls', providerFinishReason: 'stop' },
  { cause: 'user_cancel', providerFinishReason: 'stop' },
  { cause: 'unknown', providerFinishReason: 'tool_calls' },
]

const TERMINATION_CAUSES: GenerationTerminationCause[] = [
  'provider_stop',
  'provider_length',
  'provider_content_filter',
  'provider_tool_calls',
  'user_cancel',
  'transport_error',
  'idle_timeout',
  'protocol_error',
  'reasoning_gate_exceeded',
  'unknown',
]

const LATCH_CASES: Array<{
  requestId: string
  actions: Array<{ op: 'claim' | 'markPersisted' | 'accepts'; cause?: string }>
}> = [
  { requestId: 'r1', actions: [{ op: 'accepts' }, { op: 'claim', cause: 'provider_stop' }, { op: 'accepts' }, { op: 'markPersisted' }, { op: 'markPersisted' }, { op: 'accepts' }] },
  { requestId: 'r2', actions: [{ op: 'claim', cause: 'user_cancel' }, { op: 'markPersisted' }, { op: 'claim', cause: 'provider_stop' }] },
  { requestId: 'r3', actions: [{ op: 'claim', cause: 'transport_error' }, { op: 'claim', cause: 'provider_stop' }, { op: 'markPersisted' }] },
  { requestId: 'r4', actions: [{ op: 'markPersisted' }, { op: 'claim', cause: 'provider_stop' }] },
  { requestId: 'r5', actions: [{ op: 'claim', cause: 'user_cancel' }, { op: 'claim', cause: 'idle_timeout' }, { op: 'accepts' }] },
  { requestId: 'r6', actions: [] },
  { requestId: 'r7', actions: [{ op: 'claim', cause: 'protocol_error' }, { op: 'accepts' }, { op: 'markPersisted' }, { op: 'claim', cause: 'user_cancel' }] },
]

/** 域错误码全表（`errors.ts` 的联合类型成员，测试侧显式列出以便逐码断言）。 */
const DOMAIN_ERROR_CODES: DomainErrorCode[] = [
  'INVALID_COMMAND',
  'UNAUTHORIZED',
  'VERSION_INCOMPATIBLE',
  'SESSION_NOT_FOUND',
  'CHARACTER_NOT_FOUND',
  'TASK_CONFLICT',
  'TASK_NOT_FOUND',
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'CONTEXT_TOO_LARGE',
  'INVALID_MODEL_RESPONSE',
  'TOOL_PERMISSION_DENIED',
  'TOOL_FAILED',
  'PERSISTENCE_FAILED',
  'TASK_INTERRUPTED',
  'UNKNOWN',
]

const SANITIZE_CASES = [
  'plain error message',
  'sk-abcdefghijklmnopqrstuvwxyz123456',
  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'failed at C:\\Users\\Administrator\\AppData\\Local\\qingyu\\config.json while saving',
  'open /home/user/data/session.json failed',
  'no secrets here /tmp/plain.txt',
  'a'.repeat(600),
  '',
]

// ---------------------------------------------------------------- 长记忆事实与排名

const FACT_NOW = 1_700_000_000_000

/** facts 里常用的结构化事实。 */
const factA: MemoryFact = {
  id: 'f1', subject: '苏晚', predicate: '职业', value: '书店店主',
  status: 'active', importance: 4, confidence: 0.9,
  sourceMessageIds: ['m1'], updatedAt: FACT_NOW - 1000,
}
const factB: MemoryFact = {
  id: 'f2', subject: '苏晚', predicate: '喜好', value: '喜欢旧书',
  status: 'active', importance: 2, confidence: 0.6,
  sourceMessageIds: [], updatedAt: FACT_NOW - 86_400_000,
}
const factInactive: MemoryFact = { ...factA, id: 'f3', value: '已废弃', status: 'inactive' }
const factScoped: MemoryFact = { ...factA, id: 'f4', scope: 'session', entityId: 'e1' }

const FACT_PARSE_TEXTS: string[] = [
  '【摘要】她开了家书店\n【事实】\n1. 苏晚的职业：书店店主\n2. 苏晚的喜好：旧书',
  '【当前状态】深夜书店，灯还亮着\n【时间线】她刚送走最后一位客人\n【事实】\n- 苏晚的职业：书店店主',
  '【当前状态】状态文本\n【摘要】摘要文本\n【事实】\n３、全角编号事实',
  '【事实】\n* 星号事实\n(1) 括号编号',
  '只有自由文本，没有任何标记',
  '<thought>思考不应出现</thought>【摘要】剥离思考后的摘要',
  '【摘要】带事实变更\n【事实变更】\n```json\n[{"action":"add","fact":{"subject":"苏晚","predicate":"职业","value":"店主"}}]\n```',
  '【摘要】变更格式错误\n【事实变更】not json',
  '【摘要】提案\n【事实提案】[{"changeType":"set","subject":"苏晚","predicate":"心情","value":"平静"},{"changeType":"bad"}]',
  '【事实提案】[{"changeType":"bad"}]',
  '',
  '   ',
]

const FACT_APPLY_CASES: Array<{
  previousFacts: MemoryFactRecord[]
  previousHistory?: MemoryFact[]
  changes?: MemoryFactChange[]
  proposals?: FactProposal[]
  sourceMessageId: string
  updatedAt: number
}> = [
  // 旧文本事实迁移为结构化事实
  { previousFacts: ['苏晚的职业：书店店主'], sourceMessageId: 'm1', updatedAt: FACT_NOW },
  // add 覆盖同键旧事实（旧事实进 history 且标 superseded）
  {
    previousFacts: [factA],
    changes: [{ action: 'add', fact: { subject: '苏晚', predicate: '职业', value: '咖啡店主' } }],
    sourceMessageId: 'm2',
    updatedAt: FACT_NOW,
  },
  // update 修改 value：旧值归档为 superseded
  {
    previousFacts: [factA],
    changes: [{ action: 'update', id: 'f1', patch: { value: '图书馆员', importance: 5 } }],
    sourceMessageId: 'm3',
    updatedAt: FACT_NOW,
  },
  // update 只改 importance：不产生归档
  {
    previousFacts: [factA],
    changes: [{ action: 'update', id: 'f1', patch: { importance: 2 } }],
    sourceMessageId: 'm4',
    updatedAt: FACT_NOW,
  },
  // deactivate
  {
    previousFacts: [factA, factB],
    changes: [{ action: 'deactivate', id: 'f1' }],
    sourceMessageId: 'm5',
    updatedAt: FACT_NOW,
  },
  // 未知 ID 忽略
  {
    previousFacts: [factA],
    changes: [{ action: 'deactivate', id: 'missing' }],
    sourceMessageId: 'm6',
    updatedAt: FACT_NOW,
  },
  // inactive 旧事实不参与 active 集合，但保留在 history 输入中
  {
    previousFacts: [factA, factInactive],
    previousHistory: [factB],
    changes: [],
    sourceMessageId: 'm7',
    updatedAt: FACT_NOW,
  },
  // 提案 set 命中同键事实 → 走 update
  {
    previousFacts: [factA],
    proposals: [{ changeType: 'set', subject: '苏晚', predicate: '职业', value: '花店主' }],
    sourceMessageId: 'm8',
    updatedAt: FACT_NOW,
  },
  // 提案 set 未命中 → 新增；clear 命中 → 停用
  {
    previousFacts: [factA, factB],
    proposals: [
      { changeType: 'set', subject: '苏晚', predicate: '心情', value: '平静' },
      { changeType: 'clear', subject: '苏晚', predicate: '喜好', value: '' },
    ],
    sourceMessageId: 'm9',
    updatedAt: FACT_NOW,
  },
  // 提案 clear 未命中 → 无操作
  {
    previousFacts: [factA],
    proposals: [{ changeType: 'clear', subject: '他人', predicate: '未知', value: '' }],
    sourceMessageId: 'm10',
    updatedAt: FACT_NOW,
  },
  // 不同 scope 的提案不得越权修改
  {
    previousFacts: [factScoped],
    proposals: [{ changeType: 'clear', subject: '苏晚', predicate: '职业', value: '' }],
    sourceMessageId: 'm11',
    updatedAt: FACT_NOW,
  },
  // 事实数超上限 → 按 importance/confidence/updatedAt 保留
  {
    previousFacts: Array.from({ length: MAX_MEMORY_FACTS + 5 }, (_, i) => ({
      id: `bulk-${i}`,
      subject: `主体${i}`,
      predicate: '属性',
      value: `值${i}`,
      status: 'active' as const,
      importance: ((i % 5) + 1) as MemoryFact['importance'],
      confidence: 0.5,
      sourceMessageIds: [],
      updatedAt: FACT_NOW - i,
    })),
    sourceMessageId: 'm12',
    updatedAt: FACT_NOW,
  },
]

const FACT_RECENCY_CASES: Array<{ updatedAt?: number; now: number }> = [
  { updatedAt: FACT_NOW, now: FACT_NOW },
  { updatedAt: FACT_NOW - 86_400_000, now: FACT_NOW },
  { updatedAt: FACT_NOW - 30 * 86_400_000, now: FACT_NOW },
  { updatedAt: FACT_NOW + 1000, now: FACT_NOW },
  { updatedAt: 0, now: FACT_NOW },
  { updatedAt: undefined, now: FACT_NOW },
]

const FACT_RANK_CASES: Array<{
  facts: MemoryFactRecord[]
  semanticScores?: number[]
  now: number
}> = [
  { facts: [factA, factB], now: FACT_NOW },
  { facts: [factA, factB], semanticScores: [0.9, 0.1], now: FACT_NOW },
  { facts: [factA, factB], semanticScores: [0, 0], now: FACT_NOW },
  { facts: [factA, factB], semanticScores: [0.5], now: FACT_NOW },
  { facts: ['苏晚的职业：书店店主', factA], semanticScores: [0.8, 0.4], now: FACT_NOW },
  { facts: [], semanticScores: undefined, now: FACT_NOW },
]

const FACT_BUDGET_SELECT_CASES: Array<{
  facts: MemoryFactRecord[]
  semanticScores?: number[]
  budget: number
  now: number
}> = [
  { facts: [factA, factB], budget: 1000, now: FACT_NOW },
  { facts: [factA, factB], budget: 10, now: FACT_NOW },
  { facts: [factA, factB], budget: 0, now: FACT_NOW },
  { facts: [factA, factInactive, factB], budget: 1000, now: FACT_NOW },
]

const FACT_LAYERED_CASES: Array<{
  currentState?: string
  timeline: string
  facts: MemoryFactRecord[]
  budget: number
  semanticScores?: number[]
  now: number
}> = [
  {
    currentState: '深夜的旧书店，灯还亮着',
    timeline: '她送走了最后一位客人，然后开始整理书架。'.repeat(3),
    // 刻意使用**无 updatedAt 的事实**（旧文本事实）：`fitLayeredMemoryBudget` 内部用
    // `Date.now()` 计算 recency，PC 与 Android 时钟不同必然不等；无 updatedAt 时
    // recency 恒为 0.5，跨语言可比。recency 本身由显式 now 的 recency/rank 用例锁定。
    facts: ['苏晚的职业：书店店主', '苏晚的喜好：旧书'],
    budget: 500,
    now: FACT_NOW,
  },
  { timeline: '没有当前状态的旧会话摘要。'.repeat(2), facts: ['旧事实一'], budget: 200, now: FACT_NOW },
  { currentState: '很短', timeline: '时间线', facts: [], budget: 60, now: FACT_NOW },
  { currentState: '', timeline: '时间线文本', facts: ['无状态的旧事实'], budget: 300, semanticScores: [0.7], now: FACT_NOW },
  { timeline: '', facts: [], budget: 100, now: FACT_NOW },
]

const FACT_FORMAT_CASES: MemoryFactRecord[][] = [
  [factA, factB],
  ['旧文本事实', factA],
  [factInactive],
  [],
]

// ---------------------------------------------------------------- 叙事模式 / thought / instruct 模板

/** 叙事模式实参的可往返编码：undefined 与 null 行为相同，但语义不同，故显式区分。 */
const modeArg = (value: string | null | undefined): unknown =>
  value === undefined ? { kind: 'undefined' } : value === null ? { kind: 'null' } : { kind: 'string', value }
const NARRATIVE_IS_MODE_CASES: Array<string | null | undefined> = [
  'immersive',
  'omniscient',
  'unknown',
  '',
  null,
  undefined,
]

const NARRATIVE_RESOLVE_CASES: Array<Array<string | null | undefined>> = [
  [],
  ['omniscient'],
  ['immersive'],
  ['bad', 'omniscient'],
  [null, undefined, 'immersive'],
  ['bad'],
]

const NARRATIVE_PROMPT_CASES: Array<{
  mode: NarrativeMode
  userName: string
  characterName: string
  omniscientRules?: string
}> = [
  { mode: 'immersive', userName: '旅人', characterName: '苏晚' },
  // 未提供自定义规则 → 使用内置模板并替换 {{char}}/{{user}}
  { mode: 'omniscient', userName: '旅人', characterName: '苏晚' },
  // 自定义规则含变量
  { mode: 'omniscient', userName: '旅人', characterName: '苏晚', omniscientRules: '只叙述 {{char}} 所见，面向 {{user}}。' },
  // 自定义规则不含变量
  { mode: 'omniscient', userName: '旅人', characterName: '苏晚', omniscientRules: '纯第三人称。' },
  // 空白规则 → 回退内置
  { mode: 'omniscient', userName: '旅人', characterName: '苏晚', omniscientRules: '   ' },
  { mode: 'omniscient', userName: '', characterName: '' },
]

const CONTRACT_BODY_CASES: Array<{ narrativeMode: NarrativeMode; subjectName?: string }> = [
  { narrativeMode: 'immersive' },
  { narrativeMode: 'immersive', subjectName: '苏晚' },
  { narrativeMode: 'omniscient' },
  { narrativeMode: 'omniscient', subjectName: '苏晚' },
  { narrativeMode: 'omniscient', subjectName: '' },
]

const TEMPLATE_NAME_CASES: Array<string | null | undefined> = [
  'chatml',
  'CHATML',
  '  qwen  ',
  'llama3',
  'command-r',
  'gemma',
  'unknown',
  '',
  null,
  undefined,
]

const TEMPLATE_INFER_CASES: Array<{ provider: string; model: string }> = [
  { provider: 'ollama', model: 'qwen2.5:7b' },
  { provider: 'ollama', model: 'deepseek-r1' },
  { provider: 'ollama', model: 'llama3.1' },
  { provider: 'ollama', model: 'llama2:13b' },
  { provider: 'ollama', model: 'mistral' },
  { provider: 'ollama', model: 'phi3' },
  { provider: 'ollama', model: 'gemma2' },
  { provider: 'ollama', model: 'command-r-plus' },
  { provider: 'ollama', model: 'totally-unknown-model' },
  { provider: 'openai', model: 'gpt-4o-mini' },
  // PC 只识别 provider 字面量 claude / gemini；anthropic 与 openai 同为空默认
  { provider: 'claude', model: 'claude-3-5-sonnet' },
  { provider: 'gemini', model: 'gemini-1.5-pro' },
  { provider: 'anthropic', model: 'claude-3-5-sonnet' },
]

const TEMPLATE_EFFECTIVE_CASES: Array<{
  contextTemplate?: string
  provider: string
  model: string
  useInstructTemplate?: boolean
}> = [
  { contextTemplate: 'chatml', provider: 'openai', model: 'gpt-4o-mini' },
  { contextTemplate: 'unknown', provider: 'ollama', model: 'llama3.1' },
  { provider: 'ollama', model: 'llama3.1', useInstructTemplate: true },
  { provider: 'ollama', model: 'llama3.1', useInstructTemplate: false },
  { provider: 'openai', model: 'gpt-4o-mini' },
]

const TEMPLATE_APPLY_CASES: Array<{
  templateName: string
  messages: Array<{ role: string; content: string }>
}> = [
  {
    templateName: 'chatml',
    messages: [
      { role: 'system', content: '你是苏晚。' },
      { role: 'user', content: '夜安' },
      { role: 'assistant', content: '夜安。' },
      { role: 'user', content: '还在营业吗' },
    ],
  },
  { templateName: 'llama2', messages: [{ role: 'user', content: '你好' }] },
  { templateName: 'alpaca', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }] },
  // 未知 role 必须被整段跳过（不落到任何分支）
  { templateName: 'chatml', messages: [{ role: 'tool', content: 'T' }, { role: 'user', content: 'U' }] },
  { templateName: 'chatml', messages: [] },
]

// ---------------------------------------------------------------- 记忆候选与注入

/** 超过时间线单块硬上限（180 token）的长行：用于验证按句再切。 */
const MEMC_LONG_LINE = ('他在旧书店里翻到一本没有书名的册子。' + '她把它推回原处。').repeat(30)
/** 超过时间线候选上限（48 块）的多行输入。 */
const MEMC_MANY_LINES = Array.from({ length: 60 }, (_, i) => `第${i + 1}件小事`).join('\n')

const MEMC_SPLIT_CASES: Array<string | null | undefined> = [
  null,
  '',
  '   ',
  '单行事件',
  '事件一\n事件二\n事件三',
  '  事件一  \n\n  事件二  ',
  '事件一\r\n事件二',
  MEMC_LONG_LINE,
  MEMC_MANY_LINES,
]

const MEMC_BUILD_CASES: Array<MemoryCandidateInput> = [
  { currentState: '深夜的旧书店，灯还亮着' },
  { timeline: '她送走了最后一位客人\n然后开始整理书架' },
  { currentState: '', timeline: '   ', facts: [] },
  // 事实一律用旧文本事实（无 updatedAt → recency 恒 0.5），保证跨语言可比
  { currentState: '状态', timeline: '事件一\n事件二', facts: ['苏晚的职业：书店店主', '苏晚的喜好：旧书'] },
  { facts: ['A的a：1', 'B的b：2'], semanticScores: [0.9, 0.1] },
  { facts: ['A的a：1', 'B的b：2'], semanticScores: [0, 0] },
  { facts: ['A的a：1', 'B的b：2'], semanticScores: [0.9] },
  { currentState: '状态', facts: ['没有冒号分隔的旧事实'] },
]

const MEMC_SELECT_CASES: Array<{
  build: MemoryCandidateInput
  budgetTokens: number
  competitors?: ContextCandidate[]
}> = [
  { build: MEMC_BUILD_CASES[4]!, budgetTokens: 1000 },
  { build: MEMC_BUILD_CASES[4]!, budgetTokens: 20 },
  { build: MEMC_BUILD_CASES[4]!, budgetTokens: 0 },
  {
    build: MEMC_BUILD_CASES[4]!,
    budgetTokens: 120,
    competitors: [
      cand({ id: 'character:core', kind: 'character', estimatedTokens: 100, mandatory: true, importance: 1, originalOrder: 0 }),
    ],
  },
  { build: MEMC_BUILD_CASES[2]!, budgetTokens: 100 },
]

const MEMC_SHADOW_CASES: Array<{
  build: MemoryCandidateInput
  existing: MemoryInjectionStats
  budgetTokens: number
  competitors?: ContextCandidate[]
}> = [
  {
    build: MEMC_BUILD_CASES[4]!,
    existing: {
      capTokens: 800,
      stateTokens: 0,
      factCount: 2,
      factTokens: 20,
      timelineChunkCount: 0,
      timelineTokens: 0,
      totalTokens: 20,
      retrievalMode: 'semantic',
    },
    budgetTokens: 500,
  },
  {
    build: MEMC_BUILD_CASES[5]!,
    existing: {
      capTokens: 400,
      stateTokens: 10,
      factCount: 1,
      factTokens: 6,
      timelineChunkCount: 2,
      timelineTokens: 30,
      totalTokens: 46,
      retrievalMode: 'fallback',
    },
    budgetTokens: 60,
  },
  {
    build: MEMC_BUILD_CASES[4]!,
    existing: {
      capTokens: 0,
      stateTokens: 0,
      factCount: 2,
      factTokens: 20,
      timelineChunkCount: 0,
      timelineTokens: 0,
      totalTokens: 20,
      retrievalMode: 'semantic',
    },
    budgetTokens: 200,
    competitors: [
      cand({ id: 'history:recent', kind: 'history', estimatedTokens: 60, recency: 0.9, relevance: 0.9, importance: 0.5, continuity: 0.9, originalOrder: 0 }),
    ],
  },
]

const MEMC_MATERIALIZE_CASES: Array<{
  build: MemoryCandidateInput
  selectedIds: (plan: MemoryCandidateSet) => string[]
}> = [
  { build: MEMC_BUILD_CASES[2]!, selectedIds: () => [] },
  { build: MEMC_BUILD_CASES[3]!, selectedIds: (plan) => plan.candidates.map((c) => c.id) },
  { build: MEMC_BUILD_CASES[3]!, selectedIds: () => ['memory:current-state'] },
  { build: MEMC_BUILD_CASES[1]!, selectedIds: (plan) => plan.candidates.slice(0, 1).map((c) => c.id) },
  { build: MEMC_BUILD_CASES[4]!, selectedIds: (plan) => plan.candidates.map((c) => c.id) },
  // 只选事实层：状态与时间线必须为空
  { build: MEMC_BUILD_CASES[3]!, selectedIds: (plan) => plan.candidates.filter((c) => c.id.startsWith('memory:fact:')).map((c) => c.id) },
]

// ---------------------------------------------------------------- 文本度量 / 收尾器 / 收尾管线

const METRICS_VISIBLE_CASES: string[] = [
  '',
  '普通正文',
  '含 空格\t与\n换行',
  '全角\u3000空格',          // JS \s 含 U+3000，JVM 默认 \s 不含 —— 显式集合必须一致
  '不换行\u00a0空格',        // JS \s 含 U+00A0
  '行分隔\u2028符',          // JS \s 含 U+2028
  'BOM\uFEFF残留',           // JS \s 含 U+FEFF
  'emoji😀计数',             // 代理对按 1 个码点计
  '👨‍👩‍👧‍👦 家庭组合',
  '   ',
]

const METRICS_SENTENCE_CASES: string[] = [
  '',
  '   ',
  '完整句。',
  '带引号收尾。”',
  '带括号收尾。）',
  '带空格收尾。   ',
  '英文收尾!',
  '问句？',
  '省略号…',
  '未完成，',
  '悬空动作*',
  '“引号里的话。”',
  'emoji 收尾😀',
  '逗号收尾，',
]

const METRICS_TRIM_CASES: Array<{ text: string; minChars: number; maxChars: number }> = [
  { text: '第一句。第二句。第三句。', minChars: 1, maxChars: 8 },
  { text: '第一句。第二句。第三句。', minChars: 10, maxChars: 8 },
  { text: '没有句末标点的文本', minChars: 1, maxChars: 100 },
  { text: '短。', minChars: 5, maxChars: 100 },
  { text: '刚好。', minChars: 1, maxChars: 2 },
  { text: '', minChars: 1, maxChars: 10 },
]

const METRICS_TAIL_CASES: Array<{ text: string; maxChars?: number }> = [
  { text: '' },
  { text: '短文本' },
  { text: '含 多个   空白\n与换行 的文本' },
  { text: '长文本'.repeat(30) },
  { text: '长文本'.repeat(30), maxChars: 10 },
  { text: 'emoji😀结尾' },
]

const METRICS_CLOSURE_CASES: string[] = [
  '',
  '正常文本。',
  '未闭合“引号',
  '未闭合（括号',
  '成对“引号”与（括号）',
  '奇数*星号',
  '偶数**星号**',
  '未闭合<thought>内容',
  '<thought>闭合了</thought>正文',
  '<thought>a</thought>未闭合<thought>b',
]

const FINALIZER_REPAIR_CONTEXT_CASES: string[] = [
  '',
  '只有一个段落。',
  '第一段。\n\n第二段。\n\n第三段。',
  '长段落'.repeat(200),
  '第一段。\n\n' + '很长'.repeat(400),
]

const FINALIZER_CASES: Array<{ rawText: string; finishReason: AIFinishReason }> = [
  { rawText: '', finishReason: 'stop' },
  { rawText: '   ', finishReason: 'stop' },
  { rawText: '完整回复。', finishReason: 'stop' },
  { rawText: '完整回复。', finishReason: 'length' },
  { rawText: '完整回复。', finishReason: 'network_error' },
  { rawText: '完整回复。', finishReason: 'content_filter' },
  // 半句 + length：回退到稳定句界
  { rawText: '第一句完整。第二句被截断在', finishReason: 'length' },
  // 稳定正文过短 → needs_tail_repair
  { rawText: '好。然后继续说了一大段没有结束的话', finishReason: 'length' },
  // 完全无稳定边界
  { rawText: '没有任何句末标点的一整段话', finishReason: 'length' },
  { rawText: '完全没有标点', finishReason: 'network_error' },
  // 未闭合 thought：回退到该块之前
  { rawText: '正文结束。<thought>未闭合的思考', finishReason: 'length' },
  { rawText: '<thought>只有思考', finishReason: 'length' },
  // 空 thought 标签与供应商哨兵
  { rawText: '<thought></thought>正文。', finishReason: 'stop' },
  { rawText: '正文。[TOOL_CALL: x]', finishReason: 'stop' },
  // 悬空尾部星号
  { rawText: '动作描写。*', finishReason: 'length' },
  { rawText: '第一段。\n\n第二段被截', finishReason: 'length' },
]

const FINALIZER_MERGE_CASES: Array<{
  rawText: string
  finishReason: AIFinishReason
  repairText: string
  mergeFinishReason?: AIFinishReason
}> = [
  { rawText: '稳定前缀。', finishReason: 'length', repairText: '', mergeFinishReason: 'stop' },
  { rawText: '稳定前缀。', finishReason: 'length', repairText: '补尾内容。', mergeFinishReason: 'stop' },
  // 重叠去重：补尾文本与前缀末尾重叠
  { rawText: '她说：“走吧。”', finishReason: 'length', repairText: '走吧。”那我们出发。', mergeFinishReason: 'stop' },
  // 补尾后仍不完整 → 回退稳定前缀
  { rawText: '稳定前缀。', finishReason: 'length', repairText: '仍然没有句末标点', mergeFinishReason: 'length' },
]

const PIPELINE_OUTPUT_RULES: RegexRule[] = [
  rule({ id: 'strip-tags', pattern: '<[^>]+>', replacement: '', flags: 'g' }),
  rule({ id: 'stop-x', pattern: '\\[STOP\\]', replacement: '', stopStrings: ['[STOP]'] }),
]

const PIPELINE_RUN_CASES: Array<{
  rawText: string
  finishReason: AIFinishReason
  regexRules: RegexRule[]
  repairText?: string | null
  allowEmptyTailPassthrough?: boolean
}> = [
  { rawText: '完整回复。', finishReason: 'stop', regexRules: [] },
  { rawText: '完整回复。', finishReason: 'length', regexRules: [] },
  // 正则先于收尾器：去标签后再做完整性检查
  { rawText: '带<em>标签</em>的完整回复。', finishReason: 'stop', regexRules: PIPELINE_OUTPUT_RULES },
  // 停止字符串截断
  { rawText: '前半句。[STOP]这部分应被截掉。', finishReason: 'stop', regexRules: PIPELINE_OUTPUT_RULES },
  { rawText: '半句被截断在', finishReason: 'length', regexRules: [], repairText: '补尾结果。' },
  { rawText: '半句被截断在', finishReason: 'length', regexRules: [], repairText: null },
  { rawText: '半句被截断在', finishReason: 'length', regexRules: [], repairText: '' },
  // 无稳定边界 + allowEmptyTailPassthrough
  { rawText: '没有任何标点', finishReason: 'stop', regexRules: [], allowEmptyTailPassthrough: true },
  { rawText: '没有任何标点', finishReason: 'stop', regexRules: [], allowEmptyTailPassthrough: false },
  { rawText: '', finishReason: 'stop', regexRules: [] },
  { rawText: '[STOP]只剩停止串', finishReason: 'stop', regexRules: PIPELINE_OUTPUT_RULES },
]

const PIPELINE_TERMINAL_CASES: Array<{
  rawText: string
  finishReason: AIFinishReason
  terminationCause: GenerationTerminationCause
  errorMessage?: string
  regexRules: RegexRule[]
  repairText?: string | null
}> = [
  // 用户取消：保留已见正文、不补尾
  { rawText: '已看到的内容', finishReason: 'cancelled', terminationCause: 'user_cancel', regexRules: [] },
  { rawText: '   ', finishReason: 'cancelled', terminationCause: 'user_cancel', regexRules: [] },
  // 审核拦截：丢弃正文
  { rawText: '被拦截的正文', finishReason: 'content_filter', terminationCause: 'provider_content_filter', regexRules: [] },
  {
    rawText: '被拦截的正文',
    finishReason: 'content_filter',
    terminationCause: 'provider_content_filter',
    errorMessage: '供应商原文',
    regexRules: [],
  },
  // 传输中断：保留完整部分并给提示
  { rawText: '第一句完整。第二句被截', finishReason: 'network_error', terminationCause: 'transport_error', regexRules: [] },
  // 正常 stop：完整正文
  { rawText: '完整正文。', finishReason: 'stop', terminationCause: 'provider_stop', regexRules: [] },
  // stop 但无标点：allowEmptyTailPassthrough 生效
  { rawText: '没有标点的完整正文', finishReason: 'stop', terminationCause: 'provider_stop', regexRules: [] },
  // provider_length + 补尾成功
  { rawText: '半句被截断在', finishReason: 'length', terminationCause: 'provider_length', regexRules: [], repairText: '补尾结果。' },
  // provider_length + 补尾失败
  { rawText: '半句被截断在', finishReason: 'length', terminationCause: 'provider_length', regexRules: [], repairText: null },
  // 无可用正文
  { rawText: '', finishReason: 'network_error', terminationCause: 'transport_error', regexRules: [] },
  // 正则处理后无正文
  { rawText: '[STOP]', finishReason: 'stop', terminationCause: 'provider_stop', regexRules: PIPELINE_OUTPUT_RULES },
]

// ---------------------------------------------------------------- 预算链（档案 / 门控 / 任务预算）

/**
 * 生成任务的正文体量默认值（与 `generationTaskBudget.ts` 的私有 `TASK_BODY_DEFAULTS` 同源）。
 * PC 未导出该常量，故在测试侧显式列出：它本身就是契约的一部分（Kotlin 侧必须一致）。
 */
const TASK_BODY_DEFAULTS_FOR_FIXTURE: Record<string, number> = {
  main: 600,
  translation: 256,
  continuation: 180,
  tail_repair: 200,
  polish: 600,
  memory: 2500,
  compression: 600,
  title: 20,
  direction: 800,
  character_expand: 1800,
  character_field: 800,
  greeting: 900,
  preset_draft: 900,
  image_prompt: 1200,
  image_prompt_translation: 256,
  lorebook_keywords: 600,
  group_reply: 600,
  generic: 600,
}

const PROFILE_MODELS: string[] = [
  '',
  'gpt-4o-mini',
  'deepseek-v4',
  'deepseek-reasoner',
  'deepseek-r1',
  'claude-3-7-sonnet',
  'claude-3.7-sonnet',
  'claude-4-opus',
  'claude-3-5-haiku',
  'gemini-2.5-pro',
  'gemini-3-flash',
  'o1-preview',
  'gpt-5',
  'kimi-k2',
  'glm-4',
  'qwen2.5',
  'llama3.1',
  'unknown-model-xyz',
]

const PROFILE_RESOLVE_CASES: Array<{
  model: string
  userOverride?: ModelProfileUserOverride
  runtimeCorrection?: ModelCapabilityCorrection
}> = [
  { model: 'gpt-4o-mini' },
  { model: 'gpt-4o-mini', userOverride: { outputLimit: 4096 } },
  { model: 'gpt-4o-mini', userOverride: { contextLimit: 8000, outputLimit: 0 } },
  { model: 'gpt-4o-mini', userOverride: { outputLimit: 65536, contextLimit: 300000 } },
  { model: 'gpt-4o-mini', runtimeCorrection: { outputLimit: 1024, reason: 'output_limit', updatedAt: 1 } },
  { model: 'gpt-4o-mini', runtimeCorrection: { contextLimit: 4096, reason: 'context_limit', updatedAt: 2 } },
  {
    model: 'gpt-4o-mini',
    userOverride: { outputLimit: 8192, contextLimit: 200000 },
    runtimeCorrection: { outputLimit: 4096, reason: 'output_limit', updatedAt: 3 },
  },
  // 运行时纠正只能收紧：不得放大
  { model: 'deepseek-v4', runtimeCorrection: { outputLimit: 999999, contextLimit: 999999, reason: 'output_limit', updatedAt: 4 } },
]

const PERCENTILE_CASES: number[][] = [
  [],
  [5],
  [1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100],
  [-1, 5],
  [Number.NaN, 5, 7],
  [0, 0, 0],
]

const RESERVE_CASES: Array<{ model: string; recentReasoningTokens?: number[] }> = [
  { model: 'gpt-4o-mini' },
  { model: 'gpt-4o-mini', recentReasoningTokens: [100, 200, 300] },
  { model: 'gpt-4o-mini', recentReasoningTokens: [0, 0, 0] },
  { model: 'gpt-4o-mini', recentReasoningTokens: [-5, -1] },
  { model: 'deepseek-v4', recentReasoningTokens: [1000, 2000, 3000] },
  { model: 'deepseek-v4', recentReasoningTokens: [999999] },
]

const HARD_CAP_CASES: Array<number | null | undefined> = [null, undefined, 0, -1, 100, 4096.7, Number.NaN]

const OVERRIDE_CASES: Array<{ enabled?: boolean; contextLimit?: number; outputLimit?: number }> = [
  { enabled: false, contextLimit: 1000 },
  { enabled: true },
  { enabled: true, contextLimit: 0 },
  { enabled: true, contextLimit: 8000 },
  { enabled: true, outputLimit: 4096 },
  { enabled: true, contextLimit: 8000, outputLimit: 4096 },
]

const CONTEXT_LIMIT_CASES: Array<{
  model: string
  profileMaxContext?: number
  presetMaxContext?: number
  capabilityOverride?: { enabled?: boolean; contextLimit?: number; outputLimit?: number } | null
}> = [
  { model: 'gpt-4o-mini' },
  { model: 'gpt-4o-mini', profileMaxContext: 8000 },
  { model: 'gpt-4o-mini', profileMaxContext: 999999 },
  { model: 'gpt-4o-mini', presetMaxContext: 4000 },
  { model: 'gpt-4o-mini', capabilityOverride: { enabled: true, contextLimit: 64000 } },
  { model: 'gpt-4o-mini', capabilityOverride: { enabled: false, contextLimit: 64000 } },
  { model: 'unknown-model-xyz', profileMaxContext: 8000, presetMaxContext: 6000 },
]

const REQUEST_BUDGET_CASES: RequestBudgetInput[] = [
  { model: 'gpt-4o-mini', hardMaxChars: 600 },
  { model: 'gpt-4o-mini', hardMaxChars: 0 },
  { model: 'gpt-4o-mini', hardMaxChars: -5 },
  { model: 'gpt-4o-mini', hardMaxChars: 600, userHardCap: 4096 },
  { model: 'gpt-4o-mini', hardMaxChars: 600, userHardCap: 100 },
  { model: 'gpt-4o-mini', hardMaxChars: 600, recentReasoningTokens: [1000, 2000, 3000] },
  {
    model: 'gpt-4o-mini',
    hardMaxChars: 600,
    reasoningGate: { level: 'low', knob: 'thinking-budget', enforced: true, gateTokens: 1024, source: 'gate' },
  },
  {
    model: 'gpt-4o-mini',
    hardMaxChars: 600,
    recentReasoningTokens: [3000],
    reasoningGate: { level: 'low', knob: 'thinking-budget', enforced: false, gateTokens: 1024, source: 'conservative' },
  },
  {
    model: 'gpt-4o-mini',
    hardMaxChars: 600,
    reasoningGate: { level: 'off', knob: 'thinking-disable', enforced: true, gateTokens: 0, source: 'gate' },
  },
  { model: 'gpt-4o-mini', hardMaxChars: 600, profileOverride: { outputLimit: 3000 } },
  { model: 'deepseek-v4', hardMaxChars: 1100 },
]

const REASONING_LEVELS = ['off', 'low', 'standard', 'full'] as const

const GATE_RESOLVE_CASES: ReasoningGateResolveInput[] = [
  { model: 'gpt-4o-mini' },
  { model: 'deepseek-v4' },
  { model: 'deepseek-v4', auxiliary: true },
  { model: 'deepseek-v4', enabled: false },
  { model: 'deepseek-v4', requestedLevel: 'low' },
  { model: 'deepseek-v4', startLevel: 'off' },
  {
    model: 'deepseek-v4',
    probe: { knob: 'thinking-disable', knobAccepted: true, recentReasoningTokens: [], updatedAt: 1 },
  },
  {
    model: 'deepseek-v4',
    probe: { knob: 'thinking-disable', knobAccepted: false, recentReasoningTokens: [], updatedAt: 1 },
  },
  {
    model: 'deepseek-v4',
    probe: { knob: 'thinking-disable', disableIgnored: true, recentReasoningTokens: [], updatedAt: 1 },
  },
  { model: 'deepseek-v4', recentReasoningTokens: [2000, 4000] },
  { model: 'unknown-model-xyz', requestedLevel: 'full' },
]

const KNOB_CASES: Array<{ model: string; level: ReasoningGateLevel; probe?: GateProbe | null }> = [
  { model: 'deepseek-v4', level: 'standard' },
  { model: 'deepseek-v4', level: 'standard', probe: { knob: 'thinking-disable', knobAccepted: false, recentReasoningTokens: [], updatedAt: 1 } },
  { model: 'deepseek-v4', level: 'off', probe: { knob: 'thinking-disable', disableIgnored: true, recentReasoningTokens: [], updatedAt: 1 } },
  { model: 'deepseek-reasoner', level: 'off' },
  { model: 'unknown-model-xyz', level: 'low' },
]

const DEFAULT_LEVEL_CASES: Array<{ model: string; enabled: boolean; auxiliary?: boolean }> = [
  { model: 'gpt-4o-mini', enabled: true },
  { model: 'gpt-4o-mini', enabled: false },
  { model: 'gpt-4o-mini', enabled: true, auxiliary: true },
  { model: '', enabled: true },
]

const PROBE_MERGE_CASES: Array<{ current?: GateProbe | null; update: GateProbeUpdate }> = [
  { update: { knob: 'thinking-disable', updatedAt: 1 } },
  { current: { knob: 'unknown', recentReasoningTokens: [], updatedAt: 0 }, update: { knobAccepted: false, updatedAt: 2 } },
  {
    current: { knob: 'thinking-disable', knobAccepted: false, recentReasoningTokens: [100], updatedAt: 1 },
    update: { knobAccepted: true, updatedAt: 3 },
  },
  { current: { knob: 'none', recentReasoningTokens: [1, 2], updatedAt: 1 }, update: { reasoningTokens: 500, updatedAt: 4 } },
  { current: { knob: 'none', recentReasoningTokens: [1], updatedAt: 1 }, update: { reasoningTokens: -5, updatedAt: 5 } },
  { current: { knob: 'none', recentReasoningTokens: [1], updatedAt: 1 }, update: { reasoningTokens: Number.NaN, updatedAt: 6 } },
  {
    current: { knob: 'none', recentReasoningTokens: Array.from({ length: 40 }, (_, i) => i), updatedAt: 1 },
    update: { reasoningTokens: 999, updatedAt: 7 },
  },
]

const CLAMP_CASES: Array<{ gateTokens: number; requestMaxTokens: number }> = [
  { gateTokens: 1024, requestMaxTokens: 2000 },
  { gateTokens: 1024, requestMaxTokens: 300 },
  { gateTokens: 0, requestMaxTokens: 2000 },
  { gateTokens: -10, requestMaxTokens: 2000 },
  { gateTokens: Number.NaN, requestMaxTokens: 2000 },
  { gateTokens: 1024, requestMaxTokens: Number.NaN },
  { gateTokens: 5000, requestMaxTokens: 256 },
]

const BODY_CHARS_CASES: Array<{ task: GenerationTask; inputChars?: number; expectedBodyChars?: number }> = [
  { task: 'main' },
  { task: 'main', expectedBodyChars: 1234 },
  { task: 'main', expectedBodyChars: 0 },
  { task: 'translation', inputChars: 100 },
  { task: 'translation', inputChars: 1000 },
  { task: 'image_prompt_translation', inputChars: 0 },
  { task: 'polish', inputChars: 100 },
  { task: 'polish', inputChars: 1000 },
  { task: 'memory' },
  { task: 'title' },
  { task: 'generic', inputChars: -5 },
]

const EXPAND_CASES: Array<{
  currentMaxTokens: number
  budget: AdaptiveOutputBudget
  observedReasoningTokens?: number
}> = [
  { currentMaxTokens: 1000, budget: { ceilingTokens: 4096, bodyReserveTokens: 800 } },
  { currentMaxTokens: 1000, budget: { ceilingTokens: 4096, bodyReserveTokens: 800 }, observedReasoningTokens: 3000 },
  { currentMaxTokens: 4096, budget: { ceilingTokens: 4096, bodyReserveTokens: 800 } },
  { currentMaxTokens: 4000, budget: { ceilingTokens: 4096, bodyReserveTokens: 0 } },
  { currentMaxTokens: 0, budget: { ceilingTokens: 10, bodyReserveTokens: 0 } },
  { currentMaxTokens: 1000, budget: { ceilingTokens: 4096, bodyReserveTokens: 800 }, observedReasoningTokens: Number.NaN },
]

const TASK_BUDGET_CASES: GenerationTaskBudgetInput[] = [
  { task: 'main', model: 'gpt-4o-mini' },
  { task: 'main', model: 'deepseek-v4' },
  { task: 'main', model: 'deepseek-v4', userHardCap: 4096 },
  { task: 'memory', model: 'gpt-4o-mini' },
  { task: 'translation', model: 'gpt-4o-mini', inputChars: 500 },
  { task: 'title', model: 'gpt-4o-mini', reasoningLevel: 'off' },
  { task: 'main', model: 'gpt-4o-mini', recentReasoningTokens: [1000, 2000] },
  { task: 'main', model: 'deepseek-v4', reasoningLevel: 'low' },
]

// ---------------------------------------------------------------- 上下文主装配（无世界书子集）

/**
 * 构造工厂：显式写出**装配会读取的每个字段**，其余字段用类型断言补齐。
 * 之所以不用「尽量少写」的写法：遗漏字段会让 PC 侧读到 undefined、Kotlin 侧读到默认值，
 * 从而把「字段缺失」误判成「移植分歧」。
 */
function ctxCharacter(partial: Partial<Character> = {}): Character {
  return {
    id: 'c1',
    name: '苏晚',
    avatar: '',
    description: '',
    personality: '',
    scenario: '',
    firstMessage: '',
    exampleDialog: '',
    tags: [],
    lorebookId: null,
    creator: '',
    createdAt: 0,
    updatedAt: 0,
    alternateGreetings: [],
    ...partial,
  } as Character
}

function ctxPreset(partial: Partial<Preset> = {}): Preset {
  return {
    id: 'p1',
    name: '默认',
    description: '',
    systemPrompt: '',
    jailbreak: '',
    maxContext: 0,
    temperature: 0.8,
    topP: 0.95,
    maxTokens: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    isBuiltin: true,
    ...partial,
  } as Preset
}

function ctxSession(partial: Partial<SessionPreview> = {}): SessionPreview {
  return {
    id: 's1',
    characterId: 'c1',
    title: 'T',
    createdAt: 0,
    updatedAt: 0,
    memoryEnabled: false,
    memoryMode: 'manual',
    autoMemoryInterval: 10,
    memory: '',
    memoryUpdatedAt: 0,
    messageCount: 0,
    lastMessage: '',
    ...partial,
  } as SessionPreview
}

function ctxSettings(partial: Partial<Settings> = {}): Settings {
  return {
    userName: '旅人',
    activeModel: 'gpt-4o-mini',
    streamOutput: true,
    ...partial,
  } as Settings
}

function ctxMessage(partial: Partial<Message> & { role: Message['role']; content: string }): Message {
  return {
    id: `m-${partial.content.slice(0, 4)}-${partial.role}`,
    sessionId: 's1',
    characterId: 'c1',
    timestamp: 0,
    ...partial,
  } as Message
}

function ctxData(input: {
  messages: Message[]
  character?: Character
  preset?: Preset | null
  sessions?: SessionPreview[]
  currentSessionId?: string | null
  settings?: Settings
  profile?: ContextBuildData['settings']['profile']
  lorebooks?: Lorebook[]
  activeLorebookIds?: string[]
}): ContextBuildData {
  return {
    character: input.character ?? ctxCharacter(),
    preset: input.preset === undefined ? null : input.preset,
    chat: {
      messages: input.messages,
      sessions: input.sessions ?? [ctxSession()],
      currentSessionId: input.currentSessionId === undefined ? 's1' : input.currentSessionId,
      activeLorebookIds: input.activeLorebookIds ?? [],
      semanticFactsHits: [],
      semanticLoreHits: [],
      semanticLoreAvailable: false,
    },
    settings: {
      settings: input.settings ?? ctxSettings(),
      profile: input.profile === undefined
        ? { name: 'p', provider: 'openai', apiKey: 'k', baseUrl: '', model: 'gpt-4o-mini', maxContext: 0 }
        : input.profile,
    },
    lorebooks: input.lorebooks ?? [],
    regexRules: [],
  }
}

const CTX_BASE_MESSAGES = [
  ctxMessage({ role: 'user', content: '夜安。', timestamp: 1 }),
]

const CTX_PLAN_CASES: Array<{ data: ContextBuildData }> = [
  { data: ctxData({ messages: CTX_BASE_MESSAGES }) },
  // 首轮无助手回复 → 场景系数 1.15
  { data: ctxData({ messages: [ctxMessage({ role: 'user', content: '在吗', timestamp: 1 })] }) },
  // 短问句 → 0.85
  {
    data: ctxData({
      messages: [
        ctxMessage({ role: 'user', content: '你好', timestamp: 1 }),
        ctxMessage({ role: 'assistant', content: '夜安。', timestamp: 2 }),
        ctxMessage({ role: 'user', content: '在吗？', timestamp: 3 }),
      ],
    }),
  },
  // 会话级篇幅模式
  { data: ctxData({ messages: CTX_BASE_MESSAGES, sessions: [ctxSession({ responseLengthMode: 'detailed' })] }) },
  // 用户明确要求 brief 优先于会话级
  {
    data: ctxData({
      messages: [ctxMessage({ role: 'user', content: '简短回答我', timestamp: 1 })],
      sessions: [ctxSession({ responseLengthMode: 'detailed' })],
    }),
  },
  // 预设硬上限
  { data: ctxData({ messages: CTX_BASE_MESSAGES, preset: ctxPreset({ maxTokens: 4096 }) }) },
  // 明确转场 → 1.25
  {
    data: ctxData({
      messages: [
        ctxMessage({ role: 'user', content: '【场景】码头', timestamp: 1 }),
        ctxMessage({ role: 'assistant', content: '风很大。', timestamp: 2 }),
      ],
    }),
  },
]

// 世界书装配用例：验证 runtime → 渲染器 → 各落位（before/after_character、prompt_end、chat depth）
const CTX_LOREBOOK_BOOK = {
  id: 'lb1',
  name: '城市设定',
  description: '',
  enabled: true,
  scanDepth: 4,
  entries: [
    { id: 'e1', content: '【世界书·角色前】码头在雨里。', keywords: ['码头'], position: 'before_char', enabled: true, order: 0 },
    { id: 'e2', content: '【世界书·角色后】灯塔管理员。', keywords: ['码头'], position: 'after_char', enabled: true, order: 1 },
    { id: 'e3', content: '【世界书·末尾】雨夜封航。', keywords: ['码头'], position: 'at_end', enabled: true, order: 2 },
    { id: 'e4', content: '【世界书·深度】待补充细节。', keywords: ['码头'], position: 'at_depth', depth: 1, enabled: true, order: 3 },
  ],
} as unknown as Lorebook

const CTX_LOREBOOK_CASE: { data: ContextBuildData; opts?: BuildOptions } = {
  data: ctxData({
    messages: [
      ctxMessage({ role: 'user', content: '我们到码头了。', timestamp: 1 }),
      ctxMessage({ role: 'assistant', content: '雨还在下。', timestamp: 2 }),
      ctxMessage({ role: 'user', content: '进去看看。', timestamp: 3 }),
    ],
    character: ctxCharacter({ description: '旧书店的店主。' }),
    lorebooks: [CTX_LOREBOOK_BOOK],
    activeLorebookIds: ['lb1'],
  }),
}
const CTX_BUILD_CASES: Array<{ data: ContextBuildData; opts?: BuildOptions }> = [
  // 1) 最小：仅角色名 + 一条用户消息
  { data: ctxData({ messages: CTX_BASE_MESSAGES }) },
  // 2) 空名角色（边界）：不使用 character=null——PC 在 `character = {} as Character` 后会把
  //    `undefined` 直接插进提示词（字面 "undefined"），而 Kotlin 侧是空串；
  //    这种差异源于 JS 的 undefined 插值语义，不是移植分歧，故不纳入夹具。
  { data: ctxData({ messages: CTX_BASE_MESSAGES, character: ctxCharacter({ name: '', id: '' }) }) },
  // 3) 完整：systemPrompt + jailbreak + 人设 + thought + 角色设定
  {
    data: ctxData({
      messages: [
        ctxMessage({ role: 'user', content: '夜安。', timestamp: 1 }),
        ctxMessage({ role: 'assistant', content: '夜安，要坐一会儿吗？', timestamp: 2 }),
        ctxMessage({ role: 'user', content: '好。', timestamp: 3 }),
      ],
      character: ctxCharacter({
        systemPrompt: '你是{{char}}，书店店主。',
        description: '旧书店的店主。',
        personality: '冷静',
        scenario: '深夜的旧书店',
      }),
      preset: ctxPreset({ systemPrompt: '预设系统提示', jailbreak: '越狱段 {{user}}', enableThoughtFormat: true }),
      settings: ctxSettings({
        userDescription: '一名旅人。',
        userPersona: '寡言',
      }),
    }),
  },
  // 4) 全局叙事 + 用户人设 separate + 作者注释 top
  {
    data: ctxData({
      messages: CTX_BASE_MESSAGES,
      character: ctxCharacter({
        authorNote: { enabled: true, text: '注意节奏。', position: 'top', depth: 0 },
        defaultNarrativeMode: 'omniscient',
      }),
      settings: ctxSettings({
        omniscientNarrativeRules: '只叙述 {{char}} 所见，面向 {{user}}。',
        personaInjection: { enabled: true, position: 'separate', includeDescription: true, includePersona: false },
      }),
    }),
  },
  // 5) 作者注释 middle（按深度注入历史段）
  {
    data: ctxData({
      messages: [
        ctxMessage({ role: 'user', content: '第一句', timestamp: 1 }),
        ctxMessage({ role: 'assistant', content: '第二句', timestamp: 2 }),
        ctxMessage({ role: 'user', content: '第三句', timestamp: 3 }),
      ],
      character: ctxCharacter({ authorNote: { enabled: true, text: '中段注释', position: 'middle', depth: 1 } }),
    }),
  },
  // 6) 对话示例 after_system / first_turn（非首轮 → 不发）
  {
    data: ctxData({
      messages: [
        ctxMessage({ role: 'user', content: '一', timestamp: 1 }),
        ctxMessage({ role: 'assistant', content: '二', timestamp: 2 }),
        ctxMessage({ role: 'user', content: '三', timestamp: 3 }),
      ],
      character: ctxCharacter({ exampleDialog: '示例对白' }),
      preset: ctxPreset({ exampleDialogMode: 'first_turn' }),
    }),
  },
  // 7) 对话示例 after_history + always（首轮 → 发）
  {
    data: ctxData({
      messages: CTX_BASE_MESSAGES,
      character: ctxCharacter({ exampleDialog: '示例对白' }),
      settings: ctxSettings({ exampleDialogPosition: 'after_history' }),
    }),
  },
  // 8) 记忆三层注入（当前状态 + 事实 + 时间线）
  {
    data: ctxData({
      messages: CTX_BASE_MESSAGES,
      sessions: [
        ctxSession({
          memoryEnabled: true,
          memory: '她送走了最后一位客人。',
          memoryCurrentState: '深夜的旧书店',
          memoryFacts: ['苏晚的职业：书店店主'],
        }),
      ],
    }),
  },
  // 9) 记忆禁用 → 不注入
  {
    data: ctxData({
      messages: CTX_BASE_MESSAGES,
      sessions: [ctxSession({ memoryEnabled: false, memory: '不应注入', memoryCurrentState: '不应注入' })],
    }),
  },
  // 10) 续写模式
  { data: ctxData({ messages: CTX_BASE_MESSAGES }), opts: { continuation: true } },
  // 11) instruct 模板 appendAssistantPrefix（chatml）
  {
    data: ctxData({ messages: CTX_BASE_MESSAGES, preset: ctxPreset({ contextTemplate: 'chatml' }) }),
  },
  // 12) postHistoryInstructions 注入
  {
    data: ctxData({
      messages: CTX_BASE_MESSAGES,
      character: ctxCharacter({ postHistoryInstructions: '记住保持简短。' }),
    }),
  },
  // 13) 历史裁剪触发 pendingCompression
  {
    data: ctxData({
      messages: Array.from({ length: 40 }, (_, i) =>
        ctxMessage({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `第${i}条较长内容`.repeat(6),
          timestamp: i,
        }),
      ),
    }),
  },
  // 15) 激活世界书：runtime → 渲染器 → 各落位
  CTX_LOREBOOK_CASE,
  // 14) 压缩摘要已被裁剪范围覆盖 → 注入摘要而非标记压缩
  {
    data: ctxData({
      messages: Array.from({ length: 40 }, (_, i) =>
        ctxMessage({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `第${i}条较长内容`.repeat(6),
          timestamp: i,
        }),
      ),
      sessions: [
        ctxSession({
          compressedSummary: '早期摘要',
          compressedRange: { startTs: 0, endTs: 1000 },
        }),
      ],
    }),
  },
]

// ---------------------------------------------------------------- 会话导出（Markdown / JSON）

const EXPORT_ESCAPE_CASES: string[] = [
  '',
  '普通正文',
  '# 标题',
  '*斜体* 与 _下划线_',
  '`代码` 与 ```围栏```',
  '[链接](x)',
  '![图片](x)',              // 必须整体转义，防图片注入
  '反斜杠 \\ 与 {花括号}',
  '混合：**粗体** 和 [引用] 和 ![图](y)',
  'emoji 😀 与中文。',
]

const EXPORT_ROLE_CASES: string[] = ['user', 'assistant', 'system', 'other']

const EXPORT_MESSAGE_CASES: Array<{ messages: Array<{ role: string; content: string; timestamp: number; images?: string[] }> }> = [
  { messages: [] },
  {
    messages: [
      { role: 'user', content: '夜安。', timestamp: 1 },
      { role: 'assistant', content: '夜安，要坐一会儿吗？', timestamp: 2 },
    ],
  },
  // Markdown 特殊字符必须被转义，否则导出文件结构会被消息内容破坏
  {
    messages: [
      { role: 'user', content: '# 这是标题\n*斜体* 与 [链接](x)', timestamp: 10 },
      { role: 'assistant', content: '![图片](http://x/y.png)\n`代码`', timestamp: 20 },
    ],
  },
  // 图片（base64 不转义，保留图片语法）
  {
    messages: [
      { role: 'user', content: '看这张图', timestamp: 100, images: ['data:image/png;base64,AAAA'] },
      { role: 'assistant', content: '看到了', timestamp: 200, images: ['data:image/png;base64,BBBB', 'data:image/png;base64,CCCC'] },
    ],
  },
  // system 角色与未知角色
  {
    messages: [
      { role: 'system', content: '系统提示', timestamp: 5 },
      { role: 'other', content: '未知角色', timestamp: 6 },
    ],
  },
]

// ---------------------------------------------------------------- 消息翻译提示词

const TRANSLATION_LANGS: string[] = ['中文', 'English', '日本語', '繁體中文', '']

// ---------------------------------------------------------------- 输入框 AI 辅助（续写/润色）

const PERSPECTIVE_CASES: Array<{ raw: string; userName?: string; charName?: string }> = [
  { raw: '' },
  { raw: '   ' },
  { raw: '那我们走吧。' },
  // 角色开口 → 必须只保留用户部分
  { raw: '苏晚：你先坐。\n旅人：好，我坐一会儿。' },
  { raw: '苏晚: 你先坐。\n旅人: 好。' },
  // Markdown 星号装饰的名字行
  { raw: '**苏晚**：你先坐。\n旅人：好。' },
  { raw: '***苏晚***：你先坐。\n旅人：好。' },
  // 角色开口但找不到用户部分 → 空串（不得把角色的话写回输入框）
  { raw: '苏晚：你先坐。' },
  // 角色连续两次开口 → 用户部分截到下一次角色开口
  { raw: '苏晚：先坐。\n旅人：好。\n苏晚：喝茶吗？' },
]

const NORMALIZE_CASES: Array<{ raw: string; narrativeMode: 'immersive' | 'omniscient' }> = [
  // 全局模式的正文属于旁白：以焦点角色名开头也不能删
  { raw: '苏晚：你先坐。', narrativeMode: 'omniscient' },
  { raw: '苏晚：你先坐。\n旅人：好。', narrativeMode: 'immersive' },
  { raw: '  旁白内容  ', narrativeMode: 'omniscient' },
]

const TAGGED_CASES: Array<{ raw: string; tag: 'continuation' | 'prompt' }> = [
  { raw: '<continuation>那我们走吧。</continuation>', tag: 'continuation' },
  // 重复标签 → 无效（防止把协议说明当正文）
  { raw: '<continuation>甲</continuation><continuation>乙</continuation>', tag: 'continuation' },
  // 标签内但在 thought 中 → 无效
  { raw: '<thought><continuation>在思考里</continuation></thought>', tag: 'continuation' },
  { raw: '<prompt>best quality</prompt>', tag: 'prompt' },
  { raw: '<prompt> 前后空白 </prompt>', tag: 'prompt' },
  { raw: '没有标签', tag: 'continuation' },
]

const PARSE_CASES: Array<{ raw: string; charName?: string; narrativeMode?: 'immersive' | 'omniscient' }> = [
  { raw: '<continuation>那我们走吧。</continuation>' },
  // 未闭合标签 → 取开标签之后的部分
  { raw: '<continuation>那我们走吧。' },
  // 元说明行必须被剥离
  { raw: '<continuation>以下是续写：\n那我们走吧。</continuation>' },
  // 无标签且以英文为主 → 拒绝（防「英文分析 + 中文尾巴」）
  { raw: 'Need final only. 应该继续推进剧情。' },
  // 无标签的中文正文 → 接受
  { raw: '那我们走吧，去码头看看。' },
  // thought-only → 空
  { raw: '<thought>只是思考</thought>' },
  // 角色视角 → 清洗为用户视角
  { raw: '<continuation>苏晚：你先坐。\n旅人：好。</continuation>' },
  // 全局模式：以角色名开头也保留
  { raw: '<continuation>苏晚：你先坐。</continuation>', narrativeMode: 'omniscient' },
]

const FAILURE_CASES: string[] = [
  '',
  '   ',
  '<thought>只有思考</thought>',
  '<continuation>写了但没闭合',
  'English analysis only.',
]

const LENGTH_EVAL_CASES: Array<{ text: string; length: 'brief' | 'standard' | 'detailed' | 'extended' }> = [
  { text: '短句一句。', length: 'brief' },
  { text: '那我们走吧，去码头看看。', length: 'standard' },
  { text: '那我们走吧，去码头看看', length: 'standard' },   // 未以句末标点收尾 → truncated
  { text: '很短。', length: 'standard' },                    // 低于下限 → supplement
  { text: '一句完整的话。'.repeat(40), length: 'brief' },     // 明显超长 → compress
  { text: '目标区间内的完整句子。'.repeat(3), length: 'brief' },
  { text: '第一句。第二句。第三句。', length: 'brief' },
  { text: '', length: 'standard' },
]

const REPAIR_CASES: Array<{
  mode: 'supplement' | 'compress'
  length: 'brief' | 'standard' | 'detailed' | 'extended'
  chars: number
  truncated: boolean
}> = [
  { mode: 'supplement', length: 'standard', chars: 10, truncated: false },
  { mode: 'supplement', length: 'standard', chars: 30, truncated: true },
  { mode: 'compress', length: 'brief', chars: 200, truncated: false },
  { mode: 'compress', length: 'extended', chars: 2000, truncated: true },
]

const SYSTEM_PROMPT_CASES: Array<{
  hasInput: boolean
  narrativeMode: 'immersive' | 'omniscient'
  intensity: 'subtle' | 'steady' | 'active' | 'bold'
  length: 'brief' | 'standard' | 'detailed' | 'extended'
}> = [
  { hasInput: true, narrativeMode: 'immersive', intensity: 'active', length: 'standard' },
  { hasInput: false, narrativeMode: 'immersive', intensity: 'active', length: 'standard' },
  { hasInput: true, narrativeMode: 'immersive', intensity: 'subtle', length: 'brief' },
  { hasInput: true, narrativeMode: 'immersive', intensity: 'bold', length: 'extended' },
  { hasInput: true, narrativeMode: 'omniscient', intensity: 'active', length: 'standard' },
  { hasInput: false, narrativeMode: 'omniscient', intensity: 'steady', length: 'detailed' },
]

const CONTEXT_CASES: Array<{
  hasInput: boolean
  narrativeMode: 'immersive' | 'omniscient'
  originalInput: string
  intensity?: 'subtle' | 'steady' | 'active' | 'bold'
  length?: 'brief' | 'standard' | 'detailed' | 'extended'
}> = [
  { hasInput: true, narrativeMode: 'immersive', originalInput: '那我们' },
  { hasInput: false, narrativeMode: 'immersive', originalInput: '' },
  { hasInput: true, narrativeMode: 'omniscient', originalInput: '他推开门，' },
  { hasInput: false, narrativeMode: 'omniscient', originalInput: '', intensity: 'bold', length: 'extended' },
]

// ---------------------------------------------------------------- 对话方向（下一步方向）

const DIRECTIONS_ENABLED_CASES: Array<{ dialogueDirectionsEnabled?: boolean; gameMasterMode?: boolean }> = [
  {},
  { dialogueDirectionsEnabled: true },
  { dialogueDirectionsEnabled: false },
  { gameMasterMode: true },
  { gameMasterMode: false },
  // 新字段优先于旧字段
  { dialogueDirectionsEnabled: false, gameMasterMode: true },
  { dialogueDirectionsEnabled: true, gameMasterMode: false },
]

const DIRECTIONS_PAYLOAD_CASES: string[] = [
  '',
  '<directions>[{"id":"a"}]</directions>',
  // 重复标签 → 无效
  '<directions>甲</directions><directions>乙</directions>',
  // 无标签 → 无效
  '[{"id":"a"}]',
  '  <directions>  [{"id":"a"}]  </directions>  ',
]

const VALID_DIRECTIONS_JSON = JSON.stringify([
  { id: 'safe', label: '稳妥地接过茶', content: '我接过茶杯，轻声道谢，顺势问起今晚的雨势。', tendency: 'safe' },
  { id: 'explore', label: '打量四周书架', content: '我慢慢环视四周的书架，留意那些被翻旧了的书脊。', tendency: 'explore' },
  { id: 'risky', label: '直接问出心事', content: '我放下茶杯，直视着她，问出那个一直没敢问的问题。', tendency: 'risky' },
])

const DIRECTIONS_PARSE_CASES: string[] = [
  `<directions>${VALID_DIRECTIONS_JSON}</directions>`,
  // 代码块包裹
  '<directions>```json\n' + VALID_DIRECTIONS_JSON + '\n```</directions>',
  // 缺标签
  VALID_DIRECTIONS_JSON,
  // 数量不足
  `<directions>${JSON.stringify([{ id: 'safe', label: '稳妥地接过茶', content: '我接过茶杯，轻声道谢，顺势问起今晚的雨势。', tendency: 'safe' }])}</directions>`,
  // tendency 重复（应各出现一次）
  `<directions>${JSON.stringify([
    { id: 'safe', label: '稳妥地接过茶', content: '我接过茶杯，轻声道谢，顺势问起今晚的雨势。', tendency: 'safe' },
    { id: 'safe2', label: '另一种稳妥', content: '我把伞收好靠在门边，慢慢在柜台前坐下来。', tendency: 'safe' },
    { id: 'risky', label: '直接问出心事', content: '我放下茶杯，直视着她，问出那个一直没敢问的问题。', tendency: 'risky' },
  ])}</directions>`,
  // label 过短（<6 可见字符）
  `<directions>${JSON.stringify([
    { id: 'safe', label: '喝茶', content: '我接过茶杯，轻声道谢，顺势问起今晚的雨势。', tendency: 'safe' },
    { id: 'explore', label: '打量四周书架', content: '我慢慢环视四周的书架，留意那些被翻旧了的书脊。', tendency: 'explore' },
    { id: 'risky', label: '直接问出心事', content: '我放下茶杯，直视着她，问出那个一直没敢问的问题。', tendency: 'risky' },
  ])}</directions>`,
  // content 过长（>60 可见字符）
  `<directions>${JSON.stringify([
    { id: 'safe', label: '稳妥地接过茶', content: '我接过茶杯，轻声道谢，顺势问起今晚的雨势，然后又说起了路上遇到的种种事情，包括那家关门的旧书铺和空无一人的码头。', tendency: 'safe' },
    { id: 'explore', label: '打量四周书架', content: '我慢慢环视四周的书架，留意那些被翻旧了的书脊。', tendency: 'explore' },
    { id: 'risky', label: '直接问出心事', content: '我放下茶杯，直视着她，问出那个一直没敢问的问题。', tendency: 'risky' },
  ])}</directions>`,
  // 解释性前缀
  `<directions>${JSON.stringify([
    { id: 'safe', label: '选项 A：接过茶', content: '我接过茶杯，轻声道谢，顺势问起今晚的雨势。', tendency: 'safe' },
    { id: 'explore', label: '打量四周书架', content: '我慢慢环视四周的书架，留意那些被翻旧了的书脊。', tendency: 'explore' },
    { id: 'risky', label: '直接问出心事', content: '我放下茶杯，直视着她，问出那个一直没敢问的问题。', tendency: 'risky' },
  ])}</directions>`,
  // 非法 JSON
  '<directions>not json</directions>',
  // 倾向值非法
  `<directions>${JSON.stringify([
    { id: 'a', label: '稳妥地接过茶', content: '我接过茶杯，轻声道谢，顺势问起今晚的雨势。', tendency: 'calm' },
    { id: 'explore', label: '打量四周书架', content: '我慢慢环视四周的书架，留意那些被翻旧了的书脊。', tendency: 'explore' },
    { id: 'risky', label: '直接问出心事', content: '我放下茶杯，直视着她，问出那个一直没敢问的问题。', tendency: 'risky' },
  ])}</directions>`,
]

const DIRECTIONS_SIMILARITY_CASES: Array<Array<DialogueDirection>> = [
  [
    { id: 'safe', label: '稳妥地接过茶', content: '我接过茶杯，轻声道谢。', tendency: 'safe' },
    { id: 'explore', label: '打量四周书架', content: '我环视四周的书架，留意旧书脊。', tendency: 'explore' },
    { id: 'risky', label: '直接问出心事', content: '我放下茶杯，问出那个问题。', tendency: 'risky' },
  ],
  // 完全同形 → 相似
  [
    { id: 'safe', label: '稳妥地接过茶', content: '我接过茶杯，轻声道谢。', tendency: 'safe' },
    { id: 'explore', label: '稳妥地接过茶', content: '我接过茶杯，轻声道谢。', tendency: 'explore' },
    { id: 'risky', label: '直接问出心事', content: '我放下茶杯，问出那个问题。', tendency: 'risky' },
  ],
  // 包含关系（短串 ≥8 且被长串包含）→ 相似
  [
    { id: 'safe', label: '慢慢环视四周的书架', content: '我慢慢环视四周的书架，留意书脊。', tendency: 'safe' },
    { id: 'explore', label: '慢慢环视四周', content: '我环视书架。', tendency: 'explore' },
    { id: 'risky', label: '直接问出心事', content: '我放下茶杯，问出那个问题。', tendency: 'risky' },
  ],
]

const DIRECTIONS_PROMPT_CASES: Array<{
  narrativeMode: 'immersive' | 'omniscient'
  characterDescription?: string
  worldState?: string
}> = [
  { narrativeMode: 'immersive' },
  { narrativeMode: 'omniscient' },
  { narrativeMode: 'immersive', characterDescription: '' },
  { narrativeMode: 'immersive', worldState: '雨势渐大，码头封航。' },
  { narrativeMode: 'omniscient', worldState: '   ' },
]

// ---------------------------------------------------------------- 消息候选（swipe）

const SWIPE_TARGETS: Array<{ content: string; swipes?: string[] | null; swipeIndex?: number | null }> = [
  // 首次重生成：尚无候选数组 → 以当前内容作为第一个候选
  { content: '初版正文。' },
  { content: '初版正文。', swipes: null, swipeIndex: null },
  // 已有候选，当前在最后一个
  { content: '第二版。', swipes: ['初版正文。', '第二版。'], swipeIndex: 1 },
  // 已有候选，当前不在最后一个（历史切换后重生成）
  { content: '初版正文。', swipes: ['初版正文。', '第二版。'], swipeIndex: 0 },
  // 索引越界（历史数据损坏）不得崩溃
  { content: '越界。', swipes: ['甲', '乙'], swipeIndex: 9 },
]

const SWIPE_ROTATE_CASES: Array<{
  target: { content: string; swipes?: string[] | null; swipeIndex?: number | null }
  direction: number
}> = [
  { target: { content: '甲', swipes: ['甲', '乙', '丙'], swipeIndex: 0 }, direction: 1 },
  { target: { content: '乙', swipes: ['甲', '乙', '丙'], swipeIndex: 1 }, direction: 1 },
  { target: { content: '丙', swipes: ['甲', '乙', '丙'], swipeIndex: 2 }, direction: 1 },
  { target: { content: '甲', swipes: ['甲', '乙', '丙'], swipeIndex: 0 }, direction: -1 },
  { target: { content: '甲', swipes: ['甲', '乙', '丙'], swipeIndex: 0 }, direction: 5 },
  // 只有一个候选（含「没有候选数组」）→ 原样返回
  { target: { content: '唯一。' }, direction: 1 },
  { target: { content: '唯一。', swipes: ['唯一。'], swipeIndex: 0 }, direction: -1 },
  // 索引越界 → 按越界值参与取模（与 PC 的 `(current + direction + len) % len` 一致）
  { target: { content: '越界。', swipes: ['甲', '乙'], swipeIndex: 9 }, direction: 1 },
]

// ---------------------------------------------------------------- 世界书预算与分配

const HASH_CASES: string[] = [
  '',
  'a',
  '城市设定',
  '条目内容：码头在雨里。',
  'a'.repeat(200),
  'emoji 😀 与中文',
]

const COMPRESSION_KEY_CASES: Array<Array<{ key?: string; content: string }>> = [
  [],
  [{ key: 'lb1:e1', content: '甲' }],
  // 排序必须与输入顺序无关（同一组条目任何顺序都得到同一个键）
  [{ key: 'lb1:e2', content: '乙' }, { key: 'lb1:e1', content: '甲' }],
  [{ key: 'lb1:e1', content: '甲' }, { key: 'lb1:e2', content: '乙' }],
  // 缺 key（旧缓存）也要能建键
  [{ content: '无键条目' }],
  // 内容相同但 key 不同 → 键不同（条目编辑后缓存必须失效）
  [{ key: 'lb1:e1', content: '同一段话' }, { key: 'lb1:e2', content: '同一段话' }],
]

const ALLOCATE_CASES: Array<{ globalBudget: number; bookBudgets: Map<string, number> }> = [
  { globalBudget: 1000, bookBudgets: new Map() },
  // 总量不超预算 → 足额
  { globalBudget: 1000, bookBudgets: new Map([['a', 300], ['b', 400]]) },
  // 总量超出 → 按比例，最后一份吃剩余
  { globalBudget: 500, bookBudgets: new Map([['a', 300], ['b', 400]]) },
  // 部分书不带预算 → 按带预算书的平均值对待
  { globalBudget: 1000, bookBudgets: new Map([['a', 300], ['b', 0]]) },
  { globalBudget: 200, bookBudgets: new Map([['a', 300], ['b', 0], ['c', 0]]) },
  // 全部为 0
  { globalBudget: 1000, bookBudgets: new Map([['a', 0], ['b', 0]]) },
]

type LoreItemFixture = {
  key?: string
  content: string
  order: number
  position: 'before_char' | 'after_char' | 'at_depth' | 'at_end'
  depth?: number
  priority?: 'always' | 'conditional' | 'detail'
  score?: number
  summary?: string
  ignoreBudget?: boolean
}

const ENFORCE_CASES: Array<{
  items: LoreItemFixture[]
  bookCaps: Record<string, number>
  lbIdByKey: Record<string, string>
  model: string
}> = [
  {
    items: [
      { key: 'lb1:e1', content: '短条目。', order: 0, position: 'before_char', priority: 'conditional', score: 0.9 },
      { key: 'lb1:e2', content: '另一条。', order: 1, position: 'before_char', priority: 'conditional', score: 0.5 },
    ],
    bookCaps: {},
    lbIdByKey: { 'lb1:e1': 'lb1', 'lb1:e2': 'lb1' },
    model: 'gpt-4o-mini',
  },
  // cap 生效：低分长条目被丢；有手写摘要时先用摘要
  {
    items: [
      { key: 'lb1:e1', content: '高分短文。', order: 0, position: 'before_char', priority: 'conditional', score: 0.9 },
      { key: 'lb1:e2', content: '低分长文'.repeat(40), order: 1, position: 'before_char', priority: 'conditional', score: 0.2 },
      { key: 'lb1:e3', content: '带摘要的长文'.repeat(40), summary: '摘要很短。', order: 2, position: 'before_char', priority: 'conditional', score: 0.3 },
    ],
    bookCaps: { lb1: 30 },
    lbIdByKey: { 'lb1:e1': 'lb1', 'lb1:e2': 'lb1', 'lb1:e3': 'lb1' },
    model: 'gpt-4o-mini',
  },
  // ignoreBudget 条目不占书级预算
  {
    items: [
      { key: 'lb1:e1', content: '不计预算的条目'.repeat(20), order: 0, position: 'at_end', ignoreBudget: true },
      { key: 'lb1:e2', content: '普通条目。', order: 1, position: 'before_char', priority: 'conditional', score: 0.5 },
    ],
    bookCaps: { lb1: 10 },
    lbIdByKey: { 'lb1:e1': 'lb1', 'lb1:e2': 'lb1' },
    model: 'gpt-4o-mini',
  },
  // 未知书架 → 不受限
  {
    items: [{ key: 'lb9:e1', content: '外部条目'.repeat(30), order: 0, position: 'before_char', priority: 'conditional', score: 0.5 }],
    bookCaps: { lb1: 10 },
    lbIdByKey: { 'lb9:e1': 'lb9' },
    model: 'gpt-4o-mini',
  },
]

const FIT_CASES: Array<{
  items: LoreItemFixture[]
  budget: number
  model: string
  compressionCache?: Map<string, LorebookCompressionCacheEntry>
}> = [
  // 空输入
  { items: [], budget: 100, model: 'gpt-4o-mini' },
  // always 硬上限 40%：超出部分按 order 截断
  {
    items: [
      { key: 'a1', content: '常驻内容甲。'.repeat(3), order: 0, position: 'before_char', priority: 'always' },
      { key: 'a2', content: '常驻内容乙。'.repeat(3), order: 1, position: 'before_char', priority: 'always' },
      { key: 'a3', content: '常驻内容丙。'.repeat(3), order: 2, position: 'before_char', priority: 'always' },
    ],
    budget: 40,
    model: 'gpt-4o-mini',
  },
  // 无 detail 时 conditional 可用满预算
  {
    items: [
      { key: 'c1', content: '条件条目甲。', order: 0, position: 'before_char', priority: 'conditional', score: 0.9 },
      { key: 'c2', content: '条件条目乙。', order: 1, position: 'before_char', priority: 'conditional', score: 0.5 },
    ],
    budget: 200,
    model: 'gpt-4o-mini',
  },
  // 有 detail 时 always+conditional 累计不超 90%，detail 用剩余
  {
    items: [
      { key: 'a1', content: '常驻。', order: 0, position: 'before_char', priority: 'always' },
      { key: 'c1', content: '条件内容。'.repeat(10), order: 1, position: 'before_char', priority: 'conditional', score: 0.9 },
      { key: 'd1', content: '细节内容。'.repeat(10), order: 2, position: 'at_depth', depth: 1, priority: 'detail', score: 0.8 },
    ],
    budget: 80,
    model: 'gpt-4o-mini',
  },
  // 摘要替代：相关度优先，高分的先拿全文，低分短全文不抢占
  {
    items: [
      { key: 'c1', content: '低分短文。', order: 0, position: 'before_char', priority: 'conditional', score: 0.2 },
      { key: 'c2', content: '高分长文'.repeat(30), summary: '高分摘要。', order: 1, position: 'before_char', priority: 'conditional', score: 0.9 },
    ],
    budget: 30,
    model: 'gpt-4o-mini',
  },
  // 压缩请求：按注入位置分组，不同位置永不合并
  {
    items: [
      { key: 'c1', content: '位置甲的内容'.repeat(20), order: 0, position: 'before_char', priority: 'conditional', score: 0.5 },
      { key: 'c2', content: '位置乙的内容'.repeat(20), order: 1, position: 'at_depth', depth: 2, priority: 'conditional', score: 0.4 },
    ],
    budget: 40,
    model: 'gpt-4o-mini',
  },
  // 压缩缓存命中：命中后以缓存摘要注入并计入已覆盖
  {
    items: [
      { key: 'c1', content: '待压缩内容'.repeat(20), order: 0, position: 'before_char', priority: 'conditional', score: 0.5 },
    ],
    budget: 200,
    model: 'gpt-4o-mini',
    compressionCache: new Map([
      [buildCompressionKey([{ key: 'c1', content: '待压缩内容'.repeat(20) }]), { summary: '缓存摘要。', entryKeys: ['lb1:0'], createdAt: 1 }],
    ]),
  },
  // 混入 ignoreBudget：不占预算且必然保留
  {
    items: [
      // 必须给出显式 score：score 为 undefined 时 PC 的比较器返回 NaN（规范视为相等、保持原序），      // 而 Kotlin 侧把 null 当 0 排序——该输入在生产类型上是不可达的，故夹具不覆盖它
      { key: 'i1', content: '不占预算'.repeat(50), order: 0, position: 'at_end', ignoreBudget: true, score: 0.9 },
      { key: 'c1', content: '普通条件条目。', order: 1, position: 'before_char', priority: 'conditional', score: 0.5 },
    ],
    budget: 20,
    model: 'gpt-4o-mini',
  },
]

const CACHE_CASES: Array<{
  initial?: Record<string, LorebookCompressionCacheEntry>
  key: string
  entry: LorebookCompressionCacheEntry
  maxEntries?: number
}> = [
  { key: 'k1', entry: { summary: '甲', entryKeys: [], createdAt: 1 } },
  { initial: { k1: { summary: '甲', entryKeys: [], createdAt: 1 } }, key: 'k2', entry: { summary: '乙', entryKeys: [], createdAt: 2 } },
  // 覆盖同键
  { initial: { k1: { summary: '甲', entryKeys: [], createdAt: 1 } }, key: 'k1', entry: { summary: '甲改', entryKeys: [], createdAt: 2 } },
  // LRU 淘汰：超过上限时淘汰 lastUsedAt/createdAt 最小者
  {
    initial: {
      a: { summary: 'a', entryKeys: [], createdAt: 1, lastUsedAt: 100 },
      b: { summary: 'b', entryKeys: [], createdAt: 2, lastUsedAt: 2 },
      c: { summary: 'c', entryKeys: [], createdAt: 3, lastUsedAt: 3 },
    },
    key: 'd',
    entry: { summary: 'd', entryKeys: [], createdAt: 4 },
    maxEntries: 3,
  },
  // 自定义上限
  { initial: { a: { summary: 'a', entryKeys: [], createdAt: 1 } }, key: 'b', entry: { summary: 'b', entryKeys: [], createdAt: 2 }, maxEntries: 1 },
]

const TOUCH_CASES: Array<{
  cache?: Record<string, LorebookCompressionCacheEntry>
  keys: string[]
  usedAt: number
}> = [
  { keys: [], usedAt: 10 },
  { cache: { k1: { summary: '甲', entryKeys: [], createdAt: 1 } }, keys: [], usedAt: 10 },
  { cache: { k1: { summary: '甲', entryKeys: [], createdAt: 1 } }, keys: ['k1'], usedAt: 10 },
  // 未命中的键不改变时间
  { cache: { k1: { summary: '甲', entryKeys: [], createdAt: 1 } }, keys: ['missing'], usedAt: 10 },
  {
    cache: { k1: { summary: '甲', entryKeys: [], createdAt: 1 }, k2: { summary: '乙', entryKeys: [], createdAt: 2, lastUsedAt: 5 } },
    keys: ['k2'],
    usedAt: 99,
  },
]

// ---------------------------------------------------------------- 世界书触发匹配与统一评分

const LORE_STRIP_CASES: string[] = [
  '',
  '普通正文',
  '带 `行内代码` 的文本',
  '```\n代码块\n``` 之后的正文',
  '![图片](http://x/y.png) 说明',
  '[链接文字](http://x) 之后',
  '<b>粗体标签</b>内容',
  '**加粗** 与 __下划线__ 与 ~~删除线~~',
  '*斜体* 与 _下划线斜体_',
  '# 标题\n> 引用\n- 列表\n1. 有序',
  '---\n分割线之后',
]

const LORE_ESCAPE_CASES: string[] = ['', '普通', 'a.b*c', '[](){}', 'a|b\\c', '$^+?']

const LORE_KEYWORD_CASES: Array<{ keyword: string; text: string }> = [
  { keyword: '', text: '任意文本' },
  { keyword: '   ', text: '任意文本' },
  // ASCII 词边界：cat 不应命中 category
  { keyword: 'cat', text: 'a category here' },
  { keyword: 'cat', text: 'a cat here' },
  { keyword: 'CAT', text: 'a cat here' },
  // 非单词字符开头（正则里的 \b 不适用首）
  { keyword: '.txt', text: 'file.txt' },
  // CJK 多字：子串匹配
  { keyword: '码头', text: '他们在码头边等了很久。' },
  { keyword: '码头', text: '他们在码 头边等了很久。' },
  // CJK 单字：要求边界
  { keyword: '雨', text: '下雨了。' },
  { keyword: '雨', text: '大雨纷飞。' },
  { keyword: '雨', text: '雨。' },
]

const LORE_OVERLAP_CASES: Array<{ keywords: string[]; content: string; dialogue: string }> = [
  { keywords: ['码头'], content: '码头在雨里。', dialogue: '' },
  { keywords: ['码头'], content: '码头在雨里。', dialogue: '他们在码头边等了很久。' },
  { keywords: [], content: '码头在雨里。', dialogue: '他们在码头边等了很久。' },
  { keywords: ['码头', '雨'], content: '码头在雨里。还有雨。', dialogue: '雨下得很大，码头空无一人。' },
  // ASCII 词
  { keywords: ['lighthouse'], content: 'the lighthouse keeper', dialogue: 'the lighthouse is dark' },
  // 完全无关
  { keywords: ['灯塔'], content: '灯塔管理员', dialogue: '他们在码头边等了很久。' },
]

const LORE_OVERLAP_APPROX_CASES: Array<{
  itemScore?: number
  content: string
  semanticByContent?: Array<[string, number]>
}> = [
  { content: '甲' },
  { content: '甲', itemScore: 0.5 },
  { content: '甲', semanticByContent: [['甲', 0.8]] },
]

const LORE_ENTITY_CASES: Array<{
  scanTextLower: string
  charName: string
  entityVocabulary: string[]
  entries: Array<{ key: string; keywords: string[]; enabled?: boolean }>
}> = [
  { scanTextLower: '', charName: '苏晚', entityVocabulary: [], entries: [] },
  // 角色名出现在扫描文本 → 命中
  { scanTextLower: '苏晚把茶推过来。', charName: '苏晚', entityVocabulary: [], entries: [] },
  // 词表中未出现的词不入结果
  { scanTextLower: '苏晚把茶推过来。', charName: '苏晚', entityVocabulary: ['旅人'], entries: [] },
  // 条目关键词进入受控词表
  {
    scanTextLower: '码头那边传来汽笛声。',
    charName: '苏晚',
    entityVocabulary: [],
    entries: [{ key: 'lb1:e1', keywords: ['码头', '灯塔'] }],
  },
  // 停用条目不入词表
  {
    scanTextLower: '码头那边传来汽笛声。',
    charName: '苏晚',
    entityVocabulary: [],
    entries: [{ key: 'lb1:e1', keywords: ['码头'], enabled: false }],
  },
]

const LORE_ENTITY_BOOST_CASES: Array<{ keywords: string[]; content: string; recentEntities: string[] }> = [
  { keywords: ['码头'], content: '无关内容', recentEntities: [] },
  { keywords: ['码头'], content: '无关内容', recentEntities: ['码头'] },
  // 关键词大小写/空白不敏感
  { keywords: ['  码头  '], content: '无关内容', recentEntities: ['码头'] },
  // 内容包含实体名（长度 ≥2）
  { keywords: [], content: '他走向码头。', recentEntities: ['码头'] },
  // 单字实体不参与 includes（降低双字误报）
  { keywords: [], content: '他走向码头。', recentEntities: ['码'] },
]

const LORE_RECENCY_CASES: Array<{ previous?: string[][]; ids: string[] }> = [
  { ids: [] },
  { previous: [], ids: [] },
  { ids: ['k1'] },
  { previous: [['k1']], ids: ['k2'] },
  // 超过窗口必须裁掉最早的
  { previous: [['a'], ['b'], ['c'], ['d'], ['e']], ids: ['f'] },
]

type LoreEntryFixtureForScoring = {
  key: string
  keywords: string[]
  enabled?: boolean
  content?: string
  useRegex?: boolean
  regexFlags?: string
  caseSensitive?: boolean
  matchWholeWords?: boolean
  secondaryKeywords?: string[]
  selectiveLogic?: 'and_any' | 'and_all' | 'not_any' | 'not_all'
}

const LORE_SCORE_CASES: Array<{
  items: Array<{ key?: string; content: string; order: number; position: 'before_char' | 'after_char' | 'at_depth' | 'at_end'; depth?: number; priority?: 'always' | 'conditional' | 'detail' }>
  entries: Record<string, LoreEntryFixtureForScoring>
  scanText: string
  dialogueText: string
  semanticByContent?: Array<[string, number]>
  recentEntities?: string[]
  recentTriggered?: string[]
}> = [
  // 无关键词条目：keywordHits = 0，仍可因语义/实体/近因得分
  {
    items: [{ key: 'lb1:e1', content: '码头在雨里。', order: 0, position: 'before_char' }],
    entries: { 'lb1:e1': { key: 'lb1:e1', keywords: [], content: '码头在雨里。' } },
    scanText: '雨',
    dialogueText: '雨',
  },
  // coverage/frequency：命中一次 vs 反复讨论
  {
    items: [{ key: 'lb1:e1', content: '码头条目。', order: 0, position: 'before_char' }],
    entries: { 'lb1:e1': { key: 'lb1:e1', keywords: ['码头', '灯塔'], content: '码头条目。' } },
    scanText: '码头',
    dialogueText: '码头',
  },
  {
    items: [{ key: 'lb1:e1', content: '码头条目。', order: 0, position: 'before_char' }],
    entries: { 'lb1:e1': { key: 'lb1:e1', keywords: ['码头', '灯塔'], content: '码头条目。' } },
    scanText: '码头码头码头码头码头',
    dialogueText: '码头码头码头码头码头',
  },
  // 真实语义命中优先，且 semanticSource = real
  {
    items: [{ key: 'lb1:e1', content: '码头在雨里。', order: 0, position: 'before_char' }],
    entries: { 'lb1:e1': { key: 'lb1:e1', keywords: ['码头'], content: '码头在雨里。' } },
    scanText: '码头',
    dialogueText: '码头',
    semanticByContent: [['码头在雨里。', 0.7]],
  },
  // 无真实语义 → 近似补偿（semanticSource = approx）
  {
    items: [{ key: 'lb1:e1', content: '码头在雨里。', order: 0, position: 'before_char' }],
    entries: { 'lb1:e1': { key: 'lb1:e1', keywords: ['码头'], content: '码头在雨里。' } },
    scanText: '码头',
    dialogueText: '他们在码头边等了很久。',
  },
  // 实体命中与近因命中
  {
    items: [{ key: 'lb1:e1', content: '他走向码头。', order: 0, position: 'before_char' }],
    entries: { 'lb1:e1': { key: 'lb1:e1', keywords: ['无名'], content: '他走向码头。' } },
    scanText: '码头',
    dialogueText: '码头',
    recentEntities: ['码头'],
    recentTriggered: ['lb1:e1'],
  },
  // useRegex 条目
  {
    items: [{ key: 'lb1:e1', content: '正则条目。', order: 0, position: 'before_char' }],
    entries: { 'lb1:e1': { key: 'lb1:e1', keywords: ['碼|码'], useRegex: true, regexFlags: 'i', content: '正则条目。' } },
    scanText: '码头',
    dialogueText: '码头',
  },
  // 大小写敏感 + 非整词
  {
    items: [{ key: 'lb1:e1', content: 'Case 条目。', order: 0, position: 'before_char' }],
    entries: { 'lb1:e1': { key: 'lb1:e1', keywords: ['Cat'], caseSensitive: true, content: 'Case 条目。' } },
    scanText: 'cat',
    dialogueText: 'cat',
  },
]

// 供 fixture 构造真实 LoreEntry / Lorebook 的工厂（只填必要字段，其余按类型补齐）
function loreEntryForScoring(entry: LoreEntryFixtureForScoring): LoreEntry {
  return {
    id: entry.key.split(':')[1] ?? entry.key,
    keywords: entry.keywords,
    content: entry.content ?? '',
    position: 'before_char',
    enabled: entry.enabled ?? true,
    useRegex: entry.useRegex,
    regexFlags: entry.regexFlags,
    caseSensitive: entry.caseSensitive,
    matchWholeWords: entry.matchWholeWords,
    secondaryKeywords: entry.secondaryKeywords,
    selectiveLogic: entry.selectiveLogic,
  } as LoreEntry
}

function lorebookForScoring(entries: Array<{ key: string; keywords: string[]; enabled?: boolean }>): Lorebook {
  return {
    id: 'lb1',
    name: '测试世界书',
    description: '',
    enabled: true,
    entries: entries.map((entry) => loreEntryForScoring({
      key: entry.key,
      keywords: entry.keywords,
      enabled: entry.enabled,
    })),
  } as Lorebook
}

// ---------------------------------------------------------------- 世界书运行时（触发管线 + 分发）

type LorebookRuntimeBookFixture = {
  id: string
  name: string
  enabled?: boolean
  scanDepth?: number
  tokenBudget?: number
  recursiveScanning?: boolean
  entries: Array<{
    id: string
    content: string
    keywords?: string[]
    secondaryKeywords?: string[]
    selectiveLogic?: 'and_any' | 'and_all' | 'not_any' | 'not_all'
    useRegex?: boolean
    regexFlags?: string
    caseSensitive?: boolean
    matchWholeWords?: boolean
    enabled?: boolean
    position: 'before_char' | 'after_char' | 'at_depth' | 'at_end'
    depth?: number
    role?: 'system' | 'user' | 'assistant'
    priority?: 'always' | 'conditional' | 'detail'
    order?: number
    summary?: string
    ignoreBudget?: boolean
    probability?: number
    preventRecursion?: boolean
    scanDepth?: number
    generationTriggers?: string[]
    characterFilter?: { names?: string[]; tags?: string[]; exclude?: boolean }
  }>
}

const LORE_RUNTIME_CASES: Array<{
  lorebooks: LorebookRuntimeBookFixture[]
  scanText: string
  scanMessages?: string[]
  userName: string
  charName: string
  characterNames?: string[]
  characterTags?: string[]
  generationType?: string
  messageCount?: number
  budget: number
  model: string
  maxRecursiveDepth?: number
  entityVocabulary?: string[]
  recentTriggeredIds?: string[][]
  compressionCache?: Array<[string, { summary: string; entryKeys: string[]; createdAt: number }]>
}> = [
  // 1) 空世界书
  {
    lorebooks: [],
    scanText: '',
    userName: '旅人',
    charName: '苏晚',
    budget: 200,
    model: 'gpt-4o-mini',
  },
  // 2) always + 关键词 + 位置分发（before/after/at_end/at_depth）
  {
    lorebooks: [
      {
        id: 'lb1',
        name: '城市设定',
        entries: [
          { id: 'e1', content: '常驻设定。', position: 'before_char', priority: 'always', order: 0 },
          { id: 'e2', content: '码头条目。', keywords: ['码头'], position: 'after_char', order: 1 },
          { id: 'e3', content: '结尾条目。', keywords: ['码头'], position: 'at_end', order: 2 },
          { id: 'e4', content: '深度条目。', keywords: ['码头'], position: 'at_depth', depth: 2, role: 'system', order: 3 },
        ],
      },
    ],
    scanText: '他们站在码头边。',
    userName: '旅人',
    charName: '苏晚',
    budget: 500,
    model: 'gpt-4o-mini',
  },
  // 3) 扫描深度：条目级与书级
  {
    lorebooks: [
      {
        id: 'lb1',
        name: '窗口设定',
        scanDepth: 1,
        entries: [
          // 书级窗口 1 → 只扫最近一条消息，关键词出现在更早的消息中 → 不触发
          { id: 'e1', content: '书级窗口条目。', keywords: ['码头'], position: 'before_char', order: 0 },
          // 条目级窗口 3 → 扫到更早消息 → 触发
          { id: 'e2', content: '条目窗口条目。', keywords: ['码头'], position: 'before_char', order: 1, scanDepth: 3 },
        ],
      },
    ],
    scanText: '整体扫描文本不含关键词。',
    scanMessages: ['他们在码头边。', '后来下了雨。', '夜深了。'],
    userName: '旅人',
    charName: '苏晚',
    budget: 500,
    model: 'gpt-4o-mini',
  },
  // 4) 二级关键词四种 logic
  {
    lorebooks: [
      {
        id: 'lb1',
        name: '二级逻辑',
        entries: [
          { id: 'e1', content: 'and_any 条目。', keywords: ['码头'], secondaryKeywords: ['雨'], selectiveLogic: 'and_any', position: 'before_char', order: 0 },
          { id: 'e2', content: 'and_all 条目。', keywords: ['码头'], secondaryKeywords: ['雨', '夜'], selectiveLogic: 'and_all', position: 'before_char', order: 1 },
          { id: 'e3', content: 'not_any 条目。', keywords: ['码头'], secondaryKeywords: ['雪'], selectiveLogic: 'not_any', position: 'before_char', order: 2 },
          { id: 'e4', content: 'not_all 条目。', keywords: ['码头'], secondaryKeywords: ['雨', '夜'], selectiveLogic: 'not_all', position: 'before_char', order: 3 },
        ],
      },
    ],
    scanText: '码头下着雨，夜深了。',
    userName: '旅人',
    charName: '苏晚',
    budget: 500,
    model: 'gpt-4o-mini',
  },
  // 5) 递归：条目内容成为下一层扫描文本并触发另一条
  {
    lorebooks: [
      {
        id: 'lb1',
        name: '递归设定',
        entries: [
          { id: 'e1', content: '灯塔管理员住在灯塔里。', keywords: ['码头'], position: 'before_char', order: 0 },
          { id: 'e2', content: '管理员有一本旧航海日志。', keywords: ['管理员'], position: 'before_char', order: 1 },
        ],
      },
    ],
    scanText: '他们在码头边。',
    userName: '旅人',
    charName: '苏晚',
    budget: 500,
    model: 'gpt-4o-mini',
  },
  // 6) preventRecursion 阻断递归
  {
    lorebooks: [
      {
        id: 'lb1',
        name: '阻断递归',
        entries: [
          { id: 'e1', content: '灯塔管理员住在灯塔里。', keywords: ['码头'], position: 'before_char', order: 0, preventRecursion: true },
          { id: 'e2', content: '管理员有一本旧航海日志。', keywords: ['管理员'], position: 'before_char', order: 1 },
        ],
      },
    ],
    scanText: '他们在码头边。',
    userName: '旅人',
    charName: '苏晚',
    budget: 500,
    model: 'gpt-4o-mini',
  },
  // 7) 内容去重（相同正文只注入一次）
  {
    lorebooks: [
      {
        id: 'lb1',
        name: '重复内容',
        entries: [
          { id: 'e1', content: '同一段设定。', keywords: ['码头'], position: 'before_char', order: 0 },
          { id: 'e2', content: '同一段设定。', keywords: ['码头'], position: 'after_char', order: 1 },
        ],
      },
    ],
    scanText: '码头。',
    userName: '旅人',
    charName: '苏晚',
    budget: 500,
    model: 'gpt-4o-mini',
  },
  // 8) 资格过滤：generationTriggers 与 characterFilter
  {
    lorebooks: [
      {
        id: 'lb1',
        name: '资格过滤',
        entries: [
          { id: 'e1', content: '只在续写时触发。', keywords: ['码头'], generationTriggers: ['continue'], position: 'before_char', order: 0 },
          { id: 'e2', content: '仅苏晚可用。', keywords: ['码头'], characterFilter: { names: ['苏晚'] }, position: 'before_char', order: 1 },
          { id: 'e3', content: '排除苏晚。', keywords: ['码头'], characterFilter: { names: ['苏晚'], exclude: true }, position: 'before_char', order: 2 },
          { id: 'e4', content: '仅带某标签可用。', keywords: ['码头'], characterFilter: { tags: ['modern'] }, position: 'before_char', order: 3 },
        ],
      },
    ],
    scanText: '码头。',
    userName: '旅人',
    charName: '苏晚',
    characterNames: ['苏晚'],
    characterTags: ['ancient'],
    generationType: 'normal',
    budget: 500,
    model: 'gpt-4o-mini',
  },
  // 9) 概率：100 必然通过；0 必然失败（random()*100 >= 0 恒真，确定性强）
  {
    lorebooks: [
      {
        id: 'lb1',
        name: '概率',
        entries: [
          { id: 'e1', content: '必然注入。', keywords: ['码头'], probability: 100, position: 'before_char', order: 0 },
          { id: 'e2', content: '必然丢弃。', keywords: ['码头'], probability: 0, position: 'before_char', order: 1 },
        ],
      },
    ],
    scanText: '码头。',
    userName: '旅人',
    charName: '苏晚',
    budget: 500,
    model: 'gpt-4o-mini',
  },
  // 10) 预算不足：always 硬上限截断 + 条件条目丢弃
  {
    lorebooks: [
      {
        id: 'lb1',
        name: '预算',
        entries: [
          { id: 'a1', content: '常驻内容甲。'.repeat(6), position: 'before_char', priority: 'always', order: 0 },
          { id: 'a2', content: '常驻内容乙。'.repeat(6), position: 'before_char', priority: 'always', order: 1 },
          { id: 'c1', content: '条件内容。'.repeat(6), keywords: ['码头'], position: 'before_char', order: 2 },
        ],
      },
    ],
    scanText: '码头。',
    userName: '旅人',
    charName: '苏晚',
    budget: 60,
    model: 'gpt-4o-mini',
  },
  // 11) 手写摘要替代（预算不足时用摘要注入）
  {
    lorebooks: [
      {
        id: 'lb1',
        name: '摘要替代',
        entries: [
          { id: 'e1', content: '很长很长的正文。'.repeat(20), summary: '短摘要。', keywords: ['码头'], position: 'before_char', order: 0 },
        ],
      },
    ],
    scanText: '码头。',
    userName: '旅人',
    charName: '苏晚',
    budget: 30,
    model: 'gpt-4o-mini',
  },
  // 12) 书级 tokenBudget
  {
    lorebooks: [
      {
        id: 'lb1',
        name: '书级预算',
        tokenBudget: 20,
        entries: [
          { id: 'e1', content: '高分条目。', keywords: ['码头', '灯塔'], position: 'before_char', order: 0 },
          { id: 'e2', content: '另一条内容。'.repeat(10), keywords: ['码头'], position: 'before_char', order: 1 },
        ],
      },
    ],
    scanText: '码头灯塔。',
    userName: '旅人',
    charName: '苏晚',
    budget: 500,
    model: 'gpt-4o-mini',
  },
]

/**
 * 运行时夹具 → 真实 `Lorebook` 的工厂。
 *
 * **必须补齐 `enabled`**：PC 的 `LoreEntry.enabled`/`Lorebook.enabled` 是必填布尔，
 * 省略会变成 `undefined`（falsy），运行时会**静默跳过全部条目**——
 * 夹具会产出「全为空」的结果，看起来像「没有条目触发」而不是「输入不合法」。
 */
function lorebookForRuntime(book: LorebookRuntimeBookFixture): Lorebook {
  return {
    id: book.id,
    name: book.name,
    description: '',
    enabled: book.enabled ?? true,
    scanDepth: book.scanDepth,
    tokenBudget: book.tokenBudget,
    recursiveScanning: book.recursiveScanning,
    entries: book.entries.map((entry) => ({
      id: entry.id,
      content: entry.content,
      keywords: entry.keywords ?? [],
      secondaryKeywords: entry.secondaryKeywords,
      selectiveLogic: entry.selectiveLogic,
      useRegex: entry.useRegex,
      regexFlags: entry.regexFlags,
      caseSensitive: entry.caseSensitive,
      matchWholeWords: entry.matchWholeWords,
      enabled: entry.enabled ?? true,
      position: entry.position,
      depth: entry.depth,
      role: entry.role,
      priority: entry.priority,
      order: entry.order ?? 0,
      summary: entry.summary,
      ignoreBudget: entry.ignoreBudget,
      probability: entry.probability,
      preventRecursion: entry.preventRecursion,
      scanDepth: entry.scanDepth,
      generationTriggers: entry.generationTriggers,
      characterFilter: entry.characterFilter
        ? {
            names: entry.characterFilter.names ?? [],
            tags: entry.characterFilter.tags ?? [],
            exclude: entry.characterFilter.exclude,
          }
        : undefined,
    })) as never,
  } as never
}

// ---------------------------------------------------------------- 向量工具（S4-05 向量层地基）

const VECTOR_COSINE_CASES: Array<{ a: number[]; b: number[] }> = [
  { a: [], b: [] },
  { a: [], b: [1, 2] },
  // 长度不匹配 → 0（不抛异常）
  { a: [1, 2], b: [1, 2, 3] },
  // 零向量 → 0
  { a: [0, 0], b: [1, 2] },
  { a: [1, 2], b: [0, 0] },
  // 同向 → 1
  { a: [1, 2], b: [2, 4] },
  // 反向 → -1
  { a: [1, 2], b: [-2, -4] },
  // 正交 → 0
  { a: [1, 0], b: [0, 1] },
  // 负分量
  { a: [-1, -2, -3], b: [-3, -2, -1] },
  // 小数与三位以上维度
  { a: [0.1, 0.2, 0.3], b: [0.3, 0.2, 0.1] },
  { a: [1.5, -2.5, 3.5, 4.5], b: [-1.5, 2.5, -3.5, 4.5] },
]

const VECTOR_NORMALIZE_CASES: number[][] = [
  [],
  [0],
  [0, 0, 0],
  [1],
  [3, 4],
  [-3, -4],
  [0.5, 0.5, 0.5, 0.5],
  [1e-300, 1e-300],
]

const VECTOR_DOT_CASES: Array<{ a: number[]; b: number[] }> = [
  { a: [], b: [] },
  { a: [1, 2], b: [1, 2, 3] },
  { a: [0.6, 0.8], b: [0.6, 0.8] },
  { a: [-1, 2], b: [3, -4] },
]

const VECTOR_TOPK_CASES: Array<{
  query: number[]
  items: Array<{ id: string; vector: number[] }>
  k: number
  minScore?: number
}> = [
  { query: [], items: [], k: 3 },
  { query: [1, 0], items: [], k: 3 },
  // k = 0
  { query: [1, 0], items: [{ id: 'a', vector: [1, 0] }], k: 0 },
  // 维度不匹配的条目必须被跳过，而不是截断/补零
  {
    query: [1, 0],
    items: [
      { id: 'match', vector: [1, 0] },
      { id: 'wrong-dim', vector: [1, 0, 0] },
      { id: 'shorter', vector: [1] },
    ],
    k: 5,
  },
  // 排序与 minScore 过滤
  {
    query: [1, 0],
    items: [
      { id: 'orthogonal', vector: [0, 1] },
      { id: 'same', vector: [1, 0] },
      { id: 'opposite', vector: [-1, 0] },
      { id: 'diagonal', vector: [1, 1] },
    ],
    k: 5,
  },
  {
    query: [1, 0],
    items: [
      { id: 'orthogonal', vector: [0, 1] },
      { id: 'same', vector: [1, 0] },
      { id: 'opposite', vector: [-1, 0] },
    ],
    k: 5,
    minScore: 0.5,
  },
  // 同分必须保持输入顺序（JS sort 稳定；Kotlin 也稳定）
  {
    query: [1, 0],
    items: [
      { id: 'first', vector: [2, 0] },
      { id: 'second', vector: [3, 0] },
      { id: 'third', vector: [4, 0] },
    ],
    k: 5,
  },
  // k 小于命中数 → 截断
  {
    query: [1, 0],
    items: [
      { id: 'exact', vector: [1, 0] },
      { id: 'diagonal', vector: [1, 1] },
      { id: 'orthogonal', vector: [0, 1] },
    ],
    k: 2,
  },
  // 零向量条目：归一化返回原样 → 点积为 0（minScore 默认 0 时仍然入选）
  {
    query: [1, 0],
    items: [
      { id: 'zero', vector: [0, 0] },
      { id: 'unit', vector: [1, 0] },
    ],
    k: 5,
  },
]

// ---------------------------------------------------------------- 世界书向量层（条目侧）

type LoreEmbeddingEntryFixture = {
  id: string
  content: string
  keywords?: string[]
  secondaryKeywords?: string[]
  summary?: string
  title?: string
  enabled?: boolean
  priority?: 'always' | 'conditional' | 'detail'
  matchMode?: 'keyword' | 'semantic' | 'both'
}

function loreEntryForEmbedding(entry: LoreEmbeddingEntryFixture): LoreEntry {
  return {
    id: entry.id,
    content: entry.content,
    keywords: entry.keywords ?? [],
    secondaryKeywords: entry.secondaryKeywords,
    summary: entry.summary,
    enabled: entry.enabled ?? true,
    priority: entry.priority,
    matchMode: entry.matchMode,
    position: 'before_char',
    order: 0,
    runtime: entry.title === undefined ? undefined : { title: entry.title },
  } as never
}

const LORE_EMBEDDING_ENTRIES: LoreEmbeddingEntryFixture[] = [
  { id: 'plain', content: '码头在雨里。' },
  // 标题 + 关键词 + 别名 + 摘要 + 正文：标签顺序必须稳定
  {
    id: 'full',
    content: '码头在雨里。灯塔亮着。',
    keywords: ['码头', '灯塔'],
    secondaryKeywords: ['雨', '码头'],
    summary: '雨夜的海港。',
    title: '海港',
  },
  // 关键词去重保持首次出现顺序
  { id: 'dup-keys', content: '正文。', keywords: ['乙', '甲', '乙'], secondaryKeywords: ['甲'] },
  // 空字段不产生空标签
  { id: 'only-content', content: '  只有正文  ' },
  // 停用 / always / 仅关键词模式 → 不进入向量索引
  { id: 'disabled', content: '停用条目。', enabled: false },
  { id: 'always', content: '常驻条目。', priority: 'always' },
  { id: 'keyword-mode', content: '仅关键词。', matchMode: 'keyword' },
  // 语义模式但正文为空 → 无内容可向量化
  { id: 'semantic-empty', content: '   ', matchMode: 'semantic' },
  { id: 'semantic-ok', content: '语义条目。', matchMode: 'semantic' },
]

const LORE_EMBEDDING_SPLIT_CASES: Array<{
  text: string
  maxChars: number
  maxChunks?: number
  overlapRatio?: number
}> = [
  { text: '', maxChars: 100 },
  { text: '   ', maxChars: 100 },
  // 短于阈值 → 原样一片
  { text: '短文。', maxChars: 100 },
  // maxChars 下限 64
  { text: 'a'.repeat(70), maxChars: 10 },
  // 精确边界
  { text: 'a'.repeat(64), maxChars: 64 },
  { text: 'a'.repeat(65), maxChars: 64 },
  // 多片 + 重叠
  { text: 'a'.repeat(300), maxChars: 100 },
  // maxChunks 限制：最后一片必须是文档尾部
  { text: 'a'.repeat(2000), maxChars: 100, maxChunks: 3 },
  { text: Array.from({ length: 200 }, (_, i) => String.fromCharCode(0x4e00 + (i % 500))).join(''), maxChars: 80, maxChunks: 4 },
  // 自定义重叠比例（0 与较大值）
  { text: 'b'.repeat(300), maxChars: 100, overlapRatio: 0 },
  { text: 'c'.repeat(300), maxChars: 100, overlapRatio: 0.9 },
]

const LORE_EMBEDDING_MERGE_CASES: number[][][] = [
  [],
  [[]],
  [[1, 2], [3, 4]],
  // 维度不一致：以首个可用向量的维度为准，不匹配的丢弃
  [[1, 2], [3, 4, 5]],
  // 全零质心 → 归一化返回原样
  [[0, 0], [0, 0]],
  [[-1, -1], [-1, -1]],
]

const LORE_EMBEDDING_DIFF_CASES: Array<{
  prev: LoreEmbeddingEntryFixture[]
  next: LoreEmbeddingEntryFixture[]
}> = [
  { prev: [], next: [] },
  { prev: [], next: [{ id: 'a', content: '新增。' }] },
  { prev: [{ id: 'a', content: '旧。' }], next: [] },
  // 内容变化 → 失效
  { prev: [{ id: 'a', content: '旧。' }], next: [{ id: 'a', content: '新。' }] },
  // 完全一致 → 不失效
  { prev: [{ id: 'a', content: '同。' }], next: [{ id: 'a', content: '同。' }] },
  // 资格变化（启用/停用、常驻、检索模式）→ 失效
  { prev: [{ id: 'a', content: '同。' }], next: [{ id: 'a', content: '同。', enabled: false }] },
  { prev: [{ id: 'a', content: '同。' }], next: [{ id: 'a', content: '同。', priority: 'always' }] },
  { prev: [{ id: 'a', content: '同。' }], next: [{ id: 'a', content: '同。', matchMode: 'keyword' }] },
  // 标题/摘要/关键词变化 → 文档变化 → 失效
  { prev: [{ id: 'a', content: '同。' }], next: [{ id: 'a', content: '同。', title: '新标题' }] },
  { prev: [{ id: 'a', content: '同。' }], next: [{ id: 'a', content: '同。', keywords: ['新'] }] },
  // 顺序不敏感：顺序变化不产生失效
  {
    prev: [{ id: 'a', content: 'A。' }, { id: 'b', content: 'B。' }],
    next: [{ id: 'b', content: 'B。' }, { id: 'a', content: 'A。' }],
  },
]

// ---------------------------------------------------------------- 嵌入/语义检索判定层

type EmbeddingConfigFixture = {
  provider: 'local' | 'openai' | 'ollama' | string
  model: string
  baseUrl?: string
  apiKey?: string
}

const EMBEDDING_FACT_HIT_CASES: Array<{ hits: Array<{ id: string; score: number }>; facts: string[] }> = [
  { hits: [], facts: [] },
  { hits: [{ id: '0', score: 0.9 }], facts: ['甲事实'] },
  // 越界下标 → 丢弃（旧索引在事实被裁剪后必然出现）
  { hits: [{ id: '5', score: 0.9 }], facts: ['甲事实'] },
  // 非数字 id → 丢弃，不抛异常
  { hits: [{ id: 'abc', score: 0.9 }], facts: ['甲事实'] },
  { hits: [{ id: '-1', score: 0.9 }], facts: ['甲事实'] },
  { hits: [{ id: ' 1 ', score: 0.5 }], facts: ['甲事实', '乙事实'] },
  // 空字符串事实 → 丢弃（JS 的 filter(Boolean) 语义）
  { hits: [{ id: '0', score: 0.5 }, { id: '1', score: 0.4 }], facts: ['', '乙事实'] },
  // 顺序保持命中顺序
  {
    hits: [{ id: '2', score: 0.1 }, { id: '0', score: 0.9 }],
    facts: ['甲', '乙', '丙'],
  },
]

const EMBEDDING_VECTOR_SPACE_CASES: EmbeddingConfigFixture[] = [
  { provider: 'openai', model: 'text-embedding-3-small' },
  { provider: 'ollama', model: 'nomic-embed-text' },
  { provider: 'local', model: 'bge-small-zh-v1.5@1.0.0' },
  { provider: 'local', model: 'multilingual-e5-small@1.0.0' },
  // 无 `@` 的本地模型串：JS 切片怪癖必须逐字节锁定
  { provider: 'local', model: 'weird' },
  { provider: 'local', model: 'a' },
  // 含多个 `@`：以最后一个为准
  { provider: 'local', model: 'name@scope@1.2.3' },
]

const EMBEDDING_INDEX_COMPAT_CASES: Array<{
  index: {
    model: string
    provider?: string
    modelId?: string
    modelVersion?: string
  }
  config: EmbeddingConfigFixture
}> = [
  { index: { model: 'text-embedding-3-small', provider: 'openai' }, config: { provider: 'openai', model: 'text-embedding-3-small' } },
  // 模型名不同 → 不兼容（含空白差异的 trim 语义）
  { index: { model: 'a', provider: 'openai' }, config: { provider: 'openai', model: 'b' } },
  { index: { model: ' a ', provider: 'openai' }, config: { provider: 'openai', model: 'a' } },
  // provider 不同 → 不兼容
  { index: { model: 'a', provider: 'openai' }, config: { provider: 'ollama', model: 'a' } },
  // 索引没有 provider 记录（旧数据）→ 不比较 provider
  { index: { model: 'a' }, config: { provider: 'ollama', model: 'a' } },
  // local：必须同时匹配 modelId 与 modelVersion
  {
    index: { model: 'bge-small-zh-v1.5@1.0.0', provider: 'local', modelId: 'bge-small-zh-v1.5', modelVersion: '1.0.0' },
    config: { provider: 'local', model: 'bge-small-zh-v1.5@1.0.0' },
  },
  {
    index: { model: 'bge-small-zh-v1.5@1.0.0', provider: 'local', modelId: 'bge-small-zh-v1.5', modelVersion: '0.9.0' },
    config: { provider: 'local', model: 'bge-small-zh-v1.5@1.0.0' },
  },
  {
    index: { model: 'bge-small-zh-v1.5@1.0.0', provider: 'local', modelId: 'other', modelVersion: '1.0.0' },
    config: { provider: 'local', model: 'bge-small-zh-v1.5@1.0.0' },
  },
]

const EMBEDDING_THRESHOLD_CASES: Array<{ config: EmbeddingConfigFixture; requested?: number }> = [
  { config: { provider: 'openai', model: 'text-embedding-3-small' } },
  // 显式阈值优先
  { config: { provider: 'openai', model: 'text-embedding-3-small' }, requested: 0.75 },
  { config: { provider: 'openai', model: 'text-embedding-3-small' }, requested: 0 },
  // local：按评测表取值，未知模型回退通用阈值
  { config: { provider: 'local', model: 'bge-small-zh-v1.5@1.0.0' } },
  { config: { provider: 'local', model: 'multilingual-e5-small@1.0.0' } },
  { config: { provider: 'local', model: 'unknown@1.0.0' } },
  { config: { provider: 'local', model: 'bge-small-zh-v1.5@1.0.0' }, requested: 0.1 },
]

const EMBEDDING_CONFIGURED_CASES: EmbeddingConfigFixture[] = [
  { provider: 'openai', model: 'text-embedding-3-small', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' },
  // 缺 apiKey → 未配置
  { provider: 'openai', model: 'text-embedding-3-small', baseUrl: 'https://api.openai.com/v1' },
  { provider: 'openai', model: 'text-embedding-3-small', baseUrl: 'https://api.openai.com/v1', apiKey: '   ' },
  // 缺 baseUrl → 未配置
  { provider: 'openai', model: 'text-embedding-3-small', apiKey: 'sk-x' },
  { provider: 'openai', model: 'text-embedding-3-small', baseUrl: '  ', apiKey: 'sk-x' },
  // 缺 model → 未配置
  { provider: 'openai', model: '  ', baseUrl: 'https://x/v1', apiKey: 'sk-x' },
  // ollama 不需要 apiKey
  { provider: 'ollama', model: 'nomic-embed-text', baseUrl: 'http://127.0.0.1:11434' },
  { provider: 'ollama', model: 'nomic-embed-text' },
  // local：模型串必须符合 `name@x.y.z`
  { provider: 'local', model: 'bge-small-zh-v1.5@1.0.0' },
  { provider: 'local', model: 'bge-small-zh-v1.5' },
  { provider: 'local', model: 'BGE@1.0.0' },
  { provider: 'local', model: 'ab@1.0.0' },
  { provider: 'local', model: 'bge@1.0' },
  { provider: 'local', model: 'bge@1.0.0-rc.1' },
]

const EMBEDDING_SEMANTIC_ELIGIBLE_CASES: Array<{ priority?: 'always' | 'conditional' | 'detail'; matchMode?: 'keyword' | 'semantic' | 'both' }> = [
  {},
  { matchMode: 'semantic' },
  { matchMode: 'both' },
  { matchMode: 'keyword' },
  { priority: 'always' },
  { priority: 'always', matchMode: 'semantic' },
  { priority: 'detail', matchMode: 'semantic' },
  { priority: 'conditional', matchMode: 'keyword' },
]

// ---------------------------------------------------------------- 生成/校验

describe('chat-core 跨语言 golden fixture', () => {
  it('variables', () => {
    const cases = VARIABLE_CASES.map((c) => ({
      text: c.text,
      userName: c.userName,
      charName: c.charName,
      original: c.original ?? null,
      replaced: replaceVariables(c.text, c.userName, c.charName, c.original),
    }))
    writeFixture('variables', { version: 1, cases })

    // getDisplayName 单独一组（PC 语境的结构化对象）
    const displayCases = [
      { character: null, expected: getDisplayName(null) },
      { character: undefined, expected: getDisplayName(undefined) },
      { character: { name: 'Original' } as never, expected: getDisplayName({ name: 'Original' } as never) },
      {
        character: { name: 'Original', translatedContent: { name: '译名' } } as never,
        expected: getDisplayName({ name: 'Original', translatedContent: { name: '译名' } } as never),
      },
      {
        character: { name: 'Same', translatedContent: { name: 'Same' } } as never,
        expected: getDisplayName({ name: 'Same', translatedContent: { name: 'Same' } } as never),
      },
    ]
    expect(displayCases.map((c) => c.expected)).toEqual(['', '', 'Original', '译名 (Original)', 'Same'])
  })

  it('macros', () => {
    /**
     * 把非确定宏（{{random}} 实际选中的选项 / {{id}} 生成的短 ID）归一化为占位符。
     *
     * [template] 是**展开前**的原文（展开后 `{{id}}` 字面量已不存在，只能看模板判断）；
     * [chosen] 是本次实际选中的选项——必须按「实际值」替换，
     * 按「全部候选」替换会在展开值恰好等于某个未命中候选时漏改（同一用例随机会红/绿）。
     */
    const normalize = (expanded: string, template: string, chosen: string | null): string => {
      let out = expanded
      if (chosen) out = out.split(chosen).join('<RANDOM>')
      if (template.includes('{{id}}')) out = out.replace(/[a-z0-9]{6}/, '<ID>')
      return out
    }

    const cases = MACRO_CASES.map((text) => {
      const expanded = expandMacros(text, MACRO_CONTEXT)
      const randomOptions = text.includes('{{random:')
        ? text
            .slice(text.indexOf('{{random:') + 9, text.lastIndexOf('}}'))
            .split('|')
            .map((s) => s.trim())
        : null
      const randomChosen = randomOptions && randomOptions.length > 1
        ? randomOptions.find((o) => expanded.startsWith(o)) ?? null
        : randomOptions?.[0] ?? null
      // 只放**确定性**字段：golden 必须逐次运行完全一致，非确定的「本次选中值」不入库。
      return {
        text,
        hasMacro: hasMacro(text),
        randomOptions,
        // {{id}} 用例与非确定选项用例互斥，避免 "<RANDOM>" 的字母数字被当成 ID
        idShape: text.includes('{{id}}') ? /^[a-z0-9]{6}$/.test(expanded.replace(' 长度不定', '')) : null,
        normalized: normalize(expanded, text, randomChosen),
      }
    })
    writeFixture('macros', { version: 1, context: MACRO_CONTEXT, cases })

    // buildMacroContext 默认值
    const ctxCases = [
      buildMacroContext(undefined, { userName: 'u', charName: 'c' }),
      buildMacroContext([], { userName: 'u', charName: 'c' }),
      buildMacroContext(
        [
          { role: 'user', content: '一' },
          { role: 'assistant', content: '二' },
          { role: 'user', content: '三' },
          { role: 'assistant', content: '   ' },
        ],
        { userName: 'u', charName: 'c', groupName: 'g' },
      ),
    ]
    expect(ctxCases).toEqual([
      { userName: 'u', charName: 'c', originalCharName: undefined, groupName: undefined, lastMessage: '', lastUserMessage: '' },
      { userName: 'u', charName: 'c', originalCharName: undefined, groupName: undefined, lastMessage: '', lastUserMessage: '' },
      { userName: 'u', charName: 'c', originalCharName: undefined, groupName: 'g', lastMessage: '三', lastUserMessage: '三' },
    ])
  })

  it('regex rules', () => {
    const cases = REGEX_TEXTS.flatMap((text) =>
      (['input', 'output'] as const).flatMap((scope) =>
        (['text', 'markdown'] as const).map((stage) => ({
          text,
          scope,
          stage,
          result: applyRegexRules(text, REGEX_RULES, scope, stage),
        })),
      ),
    )
    writeFixture('regex-apply', { version: 1, rules: REGEX_RULES, cases })

    const outputCases = REGEX_TEXTS.map((text) => ({
      text,
      result: applyOutputRegexRules(text, REGEX_RULES),
    }))
    writeFixture('regex-output', { version: 1, cases: outputCases })

    const singleRuleCases = REGEX_TEXTS.map((text) => ({
      text,
      applied: REGEX_RULES.map((r) => {
        const outcome = applyRuleOnce(text, r)
        return { id: r.id, text: outcome.text, replaced: outcome.replaced }
      }),
    }))
    writeFixture('regex-single-rule', { version: 1, cases: singleRuleCases })

    const stopCases = REGEX_STOP_CASES.map((c) => ({
      ...c,
      findStopIndex: findStopIndex(c.text, c.stops),
      truncated: truncateAtStop(c.text, c.stops),
    }))
    writeFixture('regex-stops', { version: 1, cases: stopCases, collectedStops: collectStopStrings(REGEX_RULES) })

    const predicateCases = REGEX_RULES.flatMap((r) =>
      (['input', 'output'] as const).flatMap((scope) =>
        (['text', 'markdown'] as const).map((stage) => ({
          id: r.id,
          scope,
          stage,
          matchesScope: ruleMatchesScope(r, scope),
          matchesStage: ruleMatchesStage(r, scope, stage),
        })),
      ),
    )
    const triggerCases = REGEX_RULES.flatMap((r) =>
      REGEX_TEXTS.map((text) => ({ id: r.id, text, triggers: ruleTriggers(r, text) })),
    )
    writeFixture('regex-predicates', { version: 1, predicateCases, triggerCases })
    writeFixture('regex-safe', {
      version: 1,
      cases: [
        { pattern: 'a', flags: 'g', ok: safeRegExp('a', 'g') !== null },
        { pattern: '坏[', flags: 'g', ok: safeRegExp('坏[', 'g') !== null },
        { pattern: '', flags: 'g', ok: safeRegExp('', 'g') !== null },
        { pattern: 'x'.repeat(501), flags: 'g', ok: safeRegExp('x'.repeat(501), 'g') !== null },
        { pattern: 'x'.repeat(500), flags: 'g', ok: safeRegExp('x'.repeat(500), 'g') !== null },
      ],
    })
  })

  it('prompt converters', () => {
    // 私有 ChatMessage 的跨模块调用：显式断言一次，见文件头 converter() 注释
    const openai = converter<ChatMessage>(convertToOpenAI)
    const claude = converterWith<ChatMessage>(convertToClaude)
    const gemini = converter<ChatMessage>(convertToGemini)
    const viaProvider = (provider: string, messages: ChatMessage[]) =>
      convertMessages(provider, messages as never, { charName: 'c', userName: 'u' }) as unknown as ChatMessage[]
    const withPrefix = (messages: ChatMessage[], prefix?: string) =>
      addAssistantPrefix(messages as never, prefix) as unknown as ChatMessage[]

    const cases = CONVERTER_MESSAGE_SETS.map((messages) => ({
      messages,
      openai: openai(messages),
      claude: claude(messages, { charName: 'c', userName: 'u' }),
      gemini: gemini(messages),
      viaClaude: viaProvider('claude-3-5-sonnet', messages),
      viaGemini: viaProvider('gemini-1.5-pro', messages),
      viaOpenai: viaProvider('gpt-4o', messages),
      withPrefix: withPrefix(messages, '前缀'),
      withPrefixNoArg: withPrefix(messages),
    }))
    writeFixture('prompt-converters', { version: 1, cases })
  })

  it('message post process', () => {
    const merged = converter<ChatMessage>(mergeConsecutiveMessages)
    const strict = converter<ChatMessage>(strictAlternatingMessages)
    const semi = converter<ChatMessage>(semiStrictMessages)
    const cases = CONVERTER_MESSAGE_SETS.map((messages) => ({
      messages,
      merged: merged(messages),
      strict: strict(messages),
      semi: semi(messages),
      dialogue: DIALOGUE_CASES.map((d) => ({
        ...d,
        result: normalizeRoleplayDialoguePrefixes(d.text, d.name, d.mode),
      })),
    }))
    writeFixture('message-post-process', { version: 1, cases })
  })

  it('thought extraction', () => {
    const cases = THOUGHT_CASES.map((text) => ({
      text,
      extract: extractThought(text),
      stripped: stripThought(text),
      tagsOnly: stripThoughtTags(text),
    }))
    writeFixture('thought', { version: 1, cases })
  })

  it('continuation seam', () => {
    const cases = SEAM_CASES.map((c) => ({
      ...c,
      seam: trimContinuationSeam(c.prev, c.next),
      overlapDefault8: trimContinuationOverlap(c.prev, c.next),
      overlapCustom4: trimContinuationOverlap(c.prev, c.next, 4),
      overlapCustom3: trimContinuationOverlap(c.prev, c.next, 3),
    }))
    writeFixture('continuation-seam', { version: 1, cases })
  })

  it('token estimate', () => {
    const cases = TOKEN_CASES.map((c) => ({
      ...c,
      model: c.model ?? null,
      tokens: estimateTokens(c.text, c.model),
      formatted: formatTokens(estimateTokens(c.text, c.model)),
    }))
    writeFixture('token-estimate', {
      version: 1,
      cases,
      imageTokens: [0, 1, 3, -1].map((count) => ({ count, tokens: estimateImageTokens(count) })),
      formats: [0, 1, 999, 1000, 1500, 9999, 10000, 123456].map((tokens) => ({ tokens, text: formatTokens(tokens) })),
    })
  })

  it('lorebook lexical retrieval', () => {
    writeFixture('lorebook-tokenize', {
      version: 1,
      cases: TOKENIZE_CASES.map((text) => ({ text, tokens: tokenizeLexicalText(text) })),
    })

    const provider = new LexicalRetrievalProvider()
    provider.ensureIndex(RETRIEVAL_CORPUS)
    writeFixture('lorebook-search', {
      version: 1,
      providerId: provider.id,
      corpus: RETRIEVAL_CORPUS,
      cases: RETRIEVAL_QUERIES.map((q) => ({
        query: q.query,
        topK: q.topK ?? null,
        threshold: q.threshold ?? null,
        hits: provider.search({
          query: q.query,
          lorebooks: RETRIEVAL_CORPUS,
          ...(q.topK !== undefined ? { topK: q.topK } : {}),
          ...(q.threshold !== undefined ? { threshold: q.threshold } : {}),
        }),
      })),
    })

    writeFixture('retrieval-fusion', {
      version: 1,
      cases: FUSION_CASES.map((c) => ({ ...c, fused: reciprocalRankFusion(c.channels, c.options) })),
    })
  })

  it('lorebook render plan', () => {
    writeFixture('lorebook-render', {
      version: 1,
      cases: RENDER_CASES.map((items) => ({ items, plan: renderLorebookItems(items) })),
    })
  })

  it('memory summary window', () => {
    // 消息集合：id + content，用 tokenCounter 的启发式作为 estimator（两端同口径）
    const estimator = (value: string) => estimateTokens(value, 'gpt-4o')
    const formatter = (m: { id: string; content: string }) => `${m.id}:${m.content}`

    writeFixture('memory-budget', {
      version: 1,
      constants: {
        inputTokenBudget: MEMORY_SUMMARY_INPUT_TOKEN_BUDGET,
        minInputTokenBudget: MEMORY_SUMMARY_MIN_INPUT_TOKEN_BUDGET,
        overlapCount: MEMORY_SUMMARY_OVERLAP_COUNT,
      },
      cases: MEMORY_BUDGET_CASES.map((c) => ({
        maxContext: toSentinel(c.maxContext),
        systemPromptTokens: toSentinel(c.systemPromptTokens),
        reservedOutputTokens: toSentinel(c.reservedOutputTokens),
        resolved: resolveMemorySummaryInputBudget(c.maxContext, c.systemPromptTokens, c.reservedOutputTokens),
      })),
      oversized: MEMORY_OVERSIZED_CASES.map((c) => ({
        ...c,
        fitted: fitOversizedMemoryMessage(c.text, c.tokenBudget, estimator),
      })),
    })

    writeFixture('memory-window', {
      version: 1,
      messages: MEMORY_MESSAGES,
      cases: MEMORY_WINDOW_CASES.map((c) => {
        const window = buildMemorySummaryWindow(
          MEMORY_MESSAGES,
          c.cursorId ?? null,
          formatter,
          estimator,
          c.options ?? {},
        )
        return {
          cursorId: c.cursorId ?? null,
          options: c.options ?? {},
          pendingIds: window.pending.map((m) => m.id),
          overlapIds: window.overlap.map((m) => m.id),
          selectedIds: window.selected.map((m) => m.id),
          processedThroughMessageId: window.processedThroughMessageId,
        }
      }),
    })
  })

  it('context shared and input audit', () => {
    writeFixture('context-crop', {
      version: 1,
      constants: { tokenBudgetSafety: TOKEN_BUDGET_SAFETY, imageTokenEstimateForCrop: IMAGE_TOKEN_ESTIMATE },
      cases: CONTEXT_CROP_CASES.map((c) => {
        const crop = cropHistory(c.corpus as never[], c.usedTokens, c.budgetBase, c.model)
        return {
          // 每个用例自带语料：不同用例的图片/时间戳不同，共享一份会静默跑错
          corpus: c.corpus,
          usedTokens: c.usedTokens,
          budgetBase: c.budgetBase,
          model: c.model,
          recentIds: (crop.recent as Array<{ id: string }>).map((m) => m.id),
          droppedStartTs: crop.droppedStartTs,
          droppedEndTs: crop.droppedEndTs,
          droppedTokens: crop.droppedTokens,
          droppedEndIndex: crop.droppedEndIndex,
        }
      }),
    })

    writeFixture('context-depth-insert', {
      version: 1,
      cases: DEPTH_INSERT_CASES.map((c) => {
        const history = c.history.map((id) => ({ id }))
        const result = applyDepthInserts(
          history,
          c.inserts,
          (content: string) => ({ id: content }),
          (content: string, role?: string) => ({ id: role ? `${content}@${role}` : content }),
        )
        return {
          history: c.history,
          inserts: c.inserts,
          resultIds: (result as Array<{ id: string }>).map((m) => m.id),
        }
      }),
    })

    writeFixture('input-audit', {
      version: 1,
      maxReallocations: MAX_INPUT_REALLOCATIONS,
      cases: AUDIT_CASES.map((c) => ({
        provider: c.provider,
        model: c.model,
        parts: c.parts,
        reservedOutputTokens: toSentinel(c.reservedOutputTokens),
        contextLimit: toSentinel(c.contextLimit),
        protocolSafetyRatio: c.protocolSafetyRatio ?? null,
        serialized: c.serialized ?? false,
        audit: auditSerializedInput(
          { provider: c.provider, model: c.model, parts: c.parts, serialized: c.serialized ?? false },
          {
            reservedOutputTokens: c.reservedOutputTokens,
            contextLimit: c.contextLimit,
            ...(c.protocolSafetyRatio !== undefined ? { protocolSafetyRatio: c.protocolSafetyRatio } : {}),
          },
        ),
      })),
    })
  })

  it('response policy', () => {
    writeFixture('response-policy', {
      version: 1,
      constants: {
        ranges: RESPONSE_LENGTH_RANGES,
        labels: RESPONSE_LENGTH_LABELS,
        autoHardMaxChars: AUTO_HARD_MAX_CHARS,
        autoDefaultBaselineChars: AUTO_DEFAULT_BASELINE_CHARS,
        autoTargetMinChars: AUTO_TARGET_MIN_CHARS,
        autoTargetMaxChars: AUTO_TARGET_MAX_CHARS,
        autoBaselineWindow: AUTO_BASELINE_WINDOW,
        autoTargetParagraphs: AUTO_TARGET_PARAGRAPHS,
        autoMaxNewBeats: AUTO_MAX_NEW_BEATS,
      },
      visibleCharCases: RESPONSE_VISIBLE_CHAR_CASES.map((text) => ({
        text,
        count: countVisibleChars(text),
      })),
      medianCases: RESPONSE_MEDIAN_CASES.map((values) => ({
        values: values.map((v) => toSentinel(v)),
        median: median(values),
      })),
      collectCases: RESPONSE_COLLECT_CASES.map((c) => ({
        messages: c.messages,
        window: c.window ?? null,
        samples: collectRecentAssistantChars(c.messages as never[], c.window),
      })),
      intentCases: RESPONSE_INTENT_CASES.map((text) => ({
        text,
        intent: detectUserLengthIntent(text),
      })),
      sceneCases: RESPONSE_SCENE_CASES.map((c) => ({
        latestUserText: c.latestUserText,
        hasAssistantReply: c.hasAssistantReply,
        factor: resolveSceneFactor(c),
      })),
      modeCases: RESPONSE_MODE_CASES.map((c) => ({
        sessionMode: c.sessionMode ?? null,
        presetHint: c.presetHint ?? null,
        defaultMode: c.defaultMode ?? null,
        userIntent: c.userIntent ?? null,
        resolution: resolveResponseLengthMode(
          asModeInput({
            sessionMode: c.sessionMode ?? null,
            presetHint: c.presetHint ?? null,
            defaultMode: c.defaultMode ?? null,
            userIntent: c.userIntent ?? null,
          }),
        ),
      })),
      policyCases: RESPONSE_POLICY_CASES.map((c) => ({
        input: {
          sessionMode: c.sessionMode ?? null,
          presetHint: c.presetHint ?? null,
          defaultMode: c.defaultMode ?? null,
          userIntent: c.userIntent ?? null,
          recentAssistantVisibleChars: c.recentAssistantVisibleChars ?? null,
          sceneFactor: c.sceneFactor !== undefined ? toSentinel(c.sceneFactor) : null,
        },
        policy: resolveResponsePolicy({
          ...(c.sessionMode !== undefined ? { sessionMode: c.sessionMode } : {}),
          ...(c.presetHint !== undefined ? { presetHint: c.presetHint } : {}),
          ...(c.defaultMode !== undefined ? { defaultMode: c.defaultMode } : {}),
          ...(c.userIntent !== undefined ? { userIntent: c.userIntent } : {}),
          ...(c.recentAssistantVisibleChars !== undefined
            ? { recentAssistantVisibleChars: c.recentAssistantVisibleChars }
            : {}),
          ...(c.sceneFactor !== undefined ? { sceneFactor: c.sceneFactor } : {}),
        } as unknown as Parameters<typeof resolveResponsePolicy>[0]),
      })),
      promptCases: (['auto', 'brief', 'balanced', 'detailed'] as const).map((mode) => {
        const policy = resolveResponsePolicy({ sessionMode: mode })
        return { mode, prompt: buildMainChatOutputPrompt(policy) }
      }),
    })
  })

  it('generation termination and domain errors', () => {
    writeFixture('generation-termination', {
      version: 1,
      terminalStates: ['streaming', 'finalizing', 'persisted', 'cancelled', 'failed'],
      observationCases: OBSERVATION_CASES.map((c) => ({
        ...c,
        finishReason: c.finishReason ?? null,
        errorKind: c.errorKind ?? null,
        cancelReason: c.cancelReason ?? null,
        cause: observationTerminationCause(c),
      })),
      finishReasonCases: FINISH_REASONS.map((reason) => ({
        reason,
        cause: terminationCauseFromFinishReason(reason),
      })),
      effectiveCauseCases: EFFECTIVE_CAUSE_CASES.map((c) => ({
        cause: c.cause,
        providerFinishReason: c.providerFinishReason,
        effective: effectiveFinishReasonForCause(c.cause, c.providerFinishReason),
      })),
      withContentCases: TERMINATION_CAUSES.map((cause) => ({
        cause,
        prompt: terminationPromptWithContent(cause),
      })),
      withoutContentCases: TERMINATION_CAUSES.flatMap((cause) =>
        [undefined, '   ', '供应商原文错误'].map((errorMessage) => ({
          cause,
          errorMessage: errorMessage ?? null,
          text: terminationPromptWithoutContent(cause, errorMessage),
        })),
      ),
      contentFilterPreservesBody: contentFilterPreservesBody(),
      latchCases: LATCH_CASES.map((steps) => {
        const latch = createGenerationTerminationLatch(steps.requestId)
        const trace = steps.actions.map((action) => {
          switch (action.op) {
            case 'claim': {
              const ok = latch.claim(action.cause as never)
              return { op: 'claim', cause: action.cause, result: ok, state: latch.state, claimedCause: latch.claimedCause ?? null }
            }
            case 'markPersisted': {
              latch.markPersisted()
              return { op: 'markPersisted', result: null, state: latch.state, claimedCause: latch.claimedCause ?? null }
            }
            default: {
              return { op: 'accepts', result: latch.acceptsStreamEvent(), state: latch.state, claimedCause: latch.claimedCause ?? null }
            }
          }
        })
        return { requestId: steps.requestId, actions: steps.actions, trace, finalState: latch.state }
      }),
    })

    writeFixture('domain-errors', {
      version: 1,
      codes: DOMAIN_ERROR_CODES,
      retryableCodes: DOMAIN_ERROR_CODES.filter((code) => createDomainError(code, 'msg').retryable).sort(),
      createCases: DOMAIN_ERROR_CODES.map((code) => ({
        code,
        created: createDomainError(code, 'msg'),
        createdRetryableTrue: createDomainError(code, 'msg', { retryable: true }),
        createdRetryableFalse: createDomainError(code, 'msg', { retryable: false }),
      })),
      sanitizeCases: SANITIZE_CASES.map((raw) => ({ raw, sanitized: sanitizeErrorMessage(raw) })),
    })
  })

  it('memory facts and ranking', () => {
    // 事实记录的规范化序列化：文本事实 → {text}；结构化事实 → 原字段（省略 undefined）
    const rec = (fact: MemoryFactRecord): unknown =>
      typeof fact === 'string' ? { text: fact } : { ...fact }

    writeFixture('memory-facts', {
      version: 1,
      constants: {
        maxFacts: MAX_MEMORY_FACTS,
        maxFactHistory: MAX_MEMORY_FACT_HISTORY,
      },
      parseCases: FACT_PARSE_TEXTS.map((text) => {
        const parsed = parseMemoryResult(text)
        return {
          text,
          currentState: parsed.currentState,
          summary: parsed.summary,
          facts: parsed.facts,
          factChangesPresent: parsed.factChanges !== undefined,
          factChanges: parsed.factChanges === undefined ? null : parsed.factChanges,
          factProposalsPresent: parsed.factProposals !== undefined,
          factProposals: parsed.factProposals === undefined ? null : parsed.factProposals,
        }
      }),
      applyCases: FACT_APPLY_CASES.map((c, caseIndex) => {
        const result = c.proposals
          ? applyFactProposals(c.previousFacts, c.previousHistory ?? [], c.proposals, c.sourceMessageId, c.updatedAt)
          : applyMemoryFactChanges(c.previousFacts, c.previousHistory ?? [], c.changes ?? [], c.sourceMessageId, c.updatedAt)
        return {
          caseIndex,
          kind: c.proposals ? 'proposals' : 'changes',
          previousFacts: c.previousFacts.map(rec),
          previousHistory: (c.previousHistory ?? []).map(rec),
          changes: c.changes ?? null,
          proposals: c.proposals ?? null,
          sourceMessageId: c.sourceMessageId,
          updatedAt: c.updatedAt,
          facts: result.facts.map(rec),
          history: result.history.map(rec),
        }
      }),
      recencyCases: FACT_RECENCY_CASES.map((c) => ({
        updatedAt: c.updatedAt === undefined ? null : c.updatedAt,
        now: c.now,
        score: computeRecencyScore(c.updatedAt, c.now),
      })),
      rankCases: FACT_RANK_CASES.map((c) => ({
        facts: c.facts.map(rec),
        semanticScores: c.semanticScores ?? null,
        now: c.now,
        ranked: scoreAndRankFacts(c.facts, c.semanticScores, c.now).map((r) => ({
          text: memoryFactToText(r.fact),
          score: r.score,
          semantic: r.semantic,
          recency: r.recency,
          importance: r.importance,
          confidence: r.confidence,
        })),
      })),
      budgetCases: FACT_BUDGET_SELECT_CASES.map((c) => {
        const selectable = scoreAndRankFacts(c.facts, c.semanticScores ?? null, c.now).map((r) => r.fact)
        return {
          facts: c.facts.map(rec),
          semanticScores: c.semanticScores ?? null,
          now: c.now,
          budget: c.budget,
          selected: selectFactsByBudget(selectable, c.budget, (text) => estimateTokens(text)).map(rec),
        }
      }),
      layeredCases: FACT_LAYERED_CASES.map((c) => {
        const fitted = fitLayeredMemoryBudget(
          c.currentState ?? null,
          c.timeline,
          c.facts,
          c.budget,
          (text) => estimateTokens(text),
          undefined,
          c.semanticScores ?? null,
        )
        return {
          currentState: c.currentState ?? null,
          timeline: c.timeline,
          facts: c.facts.map(rec),
          budget: c.budget,
          semanticScores: c.semanticScores ?? null,
          now: c.now,
          fittedCurrentState: fitted.currentState,
          fittedTimeline: fitted.timeline,
          fittedFacts: fitted.facts.map(rec),
          retrievalMode: fitted.retrievalMode,
        }
      }),
      formatCases: FACT_FORMAT_CASES.map((facts) => ({
        facts: facts.map(rec),
        text: formatMemoryFacts(facts),
      })),
    })
  })

  it('narrative mode, thought contract and instruct templates', () => {
    writeFixture('narrative-thought-templates', {
      version: 1,
      narrative: {
        defaultMode: DEFAULT_NARRATIVE_MODE,
        options: NARRATIVE_MODE_OPTIONS,
        memoryGuidance: NARRATIVE_MODE_OPTIONS.map((option) => ({
          mode: option.value,
          guidance: getNarrativeMemoryGuidance(option.value),
        })),
        // 输入里的 undefined 无法经 JSON 往返（数组元素会变成 null），故用显式判别标记记录，
        // 由两端各自解码成实参；这与 fixture 的 NaN/Infinity 哨兵属同一类约定。
        isModeCases: NARRATIVE_IS_MODE_CASES.map((value) => ({
          value: modeArg(value),
          valid: isNarrativeMode(value),
        })),
        resolveCases: NARRATIVE_RESOLVE_CASES.map((candidates) => ({
          candidates: candidates.map(modeArg),
          resolved: resolveNarrativeMode(...candidates),
        })),
        labelCases: ['immersive', 'omniscient', 'unknown'].map((mode) => ({
          mode,
          label: getNarrativeModeLabel(mode as never),
        })),
        promptCases: NARRATIVE_PROMPT_CASES.map((c) => ({
          mode: c.mode,
          userName: c.userName,
          characterName: c.characterName,
          omniscientRules: c.omniscientRules ?? null,
          prompt: buildNarrativeModePrompt(
            c.mode,
            c.userName,
            c.characterName,
            c.omniscientRules,
          ),
        })),
      },
      thought: {
        clauses: [...THOUGHT_CONTRACT_CLAUSES],
        cases: CONTRACT_BODY_CASES.map((c) => ({
          narrativeMode: c.narrativeMode,
          subjectName: c.subjectName ?? null,
          body: buildThoughtContractBody({
            narrativeMode: c.narrativeMode,
            subjectName: c.subjectName,
          }),
        })),
      },
      templates: {
        builtinNames: BUILTIN_TEMPLATE_NAMES,
        byNameCases: TEMPLATE_NAME_CASES.map((name) => ({
          name: name ?? null,
          template: getTemplateByName(name) ?? null,
        })),
        inferCases: TEMPLATE_INFER_CASES.map((c) => ({
          provider: c.provider,
          model: c.model,
          template: getInstructTemplate(c.provider, c.model),
        })),
        effectiveCases: TEMPLATE_EFFECTIVE_CASES.map((c) => ({
          contextTemplate: c.contextTemplate ?? null,
          provider: c.provider,
          model: c.model,
          useInstructTemplate: c.useInstructTemplate ?? null,
          template: resolveEffectiveTemplate(
            c.contextTemplate,
            c.provider,
            c.model,
            c.useInstructTemplate,
          ) ?? null,
        })),
        applyCases: TEMPLATE_APPLY_CASES.map((c) => {
          const template = getTemplateByName(c.templateName)
          if (!template) throw new Error(`未知模板：${c.templateName}`)
          const applied = applyInstructTemplate(c.messages, template)
          return {
            templateName: c.templateName,
            messages: c.messages,
            text: applied.text,
            stopSequences: applied.stopSequences,
          }
        }),
      },
    })
  })

  it('memory candidates and injection', () => {
    const rec = (fact: MemoryFactRecord): unknown =>
      typeof fact === 'string' ? { text: fact } : { ...fact }

    writeFixture('memory-candidates', {
      version: 1,
      constants: {
        timelineTargetChunkTokens: MEMORY_TIMELINE_TARGET_CHUNK_TOKENS,
        timelineMaxChunkTokens: MEMORY_TIMELINE_MAX_CHUNK_TOKENS,
        timelineMaxChunks: MEMORY_TIMELINE_MAX_CHUNKS,
        stateScores: MEMORY_STATE_SCORES,
        timelineRelevance: MEMORY_TIMELINE_RELEVANCE,
        timelineImportance: MEMORY_TIMELINE_IMPORTANCE,
        factContinuity: MEMORY_FACT_CONTINUITY,
      },
      splitCases: MEMC_SPLIT_CASES.map((timeline) => ({
        timeline,
        chunks: splitTimelineIntoChunks(timeline).map((chunk) => ({
          id: chunk.id,
          index: chunk.index,
          text: chunk.text,
          tokens: chunk.tokens,
        })),
      })),
      buildCases: MEMC_BUILD_CASES.map((c, caseIndex) => {
        const set = buildMemoryCandidateSet(c)
        return {
          caseIndex,
          input: {
            currentState: c.currentState ?? null,
            timeline: c.timeline ?? null,
            facts: (c.facts ?? []).map(rec),
            semanticScores: c.semanticScores ?? null,
            model: c.model ?? null,
          },
          retrievalMode: set.retrievalMode,
          described: set.described,
          layerByCandidateId: set.layerByCandidateId,
          candidates: set.candidates,
        }
      }),
      selectCases: MEMC_SELECT_CASES.map((c, caseIndex) => {
        const set = buildMemoryCandidateSet(c.build)
        const selection = selectMemoryCandidates(set, {
          budgetTokens: c.budgetTokens,
          ...(c.competitors ? { competitors: c.competitors } : {}),
        })
        return {
          caseIndex,
          build: {
            currentState: c.build.currentState ?? null,
            timeline: c.build.timeline ?? null,
            facts: (c.build.facts ?? []).map(rec),
            semanticScores: c.build.semanticScores ?? null,
            model: c.build.model ?? null,
          },
          budgetTokens: c.budgetTokens,
          competitors: c.competitors ?? [],
          selection,
        }
      }),
      shadowCases: MEMC_SHADOW_CASES.map((c, caseIndex) => {
        const set = buildMemoryCandidateSet(c.build)
        const report = buildMemoryShadowReport({
          plan: set,
          existing: c.existing,
          budgetTokens: c.budgetTokens,
          ...(c.competitors ? { competitors: c.competitors } : {}),
        })
        return {
          caseIndex,
          build: {
            currentState: c.build.currentState ?? null,
            timeline: c.build.timeline ?? null,
            facts: (c.build.facts ?? []).map(rec),
            semanticScores: c.build.semanticScores ?? null,
            model: c.build.model ?? null,
          },
          existing: c.existing,
          budgetTokens: c.budgetTokens,
          competitors: c.competitors ?? [],
          report,
          formatted: formatMemoryShadowSummary(report),
        }
      }),
      materializeCases: MEMC_MATERIALIZE_CASES.map((c, caseIndex) => {
        const set = buildMemoryCandidateSet(c.build)
        const selected = c.selectedIds(set)
        const materialized = materializeMemoryInjection(set, selected, {
          currentState: c.build.currentState ?? null,
          facts: c.build.facts ?? [],
          timeline: c.build.timeline ?? null,
          semanticScores: c.build.semanticScores ?? null,
          model: c.build.model,
        })
        return {
          caseIndex,
          build: {
            currentState: c.build.currentState ?? null,
            timeline: c.build.timeline ?? null,
            facts: (c.build.facts ?? []).map(rec),
            semanticScores: c.build.semanticScores ?? null,
            model: c.build.model ?? null,
          },
          selectedIds: selected,
          currentState: materialized.currentState,
          facts: materialized.facts.map(rec),
          timeline: materialized.timeline,
          retrievalMode: materialized.retrievalMode,
        }
      }),
    })
  })

  it('text metrics, finalizer and reply pipeline', async () => {
    // 与 Kotlin 侧同样实现的「最长后缀/前缀重叠」去重器（供 mergeTailRepair 用例注入）
    const trimOverlap = (prev: string, next: string): string => {
      const max = Math.min(prev.length, next.length)
      for (let i = max; i > 0; i--) {
        if (prev.endsWith(next.slice(0, i))) return next.slice(i)
      }
      return next
    }

    // 管线是异步入口：先异步收集，再一次性写入（不能写两次——只读校验会因此失效）
    const runCases: unknown[] = []
    for (const c of PIPELINE_RUN_CASES) {
      const outcome = await runGeneratedReplyPipeline({
        rawText: c.rawText,
        finishReason: c.finishReason,
        regexRules: c.regexRules,
        characterName: '苏晚',
        ...(c.repairText !== undefined ? { runTailRepair: async () => c.repairText ?? null } : {}),
        ...(c.allowEmptyTailPassthrough !== undefined
          ? { allowEmptyTailPassthrough: c.allowEmptyTailPassthrough }
          : {}),
      })
      runCases.push({
        rawText: c.rawText,
        finishReason: c.finishReason,
        regexRules: c.regexRules,
        repairText: c.repairText ?? null,
        // 必须显式记录「是否注入补尾执行器」：repairText=null 与「未注入」语义不同
        hasRepair: c.repairText !== undefined,
        allowEmptyTailPassthrough: c.allowEmptyTailPassthrough ?? null,
        content: outcome.content,
        status: outcome.status,
        notice: outcome.notice ?? null,
        repairFailed: outcome.repairFailed ?? false,
      })
    }

    const terminalCases: unknown[] = []
    for (const c of PIPELINE_TERMINAL_CASES) {
      const outcome = await finalizeGenerationTerminalResult({
        terminalResult: {
          rawText: c.rawText,
          finishReason: c.finishReason,
          terminationCause: c.terminationCause,
          ...(c.errorMessage !== undefined ? { errorMessage: c.errorMessage } : {}),
        },
        regexRules: c.regexRules,
        characterName: '苏晚',
        ...(c.repairText !== undefined ? { runTailRepair: async () => c.repairText ?? null } : {}),
      })
      terminalCases.push({
        rawText: c.rawText,
        finishReason: c.finishReason,
        terminationCause: c.terminationCause,
        errorMessage: c.errorMessage ?? null,
        regexRules: c.regexRules,
        repairText: c.repairText ?? null,
        hasRepair: c.repairText !== undefined,
        content: outcome.content,
        status: outcome.status,
        persistable: outcome.persistable,
        noticeFields: outcome.noticeFields,
        notice: outcome.notice ?? null,
        repairFailed: outcome.repairFailed ?? false,
      })
    }

    writeFixture('text-finalizer-pipeline', {
      version: 1,
      metrics: {
        sentenceEndChars: [...SENTENCE_END_CHARS].sort(),
        tailSampleMaxChars: TAIL_SAMPLE_MAX_CHARS,
        visibleCases: METRICS_VISIBLE_CASES.map((text) => ({ text, visible: countVisibleCharacters(text) })),
        completeSentenceCases: METRICS_SENTENCE_CASES.map((text) => ({ text, complete: isCompleteSentence(text) })),
        trimBoundaryCases: METRICS_TRIM_CASES.map((c) => ({
          text: c.text,
          minChars: c.minChars,
          maxChars: c.maxChars,
          result: trimToSentenceBoundary(c.text, { minChars: c.minChars, maxChars: c.maxChars }) ?? null,
        })),
        tailSampleCases: METRICS_TAIL_CASES.map((c) => ({
          text: c.text,
          maxChars: c.maxChars ?? null,
          sample: c.maxChars === undefined ? tailSample(c.text) : tailSample(c.text, c.maxChars),
        })),
        closureCases: METRICS_CLOSURE_CASES.map((text) => ({ text, closure: analyzeTextClosure(text) })),
      },
      finalizer: {
        repairContextCases: FINALIZER_REPAIR_CONTEXT_CASES.map((rawText) => ({
          rawText,
          context: buildRepairContext(rawText),
        })),
        finalizeCases: FINALIZER_CASES.map((c) => {
          const result = finalizeAssistantOutput({ rawText: c.rawText, finishReason: c.finishReason })
          return {
            rawText: c.rawText,
            finishReason: c.finishReason,
            content: result.content,
            status: result.status,
            notice: result.notice ?? null,
            repairContext: result.repairContext ?? null,
            brokenTail: result.brokenTail ?? null,
            diagnostics: result.diagnostics,
          }
        }),
        mergeCases: FINALIZER_MERGE_CASES.map((c) => {
          const base = finalizeAssistantOutput({ rawText: c.rawText, finishReason: c.finishReason })
          const merged = mergeTailRepair({
            finalized: base,
            repairText: c.repairText,
            trimOverlap,
            finishReason: c.mergeFinishReason,
          })
          return {
            rawText: c.rawText,
            finishReason: c.finishReason,
            repairText: c.repairText,
            mergeFinishReason: c.mergeFinishReason ?? null,
            baseStatus: base.status,
            baseContent: base.content,
            content: merged.content,
            status: merged.status,
            notice: merged.notice ?? null,
          }
        }),
      },
      pipeline: { runCases, terminalCases },
    })
  })


  it('model output profile, reasoning gate and task budget', () => {
    writeFixture('budget-chain', {
      version: 1,
      constants: {
        protocolReserveTokens: PROTOCOL_RESERVE_TOKENS,
        defaultAutomaticOutputLimit: DEFAULT_AUTOMATIC_OUTPUT_LIMIT,
        defaultAutomaticReasoningReserve: DEFAULT_AUTOMATIC_REASONING_RESERVE,
        bodyReserveMultiplier: BODY_RESERVE_MULTIPLIER,
        bodyReserveOverheadTokens: BODY_RESERVE_OVERHEAD_TOKENS,
        minUsableBodyTokens: MIN_USABLE_BODY_TOKENS,
        lowGateTokens: LOW_GATE_TOKENS,
        gateProbeMaxSamples: GATE_PROBE_MAX_SAMPLES,
        taskBodyDefaults: TASK_BODY_DEFAULTS_FOR_FIXTURE,
        tasks: Object.keys(TASK_BODY_DEFAULTS_FOR_FIXTURE),
      },
      profileCases: PROFILE_MODELS.map((model) => ({ model, profile: getModelOutputProfile(model) })),
      resolveProfileCases: PROFILE_RESOLVE_CASES.map((c) => ({
        model: c.model,
        userOverride: c.userOverride ?? null,
        runtimeCorrection: c.runtimeCorrection ?? null,
        profile: resolveModelOutputProfile(c.model, {
          ...(c.userOverride ? { userOverride: c.userOverride } : {}),
          ...(c.runtimeCorrection ? { runtimeCorrection: c.runtimeCorrection } : {}),
        }),
      })),
      // 样本本身可能含 NaN：数组元素无法经 JSON 往返，必须哨兵化
      percentileCases: PERCENTILE_CASES.map((values) => ({ values: values.map((v) => toSentinel(v)), p90: percentile90(values) })),
      reserveCases: RESERVE_CASES.map((c) => ({
        model: c.model,
        recentReasoningTokens: c.recentReasoningTokens ?? null,
        reserve: resolveReasoningReserve(getModelOutputProfile(c.model), c.recentReasoningTokens),
      })),
      // null 与 undefined 对 resolveUserHardCap 行为一致，统一记为 null；NaN 必须哨兵化
      hardCapCases: HARD_CAP_CASES.map((value) => ({
        value: value === undefined || value === null ? null : toSentinel(value),
        cap: resolveUserHardCap(value),
      })),
      overrideCases: OVERRIDE_CASES.map((c) => ({
        enabled: c.enabled ?? null,
        contextLimit: c.contextLimit ?? null,
        outputLimit: c.outputLimit ?? null,
        override: enabledProfileOverride(c) ?? null,
      })),
      contextLimitCases: CONTEXT_LIMIT_CASES.map((c) => ({
        model: c.model,
        profileMaxContext: c.profileMaxContext ?? null,
        presetMaxContext: c.presetMaxContext ?? null,
        capabilityOverride: c.capabilityOverride ?? null,
        limit: resolveEffectiveContextLimit(c),
      })),
      requestBudgetCases: REQUEST_BUDGET_CASES.map((c) => {
        const budget = resolveRequestBudget(c)
        return {
          input: {
            model: c.model,
            hardMaxChars: c.hardMaxChars,
            userHardCap: c.userHardCap ?? null,
            recentReasoningTokens: c.recentReasoningTokens ?? null,
            reasoningGate: c.reasoningGate ?? null,
            profileOverride: c.profileOverride ?? null,
          },
          model: budget.model,
          profile: budget.profile,
          bodyReserve: budget.bodyReserve,
          reasoningReserve: budget.reasoningReserve,
          minimumViableOutputTokens: budget.minimumViableOutputTokens,
          requestMaxTokens: budget.requestMaxTokens,
          gate: budget.gate ?? null,
          riskNotice: budget.riskNotice ?? null,
          formattedRisk: formatRequestBudgetRisk(budget),
        }
      }),
      gateCases: GATE_RESOLVE_CASES.map((c) => ({
        input: {
          model: c.model,
          enabled: c.enabled ?? null,
          auxiliary: c.auxiliary ?? null,
          requestedLevel: c.requestedLevel ?? null,
          startLevel: c.startLevel ?? null,
          probe: c.probe ?? null,
          recentReasoningTokens: c.recentReasoningTokens ?? null,
        },
        resolved: resolveReasoningGate(c),
      })),
      levelCases: REASONING_LEVELS.flatMap((level) =>
        (['thinking-disable', 'reasoning-effort', 'thinking-budget', 'gemini-thinking-config', 'none', 'unknown'] as const).map((knob) => ({
          level,
          knob,
          tokens: levelToTokens(level, knob),
        })),
      ),
      nextLowerCases: REASONING_LEVELS.map((level) => ({ level, next: nextLowerGateLevel(level) ?? null })),
      knobCases: KNOB_CASES.map((c) => ({
        model: c.model,
        level: c.level,
        probe: c.probe ?? null,
        knob: selectGateKnob(getModelOutputProfile(c.model), c.probe, c.level),
      })),
      defaultLevelCases: DEFAULT_LEVEL_CASES.map((c) => ({
        model: c.model,
        enabled: c.enabled,
        auxiliary: c.auxiliary ?? null,
        level: resolveDefaultGateLevel(c) ?? null,
      })),
      probeMergeCases: PROBE_MERGE_CASES.map((c) => {
        const merged = mergeGateProbe(c.current, c.update)
        return {
          current: c.current ?? null,
          update: { ...c.update, ...(c.update.reasoningTokens !== undefined ? { reasoningTokens: toSentinel(c.update.reasoningTokens) } : {}) },
          merged: {
            knob: merged.knob,
            knobAccepted: merged.knobAccepted ?? null,
            disableIgnored: merged.disableIgnored ?? null,
            reportsReasoningUsage: merged.reportsReasoningUsage ?? null,
            recentReasoningTokens: merged.recentReasoningTokens,
            updatedAt: merged.updatedAt,
          },
        }
      }),
      clampCases: CLAMP_CASES.map((c) => ({
        gateTokens: toSentinel(c.gateTokens),
        requestMaxTokens: toSentinel(c.requestMaxTokens),
        clamped: clampGateBudgetForBody(c.gateTokens, c.requestMaxTokens),
      })),
      bodyCharsCases: BODY_CHARS_CASES.map((c) => ({
        task: c.task,
        inputChars: c.inputChars ?? null,
        expectedBodyChars: c.expectedBodyChars ?? null,
        chars: resolveGenerationTaskBodyChars(c),
      })),
      expandCases: EXPAND_CASES.map((c) => ({
        currentMaxTokens: c.currentMaxTokens,
        budget: c.budget,
        observedReasoningTokens: c.observedReasoningTokens === undefined
          ? null
          : toSentinel(c.observedReasoningTokens),
        next: expandAdaptiveOutputBudget(c) ?? null,
      })),
      taskBudgetCases: TASK_BUDGET_CASES.map((c) => {
        const budget = resolveGenerationTaskBudget(c)
        return {
          input: {
            task: c.task,
            model: c.model,
            inputChars: c.inputChars ?? null,
            expectedBodyChars: c.expectedBodyChars ?? null,
            userHardCap: c.userHardCap ?? null,
            recentReasoningTokens: c.recentReasoningTokens ?? null,
            reasoningLevel: c.reasoningLevel ?? null,
          },
          task: budget.task,
          expectedBodyChars: budget.expectedBodyChars,
          reasoningGate: budget.reasoningGate,
          requestMaxTokens: budget.requestMaxTokens,
          bodyReserve: budget.bodyReserve,
          reasoningReserve: budget.reasoningReserve,
          minimumViableOutputTokens: budget.minimumViableOutputTokens,
          profileOutputLimit: budget.profile.outputLimit,
          adaptiveOutputBudget: budget.adaptiveOutputBudget ?? null,
        }
      }),
    })
  })

  it('context builder (no-lorebook subset)', () => {
    writeFixture('context-builder', {
      version: 1,
      constants: {
        defaultSystemPrompt:
          '你是一个沉浸式互动叙事助手。请根据角色与世界设定持续创作，保持人物和情节的一致性。',
        defaultUserName: '用户',
        defaultModel: 'gpt-4o-mini',
        continuationInstruction:
          '请直接接续上一段内容的结尾继续写作，保持相同的风格、语气和叙事视角。不要重复已有内容，直接输出续写部分。',
      },
      planCases: CTX_PLAN_CASES.map((c, caseIndex) => {
        const plan = resolveChatRequestPlan(c.data)
        return {
          caseIndex,
          data: c.data,
          responsePolicy: plan.responsePolicy,
          requestMaxTokens: plan.requestMaxTokens,
          responseIntent: plan.responseIntent ?? null,
          sceneFactor: plan.sceneFactor,
          bodyReserve: plan.requestBudget.bodyReserve,
          reasoningReserve: plan.requestBudget.reasoningReserve,
        }
      }),
      buildCases: CTX_BUILD_CASES.map((c, caseIndex) => {
        const result = buildContextMessagesFromData(c.data, c.opts)
        return {
          caseIndex,
          data: c.data,
          opts: c.opts ?? null,
          lorebooks: c.data.lorebooks,
          messages: result.messages.map((m) => ({
            role: m.role,
            content: m.content,
            images: m.images ?? null,
            keepSeparate: (m as { keepSeparate?: boolean }).keepSeparate ?? false,
          })),
          lastContextUsage: result.lastContextUsage,
          responsePolicy: result.responsePolicy,
          requestMaxTokens: result.requestMaxTokens,
          responseIntent: result.responseIntent ?? null,
          sceneFactor: result.sceneFactor,
          narrativeMode: result.narrativeMode,
          pendingCompression: result.pendingCompression ?? null,
        }
      }),
    })
  })

  it('session export (markdown and json)', () => {
    // 时间渲染注入固定格式：`toLocaleString('zh-CN')` 的产物依赖运行时 ICU 数据，
    // 两端未必逐字节相同。结构由本 fixture 锁定，时间格式由各端自行测试。
    const formatTime = (timestamp: number): string => `T${timestamp}`
    writeFixture('session-export', {
      version: 1,
      formatterNote: 'fixture 使用 formatTime=ts=>`T${ts}` 注入固定时间，锁定结构与转义',
      escapeCases: EXPORT_ESCAPE_CASES.map((text) => ({ text, escaped: escapeMarkdownContent(text) })),
      roleLabelCases: EXPORT_ROLE_CASES.map((role) => ({ role, label: exportRoleLabel(role) })),
      markdownCases: EXPORT_MESSAGE_CASES.map((c, caseIndex) => ({
        caseIndex,
        messages: c.messages,
        markdown: exportSessionMarkdown(c.messages, { formatTime }),
      })),
      jsonCases: EXPORT_MESSAGE_CASES.map((c, caseIndex) => ({
        caseIndex,
        messages: c.messages,
        json: exportSessionJson(c.messages),
      })),
    })
  })

  it('message translation prompt', () => {
    writeFixture('translation-prompt', {
      version: 1,
      constants: { defaultTargetLang: '中文' },
      promptCases: TRANSLATION_LANGS.map((targetLang) => ({
        targetLang,
        prompt: buildMessageTranslationSystemPrompt(targetLang),
      })),
    })
  })

  it('ai input helper (continue and polish)', () => {
    writeFixture('ai-input-helper', {
      version: 1,
      constants: {
        defaultIntensity: DEFAULT_CONTINUE_INTENSITY,
        defaultLength: DEFAULT_CONTINUE_LENGTH,
        intensityTemperatures: CONTINUE_INTENSITY_PARAMS,
        lengthParams: CONTINUE_LENGTH_PARAMS,
        tolerance: CONTINUE_LENGTH_TOLERANCE,
      },
      perspectiveCases: PERSPECTIVE_CASES.map((c) => ({
        raw: c.raw,
        userName: c.userName ?? '旅人',
        charName: c.charName ?? '苏晚',
        result: ensureUserPerspective(c.raw, c.userName ?? '旅人', c.charName ?? '苏晚'),
      })),
      normalizeCases: NORMALIZE_CASES.map((c) => ({
        raw: c.raw,
        narrativeMode: c.narrativeMode,
        result: normalizeContinueOutput(c.raw, '旅人', '苏晚', c.narrativeMode),
      })),
      tagCases: TAGGED_CASES.map((c) => ({
        raw: c.raw,
        tag: c.tag,
        result: extractTaggedResult(c.raw, c.tag),
      })),
      parseCases: PARSE_CASES.map((c) => ({
        raw: c.raw,
        charName: c.charName ?? '苏晚',
        narrativeMode: c.narrativeMode ?? 'immersive',
        result: parseContinueResult(c.raw, '旅人', c.charName ?? '苏晚', c.narrativeMode ?? 'immersive'),
      })),
      failureCases: FAILURE_CASES.map((raw) => ({
        raw,
        kind: classifyContinueFailure(raw),
        shouldRetry: shouldRetryContinueFormat(raw),
      })),
      lengthCases: LENGTH_EVAL_CASES.map((c) => {
        const evaluation = evaluateContinueLength(c.text, c.length)
        return {
          text: c.text,
          length: c.length,
          chars: evaluation.chars,
          truncated: evaluation.truncated,
          action: evaluation.action,
          trimmedText: evaluation.trimmedText ?? null,
          acceptableAfterRepair: isAcceptableAfterLengthRepair(c.text, c.length),
        }
      }),
      repairInstructionCases: REPAIR_CASES.map((c) => ({
        mode: c.mode,
        length: c.length,
        chars: c.chars,
        truncated: c.truncated,
        instruction: buildLengthRepairInstruction(c.mode, c.length, { chars: c.chars, truncated: c.truncated }),
      })),
      systemPromptCases: SYSTEM_PROMPT_CASES.map((c) => ({
        userName: '旅人',
        charName: '苏晚',
        hasInput: c.hasInput,
        narrativeMode: c.narrativeMode,
        intensity: c.intensity,
        length: c.length,
        prompt: buildContinueSystemPrompt('旅人', '苏晚', c.hasInput, c.narrativeMode, c.intensity, c.length),
      })),
      contextCases: CONTEXT_CASES.map((c) => ({
        input: {
          userName: '旅人',
          charName: '苏晚',
          hasInput: c.hasInput,
          narrativeMode: c.narrativeMode,
          originalInput: c.originalInput,
          // 强度与长度必须一并记录：否则输入无法唯一决定期望输出
          intensity: c.intensity ?? null,
          length: c.length ?? null,
        },
        messages: buildContinueContext({
          character: { description: '旧书店的店主。', scenario: '深夜的旧书店' } as Character,
          userName: '旅人',
          charName: '苏晚',
          recentMessages: [
            { role: 'user', content: '夜安。' },
            { role: 'assistant', content: '<thought>内心</thought>夜安，要坐一会儿吗？' },
          ] as Message[],
          originalInput: c.originalInput,
          hasInput: c.hasInput,
          narrativeMode: c.narrativeMode,
          intensity: c.intensity,
          length: c.length,
        }),
      })),
    })
  })

  it('dialogue directions (parse, validate and prompts)', () => {
    writeFixture('dialogue-directions', {
      version: 1,
      constants: {
        tendencies: [...DIALOGUE_TENDENCIES],
        limits: DIALOGUE_DIRECTION_LIMITS,
        temperature: DIALOGUE_DIRECTION_TEMPERATURE,
        tag: DIALOGUE_DIRECTIONS_TAG,
      },
      enabledCases: DIRECTIONS_ENABLED_CASES.map((c) => ({
        dialogueDirectionsEnabled: c.dialogueDirectionsEnabled ?? null,
        gameMasterMode: c.gameMasterMode ?? null,
        enabled: resolveDialogueDirectionsEnabled(c as never),
      })),
      payloadCases: DIRECTIONS_PAYLOAD_CASES.map((raw) => ({ raw, payload: extractDirectionsPayload(raw) })),
      parseCases: DIRECTIONS_PARSE_CASES.map((raw) => ({
        raw,
        directions: parseDialogueDirections(raw),
      })),
      similarityCases: DIRECTIONS_SIMILARITY_CASES.map((directions) => ({
        directions,
        similar: hasSimilarDirections(directions),
      })),
      promptCases: DIRECTIONS_PROMPT_CASES.map((c) => {
        const input = {
          userName: '旅人',
          charName: '苏晚',
          characterDescription: c.characterDescription ?? '旧书店的店主。',
          narrativeMode: c.narrativeMode,
          recentMessages: [
            { speaker: '旅人', content: '夜安。' },
            { speaker: '苏晚', content: '夜安，要坐一会儿吗？' },
          ],
          latestReply: '她把茶推到他面前。',
          ...(c.worldState !== undefined ? { worldState: c.worldState } : {}),
        }
        return {
          input: { ...input, worldState: c.worldState ?? null },
          systemPrompt: buildDialogueDirectionSystemPrompt(input),
          userPrompt: buildDialogueDirectionUserPrompt(input),
        }
      }),
    })
  })

  it('swipe candidates (regenerate and rotate)', () => {
    writeFixture('swipe-candidates', {
      version: 1,
      regenerateCases: SWIPE_TARGETS.map((target) => ({
        target,
        newContent: '新的候选正文。',
        result: appendRegeneratedCandidate(target, '新的候选正文。'),
      })),
      rotateCases: SWIPE_ROTATE_CASES.map((c) => ({
        target: c.target,
        direction: c.direction,
        result: rotateSwipe(c.target, c.direction),
      })),
      positionCases: SWIPE_TARGETS.map((target) => ({ target, position: candidatePosition(target) }))
        .concat(SWIPE_ROTATE_CASES.map((c) => ({ target: c.target, position: candidatePosition(c.target) }))),
    })
  })

  it('lorebook budget fit and allocation', () => {
    writeFixture('lorebook-budget', {
      version: 1,
      constants: {
        alwaysRatio: LOREBOOK_PRIORITY_BUDGET.always,
        alwaysPlusConditionalRatio: LOREBOOK_PRIORITY_BUDGET.alwaysPlusConditional,
        minCompressTargetTokens: 32,
        compressionCacheMaxEntries: 10,
      },
      hashCases: HASH_CASES.map((text) => ({ text, hash: hashString(text) })),
      compressionKeyCases: COMPRESSION_KEY_CASES.map((items) => ({
        items,
        key: buildCompressionKey(items),
      })),
      allocateCases: ALLOCATE_CASES.map((c) => ({
        globalBudget: c.globalBudget,
        bookBudgets: Object.fromEntries(c.bookBudgets),
        result: (() => {
          const allocated = allocateGlobalBudgetByBooks(c.globalBudget, c.bookBudgets)
          return allocated ? Object.fromEntries(allocated) : null
        })(),
      })),
      enforceCases: ENFORCE_CASES.map((c) => {
        const result = enforceBookBudgets(
          c.items as never[],
          new Map(Object.entries(c.bookCaps)),
          new Map(Object.entries(c.lbIdByKey)),
          c.model,
        )
        return {
          items: c.items,
          bookCaps: c.bookCaps,
          lbIdByKey: c.lbIdByKey,
          model: c.model,
          kept: result.items.map((i) => ({ key: i.key ?? null, content: i.content })),
          dropped: result.dropped,
        }
      }),
      fitCases: FIT_CASES.map((c) => {
        const result = fitLorebookBudgetByPriority(
          c.items as never[],
          c.budget,
          c.model,
          c.compressionCache ? Object.fromEntries(c.compressionCache) : undefined,
        )
        return {
          items: c.items,
          budget: c.budget,
          model: c.model,
          compressionCache: c.compressionCache ? Object.fromEntries(c.compressionCache) : null,
          keptKeys: result.kept.map((i) => i.key ?? null),
          keptContents: result.kept.map((i) => i.content),
          droppedKeys: result.droppedItems.map((i) => i.key ?? null),
          usedTokens: result.usedTokens,
          alwaysDropped: result.alwaysDropped,
          conditionalDropped: result.conditionalDropped,
          detailDropped: result.detailDropped,
          compressionRequests: result.compressionRequests ?? null,
          compressionCacheHitKeys: result.compressionCacheHitKeys ?? null,
          compressionCoveredKeys: result.compressionCoveredItems.map((i) => i.key ?? null),
        }
      }),
      cacheCases: CACHE_CASES.map((c) => {
        const next = upsertCompressionCache(c.initial, c.key, c.entry, c.maxEntries ?? undefined)
        return {
          initial: c.initial ?? null,
          key: c.key,
          entry: c.entry,
          maxEntries: c.maxEntries ?? null,
          result: next,
        }
      }),
      touchCases: TOUCH_CASES.map((c) => ({
        cache: c.cache ?? null,
        keys: c.keys,
        usedAt: c.usedAt,
        result: touchCompressionCache(c.cache, c.keys, c.usedAt) ?? null,
      })),
    })
  })

  it('lorebook scoring (keyword, overlap, entity, unified)', () => {
    writeFixture('lorebook-scoring', {
      version: 1,
      constants: {
        weights: LOREBOOK_SCORE_WEIGHTS,
        recencyWindow: LOREBOOK_RECENCY_WINDOW,
      },
      stripCases: LORE_STRIP_CASES.map((text) => ({ text, stripped: stripMarkdownNoise(text) })),
      escapeCases: LORE_ESCAPE_CASES.map((text) => ({ text, escaped: escapeRegExp(text) })),
      keywordCases: LORE_KEYWORD_CASES.map((c) => ({
        keyword: c.keyword,
        text: c.text,
        matched: keywordMatch(c.keyword, c.text),
      })),
      overlapCases: LORE_OVERLAP_CASES.map((c) => ({
        keywords: c.keywords,
        content: c.content,
        dialogue: c.dialogue,
        score: semanticScoreByOverlap({ keywords: c.keywords, content: c.content }, c.dialogue),
      })),
      overlapApproxCases: LORE_OVERLAP_APPROX_CASES.map((c) => ({
        itemScore: c.itemScore ?? null,
        content: c.content,
        semanticByContent: Object.fromEntries(c.semanticByContent ?? []),
        useApprox: shouldUseOverlapApprox(
          { content: c.content, ...(c.itemScore !== undefined ? { score: c.itemScore } : {}) },
          new Map(c.semanticByContent ?? []),
        ),
      })),
      entityCases: LORE_ENTITY_CASES.map((c) => {
        const entities = extractEntities({
          scanTextLower: c.scanTextLower,
          charName: c.charName,
          entityVocabulary: c.entityVocabulary,
          lorebooks: [lorebookForScoring(c.entries)],
        })
        return {
          scanTextLower: c.scanTextLower,
          charName: c.charName,
          entityVocabulary: c.entityVocabulary,
          entries: c.entries,
          entities: [...entities].sort(),
        }
      }),
      entityBoostCases: LORE_ENTITY_BOOST_CASES.map((c) => ({
        keywords: c.keywords,
        content: c.content,
        recentEntities: c.recentEntities,
        boosted: checkEntityBoost({ keywords: c.keywords, content: c.content }, new Set(c.recentEntities)),
      })),
      recencyCases: LORE_RECENCY_CASES.map((c) => ({
        previous: c.previous ?? null,
        ids: c.ids,
        result: appendRecentTriggeredIds(c.previous, c.ids),
      })),
      scoreCases: LORE_SCORE_CASES.map((c) => {
        const entriesByKey = new Map(
          Object.entries(c.entries).map(([key, entry]) => [key, loreEntryForScoring(entry)]),
        )
        const scored = scoreItems(
          c.items.map((item) => ({ ...item })),
          {
            scanText: c.scanText,
            scanTextLower: c.scanText.toLowerCase(),
            dialogueText: c.dialogueText,
            dialogueTextLower: c.dialogueText.toLowerCase(),
            entriesByKey,
            semanticScoreByContent: new Map(c.semanticByContent ?? []),
            recentEntities: new Set(c.recentEntities ?? []),
            recentTriggered: new Set(c.recentTriggered ?? []),
          } as never,
        )
        return {
          input: {
            ...c,
            semanticByContent: Object.fromEntries(c.semanticByContent ?? []),
          },
          scored: scored.map((s) => ({
            key: s.key ?? null,
            keywordHits: s.keywordHits,
            semanticScore: s.semanticScore,
            semanticSource: s.semanticSource,
            entityHit: s.entityHit,
            recencyHit: s.recencyHit,
            score: s.score,
          })),
        }
      }),
    })
  })

  it('lorebook runtime (trigger pipeline and distribution)', () => {
    // 词法通道在 Android 侧未接入触发管线，因此夹具让 PC 也走「无词法」路径，
    // 保证比较的是同一回事（生产差异已在 Kotlin 侧文档与报告中显式记录）。
    const unavailableLexicalProvider = {
      available: () => ({ available: false, reason: 'fixture: 词法通道未接入' }),
      search: () => [],
    }
    writeFixture('lorebook-runtime', {
      version: 1,
      note: 'fixture 使用无词法 provider + 概率 100/0，保证确定性；不覆盖时效/包含组/向量/诊断',
      cases: LORE_RUNTIME_CASES.map((c, caseIndex) => {
        const result = executeLorebookRuntime({
          lorebooks: c.lorebooks.map(lorebookForRuntime),
          scanText: c.scanText,
          scanMessages: c.scanMessages,
          userName: c.userName,
          charName: c.charName,
          characterNames: c.characterNames,
          characterTags: c.characterTags,
          generationType: c.generationType,
          messageCount: c.messageCount,
          budget: c.budget,
          model: c.model,
          maxRecursiveDepth: c.maxRecursiveDepth,
          entityVocabulary: c.entityVocabulary,
          recentTriggeredIds: c.recentTriggeredIds,
          compressionCache: c.compressionCache ? Object.fromEntries(c.compressionCache) : undefined,
          semanticEnabled: false,
          lexicalProvider: unavailableLexicalProvider,
        } as never)
        return {
          caseIndex,
          input: c,
          beforeChar: result.beforeChar,
          afterChar: result.afterChar,
          atEnd: result.atEnd,
          atDepth: result.atDepth,
          triggeredCount: result.triggeredCount,
          droppedCount: result.droppedCount,
          alwaysDropped: result.alwaysDropped ?? null,
          conditionalDropped: result.conditionalDropped ?? null,
          detailDropped: result.detailDropped ?? null,
          bookBudgetDropped: result.bookBudgetDropped ?? null,
          triggeredEntryKeys: result.triggeredEntryKeys ?? null,
          compressionCacheHitKeys: result.compressionCacheHitKeys ?? null,
        }
      }),
    })
  })

  it('vector utilities (cosine, normalize, dot, topK)', () => {
    writeFixture('vector', {
      version: 1,
      cosineCases: VECTOR_COSINE_CASES.map((c) => ({
        a: c.a,
        b: c.b,
        score: cosineSimilarity(c.a, c.b),
      })),
      normalizeCases: VECTOR_NORMALIZE_CASES.map((v) => ({
        input: v,
        normalized: l2Normalize(v),
      })),
      dotCases: VECTOR_DOT_CASES.map((c) => ({
        a: c.a,
        b: c.b,
        dot: dotProduct(c.a, c.b),
      })),
      topKCases: VECTOR_TOPK_CASES.map((c) => ({
        query: c.query,
        items: c.items,
        k: c.k,
        minScore: c.minScore ?? null,
        hits: topKSimilar(c.query, c.items, c.k, c.minScore ?? 0),
      })),
    })
  })

  it('lorebook embedding (eligibility, document, split, merge, diff)', () => {
    writeFixture('lorebook-embedding', {
      version: 1,
      entries: LORE_EMBEDDING_ENTRIES.map((entry) => {
        const compiled = loreEntryForEmbedding(entry)
        return {
          input: entry,
          eligible: isLoreEntrySemanticEligible(compiled),
          document: buildLoreEntryEmbeddingDocument(compiled),
        }
      }),
      splitCases: LORE_EMBEDDING_SPLIT_CASES.map((c) => ({
        text: c.text,
        maxChars: c.maxChars,
        maxChunks: c.maxChunks ?? null,
        overlapRatio: c.overlapRatio ?? null,
        chunks: splitEmbeddingDocument(c.text, c.maxChars, c.maxChunks ?? 16, c.overlapRatio ?? 0.15),
      })),
      mergeCases: LORE_EMBEDDING_MERGE_CASES.map((vectors) => ({
        vectors,
        merged: mergeEmbeddingChunkVectors(vectors),
      })),
      diffCases: LORE_EMBEDDING_DIFF_CASES.map((c) => ({
        prev: c.prev,
        next: c.next,
        changed: diffLoreEntryEmbeddingIds(
          c.prev.map(loreEntryForEmbedding),
          c.next.map(loreEntryForEmbedding),
        ),
      })),
    })
  })

  it('embedding policy (fact hits, vector space, compatibility, threshold, configured)', () => {
    writeFixture('embedding-policy', {
      version: 1,
      constants: {
        defaultSimilarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
        remoteIndexChunkChars: REMOTE_INDEX_CHUNK_CHARS,
      },
      // 阈值/资格判定在 PC 侧依赖本地模型评测表；夹具显式带上被测表，避免依赖运行环境
      localProfiles: LOCAL_MODEL_RETRIEVAL_PROFILES,
      factHitCases: EMBEDDING_FACT_HIT_CASES.map((c) => ({
        hits: c.hits,
        facts: c.facts,
        mapped: mapFactSearchHits(c.hits, c.facts),
      })),
      vectorSpaceCases: EMBEDDING_VECTOR_SPACE_CASES.map((config) => ({
        config,
        space: vectorSpaceFromConfig(config as never),
      })),
      indexCompatCases: EMBEDDING_INDEX_COMPAT_CASES.map((c) => ({
        index: c.index,
        config: c.config,
        compatible: isVectorIndexCompatible(c.index as never, c.config as never),
      })),
      thresholdCases: EMBEDDING_THRESHOLD_CASES.map((c) => ({
        config: c.config,
        requested: c.requested ?? null,
        threshold: resolveSemanticThreshold(c.config as never, c.requested, LOCAL_MODEL_RETRIEVAL_PROFILES),
      })),
      configuredCases: EMBEDDING_CONFIGURED_CASES.map((config) => ({
        config,
        configured: isEmbeddingConfigured(config as never),
      })),
      semanticEligibleCases: EMBEDDING_SEMANTIC_ELIGIBLE_CASES.map((c) => ({
        priority: c.priority ?? null,
        matchMode: c.matchMode ?? null,
        eligible: isSemanticEligible({ priority: c.priority, matchMode: c.matchMode } as never),
      })),
    })
  })

  it('worldbook candidates shadow report', () => {
    writeFixture('worldbook-candidates', {
      version: 1,
      constants: {
        alwaysImportance: WORLDBOOK_ALWAYS_IMPORTANCE,
        conditionalImportance: WORLDBOOK_CONDITIONAL_IMPORTANCE,
        detailImportance: WORLDBOOK_DETAIL_IMPORTANCE,
      },
      scoreCases: WORLDBOOK_SCORE_CASES.map((score) => ({
        score: toSentinel(score),
        normalized: normalizeWorldbookScore(score),
      })),
      originCases: WORLDBOOK_ORIGIN_CASES.map((snapshot) => ({
        snapshot,
        origin: worldbookOrigin(snapshot as never),
      })),
      candidateSets: WORLDBOOK_SET_CASES.map((snapshots) => {
        const set = buildWorldbookCandidateSet(snapshots as never[])
        return {
          snapshots,
          described: set.described,
          keyByCandidateId: set.keyByCandidateId,
          priorityByCandidateId: set.priorityByCandidateId,
          candidates: set.candidates,
        }
      }),
      injectionCases: WORLDBOOK_INJECTION_CASES.map((c) => ({
        snapshots: c.snapshots,
        legacyCapTokens: c.legacyCapTokens,
        stats: summarizeWorldbookInjection(c.snapshots as never[], c.legacyCapTokens),
      })),
      shadowCases: WORLDBOOK_SHADOW_CASES.map((c) => {
        const plan = buildWorldbookCandidateSet(c.snapshots as never[])
        const existing = summarizeWorldbookInjection(c.snapshots as never[], c.legacyCapTokens)
        const report = buildWorldbookShadowReport({
          plan,
          existing,
          budgetTokens: c.budgetTokens,
          competitors: c.competitors as never[] | undefined,
        })
        return {
          snapshots: c.snapshots,
          legacyCapTokens: c.legacyCapTokens,
          budgetTokens: c.budgetTokens,
          competitors: c.competitors ?? [],
          report,
          formatted: formatWorldbookShadowSummary(report),
        }
      }),
    })
  })

  it('context candidates allocation', () => {
    writeFixture('context-candidates', {
      version: 1,
      kinds: CONTEXT_CANDIDATE_KINDS,
      scoreWeights: CANDIDATE_SCORE_WEIGHTS,
      kindBaseTier: KIND_BASE_TIER,
      thresholds: {
        recentHistoryRecency: RECENT_HISTORY_RECENCY,
        highRelevance: HIGH_RELEVANCE_THRESHOLD,
      },
      cases: CANDIDATE_CASES.map((c) => ({
        candidate: c,
        normalized: normalizeContextCandidate(c as never),
        score: candidateScore(c as never),
        tier: candidateTier(c as never),
      })),
      rankCases: CANDIDATE_GROUPS.map((group, index) => ({
        groupIndex: index,
        members: group,
        rankedIds: rankCandidates(group as never[]).map((x) => x.id),
        dedupe: (() => {
          const result = dedupeCandidates(group as never[])
          return { uniqueIds: result.unique.map((x) => x.id), duplicateIds: result.duplicateIds }
        })(),
        summary: (() => {
          const summary = summarizeCandidates(group as never[])
          return {
            count: summary.count,
            tokens: summary.tokens,
            mandatoryCount: summary.mandatoryCount,
            stablePrefixTokens: summary.stablePrefixTokens,
            byKind: summary.byKind,
          }
        })(),
      })),
      allocationCases: ALLOCATION_CASES.map((c) => {
        const result = allocateContextCandidates(c.group as never[], c.options)
        return {
          groupIndex: c.groupIndex,
          budgetTokens: c.options.budgetTokens,
          reservedTokens: c.options.reservedTokens ?? 0,
          selectedIds: result.selectedIds,
          droppedIds: result.droppedIds,
          selectedTokens: result.selectedTokens,
          mandatoryTokens: result.mandatoryTokens,
          effectiveBudgetTokens: result.effectiveBudgetTokens,
          overBudget: result.overBudget,
          mandatoryOverBudget: result.mandatoryOverBudget,
          dedupedIds: result.dedupedIds,
          stablePrefixSelectedTokens: result.stablePrefixSelectedTokens,
          byKind: result.byKind,
        }
      }),
    })
  })

  it('history degradation plan', () => {
    writeFixture('history-degradation', {
      version: 1,
      corpus: HISTORY_CORPUS,
      cases: HISTORY_CASES.map((c) => {
        const plan = planHistoryDegradation({
          messages: HISTORY_CORPUS as never[],
          usedTokens: c.usedTokens,
          budgetTokens: c.budgetTokens,
          model: c.model ?? '',
          ...(c.compressedSummary !== undefined ? { compressedSummary: c.compressedSummary } : {}),
          ...(c.compressedRange !== undefined ? { compressedRange: c.compressedRange } : {}),
        })
        return {
          usedTokens: c.usedTokens,
          budgetTokens: toSentinel(c.budgetTokens),
          model: c.model ?? '',
          compressedSummary: c.compressedSummary ?? null,
          compressedRange: c.compressedRange ?? null,
          plan,
          formatted: formatHistoryDegradationSummary(plan),
        }
      }),
    })
  })
})