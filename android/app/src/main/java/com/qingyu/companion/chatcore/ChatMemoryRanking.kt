package com.qingyu.companion.chatcore

import kotlin.math.max
import kotlin.math.min

/**
 * 阶段 4 S4-05：长记忆事实的检索评分与分层预算
 * （对齐 `shared/chat-core/memory.ts` 的排名 / 预算 / 格式化部分）。
 *
 * 与 PC 一致的要点：
 * - **降级路径**：无语义分数（embedding 不可用）时不去丢事实，
 *   改按 `importance/5*0.5 + recency*0.3 + confidence*0.2` 排序，`retrievalMode = fallback`；
 * - 结构化事实评分 `semantic*0.5 + recency*0.2 + (importance/5)*0.2 + confidence*0.1`；
 *   字符串事实 `semantic*0.7 + recency*0.3`；
 * - 按预算选择时**单条超限跳过继续**（而非停止），避免一条长事实饿死后面所有短事实；
 * - 分层预算：当前状态优先（上限 240、下限 30、占 30%），其次事实（占剩余 40%），最后时间线。
 */
object ChatMemoryRanking {

    /** 30 天线性衰减的最近性分数（0~1）。 */
    fun computeRecencyScore(updatedAt: Long?, now: Long): Double {
        // 与 PC `!Number.isFinite(updatedAt) || !updatedAt` 等价：**0 也视为缺省**，
        // 因为 0 是「无时间戳」的哨兵值而非 1970 年。漏掉 0 会让 recency 直接掉到 0，
        // 从而把「时间戳缺失但有价值」的旧事实排到末尾（fixture 已捕获该分歧）。
        if (updatedAt == null || updatedAt == 0L) return 0.5
        val elapsed = now - updatedAt
        if (elapsed <= 0) return 1.0
        val thirtyDays = 30L * 24 * 60 * 60 * 1000
        return max(0.0, 1.0 - elapsed.toDouble() / thirtyDays)
    }

    data class RankedFact(
        val fact: ChatMemoryFacts.FactRecord,
        val score: Double,
        val semantic: Double,
        val recency: Double,
        val importance: Int,
        val confidence: Double,
    )

    /**
     * 事实检索评分与排序。
     *
     * `semanticScores` 为与 facts 等长的相似度数组（0~1）；
     * 为 null/长度不匹配/全为 0 时走降级路径。
     */
    fun scoreAndRankFacts(
        facts: List<ChatMemoryFacts.FactRecord>?,
        semanticScores: List<Double>?,
        now: Long,
    ): List<RankedFact> {
        val list = facts ?: emptyList()
        val hasSemantic = semanticScores != null &&
            semanticScores.size == list.size &&
            semanticScores.any { it > 0.0 }

        if (!hasSemantic) {
            return list.map { fact ->
                val structured = fact as? ChatMemoryFacts.FactRecord.Structured
                val importance = structured?.importance ?: 3
                val recency = structured?.let { computeRecencyScore(it.updatedAt, now) } ?: 0.5
                val confidence = structured?.confidence ?: 0.7
                RankedFact(
                    fact = fact,
                    score = importance / 5.0 * 0.5 + recency * 0.3 + confidence * 0.2,
                    semantic = 0.0,
                    recency = recency,
                    importance = importance,
                    confidence = confidence,
                )
            }.sortedWith(
                compareByDescending<RankedFact> { it.score }
                    .thenByDescending { it.importance }
                    .thenByDescending { (it.fact as? ChatMemoryFacts.FactRecord.Structured)?.updatedAt ?: 0L },
            )
        }

        return list.mapIndexed { idx, fact ->
            val semantic = max(0.0, min(1.0, semanticScores!![idx]))
            val structured = fact as? ChatMemoryFacts.FactRecord.Structured
            val recency = structured?.let { computeRecencyScore(it.updatedAt, now) } ?: 0.5
            val importance = structured?.importance ?: 3
            val confidence = structured?.confidence ?: 0.7
            val importanceNorm = importance / 5.0
            val score = if (structured != null) {
                semantic * 0.5 + recency * 0.2 + importanceNorm * 0.2 + confidence * 0.1
            } else {
                semantic * 0.7 + recency * 0.3
            }
            RankedFact(fact, score, semantic, recency, importance, confidence)
        }.sortedByDescending { it.score }
    }

    /**
     * 按预算选择事实：按评分降序，单条超限**跳过继续**（而非停止）。
     * 传入未排名列表时按原始顺序处理（与 PC 一致）。
     */
    fun selectFactsByBudget(
        ranked: List<ChatMemoryFacts.FactRecord>,
        budget: Double,
        estimateTokens: (String) -> Int,
    ): List<ChatMemoryFacts.FactRecord> {
        var remaining = max(0.0, Math.floor(budget)).toInt()
        val selected = mutableListOf<ChatMemoryFacts.FactRecord>()
        for (fact in ranked) {
            if (fact is ChatMemoryFacts.FactRecord.Structured && fact.status != "active") continue
            val tokens = estimateTokens(ChatMemoryFacts.memoryFactToText(fact)) + 1
            if (tokens > remaining) continue
            selected += fact
            remaining -= tokens
        }
        return selected
    }

    /** 按 Token 预算裁剪文本，始终保留开头的高优先级内容。 */
    fun truncateMemoryText(text: String, budget: Double, estimateTokens: (String) -> Int): String {
        var result = text
        while (result.isNotEmpty() && estimateTokens(result) > budget) {
            result = result.substring(0, max(0, result.length - 100))
        }
        return result
    }

    data class LayeredMemory(
        val currentState: String,
        val timeline: String,
        val facts: List<ChatMemoryFacts.FactRecord>,
        /** semantic | fallback */
        val retrievalMode: String,
    )

    /**
     * 分层记忆预算：当前状态优先，其次相关事实，最后才是时间线。
     * 旧会话没有 currentState 时**不为该层预留预算**，保持原有摘要可用空间。
     */
    fun fitLayeredMemoryBudget(
        currentState: String?,
        timeline: String,
        facts: List<ChatMemoryFacts.FactRecord>?,
        budget: Double,
        estimateTokens: (String) -> Int,
        semanticScores: List<Double>?,
        /** 显式「现在」，保证与 PC fixture 逐值可比（生产传当前时间）。 */
        now: Long,
    ): LayeredMemory {
        val safeBudget = max(50.0, Math.floor(budget))
        val stateText = currentState?.trim().orEmpty()
        val stateBudget = if (stateText.isNotEmpty()) {
            min(240.0, max(30.0, Math.floor(safeBudget * 0.3)))
        } else {
            0.0
        }
        val fittedState = if (stateBudget > 0) {
            truncateMemoryText(stateText, stateBudget, estimateTokens)
        } else {
            ""
        }
        val remaining = max(0.0, safeBudget - estimateTokens(fittedState))

        val factList = facts ?: emptyList()
        val hasSemantic = semanticScores != null &&
            semanticScores.size == factList.size &&
            semanticScores.any { it > 0.0 }
        val retrievalMode = if (hasSemantic) "semantic" else "fallback"
        val rankedFacts = scoreAndRankFacts(factList, semanticScores, now)
            .map { it.fact }

        var factsRemaining = max(0.0, Math.floor(remaining * 0.4)).toInt()
        val fittedFacts = mutableListOf<ChatMemoryFacts.FactRecord>()
        for (fact in rankedFacts) {
            if (fact is ChatMemoryFacts.FactRecord.Structured && fact.status != "active") continue
            val tokens = estimateTokens(ChatMemoryFacts.memoryFactToText(fact)) + 1
            if (tokens > factsRemaining) continue
            fittedFacts += fact
            factsRemaining -= tokens
        }
        val usedFactTokens = fittedFacts.sumOf { estimateTokens(ChatMemoryFacts.memoryFactToText(it)) + 1 }
        val timelineBudget = max(0.0, remaining - usedFactTokens)
        val fittedTimeline = truncateMemoryText(timeline, timelineBudget, estimateTokens)

        return LayeredMemory(
            currentState = fittedState,
            timeline = fittedTimeline,
            facts = fittedFacts,
            retrievalMode = retrievalMode,
        )
    }

    /** 将事实列表格式化为注入文本；空列表返回空字符串。 */
    fun formatMemoryFacts(facts: List<ChatMemoryFacts.FactRecord>?): String {
        if (facts.isNullOrEmpty()) return ""
        return ChatMemoryFacts.memoryFactsToTexts(facts)
            .mapIndexed { index, text -> "${index + 1}. $text" }
            .joinToString("\n")
    }
}
