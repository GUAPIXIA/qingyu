package com.qingyu.companion.content

import com.qingyu.companion.chatcore.JsRegex
import java.util.regex.PatternSyntaxException

/**
 * 阶段 5 S5-05：正则的兼容性分析与灾难性回溯限制。
 *
 * 方案对 S5-05 提了两条硬要求，都在这里实现：
 * 1. 「对灾难性回溯设置执行超时或安全限制」；
 * 2. 「非 JavaScript/Java 共通的正则特性必须在导入时提示兼容性，不静默改变含义」。
 *
 * ### 为什么不用超时线程
 *
 * 最直觉的做法是「跑在一个可取消的线程上，超时 kill」。这里刻意不用：
 * - 正则回溯发生在原生匹配循环内部，**不响应中断**，取消/超时线程只能等它自己跑完，
 *   或者让线程泄漏在一个不可中断的死循环里；
 * - Kotlin 协程的 `withTimeoutOrNull` 同样只是设置取消标志，`Regex.find` 不会因此停下；
 * - 编辑器的「测试台」要给用户一个**可复现**的答案：同一条规则、同一段文本，
 *   在不同负载/不同温度的机器上有时成功有时超时的结果是不可接受的。
 *
 * 所以这里用**工作量预算**：把被匹配文本包一层计数 `CharSequence`，
 * 匹配过程中每取一个字符就记一次数，超过预算就抛异常。
 * 回溯型爆炸的本质就是对同一批位置反复取字符，因此预算必然被击穿；
 * 而预算只取决于「字符访问次数」，同一输入在同一规则上结果恒定，测试可复现。
 *
 * 校准数据（JDK 17 `java.util.regex`，实测见 `RegexCompatibilityTest`）：约 20 万次字符访问
 * 耗时 1ms；线性扫描 `a+z` 在 5,000 字文本上记 4,998 次（≈文本长度），
 * 而 `(x+x+)+y` 同样结构在 100 字文本上记 667,000 次（放大约 6,600 倍）。
 *
 * 别把这里想成「JS 的炸弹列表在 Java 上同样炸」：`(a+)+b` 在 V8 上是 2^28 级回溯，
 * Java 引擎却把 `(a+)+` 归并成 `a+` 并对必选字面量做预搜索，28 字仅 1,625 次访问。
 * 也就是说**引擎优化不可依赖**（换机型/换 JDK 结论就变），预算是唯一的稳定防线。
 */
object RegexCompatibility {

    /**
     * 默认工作预算：约等于「在 200k 文本上线性扫描 20 遍」的访问量上界，
     * 按实测 20 万次/毫秒折算约 20ms —— 主线程一帧的量级，
     * 既不至于让正常的长文本清理规则被误杀，也不至于让放大规则吃掉秒级时间。
     */
    const val DEFAULT_WORK_BUDGET = 4_000_000L

    /** 单次匹配允许的文本长度上限，与 `ChatRegex.MAX_TEXT_LENGTH` 同一口径。 */
    const val MAX_TEXT_LENGTH = 200_000

    /** 兼容性与风险的结论。 */
    enum class Verdict {
        /** 两端语义一致，可直接导入 */
        SUPPORTED,

        /** 能跑，但含义与来源平台不同（必须提示，不能静默） */
        APPROXIMATE,

        /** 目标引擎不支持，导入后行为会缺失 */
        UNSUPPORTED,

        /** 连编译都过不了 */
        REJECTED,
    }

    data class Finding(
        val feature: String,
        val verdict: Verdict,
        val message: String,
        val suggestion: String? = null,
    )

    data class Analysis(
        val compiles: Boolean,
        val findings: List<Finding>,
        val backtrackingRisk: BacktrackingRisk,
    ) {
        /** 有 UNSUPPORTED/REJECTED 时导入必须显式确认，方案禁止静默改变含义。 */
        val requiresUserConfirmation: Boolean
            get() = findings.any { it.verdict == Verdict.UNSUPPORTED || it.verdict == Verdict.REJECTED } ||
                !compiles ||
                backtrackingRisk.level == RiskLevel.HIGH
    }

    enum class RiskLevel { NONE, ELEVATED, HIGH }

    data class BacktrackingRisk(val level: RiskLevel, val reason: String)

    /** 匹配结果：命中或被预算拦下。预算耗尽**不是**「没匹配上」，必须区分。 */
    sealed interface MatchOutcome {
        data class Completed(val matched: Boolean, val work: Long) : MatchOutcome
        data class Aborted(val work: Long) : MatchOutcome
    }

    // ------------------------------------------------------------ 分析

    /**
     * 分析一条规则。[sourceEngine] 是来源平台（`javascript` / `python` / `java`），
     * 决定「谁有谁没有」的方向——例如 Python 风格命名组在两端都不支持，
     * 而 `\Z` 是 Python/Java 有、JavaScript 没有。
     */
    fun analyze(pattern: String, flags: String = "g", sourceEngine: String = "javascript"): Analysis {
        val findings = ArrayList<Finding>()
        if (pattern.isEmpty()) {
            return Analysis(
                compiles = false,
                findings = listOf(Finding("empty-pattern", Verdict.REJECTED, "模式为空，规则不会生效")),
                backtrackingRisk = BacktrackingRisk(RiskLevel.NONE, "空模式"),
            )
        }

        // 只用**静态扫描**判断特性差异：不要用「在本机 try 一次看会不会抛」来推断，
        // 那样一条真正会炸的 pattern 会先把编辑器卡死。
        scanConstructs(pattern).forEach { findings += it }
        if (sourceEngine == "python") {
            findings += Finding(
                "python-source",
                Verdict.APPROXIMATE,
                "来源是 Python 正则：`\\s\\w\\d` 的 Unicode 语义与 `re.UNICODE` 默认值与 JS 不同",
                "导入后按 JavaScript 语义执行，如需严格一致请人工复核",
            )
        }

        val compiles = JsRegex.compile(pattern, flags) != null
        if (!compiles) {
            findings += Finding(
                "compile",
                Verdict.REJECTED,
                "该引擎无法编译此模式（标志「$flags」或语法不被支持）",
            )
        }

        return Analysis(
            compiles = compiles,
            findings = findings,
            backtrackingRisk = assessBacktracking(pattern),
        )
    }

    private fun scanConstructs(pattern: String): List<Finding> {
        val out = ArrayList<Finding>()
        if (pythonNamedGroup.containsMatchIn(pattern)) {
            out += Finding(
                "python-named-group",
                Verdict.UNSUPPORTED,
                "Python 风格命名组 `(?P<name>…)` 在 JavaScript 与 Java 中都不支持",
                "改写为 `(?<name>…)`",
            )
        }
        if (endOfInputAnchor.containsMatchIn(pattern)) {
            out += Finding(
                "backslash-Z",
                Verdict.UNSUPPORTED,
                "`\\Z` 是 Python/Java 的结尾锚，JavaScript 没有它；\$ 锚在带 m 标志时语义也不同",
                "改用 Java 的字符串结束锚，或按需要去掉 m 标志",
            )
        }
        if (possessiveOrAtomic.containsMatchIn(pattern)) {
            out += Finding(
                "possessive-atomic",
                Verdict.APPROXIMATE,
                "占有量词 `*+`/`++`/`?+` 与原子组 `(?>…)` 是 Java 特性，JavaScript 不支持",
                "Android 侧按 Java 引擎执行；导回 PC 时这段会失效，建议改用非回溯写法",
            )
        }
        if (unicodeProperty.containsMatchIn(pattern)) {
            out += Finding(
                "unicode-property",
                Verdict.APPROXIMATE,
                "`\\p{…}` 在 Java 与 JavaScript 的字符类覆盖范围不完全一致",
            )
        }
        if (lookbehind.containsMatchIn(pattern)) {
            out += Finding(
                "lookbehind",
                Verdict.SUPPORTED,
                "变长后顾 `(?<=…)`/`(?<!…)`：ES2018 起两端都支持，但部分社区卡按旧引擎生成",
            )
        }
        if (inlineFlags.containsMatchIn(pattern)) {
            out += Finding(
                "inline-flags",
                Verdict.APPROXIMATE,
                "内联标志组 `(?imsx)` 在 JavaScript 中不是合法语法",
            )
        }
        return out
    }

    /**
     * 静态回溯风险判定：只找**结构性**的指数级模式，不做语义等价判断。
     *
     * 三类经典成因：
     * - 量词套量词：`(a+)+`、`(a*)*`、`(.*)*b`
     * - 量词作用在有重叠分支的分组上：`(a|ab)*c`
     * - 相邻的同字符量词：`a+a+`、`\d*\d*`
     *
     * 判不准没关系（宁可提示也别漏），因为真正的兜底是 [matchWithWorkLimit]。
     */
    fun assessBacktracking(pattern: String): BacktrackingRisk {
        val cleaned = stripEscapes(pattern)
        nestedQuantifier.find(cleaned)?.let {
            return BacktrackingRisk(
                RiskLevel.HIGH,
                "分组内部有量词、分组外部又有量词（形如 `${it.value}`），不匹配时可能指数级回溯",
            )
        }
        if (overlappingAlternation.matches(cleaned)) {
            return BacktrackingRisk(
                RiskLevel.HIGH,
                "被量化的分组内含可互相匹配的分支（形如 `(a|ab)*`），不匹配时可能指数级回溯",
            )
        }
        if (adjacentSameQuantifier.matches(cleaned)) {
            return BacktrackingRisk(
                RiskLevel.ELEVATED,
                "相邻片段使用同一字符类且都带量词，存在多项式级重复扫描",
            )
        }
        if (unboundedDotStar.matches(cleaned)) {
            return BacktrackingRisk(
                RiskLevel.ELEVATED,
                "连续的 `.*` 组合在大文本上代价偏高",
            )
        }
        return BacktrackingRisk(RiskLevel.NONE, "未发现典型回溯放大结构")
    }

    private val nestedQuantifier = Regex("""\([^()]*[*+][^()]*\)\s*[*+]""")
    private val overlappingAlternation = Regex("""\(([^()|]+)\|[^()]*\1[^()]*\)\s*[*+]""")
    private val adjacentSameQuantifier = Regex("""([^\s()]{1,4})[*+][^\s()]{0,4}[*+]$""")
    private val unboundedDotStar = Regex("""\.\s*\*.*\.\s*\*""")

    private val pythonNamedGroup = Regex("""\(\?P<""")
    private val endOfInputAnchor = Regex("""\\Z""")
    private val possessiveOrAtomic = Regex("""([*+?]\+|\(\?>)""")
    private val unicodeProperty = Regex("""\\p\{""")
    private val lookbehind = Regex("""\(\?<[=!]""")
    private val inlineFlags = Regex("""\(\?[imsxu]+[-:]""")

    /** 去掉 `\.` 这类转义字符，避免把 `\(a\)\+` 误判成量词套量词。 */
    private fun stripEscapes(pattern: String): String {
        val sb = StringBuilder(pattern.length)
        var index = 0
        while (index < pattern.length) {
            val ch = pattern[index]
            if (ch == '\\' && index + 1 < pattern.length) {
                sb.append(pattern, index, index + 2)
                index += 2
                continue
            }
            sb.append(ch)
            index++
        }
        return sb.toString()
    }

    // ------------------------------------------------------------ 预算受控匹配

    /**
     * 带工作预算的匹配。
     *
     * [limit] 是「允许被读取的字符次数」。回溯爆炸时这个数会远大于文本长度，
     * 因此耗尽即中止；线性匹配时它约等于文本长度的常数倍。
     *
     * 注意用 `java.util.regex` 而不是 Kotlin `Regex` 直接跑：Kotlin 的 `Regex`
     * 对 `CharSequence` 会先 `toString()`（见其实现），那样计数就失效了。
     * `java.util.regex.Matcher` 明确接受任意 `CharSequence`，逐位调用 `charAt`。
     */
    fun matchWithWorkLimit(
        pattern: String,
        flags: String,
        text: String,
        limit: Long = DEFAULT_WORK_BUDGET,
    ): MatchOutcome {
        if (text.length > MAX_TEXT_LENGTH) {
            return MatchOutcome.Aborted(0)
        }
        val options = toJavaFlags(flags) ?: return MatchOutcome.Aborted(0)
        val compiled = try {
            java.util.regex.Pattern.compile(toJavaPattern(pattern), options)
        } catch (_: PatternSyntaxException) {
            return MatchOutcome.Aborted(0)
        }
        // 预算必须在匹配**过程中**生效：等 find() 返回再比次数等于允许它先跑完指数级回溯。
        val counted = CountingCharSequence(text, budget = limit)
        val matcher = compiled.matcher(counted)
        val matched = try {
            matcher.find()
        } catch (_: WorkBudgetExceededException) {
            return MatchOutcome.Aborted(counted.reads)
        }
        return MatchOutcome.Completed(matched, counted.reads)
    }

    /**
     * JS 的 Unicode 属性写法 → Java 写法（`\p{Han}` → `\p{IsHan}`）。
     *
     * 清理规则的正则是 PC（JavaScript）语法存的，而 Java 不认裸脚本名：
     * 不做这层翻译，`\p{…}` 规则在 Android 上直接编译失败并被判为「中止」——
     * [analyze] 只把它标成 APPROXIMATE，运行时却整条规则失效，正是方案 §2 禁止的静默改含义。
     * 已带 `Is`/`In` 前缀的名字与 `Script=Greek` 这类带等号的写法原样交给 Java 自己判。
     */
    private fun toJavaPattern(pattern: String): String =
        unicodePropertySyntax.replace(pattern) { match ->
            val name = match.groupValues[2]
            if (name.startsWith("Is") || name.startsWith("In") || '=' in name) {
                match.value
            } else {
                "\\${match.groupValues[1]}{Is$name}"
            }
        }

    private val unicodePropertySyntax = Regex("""\\([pP])\{([^{}]*)\}""")

    /** JS 标志集 → `java.util.regex.Pattern` 标志；未知标志返回 null（与 `JsRegex` 同一判定）。 */
    private fun toJavaFlags(flags: String): Int? {
        var options = 0
        for (flag in flags) {
            when (flag) {
                'g', 'y' -> Unit
                'i' -> options = options or java.util.regex.Pattern.CASE_INSENSITIVE
                'm' -> options = options or java.util.regex.Pattern.MULTILINE
                's' -> options = options or java.util.regex.Pattern.DOTALL
                'u' -> Unit
                else -> return null
            }
        }
        return options
    }

    private class WorkBudgetExceededException : RuntimeException("正则工作预算耗尽")

    /** 每读一个字符记一次数，超预算抛出——这是让不可中断的匹配循环能被中止的唯一办法。 */
    internal class CountingCharSequence(
        private val delegate: String,
        var budget: Long = Long.MAX_VALUE,
    ) : CharSequence {
        var reads: Long = 0
            private set

        override val length: Int get() = delegate.length

        override fun get(index: Int): Char = read(index)

        override fun subSequence(startIndex: Int, endIndex: Int): CharSequence =
            delegate.subSequence(startIndex, endIndex)

        fun read(index: Int): Char {
            reads += 1
            if (reads > budget) throw WorkBudgetExceededException()
            return delegate[index]
        }

        override fun toString(): String = delegate
    }
}
