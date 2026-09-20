package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-01 第 5 层 / S4-05：记忆三层候选与物化的跨语言一致性测试
 * （对齐 fixture `memory-candidates.json`，oracle 为 `shared/chat-core/memoryCandidates.ts`）。
 *
 * 为什么这里的事实一律用旧文本事实：PC 的 `scoreAndRankFacts` 内部用 `Date.now()` 计算 recency，
 * 两平台时钟必然不同；旧文本事实无 `updatedAt`，recency 恒 0.5，跨语言可比。
 * recency 本身由 `ChatMemoryFacts` 的显式 now 用例锁定。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatMemoryCandidatesGoldenTest {

    private val root = ChatCoreFixtures.root("memory-candidates")

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
            sourceMessageIds = (ChatCoreFixtures.listOrNull(map, "sourceMessageIds") as? List<*>)?.map { it.toString() }
                ?: emptyList(),
            updatedAt = (map["updatedAt"] as? Number)?.toLong(),
        )
    }

    private fun factsOf(list: List<Any?>?): List<ChatMemoryFacts.FactRecord> =
        (list ?: emptyList()).map { recordOf(it as Map<String, Any?>) }

    private fun candidateOf(map: Map<String, Any?>): ChatContextCandidates.Candidate =
        ChatContextCandidates.Candidate(
            id = ChatCoreFixtures.str(map, "id") ?: "",
            kind = ChatCoreFixtures.str(map, "kind") ?: "",
            estimatedTokens = (map["estimatedTokens"] as Number).toInt(),
            mandatory = ChatCoreFixtures.boolOrNull(map, "mandatory") ?: false,
            stablePrefix = ChatCoreFixtures.boolOrNull(map, "stablePrefix") ?: false,
            relevance = (map["relevance"] as? Number)?.toDouble() ?: 0.0,
            recency = (map["recency"] as? Number)?.toDouble() ?: 0.0,
            importance = (map["importance"] as? Number)?.toDouble() ?: 0.0,
            continuity = (map["continuity"] as? Number)?.toDouble() ?: 0.0,
            dedupeKey = ChatCoreFixtures.str(map, "dedupeKey"),
            originalOrder = (map["originalOrder"] as? Number)?.toInt() ?: 0,
            origin = ChatCoreFixtures.str(map, "origin"),
        )

    private fun buildInput(map: Map<String, Any?>): ChatMemoryCandidates.Input =
        ChatMemoryCandidates.Input(
            currentState = ChatCoreFixtures.str(map, "currentState"),
            timeline = ChatCoreFixtures.str(map, "timeline"),
            facts = factsOf(ChatCoreFixtures.listOrNull(map, "facts")),
            semanticScores = (ChatCoreFixtures.listOrNull(map, "semanticScores") as? List<*>)
                ?.map { (it as Number).toDouble() },
            model = ChatCoreFixtures.str(map, "model"),
        )

    private fun assertCandidate(label: String, expected: Map<String, Any?>, actual: ChatContextCandidates.Candidate) {
        assertEquals("$label.id", ChatCoreFixtures.str(expected, "id"), actual.id)
        assertEquals("$label.kind", ChatCoreFixtures.str(expected, "kind"), actual.kind)
        assertEquals("$label.estimatedTokens", ChatCoreFixtures.intOrNull(expected, "estimatedTokens"), actual.estimatedTokens)
        assertEquals("$label.mandatory", ChatCoreFixtures.boolOrNull(expected, "mandatory"), actual.mandatory)
        assertEquals("$label.relevance", (expected["relevance"] as Number).toDouble(), actual.relevance, 1e-9)
        assertEquals("$label.recency", (expected["recency"] as Number).toDouble(), actual.recency, 1e-9)
        assertEquals("$label.importance", (expected["importance"] as Number).toDouble(), actual.importance, 1e-9)
        assertEquals("$label.continuity", (expected["continuity"] as Number).toDouble(), actual.continuity, 1e-9)
        assertEquals("$label.dedupeKey", ChatCoreFixtures.str(expected, "dedupeKey"), actual.dedupeKey)
        assertEquals("$label.originalOrder", ChatCoreFixtures.intOrNull(expected, "originalOrder"), actual.originalOrder)
        assertEquals("$label.origin", ChatCoreFixtures.str(expected, "origin"), actual.origin)
    }

    @Test
    fun constantsMatchPc() {
        val constants = ChatCoreFixtures.mapOrNull(root, "constants")!!
        assertEquals(
            "MEMORY_TIMELINE_TARGET_CHUNK_TOKENS",
            ChatCoreFixtures.intOrNull(constants, "timelineTargetChunkTokens"),
            ChatMemoryCandidates.MEMORY_TIMELINE_TARGET_CHUNK_TOKENS,
        )
        assertEquals(
            "MEMORY_TIMELINE_MAX_CHUNK_TOKENS",
            ChatCoreFixtures.intOrNull(constants, "timelineMaxChunkTokens"),
            ChatMemoryCandidates.MEMORY_TIMELINE_MAX_CHUNK_TOKENS,
        )
        assertEquals(
            "MEMORY_TIMELINE_MAX_CHUNKS",
            ChatCoreFixtures.intOrNull(constants, "timelineMaxChunks"),
            ChatMemoryCandidates.MEMORY_TIMELINE_MAX_CHUNKS,
        )
        val stateScores = ChatCoreFixtures.mapOrNull(constants, "stateScores")!!
        assertEquals("state.relevance", (stateScores["relevance"] as Number).toDouble(), ChatMemoryCandidates.MEMORY_STATE_RELEVANCE, 1e-9)
        assertEquals("state.recency", (stateScores["recency"] as Number).toDouble(), ChatMemoryCandidates.MEMORY_STATE_RECENCY, 1e-9)
        assertEquals("state.importance", (stateScores["importance"] as Number).toDouble(), ChatMemoryCandidates.MEMORY_STATE_IMPORTANCE, 1e-9)
        assertEquals("state.continuity", (stateScores["continuity"] as Number).toDouble(), ChatMemoryCandidates.MEMORY_STATE_CONTINUITY, 1e-9)
        assertEquals(
            "MEMORY_TIMELINE_RELEVANCE",
            (constants["timelineRelevance"] as Number).toDouble(),
            ChatMemoryCandidates.MEMORY_TIMELINE_RELEVANCE,
            1e-9,
        )
        assertEquals(
            "MEMORY_TIMELINE_IMPORTANCE",
            (constants["timelineImportance"] as Number).toDouble(),
            ChatMemoryCandidates.MEMORY_TIMELINE_IMPORTANCE,
            1e-9,
        )
        assertEquals(
            "MEMORY_FACT_CONTINUITY",
            (constants["factContinuity"] as Number).toDouble(),
            ChatMemoryCandidates.MEMORY_FACT_CONTINUITY,
            1e-9,
        )
    }

    @Test
    fun timelineSplitMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "splitCases") as? List<Map<String, Any?>>)
            ?: error("缺少 splitCases")
        for (case in cases) {
            val timeline = ChatCoreFixtures.str(case, "timeline") ?: ""
            @Suppress("UNCHECKED_CAST")
            val expected = (ChatCoreFixtures.listOrNull(case, "chunks") as? List<Map<String, Any?>>) ?: error("缺 chunks")
            val actual = ChatMemoryCandidates.splitTimelineIntoChunks(timeline)
            val label = "splitTimeline(len=${timeline.length})"
            assertEquals("$label 块数", expected.size, actual.size)
            expected.forEachIndexed { index, chunk ->
                assertEquals("$label[$index].id", ChatCoreFixtures.str(chunk, "id"), actual[index].id)
                assertEquals("$label[$index].index", ChatCoreFixtures.intOrNull(chunk, "index"), actual[index].index)
                assertEquals("$label[$index].text", ChatCoreFixtures.str(chunk, "text"), actual[index].text)
                assertEquals("$label[$index].tokens", ChatCoreFixtures.intOrNull(chunk, "tokens"), actual[index].tokens)
            }
        }
    }

    @Test
    fun buildCandidateSetMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "buildCases") as? List<Map<String, Any?>>)
            ?: error("缺少 buildCases")
        for (case in cases) {
            val caseIndex = ChatCoreFixtures.intOrNull(case, "caseIndex")
            val input = buildInput(ChatCoreFixtures.mapOrNull(case, "input")!!)
            val set = ChatMemoryCandidates.buildMemoryCandidateSet(input)
            val label = "build#$caseIndex"

            assertEquals("$label.retrievalMode", ChatCoreFixtures.str(case, "retrievalMode"), set.retrievalMode)
            val described = ChatCoreFixtures.mapOrNull(case, "described")!!
            assertEquals("$label.described.stateTokens", ChatCoreFixtures.intOrNull(described, "stateTokens"), set.described.stateTokens)
            assertEquals("$label.described.factCount", ChatCoreFixtures.intOrNull(described, "factCount"), set.described.factCount)
            assertEquals("$label.described.factTokens", ChatCoreFixtures.intOrNull(described, "factTokens"), set.described.factTokens)
            assertEquals(
                "$label.described.timelineChunkCount",
                ChatCoreFixtures.intOrNull(described, "timelineChunkCount"),
                set.described.timelineChunkCount,
            )
            assertEquals("$label.described.timelineTokens", ChatCoreFixtures.intOrNull(described, "timelineTokens"), set.described.timelineTokens)
            assertEquals("$label.described.totalTokens", ChatCoreFixtures.intOrNull(described, "totalTokens"), set.described.totalTokens)

            assertDeepEquals("$label.layerByCandidateId", ChatCoreFixtures.mapOrNull(case, "layerByCandidateId"), set.layerByCandidateId)

            @Suppress("UNCHECKED_CAST")
            val expected = (ChatCoreFixtures.listOrNull(case, "candidates") as? List<Map<String, Any?>>) ?: error("缺 candidates")
            assertEquals("$label 候选条数", expected.size, set.candidates.size)
            expected.forEachIndexed { index, item -> assertCandidate("$label.candidates[$index]", item, set.candidates[index]) }
        }
    }

    @Test
    fun selectCandidatesMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "selectCases") as? List<Map<String, Any?>>)
            ?: error("缺少 selectCases")
        for (case in cases) {
            val caseIndex = ChatCoreFixtures.intOrNull(case, "caseIndex")
            val input = buildInput(ChatCoreFixtures.mapOrNull(case, "build")!!)
            val plan = ChatMemoryCandidates.buildMemoryCandidateSet(input)
            val competitors = ((ChatCoreFixtures.listOrNull(case, "competitors") as? List<Map<String, Any?>>) ?: emptyList())
                .map { candidateOf(it) }
            val budget = (case["budgetTokens"] as Number).toDouble()
            val selection = ChatMemoryCandidates.selectMemoryCandidates(plan, budget, competitors)
            val expected = ChatCoreFixtures.mapOrNull(case, "selection")!!
            val label = "select#$caseIndex(budget=$budget)"

            assertEquals("$label.budgetTokens", ChatCoreFixtures.intOrNull(expected, "budgetTokens"), selection.budgetTokens)
            assertEquals("$label.selectedTokens", ChatCoreFixtures.intOrNull(expected, "selectedTokens"), selection.selectedTokens)
            assertEquals("$label.overBudget", ChatCoreFixtures.boolOrNull(expected, "overBudget"), selection.overBudget)
            assertDeepEquals(
                "$label.byLayer",
                ChatCoreFixtures.mapOrNull(expected, "byLayer"),
                selection.byLayer.mapValues { (_, value) ->
                    linkedMapOf<String, Any?>(
                        "selected" to linkedMapOf<String, Any?>(
                            "count" to value.selected.count.toLong(),
                            "tokens" to value.selected.tokens.toLong(),
                        ),
                        "dropped" to value.dropped.toLong(),
                    )
                },
            )
            assertDeepEquals(
                "$label.competitor",
                ChatCoreFixtures.mapOrNull(expected, "competitor"),
                linkedMapOf<String, Any?>(
                    "describedTokens" to selection.competitor.describedTokens.toLong(),
                    "selectedTokens" to selection.competitor.selectedTokens.toLong(),
                    "deltaTokens" to selection.competitor.deltaTokens.toLong(),
                ),
            )
        }
    }

    @Test
    fun shadowReportMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "shadowCases") as? List<Map<String, Any?>>)
            ?: error("缺少 shadowCases")
        for (case in cases) {
            val caseIndex = ChatCoreFixtures.intOrNull(case, "caseIndex")
            val input = buildInput(ChatCoreFixtures.mapOrNull(case, "build")!!)
            val plan = ChatMemoryCandidates.buildMemoryCandidateSet(input)
            val existingMap = ChatCoreFixtures.mapOrNull(case, "existing")!!
            val existing = ChatMemoryCandidates.InjectionStats(
                capTokens = ChatCoreFixtures.intOrNull(existingMap, "capTokens") ?: 0,
                stateTokens = ChatCoreFixtures.intOrNull(existingMap, "stateTokens") ?: 0,
                factCount = ChatCoreFixtures.intOrNull(existingMap, "factCount") ?: 0,
                factTokens = ChatCoreFixtures.intOrNull(existingMap, "factTokens") ?: 0,
                timelineChunkCount = ChatCoreFixtures.intOrNull(existingMap, "timelineChunkCount") ?: 0,
                timelineTokens = ChatCoreFixtures.intOrNull(existingMap, "timelineTokens") ?: 0,
                totalTokens = ChatCoreFixtures.intOrNull(existingMap, "totalTokens") ?: 0,
                retrievalMode = ChatCoreFixtures.str(existingMap, "retrievalMode") ?: "fallback",
            )
            val competitors = ((ChatCoreFixtures.listOrNull(case, "competitors") as? List<Map<String, Any?>>) ?: emptyList())
                .map { candidateOf(it) }
            val budget = (case["budgetTokens"] as Number).toDouble()
            val report = ChatMemoryCandidates.buildMemoryShadowReport(plan, existing, budget, competitors)
            val expected = ChatCoreFixtures.mapOrNull(case, "report")!!
            val label = "shadow#$caseIndex"

            assertEquals("$label.mode", ChatCoreFixtures.str(expected, "mode"), report.mode)
            assertEquals("$label.budgetTokens", ChatCoreFixtures.intOrNull(expected, "budgetTokens"), report.budgetTokens)
            assertEquals("$label.legacyCapTokens", ChatCoreFixtures.intOrNull(expected, "legacyCapTokens"), report.legacyCapTokens)
            assertEquals("$label.retrievalMode", ChatCoreFixtures.str(expected, "retrievalMode"), report.retrievalMode)
            assertEquals("$label.deltaTokens", ChatCoreFixtures.intOrNull(expected, "deltaTokens"), report.deltaTokens)
            assertEquals("$label.exceedsLegacyCap", ChatCoreFixtures.boolOrNull(expected, "exceedsLegacyCap"), report.exceedsLegacyCap)
            assertEquals("$label.degraded", ChatCoreFixtures.boolOrNull(expected, "degraded"), report.degraded)

            val candidate = ChatCoreFixtures.mapOrNull(expected, "candidate")!!
            assertEquals("$label.candidate.stateTokens", ChatCoreFixtures.intOrNull(candidate, "stateTokens"), report.candidate.stateTokens)
            assertEquals("$label.candidate.factCount", ChatCoreFixtures.intOrNull(candidate, "factCount"), report.candidate.factCount)
            assertEquals("$label.candidate.factTokens", ChatCoreFixtures.intOrNull(candidate, "factTokens"), report.candidate.factTokens)
            assertEquals(
                "$label.candidate.timelineChunkCount",
                ChatCoreFixtures.intOrNull(candidate, "timelineChunkCount"),
                report.candidate.timelineChunkCount,
            )
            assertEquals(
                "$label.candidate.timelineTokens",
                ChatCoreFixtures.intOrNull(candidate, "timelineTokens"),
                report.candidate.timelineTokens,
            )
            assertEquals("$label.candidate.totalTokens", ChatCoreFixtures.intOrNull(candidate, "totalTokens"), report.candidate.totalTokens)
            assertEquals(
                "$label.candidate.droppedFactCount",
                ChatCoreFixtures.intOrNull(candidate, "droppedFactCount"),
                report.candidate.droppedFactCount,
            )
            assertEquals(
                "$label.candidate.droppedTimelineChunkCount",
                ChatCoreFixtures.intOrNull(candidate, "droppedTimelineChunkCount"),
                report.candidate.droppedTimelineChunkCount,
            )
            assertEquals("$label.candidate.overBudget", ChatCoreFixtures.boolOrNull(candidate, "overBudget"), report.candidate.overBudget)

            @Suppress("UNCHECKED_CAST")
            val expectedLayers = (ChatCoreFixtures.listOrNull(expected, "byLayer") as? List<Map<String, Any?>>) ?: error("缺 byLayer")
            assertEquals("$label.byLayer 条数", expectedLayers.size, report.byLayer.size)
            expectedLayers.forEachIndexed { index, layer ->
                val actual = report.byLayer[index]
                assertDeepEquals(
                    "$label.byLayer[$index]",
                    layer,
                    linkedMapOf<String, Any?>(
                        "layer" to actual.layer,
                        "existingCount" to actual.existingCount.toLong(),
                        "existingTokens" to actual.existingTokens.toLong(),
                        "candidateCount" to actual.candidateCount.toLong(),
                        "candidateTokens" to actual.candidateTokens.toLong(),
                        "candidateDroppedCount" to actual.candidateDroppedCount.toLong(),
                    ),
                )
            }
            assertEquals(
                "$label.formatted",
                ChatCoreFixtures.str(case, "formatted"),
                ChatMemoryCandidates.formatMemoryShadowSummary(report),
            )
        }
    }

    @Test
    fun materializeMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "materializeCases") as? List<Map<String, Any?>>)
            ?: error("缺少 materializeCases")
        for (case in cases) {
            val caseIndex = ChatCoreFixtures.intOrNull(case, "caseIndex")
            val input = buildInput(ChatCoreFixtures.mapOrNull(case, "build")!!)
            val plan = ChatMemoryCandidates.buildMemoryCandidateSet(input)
            val selectedIds = (ChatCoreFixtures.listOrNull(case, "selectedIds") as? List<*>)?.map { it.toString() }?.toSet()
                ?: emptySet()
            val materialized = ChatMemoryCandidates.materializeMemoryInjection(
                plan = plan,
                selectedIds = selectedIds,
                currentState = input.currentState,
                facts = input.facts ?: emptyList(),
                timeline = input.timeline,
                semanticScores = input.semanticScores,
                model = input.model,
            )
            val label = "materialize#$caseIndex"
            assertEquals("$label.currentState", ChatCoreFixtures.str(case, "currentState"), materialized.currentState)
            assertEquals("$label.timeline", ChatCoreFixtures.str(case, "timeline"), materialized.timeline)
            assertEquals("$label.retrievalMode", ChatCoreFixtures.str(case, "retrievalMode"), materialized.retrievalMode)
            val expectedFacts = factsOf(ChatCoreFixtures.listOrNull(case, "facts"))
            assertEquals("$label 事实条数", expectedFacts.size, materialized.facts.size)
            expectedFacts.forEachIndexed { index, expected ->
                assertTrue("$label facts[$index] 期望 $expected 实际 ${materialized.facts[index]}", expected == materialized.facts[index])
            }
        }
    }

    /** 递归深比较普通 JSON 结构（Map/List/标量）。 */
    private fun assertDeepEquals(label: String, expected: Any?, actual: Any?) {
        when (expected) {
            null -> assertTrue("$label 期望 null，实际 $actual", actual == null)
            is Map<*, *> -> {
                @Suppress("UNCHECKED_CAST")
                val actualMap = actual as? Map<String, Any?> ?: error("$label 期望对象，实际 ${actual?.javaClass}")
                assertEquals("$label 键集合", expected.keys.map { it.toString() }.sorted(), actualMap.keys.sorted())
                for ((key, value) in expected) assertDeepEquals("$label.$key", value, actualMap[key.toString()])
            }
            is List<*> -> {
                val actualList = actual as? List<*> ?: error("$label 期望数组，实际 ${actual?.javaClass}")
                assertEquals("$label 长度", expected.size, actualList.size)
                expected.forEachIndexed { index, value -> assertDeepEquals("$label[$index]", value, actualList[index]) }
            }
            is Number -> {
                val actualNumber = (actual as? Number)?.toDouble()
                assertTrue(
                    "$label 期望 $expected，实际 $actual",
                    actualNumber != null && kotlin.math.abs(expected.toDouble() - actualNumber) <= 1e-9,
                )
            }
            else -> assertEquals(label, expected, actual)
        }
    }
}
