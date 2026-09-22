package com.qingyu.companion.embedding

import com.qingyu.companion.chatcore.ChatLorebookEmbedding
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 索引构建与失效（PC `lorebookEmbeddingIndex.ts` + `vectorStore.ts` 语义对齐）。
 * 第一条用例复刻 PC `lorebookEmbeddingIndex.test.ts` 的同名用例（跨端同管线证据）。
 */
class SemanticIndexBuilderTest {

    private fun entry(
        id: String,
        content: String,
        enabled: Boolean = true,
        priority: String? = null,
        matchMode: String? = "semantic",
    ) = ChatLorebookEmbedding.Entry(
        id = id,
        content = content,
        enabled = enabled,
        priority = priority,
        matchMode = matchMode,
    )

    @Test
    fun longEntryIsChunkedButMergesBackToASingleAggregatedVector() {
        // PC 同名用例：`长条目多片向量化后仍只保存一个聚合向量`
        val embedder = RecordingEmbedder { texts -> texts.map { if (texts.indexOf(it) % 2 == 0) listOf(1.0, 0.0) else listOf(0.0, 1.0) } }
        val result = SemanticIndexBuilder.embedEntries(listOf(entry("long", "内容".repeat(300))), embedder, maxChunkChars = 100)

        assertEquals("所有分片必须批量一次向量化（逐片请求会把远程账单和延迟翻倍）", 1, embedder.calls.size)
        assertTrue("长条目必须被切成多片（否则只索引正文开头）", result.chunkCount > 1)
        assertEquals("一条目必须只落一个向量（索引格式就这个约定）", listOf("long"), result.vectors.keys.toList())
        assertEquals("多片要合并成同维度的聚合向量", 2, result.vectors.getValue("long").size)
        assertEquals("没有向量化失败的条目", 0, result.failed)
    }

    @Test
    fun ineligibleEntriesAreIndexedAndCountedHonestly() {
        val entries = listOf(
            entry("always", "常驻内容", priority = "always"),
            entry("keyword-only", "纯关键词内容", matchMode = "keyword"),
            entry("blank", "   "),
            entry("ok", "正常语义内容"),
        )
        val embedder = RecordingEmbedder { texts -> texts.map { listOf(1.0) } }
        val result = SemanticIndexBuilder.embedEntries(entries, embedder, maxChunkChars = 100)

        assertEquals(
            "常驻/纯关键词/空正文条目不该进向量索引（进了就是白花钱还可能错命中）",
            listOf("ok"),
            result.eligibleIds,
        )
        assertEquals("eligibleIds 与向量数要能对上（界面显示索引进度）", 1, result.vectors.size)
    }

    @Test
    fun buildStateAttachesInvalidationKeysPerEntry() {
        val result = SemanticIndexBuilder.embedEntries(
            listOf(entry("e1", "内容一"), entry("e2", "内容二")),
            RecordingEmbedder { texts -> texts.map { listOf(1.0) } },
            maxChunkChars = 100,
        )
        val state = SemanticIndexBuilder.buildState(
            result,
            modelFingerprint = "openai:m",
            entityRevisions = mapOf("e1" to "r1", "e2" to "r2"),
        )
        assertEquals("每条向量都要带自己的失效键", SemanticIndexPolicy.key("openai:m", "r1"), state.records.getValue("e1").key)
        val usable = state.usableRecords(mapOf("e1" to "r1", "e2" to "r2"))
        assertEquals("失效键一致的记录必须可检索", 2, usable.size)

        val afterEdit = state.usableRecords(mapOf("e1" to "r1-changed", "e2" to "r2"))
        assertEquals("实体修订变化的那条必须被过滤（旧向量描述的是旧正文）", setOf("e2"), afterEdit.keys)
    }

    @Test
    fun staleRecordsAreSkippedUntilRebuilt() {
        val result = SemanticIndexBuilder.embedEntries(
            listOf(entry("e1", "内容一"), entry("e2", "内容二")),
            RecordingEmbedder { texts -> texts.map { listOf(1.0) } },
            maxChunkChars = 100,
        )
        val state = SemanticIndexBuilder.buildState(
            result,
            modelFingerprint = "openai:m",
            entityRevisions = mapOf("e1" to "r1", "e2" to "r2"),
        )
        val stale = SemanticIndexBuilder.markStale(state, listOf("e1"))
        assertTrue("变化条目要进 stale 集合", "e1" in stale.stale)
        assertEquals(
            "stale 的条目检索时必须跳过（旧向量会误导命中）",
            setOf("e2"),
            stale.usableRecords(mapOf("e1" to "r1", "e2" to "r2")).keys,
        )
        assertEquals("stale 条目要出现在待重建清单里", listOf("e1"), stale.rebuildRequiredIds(mapOf("e1" to "r1", "e2" to "r2")))
    }

    @Test
    fun incrementalPatchUpdatesTouchesClearsStaleAndRefusesForeignModelSpace() {
        val result = SemanticIndexBuilder.embedEntries(
            listOf(entry("e1", "内容一"), entry("e2", "内容二"), entry("e3", "内容三")),
            RecordingEmbedder { texts -> texts.map { listOf(1.0) } },
            maxChunkChars = 100,
        )
        val state = SemanticIndexBuilder.buildState(
            result,
            modelFingerprint = "openai:m",
            entityRevisions = mapOf("e1" to "r1", "e2" to "r2", "e3" to "r3"),
        ).copy(stale = setOf("e1", "e2"))

        val patched = SemanticIndexBuilder.patch(
            state,
            embedded = mapOf("e1" to listOf(9.0), "e3" to listOf(7.0)),
            touched = setOf("e1", "e2", "e3"),
            entityRevisions = mapOf("e1" to "r1b", "e2" to "r2", "e3" to "r3b"),
            modelFingerprint = "openai:m",
        )!!
        assertEquals("变化条目的向量必须被新向量覆盖", listOf(9.0), patched.records.getValue("e1").vector)
        assertEquals("修订号要跟着更新（失效键的实体修订）", "r1b", patched.records.getValue("e1").key.entityRevision)
        assertTrue("向量化失败/失去资格的条目必须删掉旧向量（e2 不在 embedded 里）", "e2" !in patched.records)
        assertEquals("patch 过的条目要清掉 stale 标记", setOf<String>(), patched.stale)

        val foreign = SemanticIndexBuilder.patch(
            state,
            embedded = mapOf("e1" to listOf(9.0)),
            touched = setOf("e1"),
            entityRevisions = mapOf("e1" to "r1b"),
            modelFingerprint = "openai:other-model",
        )
        assertNull("模型指纹不同必须拒绝增量（向量空间不同，混进旧索引就是静默错命中）", foreign)
    }
}
