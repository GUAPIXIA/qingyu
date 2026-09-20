package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-05：向量工具（对齐 PC `shared/chat-core/vector.ts`）。
 *
 * 这是「向量层接入」的算法地基：余弦相似度 / L2 归一化 / 点积 / Top-K 检索。
 * 纯函数、无 IO，因此可以逐字节与 PC 对齐并 fixture 锁定；
 * 上层的嵌入提供方（走模型端点）与本地向量存储都建立在这层之上。
 *
 * 几处刻意与 PC 保持一致的边界语义：
 * - **长度不匹配或任一为空 → 0**（不抛异常，避免一条脏数据毁掉整轮检索）
 * - **零向量 → 归一化返回原样**，相似度按 0 处理（PC 里 normA/normB 为 0 时直接返回 0）
 * - `topK` **跳过维度不匹配的条目**（而不是截断或补零）
 * - 分数相同时**保持输入顺序**（JS 自 ES2019 起 sort 稳定；Kotlin 的 sortedByDescending 同样稳定）
 */
object ChatVector {

    /** 计算两个向量的余弦相似度（长度不匹配或任一为空 → 0；任一为零向量 → 0）。 */
    fun cosineSimilarity(a: List<Double>, b: List<Double>): Double {
        if (a.isEmpty() || b.isEmpty() || a.size != b.size) return 0.0
        var dot = 0.0
        var normA = 0.0
        var normB = 0.0
        for (index in a.indices) {
            dot += a[index] * b[index]
            normA += a[index] * a[index]
            normB += b[index] * b[index]
        }
        if (normA == 0.0 || normB == 0.0) return 0.0
        return dot / (kotlin.math.sqrt(normA) * kotlin.math.sqrt(normB))
    }

    /** L2 归一化向量（零向量返回原样）。 */
    fun l2Normalize(vector: List<Double>): List<Double> {
        var sumSq = 0.0
        for (value in vector) sumSq += value * value
        if (sumSq == 0.0) return vector
        val norm = kotlin.math.sqrt(sumSq)
        return vector.map { it / norm }
    }

    /** 两个已归一化向量的点积（等价于余弦相似度）。 */
    fun dotProduct(a: List<Double>, b: List<Double>): Double {
        if (a.isEmpty() || b.isEmpty() || a.size != b.size) return 0.0
        var dot = 0.0
        for (index in a.indices) dot += a[index] * b[index]
        return dot
    }

    data class VectorItem(val id: String, val vector: List<Double>)

    data class SimilarityHit(val id: String, val score: Double)

    /**
     * 取与查询向量最相似的 K 个（分数 ≥ `minScore`），按分数降序。
     * 输入先归一化再点积（归一化后余弦 = 点积）。
     */
    fun topKSimilar(
        query: List<Double>,
        items: List<VectorItem>,
        k: Int,
        minScore: Double = 0.0,
    ): List<SimilarityHit> {
        if (items.isEmpty() || query.isEmpty()) return emptyList()
        val normalizedQuery = l2Normalize(query)
        val scores = mutableListOf<SimilarityHit>()
        for (item in items) {
            if (item.vector.size != normalizedQuery.size) continue
            val score = dotProduct(normalizedQuery, l2Normalize(item.vector))
            if (score >= minScore) scores += SimilarityHit(item.id, score)
        }
        // 稳定排序：同分保持输入顺序（与 JS sort 的稳定性一致）
        return scores.sortedByDescending { it.score }.take(k)
    }
}
