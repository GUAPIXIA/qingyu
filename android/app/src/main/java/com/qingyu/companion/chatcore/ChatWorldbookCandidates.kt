package com.qingyu.companion.chatcore

import kotlin.math.floor

/**
 * 阶段 4 S4-01 第 5 层：世界书条目 → 统一上下文候选 + 专项影子报告
 * （对齐 `shared/chat-core/worldbookCandidates.ts`）。
 *
 * 语义要点（与 PC 一致）：
 * - **always → mandatory**：常驻条目在预算可行时必须保留；
 * - 评分直接复用统一运行时的 `score`（关键词+语义+实体+近因），不新建第二套评分；
 * - `relevance` 复用 score；`importance` 按优先级分层（always 0.9 / conditional 0.55 / detail 0.35）；
 * - `recency` 固定 0.5，`continuity` always 0.7、其余 0.45；
 * - `stablePrefix`：非 `at_depth` 才进稳定前缀（at_depth 插在历史中间）；
 * - **被丢弃的条目也进入候选**（"既有没注入 vs 影子会不会选"是接管对照的核心）；
 * - 候选只携带 key/枚举/计数/数值，不携带正文。
 */
object ChatWorldbookCandidates {

    const val WORLDBOOK_ALWAYS_IMPORTANCE = 0.9
    const val WORLDBOOK_CONDITIONAL_IMPORTANCE = 0.55
    const val WORLDBOOK_DETAIL_IMPORTANCE = 0.35

    /** 运行时条目快照（PC `LorebookScoredEntrySnapshot` 的字段子集）。 */
    data class Snapshot(
        val key: String,
        val score: Double = 0.0,
        /** always | conditional | detail */
        val priority: String? = null,
        /** before_char | after_char | at_depth | at_end */
        val position: String = "at_end",
        val depth: Int? = null,
        val order: Int = 0,
        val tokens: Double = 0.0,
        val kept: Boolean = false,
        val usedSummary: Boolean = false,
        val ignoreBudget: Boolean = false,
    )

    /** 评分归一到 0~1：非有限/负数视为 0，超界截到 1。 */
    fun normalizeWorldbookScore(score: Double?): Double {
        if (score == null || !score.isFinite() || score <= 0.0) return 0.0
        return if (score > 1.0) 1.0 else score
    }

    /** 位置 → 渲染锚点 origin（差异解释用；at_depth 带 depth）。 */
    fun worldbookOrigin(snapshot: Snapshot): String = when (snapshot.position) {
        "before_char" -> "worldbook:before_character"
        "after_char" -> "worldbook:after_character"
        "at_depth" -> "worldbook:chat_depth:${snapshot.depth ?: 0}"
        else -> "worldbook:prompt_end"
    }

    data class Described(
        val totalCount: Int,
        val totalTokens: Int,
        val alwaysCount: Int,
        val alwaysTokens: Int,
        val conditionalCount: Int,
        val detailCount: Int,
    )

    data class CandidateSet(
        val candidates: List<ChatContextCandidates.Candidate>,
        /** 候选 id → 原条目 key */
        val keyByCandidateId: Map<String, String>,
        /** 候选 id → 优先级（分层差异解释） */
        val priorityByCandidateId: Map<String, String>,
        val described: Described,
    )

    /** 快照 tokens 口径：非有限按 0，负数按 0，其余向下取整。 */
    private fun snapshotTokens(snapshot: Snapshot): Int =
        maxOf(0, floor(snapshot.tokens.takeIf { it.isFinite() } ?: 0.0).toInt())

    /**
     * 世界书条目 → 候选集合（确定性）：稳定顺序为 `order` 升序 → `key` 升序。
     */
    fun buildWorldbookCandidateSet(snapshots: List<Snapshot>?): CandidateSet {
        val candidates = mutableListOf<ChatContextCandidates.Candidate>()
        val keyByCandidateId = LinkedHashMap<String, String>()
        val priorityByCandidateId = LinkedHashMap<String, String>()
        var alwaysCount = 0
        var alwaysTokens = 0
        var conditionalCount = 0
        var detailCount = 0
        var totalTokens = 0

        val ordered = (snapshots ?: emptyList()).sortedWith(
            compareBy({ it.order }, { it.key }),
        )

        ordered.forEachIndexed { index, snapshot ->
            if (snapshot.key.isEmpty()) return@forEachIndexed
            val tokens = snapshotTokens(snapshot)
            if (tokens <= 0 && !snapshot.ignoreBudget) return@forEachIndexed
            val priority = snapshot.priority ?: "conditional"
            val mandatory = priority == "always"
            val importance = when (priority) {
                "always" -> WORLDBOOK_ALWAYS_IMPORTANCE
                "detail" -> WORLDBOOK_DETAIL_IMPORTANCE
                else -> WORLDBOOK_CONDITIONAL_IMPORTANCE
            }
            val id = "worldbook:${snapshot.key}"
            keyByCandidateId[id] = snapshot.key
            priorityByCandidateId[id] = priority
            candidates += ChatContextCandidates.Candidate(
                id = id,
                kind = "worldbook",
                estimatedTokens = tokens,
                mandatory = mandatory,
                stablePrefix = snapshot.position != "at_depth",
                relevance = normalizeWorldbookScore(snapshot.score),
                recency = 0.5,
                importance = importance,
                continuity = if (priority == "always") 0.7 else 0.45,
                dedupeKey = "lore:${snapshot.key}",
                originalOrder = index,
                origin = worldbookOrigin(snapshot),
            )
            totalTokens += tokens
            when {
                mandatory -> {
                    alwaysCount += 1
                    alwaysTokens += tokens
                }
                priority == "detail" -> detailCount += 1
                else -> conditionalCount += 1
            }
        }

        return CandidateSet(
            candidates = candidates,
            keyByCandidateId = keyByCandidateId,
            priorityByCandidateId = priorityByCandidateId,
            described = Described(
                totalCount = candidates.size,
                totalTokens = totalTokens,
                alwaysCount = alwaysCount,
                alwaysTokens = alwaysTokens,
                conditionalCount = conditionalCount,
                detailCount = detailCount,
            ),
        )
    }

    /** 既有实现实际注入的统计（分桶口径）。 */
    data class InjectionStats(
        val keptCount: Int = 0,
        val keptTokens: Int = 0,
        val droppedCount: Int = 0,
        val droppedTokens: Int = 0,
        val alwaysDropped: Int = 0,
        val legacyCapTokens: Int = 0,
        val keptAlwaysCount: Int = 0,
        val keptConditionalCount: Int = 0,
        val keptDetailCount: Int = 0,
        val alwaysKeptTokens: Int = 0,
        val conditionalKeptTokens: Int = 0,
        val detailKeptTokens: Int = 0,
        val summaryFallbackCount: Int = 0,
    )

    /** 从运行时快照汇总「既有实现实际注入」一侧。 */
    fun summarizeWorldbookInjection(snapshots: List<Snapshot>?, legacyCapTokens: Double): InjectionStats {
        var stats = InjectionStats(
            legacyCapTokens = maxOf(0, floor(legacyCapTokens.takeIf { it.isFinite() } ?: 0.0).toInt()),
        )
        for (snapshot in snapshots ?: emptyList()) {
            val tokens = snapshotTokens(snapshot)
            if (snapshot.kept) {
                stats = stats.copy(
                    keptCount = stats.keptCount + 1,
                    keptTokens = stats.keptTokens + tokens,
                    keptAlwaysCount = stats.keptAlwaysCount + if (snapshot.priority == "always") 1 else 0,
                    alwaysKeptTokens = stats.alwaysKeptTokens + if (snapshot.priority == "always") tokens else 0,
                    keptDetailCount = stats.keptDetailCount + if (snapshot.priority == "detail") 1 else 0,
                    detailKeptTokens = stats.detailKeptTokens + if (snapshot.priority == "detail") tokens else 0,
                    keptConditionalCount = stats.keptConditionalCount +
                        if (snapshot.priority != "always" && snapshot.priority != "detail") 1 else 0,
                    conditionalKeptTokens = stats.conditionalKeptTokens +
                        if (snapshot.priority != "always" && snapshot.priority != "detail") tokens else 0,
                    summaryFallbackCount = stats.summaryFallbackCount + if (snapshot.usedSummary) 1 else 0,
                )
            } else {
                stats = stats.copy(
                    droppedCount = stats.droppedCount + 1,
                    droppedTokens = stats.droppedTokens + tokens,
                    alwaysDropped = stats.alwaysDropped + if (snapshot.priority == "always") 1 else 0,
                )
            }
        }
        return stats
    }

    data class LayerDiff(
        val priority: String,
        val existingCount: Int,
        val existingTokens: Int,
        val candidateCount: Int,
        val candidateTokens: Int,
        val candidateDroppedCount: Int,
    )

    data class CandidateStats(
        val selectedCount: Int,
        val selectedTokens: Int,
        val droppedCount: Int,
        val alwaysMandatoryCount: Int,
        val alwaysSelectedCount: Int,
        val alwaysDroppedCount: Int,
        val overBudget: Boolean,
        val mandatoryOverBudget: Boolean,
    )

    data class ShadowReport(
        val mode: String = "worldbook-shadow",
        val budgetTokens: Int,
        /** 既有世界书专属预算（固定比例） */
        val legacyCapTokens: Int,
        val existing: InjectionStats,
        val candidate: CandidateStats,
        /** candidate.selectedTokens − existing.keptTokens */
        val deltaTokens: Int,
        /** 候选侧突破既有世界书专属上限（统一池竞争的预期差异） */
        val exceedsLegacyCap: Boolean,
        val byPriority: List<LayerDiff>,
        /** 采集/选择异常兜底 */
        val degraded: Boolean,
    )

    private fun degradedShadow(existing: InjectionStats, budgetTokens: Double): ShadowReport = ShadowReport(
        budgetTokens = maxOf(0, floor(budgetTokens.takeIf { it.isFinite() } ?: 0.0).toInt()),
        legacyCapTokens = existing.legacyCapTokens,
        existing = existing,
        candidate = CandidateStats(0, 0, 0, 0, 0, 0, false, false),
        deltaTokens = -existing.keptTokens,
        exceedsLegacyCap = false,
        byPriority = listOf(
            LayerDiff("always", existing.keptAlwaysCount, existing.alwaysKeptTokens, 0, 0, 0),
            LayerDiff("conditional", existing.keptConditionalCount, existing.conditionalKeptTokens, 0, 0, 0),
            LayerDiff("detail", existing.keptDetailCount, existing.detailKeptTokens, 0, 0, 0),
        ),
        degraded = true,
    )

    /**
     * 世界书专项影子报告：既有固定比例注入 vs 候选统一预算选择。
     * 竞争对手由调用方传入，使差异可解释到「统一池」口径。
     */
    fun buildWorldbookShadowReport(
        plan: CandidateSet,
        existing: InjectionStats,
        budgetTokens: Double,
        competitors: List<ChatContextCandidates.Candidate> = emptyList(),
    ): ShadowReport {
        return try {
            val allocation = ChatContextCandidates.allocateContextCandidates(
                candidates = plan.candidates + competitors,
                options = ChatContextCandidates.AllocationOptions(budgetTokens = budgetTokens),
            )
            var selectedCount = 0
            var selectedTokens = 0
            var droppedCount = 0
            var alwaysSelectedCount = 0
            var alwaysDroppedCount = 0
            val selectedIdSet = allocation.selectedIds.toSet()

            val byPriority = listOf("always", "conditional", "detail").map { priority ->
                val layer = plan.candidates.filter { plan.priorityByCandidateId[it.id] == priority }
                var candidateTokens = 0
                var candidateDroppedCount = 0
                for (candidate in layer) {
                    if (selectedIdSet.contains(candidate.id)) {
                        candidateTokens += candidate.estimatedTokens
                    } else {
                        candidateDroppedCount += 1
                    }
                }
                val existingCount = when (priority) {
                    "always" -> existing.keptAlwaysCount
                    "detail" -> existing.keptDetailCount
                    else -> existing.keptConditionalCount
                }
                val existingTokens = when (priority) {
                    "always" -> existing.alwaysKeptTokens
                    "detail" -> existing.detailKeptTokens
                    else -> existing.conditionalKeptTokens
                }
                LayerDiff(priority, existingCount, existingTokens, layer.size, candidateTokens, candidateDroppedCount)
            }

            for (candidate in allocation.selected) {
                if (plan.keyByCandidateId[candidate.id] == null) continue
                selectedCount += 1
                selectedTokens += candidate.estimatedTokens
                if (candidate.mandatory) alwaysSelectedCount += 1
            }
            for (candidate in plan.candidates) {
                if (selectedIdSet.contains(candidate.id)) continue
                droppedCount += 1
                if (candidate.mandatory) alwaysDroppedCount += 1
            }

            ShadowReport(
                budgetTokens = allocation.effectiveBudgetTokens,
                legacyCapTokens = existing.legacyCapTokens,
                existing = existing,
                candidate = CandidateStats(
                    selectedCount = selectedCount,
                    selectedTokens = selectedTokens,
                    droppedCount = droppedCount,
                    alwaysMandatoryCount = plan.described.alwaysCount,
                    alwaysSelectedCount = alwaysSelectedCount,
                    alwaysDroppedCount = alwaysDroppedCount,
                    overBudget = allocation.overBudget,
                    mandatoryOverBudget = allocation.mandatoryOverBudget,
                ),
                deltaTokens = selectedTokens - existing.keptTokens,
                exceedsLegacyCap = selectedTokens > existing.legacyCapTokens,
                byPriority = byPriority,
                degraded = false,
            )
        } catch (_: Throwable) {
            degradedShadow(existing, budgetTokens)
        }
    }

    /** 数值化日志串（不含正文/条目内容/提示词）。 */
    fun formatWorldbookShadowSummary(report: ShadowReport): String {
        val layers = report.byPriority.joinToString(",") { diff ->
            "${diff.priority}:${diff.existingTokens}->${diff.candidateTokens}/${diff.existingCount}->${diff.candidateCount}"
        }
        return listOf(
            "mode=worldbook-shadow",
            "budget=${report.budgetTokens}",
            "cap=${report.legacyCapTokens}",
            "existing=${report.existing.keptTokens}",
            "candidate=${report.candidate.selectedTokens}",
            "delta=${report.deltaTokens}",
            "exceedsCap=${if (report.exceedsLegacyCap) 1 else 0}",
            "alwaysSel=${report.candidate.alwaysSelectedCount}/${report.candidate.alwaysMandatoryCount}",
            "alwaysDrop=${report.candidate.alwaysDroppedCount}",
            "mandatoryOver=${if (report.candidate.mandatoryOverBudget) 1 else 0}",
            "degraded=${if (report.degraded) 1 else 0}",
            "layers=$layers",
        ).joinToString(" ")
    }
}
