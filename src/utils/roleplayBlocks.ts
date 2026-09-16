/**
 * 语义分块（阶段5「语义块渲染」§6.1）。
 *
 * 从自然语言正文得到确定性的 RoleplayBlock[]：
 * - 纯 `“……”` / `「……」` / `『……』` / `"……"` 行 → dialogue（可带说话人前缀）；
 * - `<thought>...</thought>` → thought；
 * - 整段 `*动作*` → narration（剥离星号，样式由 CSS 呈现）；
 * - 一行同时含对白与叙述 → mixed（保持原文，不强行补角色名）；
 * - 其余普通段落 → narration。
 *
 * 分块只影响展示：Message.content 保持可复制的原始正文（§6.2），
 * 旧消息按现有 Markdown 规则渲染（由 Message.contentRenderMode 区分）。
 *
 * 解析层是纯函数：同一输入 + phase 得到确定结果。流式阶段检测到
 * “说话人前缀 + 左引号”即产出 dialogue 且 complete=false，右引号到达后
 * 只更新正文与 complete，不改变 block 类型。
 */

export type RoleplayBlockKind = 'dialogue' | 'narration' | 'thought' | 'mixed'

export type RoleplayBlock =
  | { kind: 'dialogue'; text: string; speaker?: string; complete?: boolean }
  | { kind: 'narration'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'mixed'; text: string }

export type RoleplayParsePhase = 'streaming' | 'final'

export interface ParseRoleplayBlocksOptions {
  phase?: RoleplayParsePhase
}

/** 配对引号：左 → 右 */
export const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ['"', '"'],
]

/** 用于匹配 SPEAKER/纯对白的引号字符集（四类左/右引号；不含 ASCII 单引号，避免撇号误伤） */
const OPEN_QUOTE_CHARS = '“「『"'
const CLOSE_QUOTE_CHARS = '”」』"'

/**
 * 说话人前缀：冒号前的名称（1–8 个非空白非标点字符，覆盖中英文角色名与
 * "绿色外星人"这类指代名；带标点/空格的长前缀是叙述句，不可能是名字）。
 * 再用 NARRATION_PREFIX 排除叙述式前缀，避免"她轻声说道：/苏晚推开门："
 * 这类叙述被误当说话人。remark-roleplay 与 blocks 共用本规则。
 *
 * 右侧允许四类引号 + 可选空白后开始对白；流式阶段可能尚未闭合右引号。
 */
export const SPEAKER_QUOTE =
  new RegExp(
    `^([^${OPEN_QUOTE_CHARS}${CLOSE_QUOTE_CHARS}：:：\\s，。！？、；,.!?;'"()（）【】〔〕—…·\\-]{1,8})[：:]\\s*([${OPEN_QUOTE_CHARS}][\\s\\S]*)$`,
  )

/**
 * 叙述式前缀特征字：代词、结构助词、常见动作/说话动词。命中任一即视为叙述而非角色名。
 * 注意收录边界： transliteration 名常用字（拉/洛/诺/丽等）不得入表，避免"美洛拉"被误杀；
 * 误杀的后果只是退化为匿名对白块（可接受的降级），而漏杀会把叙述整段错标成角色。
 */
export const NARRATION_PREFIX = /[她他它您我谁的了着是在推说道问答笑喊叫哼吼念讲走站坐打握摇抬皱眨顿望听看感摆挥耸抿咬飘]/

/** 整行纯对白（四类引号成对；流式 phase 下允许未闭合） */
export const PURE_QUOTE = new RegExp(`^[${OPEN_QUOTE_CHARS}][\\s\\S]*[${CLOSE_QUOTE_CHARS}]$`)

/** 仅有左引号（流式/异常未闭合） */
const LEADING_OPEN_QUOTE = new RegExp(`^[${OPEN_QUOTE_CHARS}][\\s\\S]*$`)

/** 整行动作段（旧样式星号包裹） */
const ACTION_LINE = /^\*(.+)\*$/s

/** 引号字符（判断行内是否含对白；不含 ASCII 单引号，避免英文撇号整行误判 mixed） */
const CONTAINS_QUOTE = /[“”「」『』"]/

/** 按码点 trim（与 textMetrics 口径一致；\u3000 = 全角空格） */
function trimLine(line: string): string {
  return line.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '')
}

/**
 * 从 text[0]=open 出发，找与首引号配对的 close 下标（嵌套同类引号按深度配对）。
 * 找不到返回 -1。ASCII 同字符引号按「成对游走」计数。
 */
function findMatchingCloseIndex(text: string, open: string, close: string): number {
  if (open === close) {
    let seen = 0
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === open) {
        seen += 1
        if (seen % 2 === 0) return i
      }
    }
    return -1
  }
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === open) {
      depth += 1
    } else if (ch === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 从 text[0]=open 出发的闭合判定：
 * - `endsWithClose`：与首引号配对的 close 正好落在末尾 → 完整纯对白
 *   （嵌套 “他说：“好。”” 按深度配对；不能只看末字符，否则 `"A"叙述"B"` 会被误判）
 * - `hasInnerClose`：文中存在与首引号配对的 close，但不在末尾 → 闭合后仍有尾随（mixed）
 * - 否则：未闭合（流式 incomplete）
 */
function classifyOpenQuote(text: string): { endsWithClose: boolean; hasInnerClose: boolean } {
  if (!text || text.length < 1) return { endsWithClose: false, hasInnerClose: false }
  for (const [open, close] of QUOTE_PAIRS) {
    if (text[0] !== open) continue
    const matchEnd = findMatchingCloseIndex(text, open, close)
    if (matchEnd < 0) return { endsWithClose: false, hasInnerClose: false }
    if (matchEnd === text.length - 1) return { endsWithClose: true, hasInnerClose: true }
    return { endsWithClose: false, hasInnerClose: true }
  }
  return { endsWithClose: false, hasInnerClose: false }
}

/** 起始引号是否整段闭合 */
function isQuoteClosed(text: string): boolean {
  return classifyOpenQuote(text).endsWithClose
}

/**
 * 说话人前缀匹配（共用规则）；命中且非叙述式前缀时返回：
 * - complete: 整段为「名：纯对白」
 * - streamingOpen: 「名：」+ 未闭合左引号（流式/异常输出）
 * - 否则 null（含闭合对白后仍有尾随叙述 → 调用方走 mixed）
 */
export function matchSpeakerDialogue(
  line: string,
  _phase: RoleplayParsePhase = 'final',
): { speaker: string; dialogue: string; complete: boolean; streamingOpen: boolean } | null {
  const m = line.match(SPEAKER_QUOTE)
  if (!m) return null
  const speaker = trimLine(m[1] ?? '')
  if (!speaker || NARRATION_PREFIX.test(speaker)) return null
  const dialogue = m[2] ?? ''
  if (![...OPEN_QUOTE_CHARS].includes(dialogue[0] ?? '')) return null
  const q = classifyOpenQuote(dialogue)
  if (q.endsWithClose) {
    return { speaker, dialogue, complete: true, streamingOpen: false }
  }
  // 闭合引号后仍有文字（`“你好。”她…`）→ 不是纯对白
  if (q.hasInnerClose) return null
  // 未闭合：流式或最终异常都保持 dialogue incomplete（不吞正文）
  return { speaker, dialogue, complete: false, streamingOpen: true }
}

/** 是否整行纯对白（首尾配对为单一外层引号，或未闭合的左引号起始行） */
export function isPureDialogueLine(line: string, _phase: RoleplayParsePhase = 'final'): boolean {
  if (!line) return false
  if (!LEADING_OPEN_QUOTE.test(line) || ![...OPEN_QUOTE_CHARS].includes(line[0] ?? '')) return false
  const q = classifyOpenQuote(line)
  // 外层引号深度配对且收在末尾 → 纯对白（允许内部嵌套引号与冒号）
  if (q.endsWithClose) return true
  // 闭合后仍有文字（含 `"对白"叙述"对白"`）→ mixed
  if (q.hasInnerClose) return false
  // 未闭合：以左引号起即 incomplete 对白（流式/异常）；冒号不影响，说话人路径已单独处理
  return true
}

/** 单行 → 块 */
function classifyLine(rawLine: string, phase: RoleplayParsePhase): RoleplayBlock {
  const line = trimLine(rawLine)
  if (!line) return { kind: 'narration', text: '' }

  // 旧样式动作段：*动作* → narration（剥离星号，避免与 CSS 样式叠加）
  const action = line.match(ACTION_LINE)
  if (action) return { kind: 'narration', text: trimLine(action[1]) }

  // 说话人 + 纯对白：苏晚：“我知道。” / 叶：“走吧。”（单字角色名同样成立）
  const speaker = matchSpeakerDialogue(line, phase)
  if (speaker) {
    return {
      kind: 'dialogue',
      text: speaker.dialogue,
      speaker: speaker.speaker,
      ...(speaker.complete ? {} : { complete: false }),
    }
  }

  // 整行纯对白
  if (isPureDialogueLine(line, phase)) {
    const complete = isQuoteClosed(line)
    return {
      kind: 'dialogue',
      text: line,
      ...(complete ? {} : { complete: false }),
    }
  }

  // 对白与叙述混写 → mixed，保持原文
  if (CONTAINS_QUOTE.test(line)) return { kind: 'mixed', text: line }

  return { kind: 'narration', text: line }
}

/**
 * 将正文解析为语义块。
 * - 思考块（可跨行）优先解析为 thought；
 * - 相邻 narration 行合并为一个块（保持段落自然）；
 * - 不改写除剥离包裹星号之外的任何字符。
 *
 * @param content 原始正文
 * @param options.phase streaming：允许未闭合对白保持 dialogue；final：默认
 */
export function parseRoleplayBlocks(
  content: string,
  options: ParseRoleplayBlocksOptions = {},
): RoleplayBlock[] {
  const phase: RoleplayParsePhase = options.phase ?? 'final'
  if (!content) return []

  const blocks: RoleplayBlock[] = []
  // 先以 thought 块为分隔切分（thought 可跨行），其余按行分类
  const thoughtRe = /<thought>([\s\S]*?)<\/thought>\s*/gi
  let lastIndex = 0
  for (const match of content.matchAll(thoughtRe)) {
    const before = content.slice(lastIndex, match.index)
    appendLines(blocks, before, phase)
    const inner = trimLine(match[1] ?? '')
    if (inner) blocks.push({ kind: 'thought', text: inner })
    lastIndex = (match.index ?? 0) + match[0].length
  }
  appendLines(blocks, content.slice(lastIndex), phase)

  return blocks.filter((b) => !(b.kind === 'narration' && !b.text))
}

/** 兼容入口：最终态解析（历史调用方） */
export function buildRoleplayBlocks(content: string): RoleplayBlock[] {
  return parseRoleplayBlocks(content, { phase: 'final' })
}

/**
 * 展示层剥除对白外层引号（“…”/「…」/『…』/ "…" 成对时去掉）。
 * 只影响渲染：RoleplayBlock.text 与 message.content 保持原文，复制/搜索不受影响。
 * 未闭合时不剥，避免流式布局跳动。
 */
export function stripOuterQuotes(text: string): string {
  const t = text.trim()
  for (const [open, close] of QUOTE_PAIRS) {
    if (t.startsWith(open) && t.endsWith(close) && t.length >= 2) {
      if (open === close && t.length === 1) return text
      return t.slice(1, -1)
    }
  }
  return text
}

/**
 * mixed 段行内对白切分：引号对（含引号本身）标 quoted，其余保持原文。
 * 支持四类引号；与 classifyOpenQuote 同源深度/游走配对，避免嵌套被首个 close 截断。
 * 流式未闭合时尾部开引号保持未标记（原文）。
 */
export function splitQuoteSegments(text: string): Array<{ text: string; quoted: boolean }> {
  if (!text) return []
  const segments: Array<{ text: string; quoted: boolean }> = []
  let lastIndex = 0

  /** 扫描从 i 起能匹配的最早完整引号对；命中返回 [start, endInclusive] */
  const findQuotedSpan = (from: number): { start: number; end: number } | null => {
    for (let j = from; j < text.length; j += 1) {
      for (const [open, close] of QUOTE_PAIRS) {
        if (text[j] !== open) continue
        const end = findMatchingCloseIndex(text.slice(j), open, close)
        if (end > 0) return { start: j, end: j + end }
      }
    }
    return null
  }

  let cursor = 0
  while (cursor < text.length) {
    const span = findQuotedSpan(cursor)
    if (!span) break
    if (span.start > lastIndex) {
      segments.push({ text: text.slice(lastIndex, span.start), quoted: false })
    }
    segments.push({ text: text.slice(span.start, span.end + 1), quoted: true })
    lastIndex = span.end + 1
    cursor = lastIndex
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), quoted: false })
  }
  return segments
}

/** 把一段纯文本按行分类并追加到 blocks（同一段落内的相邻 narration 行合并；空行分隔段落） */
function appendLines(blocks: RoleplayBlock[], text: string, phase: RoleplayParsePhase): void {
  if (!text) return
  // 按空行切段：不同段落的 narration 不合并
  const paragraphs = text.split(/\n\s*\n/)
  for (const paragraph of paragraphs) {
    let lastNarration: RoleplayBlock | null = null
    for (const rawLine of paragraph.split(/\n/)) {
      const line = trimLine(rawLine)
      if (!line) continue
      const block = classifyLine(line, phase)
      const prev = blocks[blocks.length - 1]
      if (block.kind === 'narration' && prev && prev.kind === 'narration' && prev === lastNarration) {
        prev.text = `${prev.text}\n${block.text}`
      } else {
        blocks.push(block)
        if (block.kind === 'narration') lastNarration = block
      }
    }
  }
}
