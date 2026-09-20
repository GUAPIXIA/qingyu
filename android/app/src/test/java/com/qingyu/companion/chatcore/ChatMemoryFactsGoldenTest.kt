package com.qingyu.companion.chatcore

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-05：长记忆事实核心的跨语言一致性测试
 * （对齐 fixture `memory-facts.json`，oracle 为 `shared/chat-core/memory.ts`）。
 *
 * 覆盖：结构解析（含格式无效时必须保留旧事实的语义）、旧文本事实迁移、
 * 增量变更与语义提案应用、归档到 history、去重与上限、最近性/评分/预算/分层/格式化。
 *
 * 需要 Robolectric：解析与身份匹配依赖 `org.json`（JVM 单测里未实现）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatMemoryFactsGoldenTest {

    private val root = ChatCoreFixtures.root("memory-facts")

    private fun factsOf(list: List<Any?>?): List<ChatMemoryFacts.FactRecord> =
        (list ?: emptyList()).map { recordOf(it as Map<String, Any?>) }

    private fun recordOf(map: Map<String, Any?>): ChatMemoryFacts.FactRecord {
        val text = ChatCoreFixtures.str(map, "text")
        if (text != null && map["subject"] == null) return ChatMemoryFacts.FactRecord.TextFact(text)
        return ChatMemoryFacts.FactRecord.Structured(
            id = ChatCoreFixtures.str(map, "id") ?: "",
            subject = ChatCoreFixtures.str(map, "subject") ?: "",
            predicate = ChatCoreFixtures.str(map, "predicate") ?: "",
            value = ChatCoreFixtures.str(map, "value") ?: "",
            status = ChatCoreFixtures.str(map, "status") ?: "active",
            importance = (map["importance"] as? Number)?.toInt() ?: 3,
            confidence = (map["confidence"] as? Number)?.toDouble() ?: 0.8,
            scope = ChatCoreFixtures.str(map, "scope"),
            entityId = ChatCoreFixtures.str(map, "entityId"),
            sourceMessageIds = (ChatCoreFixtures.listOrNull(map, "sourceMessageIds") as? List<*>)?.map { item -> item.toString() }
                ?: emptyList(),
            updatedAt = (map["updatedAt"] as? Number)?.toLong(),
        )
    }

    private fun toFixtureJson(value: Any?): String = when (value) {
        null -> "null"
        is Map<*, *> -> value.entries.joinToString(",", "{", "}") { (k, v) -> "\"$k\":${toFixtureJson(v)}" }
        is List<*> -> value.joinToString(",", "[", "]") { toFixtureJson(it) }
        is String -> "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
        is Boolean -> value.toString()
        is Double -> if (value == Math.floor(value) && value.isFinite()) value.toLong().toString() else value.toString()
        is Number -> value.toString()
        else -> value.toString()
    }

    @Test
    fun constantsMatchPc() {
        val constants = ChatCoreFixtures.mapOrNull(root, "constants")!!
        assertEquals(
            "MAX_MEMORY_FACTS",
            ChatCoreFixtures.intOrNull(constants, "maxFacts"),
            ChatMemoryFacts.MAX_MEMORY_FACTS,
        )
        assertEquals(
            "MAX_MEMORY_FACT_HISTORY",
            ChatCoreFixtures.intOrNull(constants, "maxFactHistory"),
            ChatMemoryFacts.MAX_MEMORY_FACT_HISTORY,
        )
    }

    @Test
    fun parseCasesMatchPc() {
        for (case in ChatCoreFixtures.cases("memory-facts")) {
            val text = ChatCoreFixtures.str(case, "text") ?: ""
            val label = "parse(${text.take(24)})"
            val parsed = ChatMemoryFacts.parseMemoryResult(text)

            assertEquals("$label.currentState", ChatCoreFixtures.str(case, "currentState"), parsed.currentState)
            assertEquals("$label.summary", ChatCoreFixtures.str(case, "summary"), parsed.summary)
            assertEquals(
                "$label.facts",
                (ChatCoreFixtures.listOrNull(case, "facts") as? List<*>)?.map { item -> item.toString() }
                    ?: emptyList<String>(),
                parsed.facts,
            )
            assertEquals(
                "$label.factChangesPresent",
                ChatCoreFixtures.boolOrNull(case, "factChangesPresent"),
                parsed.factChangesPresent,
            )
            // 段存在但格式无效 → PC 返回 null，Kotlin 必须同为 null（调用方保留旧事实）
            val expectedChanges = ChatCoreFixtures.listOrNull(case, "factChanges")
            if (expectedChanges == null) {
                assertTrue("$label.factChanges 期望 null", parsed.factChanges == null)
            } else {
                assertEquals(
                    "$label.factChanges 条数",
                    expectedChanges.size,
                    parsed.factChanges?.size,
                )
            }
            assertEquals(
                "$label.factProposalsPresent",
                ChatCoreFixtures.boolOrNull(case, "factProposalsPresent"),
                parsed.factProposalsPresent,
            )
            val expectedProposals = ChatCoreFixtures.listOrNull(case, "factProposals")
            if (expectedProposals == null) {
                assertTrue("$label.factProposals 期望 null", parsed.factProposals == null)
            } else {
                assertEquals("$label.factProposals 条数", expectedProposals.size, parsed.factProposals?.size)
            }
        }
    }

    @Test
    fun applyCasesMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "applyCases") as? List<Map<String, Any?>>)
            ?: error("缺少 applyCases")
        for (case in cases) {
            val caseIndex = ChatCoreFixtures.intOrNull(case, "caseIndex")
            val kind = ChatCoreFixtures.str(case, "kind")
            val previousFacts = factsOf(ChatCoreFixtures.listOrNull(case, "previousFacts"))
            @Suppress("UNCHECKED_CAST")
            val previousHistoryRaw: List<Any?> =
                (ChatCoreFixtures.listOrNull(case, "previousHistory") as? List<*>) ?: emptyList<Any?>()
            val previousHistory = previousHistoryRaw.map { recordOf(it as Map<String, Any?>) }
            val sourceMessageId = ChatCoreFixtures.str(case, "sourceMessageId") ?: ""
            val updatedAt = (case["updatedAt"] as Number).toLong()

            val result = if (kind == "proposals") {
                val proposals = ChatMemoryFacts.parseFactProposals(toFixtureJson(case["proposals"])) ?: emptyList()
                ChatMemoryFacts.applyFactProposals(
                    previousFacts,
                    previousHistory,
                    proposals,
                    sourceMessageId,
                    updatedAt,
                )
            } else {
                val changes = ChatMemoryFacts.parseFactChanges(toFixtureJson(case["changes"])) ?: emptyList()
                ChatMemoryFacts.applyMemoryFactChanges(
                    previousFacts,
                    previousHistory,
                    changes,
                    sourceMessageId,
                    updatedAt,
                )
            }

            val expectedFacts = factsOf(ChatCoreFixtures.listOrNull(case, "facts"))
            assertEquals("case#$caseIndex 事实条数", expectedFacts.size, result.facts.size)
            expectedFacts.forEachIndexed { index, expected ->
                val actual = result.facts[index]
                assertTrue(
                    "case#$caseIndex facts[$index] 期望 $expected 实际 $actual",
                    expected == actual,
                )
            }

            val expectedHistory = factsOf(ChatCoreFixtures.listOrNull(case, "history"))
            assertEquals("case#$caseIndex history 条数", expectedHistory.size, result.history.size)
            expectedHistory.forEachIndexed { index, expected ->
                assertTrue(
                    "case#$caseIndex history[$index] 期望 $expected 实际 ${result.history[index]}",
                    expected == result.history[index],
                )
            }
        }
    }

    @Test
    fun recencyCasesMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "recencyCases") as? List<Map<String, Any?>>)
            ?: error("缺少 recencyCases")
        for (case in cases) {
            val updatedAt = (case["updatedAt"] as? Number)?.toLong()
            val now = (case["now"] as Number).toLong()
            assertEqualsApprox(
                "computeRecencyScore($updatedAt, $now)",
                (case["score"] as Number).toDouble(),
                ChatMemoryRanking.computeRecencyScore(updatedAt, now),
            )
        }
    }

    @Test
    fun rankCasesMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "rankCases") as? List<Map<String, Any?>>)
            ?: error("缺少 rankCases")
        for (case in cases) {
            val facts = factsOf(ChatCoreFixtures.listOrNull(case, "facts"))
            val semantic = (ChatCoreFixtures.listOrNull(case, "semanticScores") as? List<*>)
                ?.map { (it as Number).toDouble() }
            val now = (case["now"] as Number).toLong()
            val actual = ChatMemoryRanking.scoreAndRankFacts(facts, semantic, now)
            @Suppress("UNCHECKED_CAST")
            val expected = (ChatCoreFixtures.listOrNull(case, "ranked") as? List<Map<String, Any?>>)
                ?: error("缺少 ranked")

            assertEquals("ranked 条数", expected.size, actual.size)
            expected.forEachIndexed { index, item ->
                val label = "ranked[$index]"
                assertEquals(
                    "$label.text",
                    ChatCoreFixtures.str(item, "text"),
                    ChatMemoryFacts.memoryFactToText(actual[index].fact),
                )
                assertEqualsApprox("$label.score", (item["score"] as Number).toDouble(), actual[index].score)
                assertEqualsApprox("$label.semantic", (item["semantic"] as Number).toDouble(), actual[index].semantic)
                assertEqualsApprox("$label.recency", (item["recency"] as Number).toDouble(), actual[index].recency)
                assertEquals("$label.importance", ChatCoreFixtures.intOrNull(item, "importance"), actual[index].importance)
                assertEqualsApprox(
                    "$label.confidence",
                    (item["confidence"] as Number).toDouble(),
                    actual[index].confidence,
                )
            }
        }
    }

    @Test
    fun budgetSelectionCasesMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "budgetCases") as? List<Map<String, Any?>>)
            ?: error("缺少 budgetCases")
        for (case in cases) {
            val facts = factsOf(ChatCoreFixtures.listOrNull(case, "facts"))
            val semantic = (ChatCoreFixtures.listOrNull(case, "semanticScores") as? List<*>)?.map { (it as Number).toDouble() }
            val now = (case["now"] as Number).toLong()
            val budget = (case["budget"] as Number).toDouble()
            val ranked = ChatMemoryRanking.scoreAndRankFacts(facts, semantic, now).map { it.fact }
            val selected = ChatMemoryRanking.selectFactsByBudget(ranked, budget) { ChatTokenCounter.estimateTokens(it) }
            val expected = factsOf(ChatCoreFixtures.listOrNull(case, "selected"))
            assertEquals("budget=$budget 选中条数", expected.size, selected.size)
            expected.forEachIndexed { index, expectedFact ->
                assertTrue("budget=$budget selected[$index]", expectedFact == selected[index])
            }
        }
    }

    @Test
    fun layeredBudgetCasesMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "layeredCases") as? List<Map<String, Any?>>)
            ?: error("缺少 layeredCases")
        for (case in cases) {
            val facts = factsOf(ChatCoreFixtures.listOrNull(case, "facts"))
            val semantic = (ChatCoreFixtures.listOrNull(case, "semanticScores") as? List<*>)?.map { (it as Number).toDouble() }
            val budget = (case["budget"] as Number).toDouble()
            val now = (case["now"] as Number).toLong()
            val actual = ChatMemoryRanking.fitLayeredMemoryBudget(
                currentState = ChatCoreFixtures.str(case, "currentState"),
                timeline = ChatCoreFixtures.str(case, "timeline") ?: "",
                facts = facts,
                budget = budget,
                estimateTokens = { ChatTokenCounter.estimateTokens(it) },
                semanticScores = semantic,
                now = now,
            )
            val label = "layered(budget=$budget)"
            assertEquals("$label.currentState", ChatCoreFixtures.str(case, "fittedCurrentState"), actual.currentState)
            assertEquals("$label.timeline", ChatCoreFixtures.str(case, "fittedTimeline"), actual.timeline)
            assertEquals("$label.retrievalMode", ChatCoreFixtures.str(case, "retrievalMode"), actual.retrievalMode)
            val expectedFacts = factsOf(ChatCoreFixtures.listOrNull(case, "fittedFacts"))
            assertEquals("$label 事实条数", expectedFacts.size, actual.facts.size)
            expectedFacts.forEachIndexed { index, expectedFact ->
                assertTrue("$label fittedFacts[$index]", expectedFact == actual.facts[index])
            }
        }
    }

    @Test
    fun formatCasesMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "formatCases") as? List<Map<String, Any?>>)
            ?: error("缺少 formatCases")
        for (case in cases) {
            val facts = factsOf(ChatCoreFixtures.listOrNull(case, "facts"))
            assertEquals(
                "formatMemoryFacts(n=${facts.size})",
                ChatCoreFixtures.str(case, "text") ?: "",
                ChatMemoryRanking.formatMemoryFacts(facts),
            )
        }
    }

    private fun assertEqualsApprox(label: String, expected: Double, actual: Double) {
        val tolerance = 1e-9 * maxOf(1.0, kotlin.math.abs(expected))
        assertTrue("$label 期望 $expected 实际 $actual", kotlin.math.abs(expected - actual) <= tolerance)
    }
}
