package com.qingyu.companion.embedding

import com.qingyu.companion.chatcore.ChatLorebookEmbedding

/**
 * 阶段 6 S6-05：**向量索引的构建与失效**（PC `electron/services/lorebookEmbeddingIndex.ts`
 * 与 `electron/services/vectorStore.ts` 的语义对齐）。
 *
 * - 构建：条目 → 语义资格过滤 → 向量文档 → 切片 → 批量向量化 → 多片质心合并回「一条目一向量」
 *   （与 PC 同一管线，`SemanticIndexBuilderTest` 复刻 PC `lorebookEmbeddingIndex.test.ts` 的用例）；
 * - 失效：每条向量记录带 [SemanticIndexKey]（三要素失效键），外加 `stale` 标记
 *   （条目已改、索引未重建期间**跳过旧向量**，避免旧向量误导——PC `semanticSearch` 同款）；
 * - 增量：`patch` 只重算变化条目（PC `patchVectorIndex` 同款），但**失效键不一致的记录
 *   永远不进检索**——增量与「任一要素变化即重建」不冲突。
 */

/** 一条向量记录（带失效键）。 */
data class IndexedVector(
    val vector: List<Double>,
    val key: SemanticIndexKey,
)

/**
 * 一个检索单元（一本世界书 / 一组记忆事实）的向量索引状态。
 * 纯内存结构：不落盘、不进同步（见 [SemanticIndexSyncPolicy]），随时可从源数据重建。
 */
data class SemanticIndexState(
    val modelFingerprint: String,
    /** entryId → 向量记录。 */
    val records: Map<String, IndexedVector> = emptyMap(),
    /** 已变更但未重建的条目（检索时跳过，PC `stale` 同款）。 */
    val stale: Set<String> = emptySet(),
) {
    /**
     * 当前可参与检索的记录：失效键与当前口径一致 **且** 不在 stale 集合里。
     * [currentRevisions] 缺失修订号的条目视为不可用（宁可少命中，不可拿旧向量错命中）。
     */
    fun usableRecords(currentRevisions: Map<String, String>): Map<String, IndexedVector> {
        val usable = mutableMapOf<String, IndexedVector>()
        for ((entryId, record) in records) {
            if (entryId in stale) continue
            val revision = currentRevisions[entryId] ?: continue
            val current = SemanticIndexPolicy.key(modelFingerprint, revision)
            if (SemanticIndexPolicy.canReuse(record.key, current).reusable) usable[entryId] = record
        }
        return usable
    }

    /** 需要重建的条目 id（失效键变化或被标 stale 的）。 */
    fun rebuildRequiredIds(currentRevisions: Map<String, String>): List<String> {
        val needed = mutableListOf<String>()
        for ((entryId, record) in records) {
            val revision = currentRevisions[entryId]
            val current = revision?.let { SemanticIndexPolicy.key(modelFingerprint, it) }
            if (entryId in stale || current == null || !SemanticIndexPolicy.canReuse(record.key, current).reusable) {
                needed += entryId
            }
        }
        return needed
    }
}

object SemanticIndexBuilder {

    /** 一次索引构建的产出（PC `EmbeddedLorebookEntries` 同字段）。 */
    data class BuildResult(
        val eligibleIds: List<String>,
        val vectors: Map<String, List<Double>>,
        val failed: Int,
        val chunkCount: Int,
    )

    /**
     * 对条目文档切片后批量向量化，再聚合回「一条目一向量」（PC `embedLorebookEntries`）。
     *
     * [maxChunkChars] 由提供方决定：远程 [EmbeddingProtocols.MAX_INPUT_CHARS] 之外的
     * 索引切片用 `ChatEmbeddingPolicy.resolveIndexChunkChars`；本地用 [localIndexChunkChars]。
     */
    fun embedEntries(
        entries: List<ChatLorebookEmbedding.Entry>,
        embedder: TextEmbedder,
        maxChunkChars: Int,
    ): BuildResult {
        val eligible = entries.filter { ChatLorebookEmbedding.isSemanticEligible(it) }
        val chunks = mutableListOf<Pair<String, String>>() // entryId → chunkText
        for (entry in eligible) {
            val document = ChatLorebookEmbedding.buildEmbeddingDocument(entry)
            for (text in ChatLorebookEmbedding.splitEmbeddingDocument(document, maxChunkChars)) {
                chunks += entry.id to text
            }
        }
        val embedded = if (chunks.isEmpty()) emptyList()
        else embedder.embed(chunks.map { it.second }, EmbeddingInputKind.PASSAGE)

        val byEntry = mutableMapOf<String, MutableList<List<Double>>>()
        for ((index, chunk) in chunks.withIndex()) {
            val vector = embedded.getOrNull(index) ?: continue
            if (vector.isEmpty()) continue
            byEntry.getOrPut(chunk.first) { mutableListOf() }.add(vector)
        }
        val vectors = mutableMapOf<String, List<Double>>()
        var failed = 0
        for (entry in eligible) {
            val merged = ChatLorebookEmbedding.mergeChunkVectors(byEntry[entry.id].orEmpty())
            if (merged.isNotEmpty()) vectors[entry.id] = merged else failed++
        }
        return BuildResult(
            eligibleIds = eligible.map { it.id },
            vectors = vectors,
            failed = failed,
            chunkCount = chunks.size,
        )
    }

    /** 构建结果 → 索引状态（每条记录带失效键：模型指纹 + 该条目实体修订 + 切片策略版本）。 */
    fun buildState(
        result: BuildResult,
        modelFingerprint: String,
        entityRevisions: Map<String, String>,
    ): SemanticIndexState {
        val records = mutableMapOf<String, IndexedVector>()
        for ((entryId, vector) in result.vectors) {
            val revision = entityRevisions[entryId] ?: continue
            records[entryId] = IndexedVector(vector, SemanticIndexPolicy.key(modelFingerprint, revision))
        }
        return SemanticIndexState(modelFingerprint = modelFingerprint, records = records)
    }

    /** 标记变化条目为 stale（索引未重建期间检索跳过，PC `markStale`/`markEntriesStale` 同款）。 */
    fun markStale(state: SemanticIndexState, changedIds: Collection<String>): SemanticIndexState {
        val existing = changedIds.filter { it in state.records }
        if (existing.isEmpty()) return state
        return state.copy(stale = state.stale + existing)
    }

    /**
     * 增量更新（PC `patchVectorIndex`）：更新变化条目、删除失去语义资格/向量化失败的条目，
     * 并清除这些条目的 stale 标记。**模型指纹不一致时拒绝增量**（要求整体重建）。
     */
    fun patch(
        state: SemanticIndexState,
        embedded: Map<String, List<Double>>,
        touched: Set<String>,
        entityRevisions: Map<String, String>,
        modelFingerprint: String,
    ): SemanticIndexState? {
        if (state.modelFingerprint != modelFingerprint) return null
        val records = state.records.toMutableMap()
        for (entryId in touched) {
            val vector = embedded[entryId]
            val revision = entityRevisions[entryId]
            if (vector == null || vector.isEmpty() || revision == null) {
                records.remove(entryId) // 失去语义资格 / 向量化失败 / 无修订号 → 不保留旧向量
            } else {
                records[entryId] = IndexedVector(vector, SemanticIndexPolicy.key(modelFingerprint, revision))
            }
        }
        return state.copy(records = records, stale = state.stale - touched)
    }
}
