package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-01 第 8 层：文本度量（可见字符、完整句、格式闭合诊断）
 * （对齐 `shared/textMetrics.ts`）。
 *
 * 续写长度校验、收尾器边界判定与方向选项校验共用同一口径，
 * 避免出现「界面显示 80 字、模型按 90 字理解」这类跨模块不一致。
 *
 * **为什么显式写出空白字符集**：JS 的 `\s` 包含 `\u3000`（全角空格）、`\u00a0`（不换行空格）等
 * Unicode 空白，而 JVM 正则的 `\s` 在默认模式下只保证 ASCII 空白。
 * 依赖平台默认行为会让「可见字符数」在两端漂移，进而改变收尾器的
 * `MIN_KEEP_VISIBLE_CHARS` 判定与补尾决策。这里把 JS 的集合逐字符写死，与 fixture 逐值可比。
 */
object ChatTextMetrics {

    /** 句末标点：以这些字符收尾视为一个完整句。 */
    val SENTENCE_END_CHARS: Set<Char> = setOf('。', '！', '？', '…', '!', '?')

    /** JS `\s`（ES2018+）的等价字符类。 */
    private const val JS_SPACE_CLASS =
        "\\t\\n\\u000B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"

    private val JS_WHITESPACE = Regex("[$JS_SPACE_CLASS]")

    /** 收尾后可以忽略的成对符号（引号、括号、书名号）+ JS 空白。 */
    private val CLOSING_MARKS = Regex("[$JS_SPACE_CLASS\"'”’」』）)】\\]》]+\\z")

    /**
     * 可见字符统计：忽略空白，**按码点计数**（emoji 与代理对按 1 个字符计）。
     * 与 `String.length` 的区别在于不把换行、缩进算进篇幅。
     */
    fun countVisibleCharacters(text: String): Int {
        val stripped = JS_WHITESPACE.replace(text, "")
        return stripped.codePointCount(0, stripped.length)
    }

    /**
     * 是否以完整句收尾。
     * 先剥离末尾成对符号（`她说：“走吧。”` 视为完整），再看最后一个字符是否句末标点。
     * 悬空动作、逗号、顿号、连接词结尾一律判为不完整，用于识别被 maxTokens 截断的输出。
     */
    fun isCompleteSentence(text: String): Boolean {
        val stripped = CLOSING_MARKS.replace(text.trim(), "")
        if (stripped.isEmpty()) return false
        val last = stripped.codePointAt(stripped.length - codePointLengthOfLast(stripped))
        return last.toChar() in SENTENCE_END_CHARS
    }

    /** 取字符串最后一个码点的长度（1 或 2 个 Char），用于按码点定位末字符。 */
    private fun codePointLengthOfLast(text: String): Int {
        if (text.isEmpty()) return 0
        val lastChar = text[text.length - 1]
        return if (Character.isLowSurrogate(lastChar) && text.length >= 2 &&
            Character.isHighSurrogate(text[text.length - 2])
        ) {
            2
        } else {
            1
        }
    }

    /**
     * 在可见字符上限内寻找最后一个句末标点，把超长文本安全收束到句边界。
     * 收束结果必须仍落在 `[minChars, maxChars]` 内，否则返回 null（交由压缩修复处理）。
     */
    fun trimToSentenceBoundary(text: String, minChars: Int, maxChars: Int): String? {
        val chars = text.codePoints().toArray().map { String(Character.toChars(it)) }
        var visible = 0
        var lastBoundary = -1

        for (i in chars.indices) {
            val char = chars[i]
            // 先判上限再记边界，避免把超出 ceiling 的那一句也算进来
            if (!JS_WHITESPACE.matches(char)) {
                visible += 1
                if (visible > maxChars) break
            }
            if (char.length == 1 && char[0] in SENTENCE_END_CHARS) lastBoundary = i + 1
        }

        if (lastBoundary < 0) return null
        val candidate = chars.subList(0, lastBoundary).joinToString("").trimEnd()
        val candidateChars = countVisibleCharacters(candidate)
        if (candidateChars < minChars || candidateChars > maxChars) return null
        return candidate
    }

    // ===================== 格式闭合诊断 =====================

    /** 成对中文引号/括号：开符号与闭符号数量必须相等。 */
    private val PAIRED_MARKS: List<Pair<Char, Char>> = listOf(
        '“' to '”',
        '‘' to '’',
        '「' to '」',
        '『' to '』',
        '（' to '）',
        '《' to '》',
    )

    /** 正文尾部采样长度（观测记录用，避免落盘完整正文）。 */
    const val TAIL_SAMPLE_MAX_CHARS = 80

    /** 取正文尾部采样（按码点截断），用于本地诊断记录。 */
    fun tailSample(text: String, maxChars: Int = TAIL_SAMPLE_MAX_CHARS): String {
        if (text.isEmpty()) return ""
        val collapsed = Regex("[$JS_SPACE_CLASS]+").replace(text, " ").trim()
        val chars = collapsed.codePoints().toArray().map { String(Character.toChars(it)) }
        return if (chars.size <= maxChars) {
            chars.joinToString("")
        } else {
            chars.subList(chars.size - maxChars, chars.size).joinToString("")
        }
    }

    data class TextClosureDiagnostics(
        val balancedQuotes: Boolean,
        val balancedAsterisks: Boolean,
        val closedThought: Boolean,
        val unclosed: Boolean,
    )

    private val COMPLETE_THOUGHT = Regex("<thought[\\s\\S]*?</thought>", RegexOption.IGNORE_CASE)
    private val ANY_THOUGHT_OPEN = Regex("<thought[$JS_SPACE_CLASS>]", RegexOption.IGNORE_CASE)

    /**
     * 正文格式闭合性诊断：
     * - balancedQuotes：中文引号/括号成对；
     * - balancedAsterisks：星号数量为偶数（旧动作段样式）；
     * - closedThought：不存在未闭合的 `<thought>` 标签；
     * - unclosed：以上任一不满足。
     */
    fun analyzeTextClosure(text: String): TextClosureDiagnostics {
        if (text.isEmpty()) {
            return TextClosureDiagnostics(
                balancedQuotes = true,
                balancedAsterisks = true,
                closedThought = true,
                unclosed = false,
            )
        }
        var balancedQuotes = true
        for ((open, close) in PAIRED_MARKS) {
            val openCount = text.count { it == open }
            val closeCount = text.count { it == close }
            if (openCount != closeCount) {
                balancedQuotes = false
                break
            }
        }
        val asterisks = text.count { it == '*' }
        val balancedAsterisks = asterisks % 2 == 0
        // 剥掉完整 <thought>...</thought> 块后不应残留起始标签
        val closedThought = !ANY_THOUGHT_OPEN.containsMatchIn(COMPLETE_THOUGHT.replace(text, ""))
        return TextClosureDiagnostics(
            balancedQuotes = balancedQuotes,
            balancedAsterisks = balancedAsterisks,
            closedThought = closedThought,
            unclosed = !balancedQuotes || !balancedAsterisks || !closedThought,
        )
    }
}
