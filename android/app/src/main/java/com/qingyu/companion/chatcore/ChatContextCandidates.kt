package com.qingyu.companion.chatcore

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.roundToLong

/**
 * 阶段 4 S4-01 第 5 层：统一上下文候选与确定性分配器
 * （对齐 `shared/chat-core/contextCandidates.ts`）。
 *
 * 设计约束（与 PC 一致）：
 * - 候选只携带数值元数据与稳定 id，**不携带任何正文/提示词/URL**，因此分配记录天然不含内容；
 * - 排序是**四级确定性 tie-break**：`tier` → 评分降序 → `originalOrder` → `id`，
 *   相同输入必得相同顺序（避免供应商前缀缓存抖动）；
 * - mandatory 块在预算不可行时也保留，并由 `mandatoryOverBudget` 显式暴露，绝不静默截断；
 * - 单块超限不阻塞后续小块（"能放下就放，放不下跳过继续"）；
 * - 结果对预算单调：预算增大只会新增入选块。
 */
object ChatContextCandidates {

    /** 候选分类（顺序即报告与统计的输出顺序）。 */
    val CANDIDATE_KINDS = listOf(
        "protocol",
        "character",
        "current-state",
        "memory",
        "worldbook",
        "history",
        "example",
        "group-state",
    )

    /** 分类基准优先级（数字越小越先保留）。 */
    private val KIND_BASE_TIER = mapOf(
        "protocol" to 0,
        "character" to 0,
        "group-state" to 1,
        "current-state" to 2,
        "memory" to 2,
        "worldbook" to 2,
        "history" to 3,
        "example" to 3,
    )

    const val TIER_STRUCTURAL = 0
    const val TIER_RECENT_DIALOGUE = 1
    const val TIER_RELEVANT_CONTEXT = 2
    const val TIER_LOW_VALUE = 3

    /** 历史消息达到该近因时视为「最近连续对话」（升到第 1 顺位）。 */
    const val RECENT_HISTORY_RECENCY = 0.5

    /** 记忆/世界书达到该相关度时视为「高相关」（升到第 2 顺位）。 */
    const val HIGH_RELEVANCE_THRESHOLD = 0.5

    /** 块内评分权重（合计 1）。 */
    const val WEIGHT_RELEVANCE = 0.35
    const val WEIGHT_RECENCY = 0.25
    const val WEIGHT_IMPORTANCE = 0.25
    const val WEIGHT_CONTINUITY = 0.15

    data class Candidate(
        val id: String,
        val kind: String,
        val estimatedTokens: Int,
        val mandatory: Boolean = false,
        val stablePrefix: Boolean = false,
        val relevance: Double = 0.0,
        val recency: Double = 0.0,
        val importance: Double = 0.0,
        val continuity: Double = 0.0,
        val dedupeKey: String? = null,
        val originalOrder: Int = 0,
        val origin: String? = null,
    )

    /** 归一化 0~1 评分：非有限/负数视为 0，超过 1 截到 1。 */
    fun normalizeCandidateScore(value: Double?): Double {
        if (value == null || !value.isFinite() || value <= 0.0) return 0.0
        return if (value > 1.0) 1.0 else value
    }

    /** 归一化 token 估计：非有限/负数视为 0，其余向上取整。 */
    fun normalizeCandidateTokens(value: Double?): Int {
        if (value == null || !value.isFinite() || value <= 0.0) return 0
        return ceil(value).toInt()
    }

    /** 净化候选：数值越界、缺 id、缺 kind 都不让分配崩溃；兜底 id 不含随机性。 */
    fun normalize(candidate: Candidate, index: Int = 0): Candidate {
        val kind = if (candidate.kind in CANDIDATE_KINDS) candidate.kind else "history"
        val rawId = candidate.id.trim()
        val originalOrder = candidate.originalOrder
        return candidate.copy(
            id = rawId.ifEmpty { "candidate#$index" },
            kind = kind,
            estimatedTokens = normalizeCandidateTokens(candidate.estimatedTokens.toDouble()),
            mandatory = candidate.mandatory,
            stablePrefix = candidate.stablePrefix,
            relevance = normalizeCandidateScore(candidate.relevance),
            recency = normalizeCandidateScore(candidate.recency),
            importance = normalizeCandidateScore(candidate.importance),
            continuity = normalizeCandidateScore(candidate.continuity),
            originalOrder = originalOrder,
            dedupeKey = candidate.dedupeKey?.takeIf { it.isNotEmpty() },
        )
    }

    /** 块内评分（0~1，保留 6 位小数消除浮点噪声，保证同分判定稳定）。 */
    fun candidateScore(candidate: Candidate): Double {
        val raw = normalizeCandidateScore(candidate.relevance) * WEIGHT_RELEVANCE +
            normalizeCandidateScore(candidate.recency) * WEIGHT_RECENCY +
            normalizeCandidateScore(candidate.importance) * WEIGHT_IMPORTANCE +
            normalizeCandidateScore(candidate.continuity) * WEIGHT_CONTINUITY
        // TS: Math.round(raw * 1e6) / 1e6 —— 对正数 floor(x+0.5) 与 Math.round 等价
        return floor(raw * 1e6 + 0.5) / 1e6
    }

    /**
     * 分配顺位：mandatory 恒为 0；历史按近因、记忆/世界书按相关度在同层内升降。
     */
    fun candidateTier(candidate: Candidate): Int {
        if (candidate.mandatory) return TIER_STRUCTURAL
        if (candidate.kind == "history") {
            return if (normalizeCandidateScore(candidate.recency) >= RECENT_HISTORY_RECENCY) {
                TIER_RECENT_DIALOGUE
            } else {
                TIER_LOW_VALUE
            }
        }
        if (candidate.kind == "memory" || candidate.kind == "worldbook") {
            return if (normalizeCandidateScore(candidate.relevance) >= HIGH_RELEVANCE_THRESHOLD) {
                TIER_RELEVANT_CONTEXT
            } else {
                TIER_LOW_VALUE
            }
        }
        return KIND_BASE_TIER[candidate.kind] ?: TIER_LOW_VALUE
    }

    /** 确定性排序比较器：顺位 → 评分降序 → 原始顺序 → id。 */
    val COMPARATOR: Comparator<Candidate> = Comparator { a, b ->
        val tierDiff = candidateTier(a) - candidateTier(b)
        if (tierDiff != 0) return@Comparator tierDiff
        val scoreDiff = candidateScore(b) - candidateScore(a)
        if (scoreDiff != 0.0) return@Comparator if (scoreDiff < 0) -1 else 1
        if (a.originalOrder != b.originalOrder) return@Comparator a.originalOrder - b.originalOrder
        if (a.id == b.id) 0 else if (a.id < b.id) -1 else 1
    }

    /** 按确定性顺序返回新数组（不修改入参）。 */
    fun rankCandidates(candidates: List<Candidate>): List<Candidate> =
        candidates.mapIndexed { index, candidate -> normalize(candidate, index) }.sortedWith(COMPARATOR)

    data class DedupeResult(
        /** 保序的保留集合（按 **originalOrder / id** 顺序，与 PC 一致） */
        val unique: List<Candidate>,
        /** 被去重掉的候选 id（按确定性顺序） */
        val duplicateIds: List<String>,
    )

    /** 同一 `dedupeKey` 最多保留排序最靠前的一项。 */
    fun dedupeCandidates(candidates: List<Candidate>): DedupeResult {
        val ranked = rankCandidates(candidates)
        val representative = LinkedHashMap<String, String>()
        val duplicateIds = mutableListOf<String>()
        for (candidate in ranked) {
            val key = candidate.dedupeKey ?: continue
            if (representative.containsKey(key)) {
                duplicateIds += candidate.id
                continue
            }
            representative[key] = candidate.id
        }
        val keptIds = representative.values.toSet()
        val unique = ranked
            .filter { it.dedupeKey == null || keptIds.contains(it.id) }
            .sortedWith(compareBy({ it.originalOrder }, { it.id }))
        return DedupeResult(unique, duplicateIds)
    }

    data class KindStat(
        val count: Int = 0,
        val tokens: Int = 0,
        val mandatoryCount: Int = 0,
        val selectedCount: Int = 0,
        val selectedTokens: Int = 0,
        val stablePrefixTokens: Int = 0,
        val droppedCount: Int = 0,
    )

    data class Summary(
        val count: Int,
        val tokens: Int,
        val mandatoryCount: Int,
        val stablePrefixTokens: Int,
        val byKind: Map<String, KindStat>,
    )

    private fun emptyKindStats(): MutableMap<String, KindStat> =
        CANDIDATE_KINDS.associateWith { KindStat() }.toMutableMap()

    /** 汇总候选数量与 token（"现有实现选择的块"一侧口径）。 */
    fun summarizeCandidates(candidates: List<Candidate>): Summary {
        val byKind = emptyKindStats()
        var count = 0
        var tokens = 0
        var mandatoryCount = 0
        var stablePrefixTokens = 0
        candidates.forEachIndexed { index, raw ->
            val candidate = normalize(raw, index)
            val stat = byKind.getValue(candidate.kind)
            count += 1
            tokens += candidate.estimatedTokens
            byKind[candidate.kind] = stat.copy(
                count = stat.count + 1,
                tokens = stat.tokens + candidate.estimatedTokens,
                mandatoryCount = stat.mandatoryCount + if (candidate.mandatory) 1 else 0,
            )
            if (candidate.mandatory) mandatoryCount += 1
            if (candidate.stablePrefix) stablePrefixTokens += candidate.estimatedTokens
        }
        return Summary(count, tokens, mandatoryCount, stablePrefixTokens, byKind)
    }

    data class AllocationOptions(val budgetTokens: Double, val reservedTokens: Double = 0.0)

    data class AllocationResult(
        /** 入选候选 id（按确定性顺序） */
        val selectedIds: List<String>,
        val selected: List<Candidate>,
        /** 未入选候选 id（按确定性顺序） */
        val droppedIds: List<String>,
        val selectedTokens: Int,
        /** mandatory 块合计 token（预算不可行判定用） */
        val mandatoryTokens: Int,
        /** 有效预算 = budgetTokens − reservedTokens（下限 0） */
        val effectiveBudgetTokens: Int,
        /** 实际选择量超过有效预算（只可能因 mandatory 强制保留） */
        val overBudget: Boolean,
        /** mandatory 单独即超出有效预算：预算不可行，需调用方降级而非静默截断 */
        val mandatoryOverBudget: Boolean,
        /** 因 `dedupeKey` 重复被丢弃的候选 id */
        val dedupedIds: List<String>,
        /** 入选的稳定前缀块 token（前缀缓存抖动诊断） */
        val stablePrefixSelectedTokens: Int,
        val byKind: Map<String, KindStat>,
    )

    /**
     * 确定性预算选择：
     * 1. 净化 → 去重（同 key 只留最优）→ 确定性排序；
     * 2. mandatory 全量保留（超预算也保留，由 `mandatoryOverBudget` 暴露）；
     * 3. 其余按顺序"能放下就放"，放不下跳过继续；
     * 4. 结果对预算单调。
     */
    fun allocateContextCandidates(
        candidates: List<Candidate>,
        options: AllocationOptions,
    ): AllocationResult {
        val budgetTokens = normalizeCandidateTokens(options.budgetTokens)
        val reservedTokens = normalizeCandidateTokens(options.reservedTokens)
        val effectiveBudgetTokens = maxOf(0, budgetTokens - reservedTokens)

        val sanitized = candidates.mapIndexed { index, candidate -> normalize(candidate, index) }
        val dedupe = dedupeCandidates(sanitized)
        val ranked = rankCandidates(dedupe.unique)

        val byKind = emptyKindStats()
        for (candidate in sanitized) {
            val stat = byKind.getValue(candidate.kind)
            byKind[candidate.kind] = stat.copy(
                count = stat.count + 1,
                tokens = stat.tokens + candidate.estimatedTokens,
                mandatoryCount = stat.mandatoryCount + if (candidate.mandatory) 1 else 0,
            )
        }

        val selected = mutableListOf<Candidate>()
        var selectedTokens = 0
        for (candidate in ranked) {
            if (!candidate.mandatory) continue
            selected += candidate
            selectedTokens += candidate.estimatedTokens
        }
        val mandatoryTokens = selectedTokens
        val mandatoryOverBudget = mandatoryTokens > effectiveBudgetTokens
        if (!mandatoryOverBudget) {
            for (candidate in ranked) {
                if (candidate.mandatory) continue
                if (selectedTokens + candidate.estimatedTokens > effectiveBudgetTokens) continue
                selected += candidate
                selectedTokens += candidate.estimatedTokens
            }
        }
        selected.sortWith(COMPARATOR)

        val selectedIdSet = selected.map { it.id }.toSet()
        var stablePrefixSelectedTokens = 0
        for (candidate in selected) {
            val stat = byKind.getValue(candidate.kind)
            val stablePrefixTokens = stat.stablePrefixTokens + if (candidate.stablePrefix) candidate.estimatedTokens else 0
            byKind[candidate.kind] = stat.copy(
                selectedCount = stat.selectedCount + 1,
                selectedTokens = stat.selectedTokens + candidate.estimatedTokens,
                stablePrefixTokens = stablePrefixTokens,
            )
            if (candidate.stablePrefix) stablePrefixSelectedTokens += candidate.estimatedTokens
        }
        for (kind in CANDIDATE_KINDS) {
            val stat = byKind.getValue(kind)
            byKind[kind] = stat.copy(droppedCount = stat.count - stat.selectedCount)
        }

        return AllocationResult(
            selectedIds = selected.map { it.id },
            selected = selected,
            droppedIds = ranked.filter { !selectedIdSet.contains(it.id) }.map { it.id },
            selectedTokens = selectedTokens,
            mandatoryTokens = mandatoryTokens,
            effectiveBudgetTokens = effectiveBudgetTokens,
            overBudget = selectedTokens > effectiveBudgetTokens,
            mandatoryOverBudget = mandatoryOverBudget,
            dedupedIds = dedupe.duplicateIds,
            stablePrefixSelectedTokens = stablePrefixSelectedTokens,
            byKind = byKind,
        )
    }
}
