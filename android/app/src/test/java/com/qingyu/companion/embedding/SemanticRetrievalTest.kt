package com.qingyu.companion.embedding

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 世界书语义检索：全局 topK、去重、阈值过滤，以及**失效键/stale 记录绝不进检索**
 * （旧向量误导比不命中更糟：它会把无关条目注进提示词）。
 */
class SemanticRetrievalTest {

    private fun state(vararg entries: Pair<String, String>): SemanticIndexState {
        // entryId to entityRevision，向量用可区分的单位向量
        val records = entries.mapIndexed { index, (entryId, revision) ->
            entryId to IndexedVector(
                vector = listOf(1.0 - index * 0.1, index * 0.1),
                key = SemanticIndexPolicy.key("openai:m", revision),
            )
        }.toMap()
        return SemanticIndexState(modelFingerprint = "openai:m", records = records)
    }

    @Test
    fun searchSortsGloballyDedupesAndRespectsMaxResults() {
        val bookA = SemanticRetrieval.BookIndex("lbA", state("a1" to "r1", "a2" to "r2"), mapOf("a1" to "r1", "a2" to "r2"))
        val bookB = SemanticRetrieval.BookIndex("lbB", state("b1" to "r1"), mapOf("b1" to "r1"))
        val query = listOf(1.0, 0.0) // 与 index=0 的向量同向 → 最高分

        val hits = SemanticRetrieval.search(query, listOf(bookA, bookB), threshold = 0.0, maxResults = 2)
        assertEquals("最多返回 maxResults 条", 2, hits.size)
        assertEquals("全局按分数排序：a1 最相似（同向）", "a1", hits[0].entryId)
        assertTrue("命中要带 bookId（调用方按 bookId:entryId 取正文）", hits.all { it.bookId.isNotEmpty() })

        val again = SemanticRetrieval.search(query, listOf(bookA, bookA), threshold = 0.0, maxResults = 5)
        assertEquals(
            "同一本书重复送进来不能产生重复命中（key 去重）",
            again.map { "${it.bookId}:${it.entryId}" }.distinct().size,
            again.size,
        )
    }

    @Test
    fun staleAndInvalidatedRecordsNeverEnterSearch() {
        val staleState = SemanticIndexBuilder.markStale(state("s1" to "r1", "s2" to "r2"), listOf("s1"))
        val book = SemanticRetrieval.BookIndex("lb", staleState, mapOf("s1" to "r1", "s2" to "r2"))
        val hits = SemanticRetrieval.search(listOf(1.0, 0.0), listOf(book), threshold = 0.0, maxResults = 5)
        assertEquals("stale 条目必须被跳过（旧向量会误导命中）", listOf("s2"), hits.map { it.entryId })

        val invalidated = SemanticRetrieval.BookIndex(
            "lb",
            state("s1" to "r1"),
            mapOf("s1" to "r1-edited"), // 实体修订已变 → 失效键不匹配
        )
        val noHits = SemanticRetrieval.search(listOf(1.0, 0.0), listOf(invalidated), threshold = 0.0, maxResults = 5)
        assertTrue("失效键不匹配的记录绝不能进检索（等重建，不能拿旧向量硬凑）", noHits.isEmpty())
    }

    @Test
    fun thresholdFiltersWeakMatches() {
        val book = SemanticRetrieval.BookIndex("lb", state("a1" to "r1"), mapOf("a1" to "r1"))
        val orthogonal = listOf(0.0, 1.0) // 与 [0.9, 0.1] 不同向
        val hits = SemanticRetrieval.search(orthogonal, listOf(book), threshold = 0.99, maxResults = 5)
        assertTrue("低于阈值的相似度不该返回（阈值口径与事实检索一致）", hits.isEmpty())

        val empty = SemanticRetrieval.search(emptyList(), listOf(book), threshold = 0.0, maxResults = 5)
        assertTrue("空查询向量返回空而不是报错", empty.isEmpty())
    }
}
