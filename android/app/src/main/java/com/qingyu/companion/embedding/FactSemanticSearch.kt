package com.qingyu.companion.embedding

import com.qingyu.companion.chatcore.ChatEmbeddingPolicy
import com.qingyu.companion.chatcore.ChatVector

/**
 * 阶段 6 S6-05：**事实向量检索**（能力矩阵 `semantic.factSearch`，要求与世界书语义检索**同口径**）。
 *
 * 同口径的四件事：
 * 1. 同一失效键（[SemanticIndexKey]：模型指纹 + 实体修订 + 切片策略版本）——事实索引同样
 *    不同步、目标端按记忆数据重建；
 * 2. 同一阈值口径（[ChatEmbeddingPolicy.resolveSemanticThreshold]：显式值优先、
 *    本地模型按校准表、未知模型保守默认 0.3）；
 * 3. 同一命中映射（[ChatEmbeddingPolicy.mapFactSearchHits]：字符串下标 id、越界丢弃）；
 * 4. 同一三档降级（[TierDecision]）——向量不可用时**回退全量注入**
 *    （PC `embedding:searchFacts` 失败即返回空 → 渲染层回退全量注入），
 *    并给出可解释原因（矩阵备注「不可用时关键词降级」：事实本身继续按
 *    重要性+最近性的非向量路径排序注入，见 `ChatMemoryFacts`/`ChatMemoryRanking`）。
 */
object FactSemanticSearch {

    /** 事实向量索引（facts[i] 的向量与失效键）。 */
    data class FactVectorIndex(
        val facts: List<String>,
        val vectors: List<List<Double>>,
        val keys: List<SemanticIndexKey>,
    ) {
        /** 按当前失效键口径过滤出可检索的下标（任一要素变化的记录不进检索）。 */
        fun usableIndices(currentKeys: List<SemanticIndexKey>): Set<Int> {
            if (currentKeys.size != keys.size || vectors.size != keys.size) return emptySet()
            val usable = mutableSetOf<Int>()
            for (index in keys.indices) {
                if (SemanticIndexPolicy.canReuse(keys[index], currentKeys[index]).reusable) usable += index
            }
            return usable
        }
    }

    enum class Channel {
        /** 向量通道命中（可能为空 = 真的没有相似事实）。 */
        VECTOR,

        /** 向量通道不可用/索引不可用 → 全量注入兜底（PC 同款回退）。 */
        FULL_INJECTION_FALLBACK,
    }

    data class FactSearchResult(
        val hits: List<ChatEmbeddingPolicy.FactHit>,
        val channel: Channel,
        /** 可解释读数：为什么走了兜底 / 用的什么阈值（界面与调试面板直接展示）。 */
        val explanation: String,
    )

    /**
     * 事实语义检索。
     *
     * [queryVector] 为 null 表示查询向量化失败或向量档不可用；
     * [currentKeys] 是**当前**各事实的失效键口径（与 [FactVectorIndex.keys] 等长逐项比对）。
     */
    fun search(
        query: String,
        queryVector: List<Double>?,
        index: FactVectorIndex?,
        currentKeys: List<SemanticIndexKey>?,
        decision: TierDecision,
        config: ChatEmbeddingPolicy.Config,
        requestedThreshold: Double? = null,
        maxResults: Int = 3,
    ): FactSearchResult {
        if (query.isBlank()) {
            return FactSearchResult(emptyList(), Channel.FULL_INJECTION_FALLBACK, "查询为空，事实回退全量注入")
        }
        if (!decision.vectorChannelAvailable) {
            return FactSearchResult(
                emptyList(),
                Channel.FULL_INJECTION_FALLBACK,
                "事实语义检索已降级为全量注入（${decision.explanation}）",
            )
        }
        if (queryVector == null || queryVector.isEmpty()) {
            return FactSearchResult(
                emptyList(),
                Channel.FULL_INJECTION_FALLBACK,
                "查询向量化未完成，事实回退全量注入（不影响已保存的事实）",
            )
        }
        if (index == null || currentKeys == null) {
            return FactSearchResult(
                emptyList(),
                Channel.FULL_INJECTION_FALLBACK,
                "事实向量索引尚未建立，事实回退全量注入（索引可随时按记忆数据重建）",
            )
        }
        val usable = index.usableIndices(currentKeys)
        if (usable.isEmpty()) {
            return FactSearchResult(
                emptyList(),
                Channel.FULL_INJECTION_FALLBACK,
                "事实向量索引已失效（模型指纹/实体修订/切片策略变化），事实回退全量注入并等待重建",
            )
        }
        val threshold = ChatEmbeddingPolicy.resolveSemanticThreshold(config, requestedThreshold)
        val items = usable.sorted().map { position ->
            ChatVector.VectorItem(id = position.toString(), vector = index.vectors[position])
        }
        val hits = ChatVector.topKSimilar(queryVector, items, maxResults, threshold)
        val mapped = ChatEmbeddingPolicy.mapFactSearchHits(
            hits.map { it.id to it.score },
            index.facts,
        )
        return FactSearchResult(
            hits = mapped,
            channel = Channel.VECTOR,
            explanation = "事实语义检索命中 ${mapped.size} 条（阈值 $threshold）",
        )
    }
}
