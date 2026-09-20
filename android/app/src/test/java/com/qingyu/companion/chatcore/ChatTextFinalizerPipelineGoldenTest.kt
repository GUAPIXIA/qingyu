package com.qingyu.companion.chatcore

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-01 第 8 层：文本度量 / 收尾器 / 收尾管线的跨语言一致性测试
 * （对齐 fixture `text-finalizer-pipeline.json`，oracle 为 PC 的
 * `shared/textMetrics.ts`、`shared/assistantOutputFinalizer.ts`、
 * `shared/chat-core/generatedReplyPipeline.ts`）。
 *
 * 这一层决定「什么正文可以落盘」：收尾器的边界判定一旦与 PC 不同，
 * 同一段模型输出会在两端得到不同的可保存内容与不同提示。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatTextFinalizerPipelineGoldenTest {

    private val root = ChatCoreFixtures.root("text-finalizer-pipeline")

    /** 与 TS fixture 中同样实现的「最长后缀/前缀重叠」去重器。 */
    private fun trimOverlap(prev: String, next: String): String {
        val max = minOf(prev.length, next.length)
        for (i in max downTo 1) {
            if (prev.endsWith(next.substring(0, i))) return next.substring(i)
        }
        return next
    }

    private fun mapOfDiagnostics(d: ChatAssistantOutputFinalizer.Diagnostics): Map<String, Any?> = linkedMapOf(
        "completeSentence" to d.completeSentence,
        "balancedQuotes" to d.balancedQuotes,
        "balancedMarkup" to d.balancedMarkup,
        "visibleChars" to d.visibleChars.toLong(),
    )

    @Test
    fun textMetricsMatchPc() {
        val metrics = ChatCoreFixtures.mapOrNull(root, "metrics")!!

        val expectedChars = (ChatCoreFixtures.listOrNull(metrics, "sentenceEndChars") as? List<*>)
            ?.map { (it as String)[0] }?.toSet() ?: emptySet()
        assertEquals("SENTENCE_END_CHARS", expectedChars, ChatTextMetrics.SENTENCE_END_CHARS)
        assertEquals(
            "TAIL_SAMPLE_MAX_CHARS",
            ChatCoreFixtures.intOrNull(metrics, "tailSampleMaxChars"),
            ChatTextMetrics.TAIL_SAMPLE_MAX_CHARS,
        )

        @Suppress("UNCHECKED_CAST")
        val visibleCases = (ChatCoreFixtures.listOrNull(metrics, "visibleCases") as? List<Map<String, Any?>>)
            ?: error("缺少 visibleCases")
        for (case in visibleCases) {
            val text = ChatCoreFixtures.str(case, "text") ?: ""
            assertEquals(
                "countVisibleCharacters(${text.take(12)})",
                ChatCoreFixtures.intOrNull(case, "visible"),
                ChatTextMetrics.countVisibleCharacters(text),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val sentenceCases = (ChatCoreFixtures.listOrNull(metrics, "completeSentenceCases") as? List<Map<String, Any?>>)
            ?: error("缺少 completeSentenceCases")
        for (case in sentenceCases) {
            val text = ChatCoreFixtures.str(case, "text") ?: ""
            assertEquals(
                "isCompleteSentence(${text.take(12)})",
                ChatCoreFixtures.boolOrNull(case, "complete"),
                ChatTextMetrics.isCompleteSentence(text),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val trimCases = (ChatCoreFixtures.listOrNull(metrics, "trimBoundaryCases") as? List<Map<String, Any?>>)
            ?: error("缺少 trimBoundaryCases")
        for (case in trimCases) {
            val text = ChatCoreFixtures.str(case, "text") ?: ""
            val minChars = (case["minChars"] as Number).toInt()
            val maxChars = (case["maxChars"] as Number).toInt()
            assertEquals(
                "trimToSentenceBoundary(${text.take(12)}, $minChars, $maxChars)",
                ChatCoreFixtures.str(case, "result"),
                ChatTextMetrics.trimToSentenceBoundary(text, minChars, maxChars),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val tailCases = (ChatCoreFixtures.listOrNull(metrics, "tailSampleCases") as? List<Map<String, Any?>>)
            ?: error("缺少 tailSampleCases")
        for (case in tailCases) {
            val text = ChatCoreFixtures.str(case, "text") ?: ""
            val maxChars = ChatCoreFixtures.intOrNull(case, "maxChars")
            val actual = if (maxChars == null) {
                ChatTextMetrics.tailSample(text)
            } else {
                ChatTextMetrics.tailSample(text, maxChars)
            }
            assertEquals("tailSample(len=${text.length}, max=$maxChars)", ChatCoreFixtures.str(case, "sample"), actual)
        }

        @Suppress("UNCHECKED_CAST")
        val closureCases = (ChatCoreFixtures.listOrNull(metrics, "closureCases") as? List<Map<String, Any?>>)
            ?: error("缺少 closureCases")
        for (case in closureCases) {
            val text = ChatCoreFixtures.str(case, "text") ?: ""
            val actual = ChatTextMetrics.analyzeTextClosure(text)
            val expected = ChatCoreFixtures.mapOrNull(case, "closure")!!
            val label = "analyzeTextClosure(${text.take(14)})"
            assertEquals("$label.balancedQuotes", ChatCoreFixtures.boolOrNull(expected, "balancedQuotes"), actual.balancedQuotes)
            assertEquals(
                "$label.balancedAsterisks",
                ChatCoreFixtures.boolOrNull(expected, "balancedAsterisks"),
                actual.balancedAsterisks,
            )
            assertEquals("$label.closedThought", ChatCoreFixtures.boolOrNull(expected, "closedThought"), actual.closedThought)
            assertEquals("$label.unclosed", ChatCoreFixtures.boolOrNull(expected, "unclosed"), actual.unclosed)
        }
    }

    @Test
    fun finalizerMatchesPc() {
        val finalizer = ChatCoreFixtures.mapOrNull(root, "finalizer")!!

        @Suppress("UNCHECKED_CAST")
        val contextCases = (ChatCoreFixtures.listOrNull(finalizer, "repairContextCases") as? List<Map<String, Any?>>)
            ?: error("缺少 repairContextCases")
        for (case in contextCases) {
            val rawText = ChatCoreFixtures.str(case, "rawText") ?: ""
            assertEquals(
                "buildRepairContext(len=${rawText.length})",
                ChatCoreFixtures.str(case, "context"),
                ChatAssistantOutputFinalizer.buildRepairContext(rawText),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val finalizeCases = (ChatCoreFixtures.listOrNull(finalizer, "finalizeCases") as? List<Map<String, Any?>>)
            ?: error("缺少 finalizeCases")
        for (case in finalizeCases) {
            val rawText = ChatCoreFixtures.str(case, "rawText") ?: ""
            val finishReason = ChatCoreFixtures.str(case, "finishReason")
            val actual = ChatAssistantOutputFinalizer.finalizeAssistantOutput(rawText, finishReason)
            val label = "finalize(${rawText.take(16)}, $finishReason)"
            assertEquals("$label.content", ChatCoreFixtures.str(case, "content"), actual.content)
            assertEquals("$label.status", ChatCoreFixtures.str(case, "status"), actual.status)
            assertEquals("$label.notice", ChatCoreFixtures.str(case, "notice"), actual.notice)
            assertEquals("$label.repairContext", ChatCoreFixtures.str(case, "repairContext"), actual.repairContext)
            assertEquals("$label.brokenTail", ChatCoreFixtures.str(case, "brokenTail"), actual.brokenTail)
            val expectedDiagnostics = ChatCoreFixtures.mapOrNull(case, "diagnostics")!!
            val actualDiagnostics = mapOfDiagnostics(actual.diagnostics)
            for (key in listOf("completeSentence", "balancedQuotes", "balancedMarkup")) {
                assertEquals(
                    "$label.diagnostics.$key",
                    ChatCoreFixtures.boolOrNull(expectedDiagnostics, key),
                    actualDiagnostics[key],
                )
            }
            assertEquals(
                "$label.diagnostics.visibleChars",
                ChatCoreFixtures.intOrNull(expectedDiagnostics, "visibleChars"),
                actual.diagnostics.visibleChars,
            )
        }

        @Suppress("UNCHECKED_CAST")
        val mergeCases = (ChatCoreFixtures.listOrNull(finalizer, "mergeCases") as? List<Map<String, Any?>>)
            ?: error("缺少 mergeCases")
        for (case in mergeCases) {
            val rawText = ChatCoreFixtures.str(case, "rawText") ?: ""
            val finishReason = ChatCoreFixtures.str(case, "finishReason")
            val repairText = ChatCoreFixtures.str(case, "repairText") ?: ""
            val mergeFinishReason = ChatCoreFixtures.str(case, "mergeFinishReason")
            val base = ChatAssistantOutputFinalizer.finalizeAssistantOutput(rawText, finishReason)
            val merged = ChatAssistantOutputFinalizer.mergeTailRepair(
                finalized = base,
                repairText = repairText,
                finishReason = mergeFinishReason,
                trimOverlap = ::trimOverlap,
            )
            val label = "merge(${rawText.take(12)}, repair=${repairText.take(12)})"
            assertEquals("$label.baseStatus", ChatCoreFixtures.str(case, "baseStatus"), base.status)
            assertEquals("$label.baseContent", ChatCoreFixtures.str(case, "baseContent"), base.content)
            assertEquals("$label.content", ChatCoreFixtures.str(case, "content"), merged.content)
            assertEquals("$label.status", ChatCoreFixtures.str(case, "status"), merged.status)
            assertEquals("$label.notice", ChatCoreFixtures.str(case, "notice"), merged.notice)
        }
    }

    @Test
    fun pipelineMatchesPc() {
        val pipeline = ChatCoreFixtures.mapOrNull(root, "pipeline")!!
        val runCases = (ChatCoreFixtures.listOrNull(pipeline, "runCases") as? List<Map<String, Any?>>)
            ?: error("缺少 runCases")
        runBlocking {
            runCases.forEachIndexed { index, case ->
                val rawText = ChatCoreFixtures.str(case, "rawText") ?: ""
                val finishReason = ChatCoreFixtures.str(case, "finishReason")
                val repairText = ChatCoreFixtures.str(case, "repairText")
                // hasRepair 必须显式判断：repairText=null 与「未注入执行器」语义不同
                val hasRepair = ChatCoreFixtures.boolOrNull(case, "hasRepair") ?: false
                val outcome = ChatGeneratedReplyPipeline.runGeneratedReplyPipeline(
                    ChatGeneratedReplyPipeline.Options(
                        rawText = rawText,
                        finishReason = finishReason,
                        regexRules = rulesOf(case),
                        characterName = "苏晚",
                        runTailRepair = if (hasRepair) { _ -> repairText } else null,
                        allowEmptyTailPassthrough = ChatCoreFixtures.boolOrNull(case, "allowEmptyTailPassthrough")
                            ?: false,
                    ),
                )
                val label = "pipeline#$index(${rawText.take(14)}, $finishReason)"
                assertEquals("$label.content", ChatCoreFixtures.str(case, "content"), outcome.content)
                assertEquals("$label.status", ChatCoreFixtures.str(case, "status"), outcome.status)
                assertEquals("$label.notice", ChatCoreFixtures.str(case, "notice"), outcome.notice)
                assertEquals("$label.repairFailed", ChatCoreFixtures.boolOrNull(case, "repairFailed"), outcome.repairFailed)
            }

            val terminalCases = (ChatCoreFixtures.listOrNull(pipeline, "terminalCases") as? List<Map<String, Any?>>)
                ?: error("缺少 terminalCases")
            terminalCases.forEachIndexed { index, case ->
                val rawText = ChatCoreFixtures.str(case, "rawText") ?: ""
                val finishReason = ChatCoreFixtures.str(case, "finishReason")
                val cause = ChatCoreFixtures.str(case, "terminationCause")!!
                val repairText = ChatCoreFixtures.str(case, "repairText")
                val hasRepair = ChatCoreFixtures.boolOrNull(case, "hasRepair") ?: false
                val outcome = ChatGeneratedReplyPipeline.finalizeGenerationTerminalResult(
                    rawText = rawText,
                    finishReason = finishReason,
                    terminationCause = cause,
                    regexRules = rulesOf(case),
                    characterName = "苏晚",
                    errorMessage = ChatCoreFixtures.str(case, "errorMessage"),
                    runTailRepair = if (hasRepair) { _ -> repairText } else null,
                )
                val label = "terminal#$index($cause, ${rawText.take(12)})"
                assertEquals("$label.content", ChatCoreFixtures.str(case, "content"), outcome.content)
                assertEquals("$label.status", ChatCoreFixtures.str(case, "status"), outcome.status)
                assertEquals("$label.persistable", ChatCoreFixtures.boolOrNull(case, "persistable"), outcome.persistable)
                assertEquals("$label.terminationCause", cause, outcome.terminationCause)
                assertEquals("$label.notice", ChatCoreFixtures.str(case, "notice"), outcome.notice)
                assertEquals("$label.repairFailed", ChatCoreFixtures.boolOrNull(case, "repairFailed"), outcome.repairFailed)
                val expectedFields = ChatCoreFixtures.mapOrNull(case, "noticeFields") ?: emptyMap()
                assertEquals("$label.noticeFields 键", expectedFields.keys.sorted(), outcome.noticeFields.keys.sorted())
                for ((key, value) in expectedFields) {
                    assertEquals("$label.noticeFields.$key", value.toString(), outcome.noticeFields[key])
                }
            }
        }
    }

    /** fixture 里的规则数组 → Kotlin 规则对象（形状与 TS 一致）。 */
    private fun rulesOf(case: Map<String, Any?>): List<ChatRegex.Rule> {
        @Suppress("UNCHECKED_CAST")
        val rules = (ChatCoreFixtures.listOrNull(case, "regexRules") as? List<Map<String, Any?>>) ?: return emptyList()
        return rules.map { map ->
            ChatRegex.Rule(
                id = ChatCoreFixtures.str(map, "id") ?: "",
                name = ChatCoreFixtures.str(map, "name") ?: "",
                pattern = ChatCoreFixtures.str(map, "pattern") ?: "",
                replacement = ChatCoreFixtures.str(map, "replacement") ?: "",
                flags = ChatCoreFixtures.str(map, "flags") ?: "g",
                enabled = ChatCoreFixtures.boolOrNull(map, "enabled") ?: true,
                scope = ChatCoreFixtures.str(map, "scope") ?: "output",
                stage = ChatCoreFixtures.str(map, "stage") ?: "text",
                triggerPattern = ChatCoreFixtures.str(map, "triggerPattern"),
                triggerFlags = ChatCoreFixtures.str(map, "triggerFlags") ?: "i",
                stopStrings = (ChatCoreFixtures.listOrNull(map, "stopStrings") as? List<*>)?.map { it.toString() }
                    ?: emptyList(),
            )
        }
    }

    @Test
    fun kotlinStatusAndNoticeTablesMatchFixture() {
        // 常量表：防止 Kotlin 侧枚举与 PC 文案集合漂移
        val finalizer = ChatCoreFixtures.mapOrNull(root, "finalizer")!!
        assertTrue("finalizer 段必须存在", finalizer.isNotEmpty())
        assertTrue(
            "收尾器必须暴露 complete 状态",
            ChatAssistantOutputFinalizer.STATUSES.contains("complete"),
        )
    }
}