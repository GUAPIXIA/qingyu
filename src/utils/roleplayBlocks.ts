/**
 * 语义分块（阶段5「语义块渲染」§6.1）。
 *
 * 从自然语言正文得到确定性的 RoleplayBlock[]：
 * - 纯 `“……”` / `「……」` 行 → dialogue（可带说话人前缀）；
 * - `<thought>...</thought>` → thought；
 * - 整段 `*动作*` → narration（剥离星号，样式由 CSS 呈现）；
 * - 一行同时含对白与叙述 → mixed（保持原文，不强行补角色名）；
 * - 其余普通段落 → narration。
 *
 * 分块只影响展示：Message.content 保持可复制的原始正文（§6.2），
 * 旧消息按现有 Markdown 规则渲染（由 Message.contentRenderMode 区分）。
 */

export type RoleplayBlock =
  | { kind: 'dialogue'; text: string; speaker?: string }
  | { kind: 'narration'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'mixed'; text: string }

/**
 * 说话人前缀：冒号前的名称（1–8 个非空白非标点字符，覆盖中英文角色名与
 * "绿色外星人"这类指代名；带标点/空格的长前缀是叙述句，不可能是名字）。
 * 再用 NARRATION_PREFIX 排除叙述式前缀，避免"她轻声说道：/苏晚推开门："
 * 这类叙述被误当说话人。remark-roleplay 与 blocks 共用本规则。
 */
export const SPEAKER_QUOTE =
  /^([^“”「」『』：:\s，。！？、；,.!?;'"()（）【】〔〕—…·\-]{1,8})[：:]\s*([“「][\s\S]*[”」])$/

/**
 * 叙述式前缀特征字：代词、结构助词、常见动作/说话动词。命中任一即视为叙述而非角色名。
 * 注意收录边界： transliteration 名常用字（拉/洛/诺/丽等）不得入表，避免"美洛拉"被误杀；
 * 误杀的后果只是退化为匿名对白块（可接受的降级），而漏杀会把叙述整段错标成角色。
 */
export const NARRATION_PREFIX = /[她他它您我谁的了着是在推说道问答笑喊叫哼吼念讲走站坐打握摇抬皱眨顿望听看感摆挥耸抿咬飘]/

/** 整行纯对白（可带说话人） */
export const PURE_QUOTE = /^[“「][\s\S]*[”」]$/

/** 整行动作段（旧样式星号包裹） */
const ACTION_LINE = /^\*(.+)\*$/s

/** 引号字符（判断行内是否含对白） */
const CONTAINS_QUOTE = /[“”「」『』]/

/** 按码点 trim（与 textMetrics 口径一致；\u3000 = 全角空格） */
function trimLine(line: string): string {
  return line.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '')
}

/** 单行 → 块 */
function classifyLine(rawLine: string): RoleplayBlock {
  const line = trimLine(rawLine)
  if (!line) return { kind: 'narration', text: '' }

  // 旧样式动作段：*动作* → narration（剥离星号，避免与 CSS 样式叠加）
  const action = line.match(ACTION_LINE)
  if (action) return { kind: 'narration', text: trimLine(action[1]) }

  // 说话人 + 纯对白：苏晚：“我知道。” / 叶：“走吧。”（单字角色名同样成立）
  const speakerMatch = line.match(SPEAKER_QUOTE)
  if (speakerMatch && !NARRATION_PREFIX.test(speakerMatch[1])) {
    return { kind: 'dialogue', text: speakerMatch[2], speaker: trimLine(speakerMatch[1]) }
  }

  // 整行纯对白
  if (PURE_QUOTE.test(line)) return { kind: 'dialogue', text: line }

  // 对白与叙述混写 → mixed，保持原文
  if (CONTAINS_QUOTE.test(line)) return { kind: 'mixed', text: line }

  return { kind: 'narration', text: line }
}

/**
 * 将正文解析为语义块。
 * - 思考块（可跨行）优先解析为 thought；
 * - 相邻 narration 行合并为一个块（保持段落自然）；
 * - 不改写除剥离包裹星号之外的任何字符。
 */
export function buildRoleplayBlocks(content: string): RoleplayBlock[] {
  if (!content) return []

  const blocks: RoleplayBlock[] = []
  // 先以 thought 块为分隔切分（thought 可跨行），其余按行分类
  const thoughtRe = /<thought>([\s\S]*?)<\/thought>\s*/gi
  let lastIndex = 0
  for (const match of content.matchAll(thoughtRe)) {
    const before = content.slice(lastIndex, match.index)
    appendLines(blocks, before)
    const inner = trimLine(match[1] ?? '')
    if (inner) blocks.push({ kind: 'thought', text: inner })
    lastIndex = (match.index ?? 0) + match[0].length
  }
  appendLines(blocks, content.slice(lastIndex))

  return blocks.filter((b) => !(b.kind === 'narration' && !b.text))
}

/**
 * 展示层剥除对白外层引号（“…”/「…」/『…』成对时去掉）。
 * 只影响渲染：RoleplayBlock.text 与 message.content 保持原文，复制/搜索不受影响。
 */
export function stripOuterQuotes(text: string): string {
  const t = text.trim()
  if (
    (t.startsWith('“') && t.endsWith('”')) ||
    (t.startsWith('「') && t.endsWith('」')) ||
    (t.startsWith('『') && t.endsWith('』'))
  ) {
    return t.slice(1, -1)
  }
  return text
}

/** mixed 段行内对白切分：引号对（含引号本身）标 quoted，其余保持原文 */
export function splitQuoteSegments(text: string): Array<{ text: string; quoted: boolean }> {
  const quoteSpan = /[“"][^“”"]*[”"]|「[^」]*」|『[^』]*』/g
  const segments: Array<{ text: string; quoted: boolean }> = []
  let lastIndex = 0
  for (const match of text.matchAll(quoteSpan)) {
    if (match.index! > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), quoted: false })
    }
    segments.push({ text: match[0], quoted: true })
    lastIndex = match.index! + match[0].length
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), quoted: false })
  return segments
}

/** 把一段纯文本按行分类并追加到 blocks（同一段落内的相邻 narration 行合并；空行分隔段落） */
function appendLines(blocks: RoleplayBlock[], text: string): void {
  if (!text) return
  // 按空行切段：不同段落的 narration 不合并
  const paragraphs = text.split(/\n\s*\n/)
  for (const paragraph of paragraphs) {
    let lastNarration: RoleplayBlock | null = null
    for (const rawLine of paragraph.split(/\n/)) {
      const line = trimLine(rawLine)
      if (!line) continue
      const block = classifyLine(line)
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
