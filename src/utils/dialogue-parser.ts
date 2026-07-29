/**
 * 对话片段解析器
 * 将角色对话消息拆分为：引用对话、动作描述、旁白叙述 三类片段
 *
 * ## 支持的对话格式
 *
 * ### 双引号对话（中文/English）
 * - `Speaker: "text"` / `Speaker："text"` → dialogue（半角/全角冒号）
 * - `"text"` → dialogue（无说话人）
 *
 * ### 单引号对话
 * - `Speaker: 'text'` / `Speaker：'text'` → dialogue
 *
 * ### 中文特有
 * - `「text」` / `『text』` / `〝text〞` -> 归一化为 "text" 后匹配
 *
 * ### 动作/场景描述
 * - `*action*` → action（支持内含 * 的复杂动作描述）
 *
 * ### 保护机制
 * - 围栏代码块 ```...``` / ~~~...~~~ → protected（不被解析）
 * - Markdown 粗体/粗斜体/删除线 → protected（不被解析）
 * - HTML 标签 → protected
 * - Markdown 图片/链接 → protected
 * - 行内代码 `code` → protected
 * - 英文缩写 don't / can't / it's → protected
 *
 * @param text 原始消息文本
 * @returns 结构化片段数组
 */

export interface DialogueSegment {
  /** 片段类型 */
  type: 'dialogue' | 'action' | 'plain'
  /** 说话人名称（如有，如 Flora: "..."） */
  speaker?: string
  /** 片段文本内容 */
  content: string
}

/** 占位符标记（使用 Unicode 私用区字符，避免空字节 \x00 在渲染管道中被破坏） */
const PH_MARKER = 'PH'

export function parseDialogue(text: string): DialogueSegment[] {
  if (!text) return []

  // 快速预检：如果文本不含任何对话/动作标记字符，直接返回纯文本
  // 注意：必须包含所有 Unicode 引号变体（""「」〝〞等），否则中文引号文本会被误判为纯文本
  if (!/[*":：'\u201C\u201D\-~()\[\]「」『』〝〞]/.test(text)) {
    return [{ type: 'plain', content: text }]
  }

  // 预处理：用占位符保护 HTML 标签和 markdown 图片/链接
  // 避免 HTML 属性值中的引号被 "[^"]*" 误匹配为对话
  // 避免 URL 中的 * 被 \*...\* 误匹配为动作描写
  const placeholders: string[] = []
  const protect = (m: string): string => {
    placeholders.push(m)
    return `${PH_MARKER}${placeholders.length - 1}${PH_MARKER}`
  }

  const protectedText = text
    // B-05: 归一化 Unicode 引号变体为 ASCII 引号
    // B-07: 先处理转义引号 \" -> "
    // B-08: 新增 CJK 双引号 〝〞 (U+301D/E)、直角引号表示形式 ﹁﹃﹂﹄ (U+FE41-44)
    // 修复：中文弯引号 \u201C\u201D（最常见的中文双引号）此前误写为两个 ASCII "，导致从未被归一化
    .replace(/\\"/g, '"')
    .replace(/[\u201C\u201D„‟＂「『‹«〝﹁﹃]/g, '"')
    .replace(/[」』›»〞﹂﹄]/g, '"')
    // 保护围栏代码块（```...``` / ~~~...~~~），避免代码块内的 *、" 等字符触发误匹配
    // 必须在 bold/italic 保护之前，否则代码块内的 ** 会被误保护
    .replace(/```[\s\S]*?```/g, protect)
    .replace(/~~~[\s\S]*?~~~/g, protect)
    // B-08: 保护英文缩写（don't, can't, it's 等），避免被单引号对话正则误匹配
    .replace(/\b[A-Za-z]+'[A-Za-z]+\b/g, protect)
    // B-06: 保护 markdown 粗体/粗斜体/删除线，避免被动作正则 *...* 误匹配
    // B-08: 改用 [\s\S]+? 非贪婪匹配，解决 **bold *italic* text** 内含 * 时保护失败
    .replace(/\*{3}[\s\S]+?\*{3}/g, protect)          // 粗斜体 ***...***
    .replace(/_{3}[\s\S]+?_{3}/g, protect)             // 粗斜体 ___...___
    .replace(/\*\*[\s\S]+?\*\*/g, protect)             // 粗体 **...**
    .replace(/__[\s\S]+?__/g, protect)                 // 粗体 __...__
    .replace(/~~[\s\S]+?~~/g, protect)                 // 删除线 ~~...~~
    .replace(/<\/?[a-zA-Z][^>]*\/?>/g, protect)       // HTML 标签 <...>
    .replace(/!\[[^\]]*\]\([^)]*\)/g, protect)         // markdown 图片 ![alt](url)
    .replace(/\[[^\]]*\]\([^)]*\)/g, protect)          // markdown 链接 [text](url)
    .replace(/`[^`\n]+`/g, protect)                   // 行内代码 `code`

  /** 将占位符还原为原始内容（循环处理嵌套占位符） */
  const restore = (s: string): string => {
    const pattern = new RegExp(`${PH_MARKER}(\\d+)${PH_MARKER}`, 'g')
    let result = s
    // 循环替换直到没有更多占位符，处理 don't → **don't** 这样的嵌套保护
    for (let i = 0; i < 10; i++) {
      const prev = result
      result = result.replace(pattern, (_, idx) => placeholders[Number(idx)])
      if (result === prev) break // 没有更多占位符可替换
    }
    return result
  }

  const segments: DialogueSegment[] = []

  // 核心解析正则（硬编码，避免 new RegExp 字符串拼接导致运行时开销和转义问题）
  // 组1: *动作描述* — [\s\S]+? 非贪婪，支持内含 *（如 *does *this* too*）
  // 组2: Name: "dialogue" / Name："dialogue" — 半角/全角冒号双引号对话
  // 组3: "dialogue" — 无说话人双引号对话
  // 组4: Name: 'dialogue' / Name：'dialogue' - 单引号对话
  const pattern = /(\*[\s\S]+?\*)|(\S+[:：]\s*"[^"]*")|("[^"]*")|(\S+[:：]\s*'[^']*')/g

  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(protectedText)) !== null) {
    // 匹配之前的纯文本
    if (match.index > lastIndex) {
      const plainText = protectedText.slice(lastIndex, match.index).trim()
      if (plainText) {
        segments.push({ type: 'plain', content: restore(plainText) })
      }
    }

    const fullMatch = match[0]

    if (match[1]) {
      // *动作描述*
      const inner = fullMatch.slice(1, -1).trim()
      if (inner) {
        segments.push({ type: 'action', content: restore(inner) })
      }
    } else if (match[2]) {
      // Speaker: "对话" / Speaker："对话"
      const colonIdx = /[:：]/.exec(fullMatch)!.index
      const speaker = fullMatch.slice(0, colonIdx).trim()
      const rawInner = fullMatch.slice(colonIdx + 1).trim()
      const inner = rawInner.startsWith('"') && rawInner.endsWith('"')
        ? rawInner.slice(1, -1)
        : rawInner
      if (speaker && inner) {
        segments.push({ type: 'dialogue', speaker: restore(speaker), content: restore(inner) })
      }
    } else if (match[3]) {
      // "对话"
      const inner = fullMatch.slice(1, -1).trim()
      if (inner) {
        segments.push({ type: 'dialogue', content: restore(inner) })
      }
    } else if (match[4]) {
      // Speaker: 'dialogue' / Speaker：'dialogue'
      const colonIdx = /[:：]/.exec(fullMatch)!.index
      const speaker = fullMatch.slice(0, colonIdx).trim()
      const rawInner = fullMatch.slice(colonIdx + 1).trim()
      const inner = rawInner.startsWith("'") && rawInner.endsWith("'")
        ? rawInner.slice(1, -1)
        : rawInner
      if (speaker && inner) {
        segments.push({ type: 'dialogue', speaker: restore(speaker), content: restore(inner) })
      }
    }

    lastIndex = match.index + fullMatch.length
  }

  // 末尾剩余纯文本
  if (lastIndex < protectedText.length) {
    const remainingText = protectedText.slice(lastIndex).trim()
    if (remainingText) {
      segments.push({ type: 'plain', content: restore(remainingText) })
    }
  }

  return segments
}
