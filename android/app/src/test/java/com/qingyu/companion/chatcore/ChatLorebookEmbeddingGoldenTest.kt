package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-05：世界书向量层（条目侧）的跨语言一致性测试
 * （对齐 fixture `lorebook-embedding.json`，oracle 为 PC 的 `shared/lorebookEmbedding.ts`）。
 *
 * 这一层决定「同一段世界书在手机与电脑上召回的是不是同一批内容」：
 * 谁进索引、向量化时喂了什么文本、长文怎么切片、多片怎么合成一条。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatLorebookEmbeddingGoldenTest {

    private val root = ChatCoreFixtures.root("lorebook-embedding")

    private fun entryOf(map: Map<String, Any?>): ChatLorebookEmbedding.Entry =
        ChatLorebookEmbedding.Entry(
            id = ChatCoreFixtures.str(map, "id") ?: "",
            content = ChatCoreFixtures.str(map, "content") ?: "",
            keywords = (ChatCoreFixtures.listOrNull(map, "keywords") as? List<*>)?.map { it.toString() } ?: emptyList(),
            secondaryKeywords = (ChatCoreFixtures.listOrNull(map, "secondaryKeywords") as? List<*>)
                ?.map { it.toString() } ?: emptyList(),
            summary = ChatCoreFixtures.str(map, "summary"),
            title = ChatCoreFixtures.str(map, "title"),
            enabled = ChatCoreFixtures.boolOrNull(map, "enabled") ?: true,
            priority = ChatCoreFixtures.str(map, "priority"),
            matchMode = ChatCoreFixtures.str(map, "matchMode"),
        )

    private fun doubles(value: Any?): List<Double> =
        (value as? List<*>)?.map { (it as Number).toDouble() } ?: emptyList()

    @Test
    fun eligibilityAndDocumentMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "entries") as? List<Map<String, Any?>>)
            ?: error("缺少 entries")
        assertTrue("fixture 应覆盖资格与文档构造的主要分支", cases.size >= 8)
        for (case in cases) {
            @Suppress("UNCHECKED_CAST")
            val input = case["input"] as Map<String, Any?>
            val entry = entryOf(input)
            val label = "entry(${entry.id})"
            assertEquals(
                "$label.eligible",
                ChatCoreFixtures.boolOrNull(case, "eligible"),
                ChatLorebookEmbedding.isSemanticEligible(entry),
            )
            assertEquals(
                "$label.document（标签顺序与去重都必须一致）",
                ChatCoreFixtures.str(case, "document"),
                ChatLorebookEmbedding.buildEmbeddingDocument(entry),
            )
        }
    }

    @Test
    fun splitMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "splitCases") as? List<Map<String, Any?>>)
            ?: error("缺少 splitCases")
        for ((index, case) in cases.withIndex()) {
            val text = ChatCoreFixtures.str(case, "text") ?: ""
            val maxChars = ChatCoreFixtures.intOrNull(case, "maxChars") ?: 0
            val maxChunks = ChatCoreFixtures.intOrNull(case, "maxChunks") ?: 16
            val overlapRatio = (case["overlapRatio"] as? Number)?.toDouble() ?: 0.15
            val expected = ((ChatCoreFixtures.listOrNull(case, "chunks") as? List<*>) ?: emptyList<Any?>())
                .map { it.toString() }
            val actual = ChatLorebookEmbedding.splitEmbeddingDocument(text, maxChars, maxChunks, overlapRatio)
            val label = "split[$index](len=${text.length}, maxChars=$maxChars, maxChunks=$maxChunks)"
            assertEquals("$label 片数", expected.size, actual.size)
            expected.forEachIndexed { chunkIndex, value ->
                assertEquals("$label[$chunkIndex]", value, actual[chunkIndex])
            }
        }
    }

    @Test
    fun mergeMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "mergeCases") as? List<Map<String, Any?>>)
            ?: error("缺少 mergeCases")
        for ((index, case) in cases.withIndex()) {
            val vectors = ((ChatCoreFixtures.listOrNull(case, "vectors") as? List<*>) ?: emptyList<Any?>())
                .map { doubles(it) }
            val expected = doubles(case["merged"])
            val actual = ChatLorebookEmbedding.mergeChunkVectors(vectors)
            val label = "merge[$index]($vectors)"
            assertEquals("$label 维度", expected.size, actual.size)
            expected.forEachIndexed { dim, value -> assertEquals("$label[$dim]", value, actual[dim], 1e-12) }
        }
    }

    @Test
    fun diffMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "diffCases") as? List<Map<String, Any?>>)
            ?: error("缺少 diffCases")
        for ((index, case) in cases.withIndex()) {
            val prev: List<ChatLorebookEmbedding.Entry> =
                ((ChatCoreFixtures.listOrNull(case, "prev") as? List<Map<String, Any?>>) ?: emptyList())
                    .map { raw -> entryOf(raw) }
            val next: List<ChatLorebookEmbedding.Entry> =
                ((ChatCoreFixtures.listOrNull(case, "next") as? List<Map<String, Any?>>) ?: emptyList())
                    .map { raw -> entryOf(raw) }
            val expected = ((ChatCoreFixtures.listOrNull(case, "changed") as? List<*>) ?: emptyList<Any?>())
                .map { it.toString() }
            assertEquals(
                "diff[$index] 失效集合（含顺序）",
                expected,
                ChatLorebookEmbedding.diffEmbeddingIds(prev, next),
            )
        }
    }

    @Test
    fun fingerprintChangesExactlyWhenEligibilityOrDocumentChanges() {
        // 指纹是**设备内部的失效判定标识**，两端不追求逐字节相同（PC 用的是 JSON.stringify 字面量），
        // 但必须满足同一不变量：当且仅当 (eligible, document) 变化时指纹才变化。
        val base = ChatLorebookEmbedding.Entry(id = "a", content = "同。")
        val same = ChatLorebookEmbedding.Entry(id = "a", content = "同。")
        assertEquals(
            "完全一致必须得到同一指纹",
            ChatLorebookEmbedding.embeddingFingerprint(base),
            ChatLorebookEmbedding.embeddingFingerprint(same),
        )

        val variants = listOf(
            base.copy(content = "改。"),
            base.copy(enabled = false),
            base.copy(priority = "always"),
            base.copy(matchMode = "keyword"),
            base.copy(title = "标题"),
            base.copy(summary = "摘要"),
            base.copy(keywords = listOf("码头")),
        )
        for (variant in variants) {
            assertNotEquals(
                "任何影响资格或文档的变化都必须让指纹改变：$variant",
                ChatLorebookEmbedding.embeddingFingerprint(base),
                ChatLorebookEmbedding.embeddingFingerprint(variant),
            )
        }
    }

    @Test
    fun nonFiniteChunkIsDroppedBeforeAveraging() {
        // NaN/Infinity 经 JSON 无法往返，故不在夹具里；但语义必须与 PC 一致：
        // 含非有限值的分片**整片剔除**，不能污染质心
        val merged = ChatLorebookEmbedding.mergeChunkVectors(
            listOf(listOf(1.0, 2.0), listOf(Double.NaN, 2.0), listOf(Double.POSITIVE_INFINITY, 0.0)),
        )
        val onlyValid = ChatLorebookEmbedding.mergeChunkVectors(listOf(listOf(1.0, 2.0)))
        assertEquals("含 NaN/Infinity 的分片必须被剔除", onlyValid, merged)
    }

    @Test
    fun longDocumentAlwaysCoversTail() {
        // 只索引开头会让长条目的后半段永远召不回来；最后一片必须覆盖文档尾部
        val text = (0 until 500).joinToString("") { (('a'.code + (it % 26)).toChar()).toString() }
        val chunks = ChatLorebookEmbedding.splitEmbeddingDocument(text, maxChars = 64, maxChunks = 3)
        assertEquals(3, chunks.size)
        assertTrue("最后一片必须覆盖文档尾部", text.endsWith(chunks.last()))
    }
}
