package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-05：向量工具的跨语言一致性测试
 * （对齐 fixture `vector.json`，oracle 为 PC 的 `shared/chat-core/vector.ts`）。
 *
 * 这层是「向量层接入」的算法地基：余弦相似度 / L2 归一化 / 点积 / Top-K。
 * 上层的嵌入提供方与本地向量存储都建立在它之上，因此这里必须先逐字节对齐——
 * 否则同一份记忆/世界书候选在两端会得到不同的排序，用户看到的就是「同一段内容，
 * 手机和电脑召回的东西不一样」。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatVectorGoldenTest {

    private val root = ChatCoreFixtures.root("vector")

    private fun doubles(value: Any?): List<Double> =
        (value as? List<*>)?.map { (it as Number).toDouble() } ?: emptyList()

    @Test
    fun cosineSimilarityMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "cosineCases") as? List<Map<String, Any?>>)
            ?: error("缺少 cosineCases")
        assertTrue("fixture 用例数应覆盖各边界", cases.size >= 10)
        for (case in cases) {
            val a = doubles(case["a"])
            val b = doubles(case["b"])
            val expected = (case["score"] as Number).toDouble()
            assertEquals(
                "cosineSimilarity($a, $b)",
                expected,
                ChatVector.cosineSimilarity(a, b),
                1e-12,
            )
        }
    }

    @Test
    fun l2NormalizeMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "normalizeCases") as? List<Map<String, Any?>>)
            ?: error("缺少 normalizeCases")
        for (case in cases) {
            val input = doubles(case["input"])
            val expected = doubles(case["normalized"])
            val actual = ChatVector.l2Normalize(input)
            assertEquals("l2Normalize($input) 长度", expected.size, actual.size)
            expected.forEachIndexed { index, value ->
                assertEquals("l2Normalize($input)[$index]", value, actual[index], 1e-12)
            }
        }
    }

    @Test
    fun dotProductMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "dotCases") as? List<Map<String, Any?>>)
            ?: error("缺少 dotCases")
        for (case in cases) {
            val a = doubles(case["a"])
            val b = doubles(case["b"])
            assertEquals(
                "dotProduct($a, $b)",
                (case["dot"] as Number).toDouble(),
                ChatVector.dotProduct(a, b),
                1e-12,
            )
        }
    }

    @Test
    fun topKSimilarMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "topKCases") as? List<Map<String, Any?>>)
            ?: error("缺少 topKCases")
        for ((index, case) in cases.withIndex()) {
            val query = doubles(case["query"])
            val items = ((ChatCoreFixtures.listOrNull(case, "items") as? List<Map<String, Any?>>)
                ?: emptyList()).map { raw ->
                ChatVector.VectorItem(
                    id = ChatCoreFixtures.str(raw, "id") ?: "",
                    vector = doubles(raw["vector"]),
                )
            }
            val k = ChatCoreFixtures.intOrNull(case, "k") ?: 0
            val minScore = (case["minScore"] as? Number)?.toDouble() ?: 0.0
            val expected = ((ChatCoreFixtures.listOrNull(case, "hits") as? List<Map<String, Any?>>)
                ?: emptyList()).map { ChatCoreFixtures.str(it, "id") to (it["score"] as Number).toDouble() }
            val actual = ChatVector.topKSimilar(query, items, k, minScore).map { it.id to it.score }

            val label = "topK[$index]"
            assertEquals("$label 命中条数", expected.size, actual.size)
            expected.forEachIndexed { hitIndex, (expectedId, expectedScore) ->
                assertEquals("$label[$hitIndex].id（顺序也必须一致）", expectedId, actual[hitIndex].first)
                assertEquals("$label[$hitIndex].score", expectedScore, actual[hitIndex].second, 1e-12)
            }
        }
    }

    @Test
    fun dimensionMismatchIsSkippedNotTruncated() {
        // 维度不匹配的条目必须被**跳过**：截断或补零会把无关内容算成高相似度
        val hits = ChatVector.topKSimilar(
            query = listOf(1.0, 0.0),
            items = listOf(
                ChatVector.VectorItem("match", listOf(1.0, 0.0)),
                ChatVector.VectorItem("wrong-dim", listOf(1.0, 0.0, 0.0)),
                ChatVector.VectorItem("shorter", listOf(1.0)),
            ),
            k = 5,
        )
        assertEquals(listOf("match"), hits.map { it.id })
    }

    @Test
    fun tiesKeepInputOrder() {
        // JS 自 ES2019 起 sort 稳定；两端排序不一致会让「同分条目谁先注入」随机漂移
        val hits = ChatVector.topKSimilar(
            query = listOf(1.0, 0.0),
            items = listOf(
                ChatVector.VectorItem("first", listOf(2.0, 0.0)),
                ChatVector.VectorItem("second", listOf(3.0, 0.0)),
                ChatVector.VectorItem("third", listOf(4.0, 0.0)),
            ),
            k = 5,
        )
        assertEquals(listOf("first", "second", "third"), hits.map { it.id })
    }

    @Test
    fun zeroVectorScoresZeroInsteadOfCrashing() {
        // 零向量没有方向：按 0 处理（PC 的 normA/normB 为 0 分支），而不是除零得到 NaN
        assertEquals(0.0, ChatVector.cosineSimilarity(listOf(0.0, 0.0), listOf(1.0, 2.0)), 1e-12)
        assertEquals(listOf(0.0, 0.0), ChatVector.l2Normalize(listOf(0.0, 0.0)))
    }

    @Test
    fun nonFiniteQueryYieldsNoHitsRatherThanGarbageRanking() {
        // NaN/Infinity 经 JSON 无法往返，因此不在夹具里；但语义必须与 PC 一致：
        // 含 NaN 的查询不会产生任何命中（JS 的 `NaN >= minScore` 为 false）
        val hits = ChatVector.topKSimilar(
            query = listOf(Double.NaN, 0.0),
            items = listOf(ChatVector.VectorItem("a", listOf(1.0, 0.0))),
            k = 5,
        )
        assertTrue("含 NaN 的查询不得产出命中", hits.isEmpty())
    }
}
