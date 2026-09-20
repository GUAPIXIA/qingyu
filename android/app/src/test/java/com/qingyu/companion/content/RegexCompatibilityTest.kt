package com.qingyu.companion.content

import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * 阶段 5 S5-05：正则兼容性与灾难性回溯限制的测试。
 *
 * 重点是**反向**用例：一条会炸的模式必须在预算内被拦下。
 * 只测「合法模式能匹配」是测不到这个需求的——合法模式什么时候都能过。
 */
class RegexCompatibilityTest {

    // ------------------------------------------------------------ 兼容性提示

    @Test
    fun flagsPythonOnlyAndJavaOnlyConstructsInsteadOfSilentlyReshapingThem() {
        // 方案原文：「不静默改变含义」。所以这些必须是明确的 UNSUPPORTED/APPROXIMATE，
        // 而不是被当成合法模式跑出一个不同的结果。
        val pythonNamed = RegexCompatibility.analyze("(?P<word>\\w+)", "g", "python")
        assertTrue(
            pythonNamed.findings.any { it.feature == "python-named-group" && it.verdict == RegexCompatibility.Verdict.UNSUPPORTED },
            "Python 命名组必须报 UNSUPPORTED：${pythonNamed.findings}",
        )

        val atomic = RegexCompatibility.analyze("(?>a|ab)c", "g")
        assertTrue(
            atomic.findings.any { it.feature == "possessive-atomic" },
            "原子组必须给出 Java/JS 差异提示：${atomic.findings}",
        )

        val endAnchor = RegexCompatibility.analyze("abc\\Z", "g", "python")
        assertTrue(
            endAnchor.findings.any { it.feature == "backslash-Z" },
            "`\\Z` 在 JavaScript 不存在，必须提示：${endAnchor.findings}",
        )
    }

    @Test
    fun plainRulesNeedNoUserConfirmation() {
        val analysis = RegexCompatibility.analyze("\\s+", "g")
        assertTrue(analysis.compiles)
        assertEquals(RegexCompatibility.RiskLevel.NONE, analysis.backtrackingRisk.level)
        assertTrue(!analysis.requiresUserConfirmation)
    }

    @Test
    fun invalidFlagsAreReportedAsRejectNotAsNoMatch() {
        // `p` 不是 JS 标志；JsRegex 会返回 null。规则若静默失效，
        // 用户会以为「这条清理规则没起作用」而删掉它。
        val analysis = RegexCompatibility.analyze("\\d+", "gp")
        assertTrue(!analysis.compiles, "未知标志必须导致 compiles=false")
        assertTrue(analysis.requiresUserConfirmation)
        assertTrue(analysis.findings.any { it.feature == "compile" })
    }

    @Test
    fun escapesDoNotTriggerFalseBacktrackingWarnings() {
        // `\(a\)\+` 里的括号和加号都是字面量，不该被判成量词套量词
        val analysis = RegexCompatibility.analyze("""\(a\)\+""", "g")
        assertEquals(RegexCompatibility.RiskLevel.NONE, analysis.backtrackingRisk.level, analysis.backtrackingRisk.reason)
    }

    @Test
    fun nestedQuantifiersAreFlaggedHighRisk() {
        listOf("(a+)+b", "(a*)*", "(.*)*x", "([a-zA-Z]+)*=").forEach { pattern ->
            val risk = RegexCompatibility.assessBacktracking(pattern)
            assertEquals(
                RegexCompatibility.RiskLevel.HIGH,
                risk.level,
                "$pattern 应判为高风险：${risk.reason}",
            )
        }
    }

    // ------------------------------------------------------------ 工作预算

    @Test
    fun linearPatternCompletesWellBelowBudget() {
        val text = "轻语".repeat(2_000)
        val outcome = RegexCompatibility.matchWithWorkLimit("""\p{Han}+""", "g", text, limit = 200_000)
        assertTrue(outcome is RegexCompatibility.MatchOutcome.Completed, "线性模式不该被预算拦下")
        assertTrue((outcome as RegexCompatibility.MatchOutcome.Completed).matched)
        assertTrue(outcome.work < 200_000, "线性匹配的访问量应与文本长度同阶，实际 ${outcome.work}")
    }

    @Test
    fun catastrophicBacktrackingIsAbortedRatherThanHanging() {
        // 实测数据（JDK 17 `java.util.regex`，也就是 Robolectric 用的同一引擎）：
        // `(x+x+)+y` 对 24 个 x 花 9,296 次字符访问，对 100 个 x 花 667,000 次 ——
        // 输入长 2.5 倍、代价涨 70 倍，这就是量词套量词的放大。没有预算时它只能跑到底。
        //
        // 为什么不用 JS 教科书炸弹 `(a+)+b`：V8 上是 2^28 级回溯，但 Java 引擎把 `(a+)+`
        // 归并成 `a+`、又对必选字面量 `b` 做预搜索，实测 28 个 a 只花 1,625 次访问就返回未命中。
        // 拿它当用例等于恒真——测的是引擎脾气，不是我们的预算。
        val outcome = RegexCompatibility.matchWithWorkLimit(
            "(x+x+)+y", "g", "x".repeat(100) + "!", limit = 20_000,
        )
        assertTrue(
            outcome is RegexCompatibility.MatchOutcome.Aborted,
            "预算必须能在回溯放大时中止匹配，实际：$outcome",
        )
        assertEquals(20_001L, (outcome as RegexCompatibility.MatchOutcome.Aborted).work, "应恰好在预算处停下")
    }

    @Test
    fun abortedIsNotReportedAsNoMatch() {
        // 这条区分是整套限制的意义所在：「超时」≠「没匹配上」。
        // 若两者混为一谈，输出清理规则会在长文本上静默失效。
        val bomb = "(x+x+)+y"
        val withinBudget = RegexCompatibility.matchWithWorkLimit(
            bomb, "g", "x".repeat(24) + "!", limit = 20_000,
        )
        val overBudget = RegexCompatibility.matchWithWorkLimit(
            bomb, "g", "x".repeat(100) + "!", limit = 20_000,
        )
        assertTrue(
            withinBudget is RegexCompatibility.MatchOutcome.Completed && !withinBudget.matched,
            "同一模式在小文本上是真未命中：$withinBudget",
        )
        assertTrue(
            overBudget is RegexCompatibility.MatchOutcome.Aborted,
            "同一模式在大文本上必须是中止，不能复用「未命中」结论：$overBudget",
        )
        // 放宽预算后大文本也跑完并且未命中：证明 Aborted 只是「中途没跑完」，不是引擎给出的答案
        val unbounded = RegexCompatibility.matchWithWorkLimit(
            bomb, "g", "x".repeat(100) + "!", limit = RegexCompatibility.DEFAULT_WORK_BUDGET,
        )
        assertTrue(
            unbounded is RegexCompatibility.MatchOutcome.Completed && !unbounded.matched,
            "预算内其实跑得完：说明中止是预算切断，而非结论",
        )
    }

    @Test
    fun oversizedInputIsRefusedBeforeMatching() {
        val outcome = RegexCompatibility.matchWithWorkLimit(
            "a", "g", "a".repeat(RegexCompatibility.MAX_TEXT_LENGTH + 1),
        )
        assertTrue(outcome is RegexCompatibility.MatchOutcome.Aborted)
        assertEquals(0L, (outcome as RegexCompatibility.MatchOutcome.Aborted).work)
    }

    @Test
    fun unknownFlagsAbortWithoutTouchingTheEngine() {
        val outcome = RegexCompatibility.matchWithWorkLimit("a", "z", "aaa")
        assertTrue(outcome is RegexCompatibility.MatchOutcome.Aborted)
    }

    @Test
    fun malformedPatternAbortsInsteadOfThrowing() {
        // 测试台会把用户正在编辑的半成品模式喂进来，未闭合括号是常态而不是异常路径
        val outcome = RegexCompatibility.matchWithWorkLimit("(unclosed", "g", "text")
        assertTrue(outcome is RegexCompatibility.MatchOutcome.Aborted)
    }

    // ------------------------------------------------------------ 预算计数器本身

    @Test
    fun countingCharSequenceBehavesLikeTheStringItWraps() {
        val counted = RegexCompatibility.CountingCharSequence("abc")
        assertEquals(3, counted.length)
        assertEquals('b', counted[1])
        assertEquals("bc", counted.subSequence(1, 3))
        assertEquals(1L, counted.reads, "只有取字符才算工作量")
        assertNotNull(counted.toString().takeIf { it == "abc" })
    }

    @Test
    fun budgetIsEnforcedMidMatchNotAfterIt() {
        val counted = RegexCompatibility.CountingCharSequence("abcdef", budget = 2)
        assertEquals('a', counted.read(0))
        assertEquals('b', counted.read(1))
        val failure = runCatching { counted.read(2) }.exceptionOrNull()
        assertNotNull(failure, "超预算必须抛出，而不是让匹配继续")
    }
}
