package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-01：JS `RegExp` 语义的 Kotlin 适配层。
 *
 * 跨语言一致性要求两端对同一正则给出同一结果，而 JS 与 JVM 的差异集中在三点：
 *
 * 1. **全局替换**：JS 需要 `g` 标志才替换全部；JVM `Regex.replace` 默认替换全部。
 *    → 本层按 JS 规则处理：无 `g` 时只替换**首次**匹配，并报告是否发生替换。
 * 2. **替换串语义**：JS 把 `$1..$9`、`$&`、`$$` 当特殊序列，**其他字符（含反斜杠）按字面量**；
 *    JVM 则把 `\` 与 `$` 都当转义引入符。
 *    → [jsReplace] 实现 JS 的替换串语义。
 * 3. **标志集**：`i/m/s/u` 映射为 JVM 选项；`g/y` 由调用方语义吸收；其余标志视为非法（返回 null）。
 *
 * 本层是**纯函数**，行为由 `ChatCoreGoldenTest` 对 `regex-*.json` 校验。
 */
object JsRegex {

    /** JS 标志 -> JVM 选项；出现未知标志返回 null（等价 JS `new RegExp` 抛错）。 */
    private fun toOptions(flags: String): Set<RegexOption>? {
        val options = mutableSetOf<RegexOption>()
        for (flag in flags) {
            when (flag) {
                'g', 'y' -> Unit // 全局/粘滞由调用方处理
                'i' -> options += RegexOption.IGNORE_CASE
                'm' -> options += RegexOption.MULTILINE
                's' -> options += RegexOption.DOT_MATCHES_ALL
                'u' -> Unit // JVM 默认按码点处理
                else -> return null
            }
        }
        return options
    }

    /** 是否全局（含 `g`；`y` 在本项目用法中等价于「无限次」，按非全局处理以贴近 JS `y`）。 */
    fun isGlobal(flags: String): Boolean = flags.contains('g')

    /** 等价 `safeRegExp(pattern, flags)`：返回 null 表示模式非法。 */
    fun compile(pattern: String, flags: String): Regex? {
        val options = toOptions(flags) ?: return null
        return runCatching { Regex(pattern, options) }.getOrNull()
    }

    /**
     * 等价 JS `String.prototype.replace(regex, replacement)`。
     *
     * @return 替换后的文本与是否发生替换（`replaced` 用于 `typeof` 比较语义）
     */
    fun jsReplace(text: String, regex: Regex, replacement: String, global: Boolean): Pair<String, Boolean> {
        val match = regex.find(text) ?: return text to false
        if (!global) {
            val replaced = buildReplacement(match, replacement, text)
            val next = text.substring(0, match.range.first) + replaced + text.substring(match.range.last + 1)
            return next to (next != text)
        }
        val sb = StringBuilder()
        var last = 0
        var found = false
        var m: MatchResult? = regex.find(text)
        while (m != null) {
            found = true
            sb.append(text, last, m.range.first)
            sb.append(buildReplacement(m, replacement, text))
            last = m.range.last + 1
            // 空匹配时前进一个字符，避免死循环（等价 JS 全局替换对空匹配的处理）
            if (m.range.isEmpty()) {
                if (last < text.length) {
                    sb.append(text[last])
                    last++
                } else {
                    m = null
                    continue
                }
            }
            m = regex.find(text, last)
        }
        sb.append(text, last, text.length)
        val next = sb.toString()
        return next to (found && next != text)
    }

    /**
     * JS 替换串展开：
     * - `$$` -> 字面 `$`
     * - `$&` -> 整个匹配
     * - `` $` `` / `$'` -> 匹配前/后文本
     * - `$1..$9`（多位数取最长可用组）-> 捕获组
     * - 其他 `$x` 原样保留；反斜杠无特殊含义
     */
    private fun buildReplacement(match: MatchResult, replacement: String, source: String): String {
        val sb = StringBuilder(replacement.length)
        var i = 0
        while (i < replacement.length) {
            val ch = replacement[i]
            if (ch != '$' || i + 1 >= replacement.length) {
                sb.append(ch)
                i++
                continue
            }
            when (val next = replacement[i + 1]) {
                '$' -> {
                    sb.append('$')
                    i += 2
                }
                '&' -> {
                    sb.append(match.value)
                    i += 2
                }
                '`' -> {
                    sb.append(source.substring(0, match.range.first))
                    i += 2
                }
                '\'' -> {
                    sb.append(source.substring(match.range.last + 1))
                    i += 2
                }
                in '0'..'9' -> {
                    // 贪婪取最长可用捕获组编号（JS 行为）
                    var digits = ""
                    var j = i + 1
                    while (j < replacement.length && replacement[j].isDigit() && digits.length < 2) {
                        val candidate = digits + replacement[j]
                        val index = candidate.toInt()
                        if (index in 1..match.groups.size - 1) {
                            digits = candidate
                            j++
                        } else {
                            break
                        }
                    }
                    if (digits.isEmpty()) {
                        sb.append(ch)
                        i++
                    } else {
                        sb.append(match.groups[digits.toInt()]?.value ?: "")
                        i += 1 + digits.length
                    }
                }
                else -> {
                    sb.append(ch)
                    i++
                }
            }
        }
        return sb.toString()
    }
}
