/**
 * 文本度量工具：可见字符计数与完整句判定。
 *
 * 续写长度校验与方向选项校验共用同一口径，避免出现
 * “界面显示 80 字、模型按 90 字理解”这类跨模块不一致。
 */

/** 句末标点：以这些字符收尾视为一个完整句（方案 §6.5）。 */
export const SENTENCE_END_CHARS: ReadonlySet<string> = new Set([
  '。', '！', '？', '…', '!', '?',
])

/** 收尾后可以忽略的成对符号（引号、括号、书名号）。 */
const CLOSING_MARKS = /[\s"'”’」』）)】\]》]+$/

/**
 * 可见字符统计：忽略空白，按码点计数（emoji 与代理对按 1 个字符计）。
 * 与 `String.length` 的区别在于不把换行、缩进算进篇幅。
 */
export function countVisibleCharacters(text: string): number {
  return Array.from(text.replace(/\s/g, '')).length
}

/**
 * 是否以完整句收尾。
 * 先剥离末尾成对符号（`她说：“走吧。”` 视为完整），再看最后一个字符是否句末标点。
 * 悬空动作、逗号、顿号、连接词结尾一律判为不完整，用于识别被 maxTokens 截断的输出。
 */
export function isCompleteSentence(text: string): boolean {
  const stripped = text.trim().replace(CLOSING_MARKS, '')
  if (!stripped) return false
  const chars = Array.from(stripped)
  return SENTENCE_END_CHARS.has(chars[chars.length - 1])
}

/**
 * 在可见字符上限内寻找最后一个句末标点，把超长文本安全收束到句边界。
 * 收束结果必须仍落在 [minChars, maxChars] 内，否则返回 undefined（交由压缩修复处理）。
 */
export function trimToSentenceBoundary(
  text: string,
  bounds: { minChars: number; maxChars: number },
): string | undefined {
  const chars = Array.from(text)
  let visible = 0
  let lastBoundary: number | undefined

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]
    // 先判上限再记边界，避免把超出 ceiling 的那一句也算进来
    if (!/\s/.test(char)) {
      visible += 1
      if (visible > bounds.maxChars) break
    }
    if (SENTENCE_END_CHARS.has(char)) lastBoundary = i + 1
  }

  if (lastBoundary === undefined) return undefined
  const candidate = chars.slice(0, lastBoundary).join('').trimEnd()
  const candidateChars = countVisibleCharacters(candidate)
  if (candidateChars < bounds.minChars || candidateChars > bounds.maxChars) return undefined
  return candidate
}
