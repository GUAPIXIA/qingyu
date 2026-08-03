/**
 * 角色扮演语义增强 remark 插件
 *
 * 在 Markdown AST 层识别对话和动作模式，添加语义化 CSS 类名：
 * - 整段 *动作*  -> <p class="action-block">（段落级，带边框背景）
 * - 行内 *动作*  -> <em class="action-em">（行内，斜体着色）
 * - "对话"       -> <em class="dialogue-inline">（行内对话）
 * - Speaker: "对话" -> <strong class="dialogue-block">（带说话人的对话块）
 *
 * 全部使用标准 mdast 节点（emphasis/strong）+ data.hProperties，
 * 不依赖 html 节点和 rehypeRaw，兼容性更好。
 */

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

/** 转义正则特殊字符 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * @提及高亮 remark 插件（BUG-09 修复配套）
 *
 * 在 AST 层把 text 节点中的 @角色名 拆分为带 className 的 span（通过 data.hName/hProperties，
 * 不产生原始 HTML），因此不需要 rehypeRaw，消息中的恶意 HTML 依然不会被渲染。
 *
 * @param mentionedNames 需要高亮的角色名列表
 */
export function remarkMentionHighlight(mentionedNames: string[]) {
  const names = [...new Set(mentionedNames.filter((n): n is string => !!n))]
  return (tree: MdastNode) => {
    if (names.length === 0 || !tree.children) return
    const pattern = new RegExp(`@(${names.map(escapeRegExp).join('|')})`, 'g')

    const highlight = (node: MdastNode): MdastNode[] => {
      // 文本节点：拆分出 @名字 片段
      if (node.type === 'text' && node.value) {
        const parts: MdastNode[] = []
        let last = 0
        let m: RegExpExecArray | null
        pattern.lastIndex = 0
        while ((m = pattern.exec(node.value)) !== null) {
          if (m.index > last) {
            parts.push({ type: 'text', value: node.value.slice(last, m.index) })
          }
          parts.push({
            type: 'text',
            value: m[0],
            data: { hName: 'span', hProperties: { className: ['mention-highlight'] } },
          })
          last = m.index + m[0].length
        }
        if (last === 0) return [node]
        if (last < node.value.length) {
          parts.push({ type: 'text', value: node.value.slice(last) })
        }
        return parts
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

      // 2. 对话拆分 + 行内动作标记
      const newChildren: MdastNode[] = []
      for (const node of child.children) {
        // 行内 emphasis 加 action-em 标记
        if (node.type === 'emphasis') {
          if (!node.data) node.data = {}
          node.data.hProperties = { className: ['action-em'] }
          newChildren.push(node)
          continue
        }

        // text 节点中匹配 "对话" / Speaker: "对话"
        if (node.type !== 'text' || !node.value) {
          newChildren.push(node)
          continue
        }

        // 归一化 CJK 引号到 ASCII 双引号（先归一化再判断，确保 CJK 引号也能被检测）
        const normalized = node.value
          .replace(/[\u201C\u201D\u201E\u201F\uFF02\u300C\u300E\u2039\u00AB\u301D\uFE41\uFE43]/g, '"')
          .replace(/[\u300D\u300F\u203A\u00BB\u301E\uFE42\uFE44]/g, '"')

        if (!normalized.includes('"')) {
          newChildren.push(node)
          continue
        }

        const regex = /(\S+[:\uff1a]\s*)?"([^"]*)"/g
        let lastIndex = 0
        let m: RegExpExecArray | null
        let matched = false

        while ((m = regex.exec(normalized)) !== null) {
          matched = true
          if (m.index > lastIndex) {
            newChildren.push({ type: 'text', value: normalized.slice(lastIndex, m.index) })
          }
          const speakerRaw = m[1] || ''
          const speaker = speakerRaw.replace(/[:\uff1a]\s*$/, '').trim()
          const dialogue = m[2]

          if (speaker) {
            // 带说话人的对话块：用 strong 作容器，内含 speaker + dialogue
            newChildren.push(strong('dialogue-block', [
              em('dialogue-speaker', speaker),
              { type: 'text', value: ' ' },
              em('dialogue-text', dialogue),
            ]))
          } else {
            // 行内对话
            newChildren.push(em('dialogue-inline', `"${dialogue}"`))
          }
          lastIndex = regex.lastIndex
        }

        if (lastIndex < normalized.length) {
          newChildren.push({ type: 'text', value: normalized.slice(lastIndex) })
        }
        if (!matched) {
          newChildren.push(node)
        }
      }
      child.children = newChildren
    }
  }
}
