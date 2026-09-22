package com.qingyu.companion.embedding

import com.qingyu.companion.chatcore.ChatVector

/**
 * 阶段 6 S6-05：世界书**语义检索**（PC `electron/ipc/embedding.ts#semanticSearch` 的语义对齐）。
 *
 * 与 PC 同款的四步：
 * 1. 只收集**可参与语义匹配**的条目向量（失效键一致、未 stale——旧向量绝不进检索）；
 * 2. 查询文本向量化（由调用方提供查询向量，便于同一查询向量跨多本书复用）；
 * 3. 每本书取 `maxResults × 2` 个候选（阈值过滤）；
 * 4. 全局按分数排序、`bookId:entryId` 去重后取 `maxResults`。
 *
 * 命中只是候选；注入与否仍由评分/预算管线（`ChatLorebookScoring` / `ChatLorebookBudget`）决定。
 */
object SemanticRetrieval {

    /** 一本书的可检索索引（state + 各条目当前修订号）。 */
    data class BookIndex(
        val bookId: String,
        val state: SemanticIndexState,
        val currentRevisions: Map<String, String>,
    )

    /** 语义命中（PC `SemanticHit` 的子集：id/lbId/score；正文由调用方按 id 取）。 */
    data class LoreSemanticHit(
        val bookId: String,
        val entryId: String,
        val score: Double,
    )

    fun search(
        queryVector: List<Double>,
        indexes: List<BookIndex>,
        threshold: Double,
        maxResults: Int = 3,
    ): List<LoreSemanticHit> {
        if (queryVector.isEmpty() || indexes.isEmpty() || maxResults <= 0) return emptyList()
        val pool = mutableListOf<LoreSemanticHit>()
        for (index in indexes) {
            val usable = index.state.usableRecords(index.currentRevisions)
            if (usable.isEmpty()) continue
            val items = usable.map { (entryId, record) ->
                ChatVector.VectorItem(id = "${index.bookId}:$entryId", vector = record.vector)
            }
            // PC：每本书先取 maxResults×2 的候选，再全局排序去重
            val hits = ChatVector.topKSimilar(queryVector, items, maxResults * 2, threshold)
            for (hit in hits) {
                val separator = hit.id.indexOf(':')
                if (separator <= 0) continue
                pool += LoreSemanticHit(
                    bookId = hit.id.substring(0, separator),
                    entryId = hit.id.substring(separator + 1),
                    score = hit.score,
                )
            }
        }
        val sorted = pool.sortedByDescending { it.score }
        val seen = mutableSetOf<String>()
        val results = mutableListOf<LoreSemanticHit>()
        for (hit in sorted) {
            val key = "${hit.bookId}:${hit.entryId}"
            if (!seen.add(key)) continue
            results += hit
            if (results.size >= maxResults) break
        }
        return results
    }
}
