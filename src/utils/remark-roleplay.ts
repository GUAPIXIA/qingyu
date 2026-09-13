/**
 * 角色扮演语义增强 remark 插件（旧消息/legacy 管线的 Markdown 兼容路径）
 *
 * 在 Markdown AST 层识别对话和动作模式，添加语义化 CSS 类名：
 * - 整段 *动作*  -> <p class="action-block">
 * - 行内 *动作*  -> <em class="action-em">
 * - 整行「角色：“对话”」或整行纯引号对白 -> <strong class="dialogue-block">
 * - 其余行内 "对话" -> <em class="dialogue-inline">（保留引号）
 *
 * 行级判定与 blocks 路径（roleplayBlocks.classifyLine）共用同一套正则与
 * 叙述前缀排除规则：同一段文本无论走哪条渲染路径，归类结果一致。
 * 行内不再单独识别说话人前缀（避免把「叙述：“对白”」误拆成对话块）。
 *
 * 全部使用标准 mdast 节点（emphasis/strong）+ data.hProperties，
 * 不依赖 html 节点和 rehypeRaw，兼容性更好。
 */

import { splitMentionSegments } from './mentionHighlight'
import { SPEAKER_QUOTE, PURE_QUOTE, NARRATION_PREFIX, stripOuterQuotes } from './roleplayBlocks'

/** 简化的 mdast 节点类型 */
interface MdastNode {
  type: string
  value?: string
  children?: MdastNode[]
  data?: {
    /** 覆盖渲染的 HTML 元素名（mdast-util-to-hast 支持） */
    hName?: string
    hProperties?: Record<string, unknown>
  }
  [key: string]: unknown
}

/** 创建带 className 的 emphasis 节点 */
function em(className: string, text: string): MdastNode {
  return {
    type: 'emphasis',
    data: { hProperties: { className: [className] } },
    children: [{ type: 'text', value: text }],
  }
}

/**
 * @提及高亮 remark 插件（BUG-09 修复配套）
 *
 * 在 AST 层把 text 节点中的 @角色名 拆分为带 className 的 span（通过 data.hName/hProperties，
 * 不产生原始 HTML），因此不需要 rehypeRaw，消息中的恶意 HTML 依然不会被渲染。
 * 识别规则与语义块渲染共用 splitMentionSegments（S7），两条路径行为一致。
 *
 * @param mentionedNames 需要高亮的角色名列表
 */
export function remarkMentionHighlight(mentionedNames: string[]) {
  const names = [...new Set(mentionedNames.filter((n): n is string => !!n))]
  return (tree: MdastNode) => {
    if (names.length === 0 || !tree.children) return

    const highlight = (node: MdastNode): MdastNode[] => {
      // 文本节点：拆分出 @名字 片段
      if (node.type === 'text' && node.value) {
        const segments = splitMentionSegments(node.value, names)
        if (!segments.some((segment) => segment.mention)) return [node]
        return segments.map((segment) => segment.mention
          ? {
              type: 'text',
              value: segment.text,
              data: { hName: 'span', hProperties: { className: ['mention-highlight'] } },
            }
          : { type: 'text', value: segment.text })
      }
      // 递归处理嵌套节点（emphasis/strong 等内部的文本）
      if (node.children) {
        return [{ ...node, children: node.children.flatMap(highlight) }]
      }
      return [node]
    }

    tree.children = tree.children.flatMap(highlight)
  }
}

/** 创建带 className 的 strong 节点（作为容器） */
function strong(className: string, children: MdastNode[]): MdastNode {
  return {
    type: 'strong',
    data: { hProperties: { className: [className] } },
    children,
  }
}

/** 把段落 children 按行拆分：break 节点与 text 内的 \n 都是行边界 */
function splitIntoLines(children: MdastNode[]): MdastNode[][] {
  const lines: MdastNode[][] = [[]]
  const push = (node: MdastNode) => lines[lines.length - 1].push(node)
  for (const node of children) {
    if (node.type === 'break') {
      lines.push([])
      continue
    }
    if (node.type === 'text' && node.value && node.value.includes('\n')) {
      const parts = node.value.split('\n')
      parts.forEach((part, index) => {
        if (index > 0) lines.push([])
        if (part) push({ type: 'text', value: part })
      })
      continue
    }
    push(node)
  }
  // 丢弃全空行（纯空白 text 节点不构成语义行）
  return lines.filter((line) =>
    line.some((n) => !(n.type === 'text' && (n.value == null || /^\s*$/.test(n.value)))),
  )
}

/** 整行对白判定（与 blocks classifyLine 同规则）：命中返回 dialogue-block 节点，否则 null */
function classifyDialogueLine(line: MdastNode[]): MdastNode | null {
  if (!line.every((n) => n.type === 'text')) return null
  const plain = line.map((n) => n.value ?? '').join('').trim()
  if (!plain) return null
  const speakerMatch = plain.match(SPEAKER_QUOTE)
  if (speakerMatch && !NARRATION_PREFIX.test(speakerMatch[1])) {
    return strong('dialogue-block', [
      em('dialogue-speaker', speakerMatch[1].trim()),
      { type: 'text', value: ' ' },
      em('dialogue-text', stripOuterQuotes(speakerMatch[2])),
    ])
  }
  if (PURE_QUOTE.test(plain)) {
    return strong('dialogue-block', [em('dialogue-text', stripOuterQuotes(plain))])
  }
  return null
}

/** 行内处理：emphasis -> action-em；text 中的引号对白 -> dialogue-inline（保留引号） */
function inlineProcessLine(line: MdastNode[]): MdastNode[] {
  const out: MdastNode[] = []
  for (const node of line) {
    if (node.type === 'emphasis') {
      if (!node.data) node.data = {}
      node.data.hProperties = { className: ['action-em'] }
      out.push(node)
      continue
    }
    if (node.type !== 'text' || !node.value) {
      out.push(node)
      continue
    }
    // 归一化 CJK 引号到 ASCII 双引号（先归一化再判断，确保 CJK 引号也能被检测）
    const normalized = node.value
      .replace(/[\u201C\u201D\u201E\u201F\uFF02\u300C\u300E\u2039\u00AB\u301D\uFE41\uFE43]/g, '"')
      .replace(/[\u300D\u300F\u203A\u00BB\u301E\uFE42\uFE44]/g, '"')

    if (!normalized.includes('"')) {
      out.push(node)
      continue
    }

    let lastIndex = 0
    let matched = false
    for (const m of normalized.matchAll(/"([^"]*)"/g)) {
      matched = true
      if (m.index! > lastIndex) {
        out.push({ type: 'text', value: normalized.slice(lastIndex, m.index) })
      }
      out.push(em('dialogue-inline', `"${m[1]}"`))
      lastIndex = m.index! + m[0].length
    }
    if (lastIndex < normalized.length) {
      out.push({ type: 'text', value: normalized.slice(lastIndex) })
    }
    if (!matched) {
      out.push(node)
    }
  }
  return out
}

/**
 * 角色扮演语义增强 remark 插件
 */
export function remarkRoleplay() {
  return (tree: MdastNode) => {
    if (!tree.children) return

    for (const child of tree.children) {
      if (child.type !== 'paragraph' || !child.children) continue

      // 1. 动作检测：段落中唯一的有效子节点是 emphasis -> 标记整段为 action-block
      const meaningful = child.children.filter(
        (c: MdastNode) => !(c.type === 'text' && c.value != null && /^\s*$/.test(c.value))
      )
      if (meaningful.length === 1 && meaningful[0].type === 'emphasis') {
        if (!child.data) child.data = {}
        child.data.hProperties = { className: ['action-block'] }
        continue
      }

      // 2. 行级语义分类（与 blocks 路径同规则）：对白行 -> dialogue-block，其余行内处理
      const lines = splitIntoLines(child.children)
      const newChildren: MdastNode[] = []
      lines.forEach((line, index) => {
        if (index > 0) newChildren.push({ type: 'break' })
        const blockNode = classifyDialogueLine(line)
        if (blockNode) newChildren.push(blockNode)
        else newChildren.push(...inlineProcessLine(line))
      })
      if (lines.length > 0) child.children = newChildren
    }
  }
}
