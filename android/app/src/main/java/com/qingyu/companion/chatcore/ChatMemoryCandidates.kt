package com.qingyu.companion.chatcore

import kotlin.math.max
import kotlin.math.min

/**
 * 阶段 4 S4-01 第 5 层 / S4-05：长记忆三层 → 统一候选与物化
 * （对齐 `shared/chat-core/memoryCandidates.ts`）。
 *
 * 三层 = 当前状态 / 结构化事实 / 时间线，交给确定性分配器做「按剩余输入空间与相关性」的动态分配。
 * 纯函数、无 IO、**不含任何存储写入**：
 * - 只读不写：候选、选择与报告都不触碰会话存储，任何失败都不删除记忆；
 * - 事实评分**复用官方 [ChatMemoryRanking.scoreAndRankFacts]**，语义检索不可用时自然落入
 *   importance+recency+confidence 的既有回退口径，不新建第二套排序规则；
 * - 隐私：候选与报告只含 id / 枚举 / 计数 / 数值；时间线与事实文本只在现场 token 估算与物化中使用，
 *   不进入候选元数据、不进入报告、不进入日志。
 *
 * **确定性说明**：PC 的 `scoreAndRankFacts` 内部用 `Date.now()` 计算 recency，
 * 故跨语言 fixture 只用**无 updatedAt 的旧文本事实**（recency 恒 0.5）；
 * recency 本身由 `ChatMemoryRanking` 的显式 `now` 用例锁定。
 */
object ChatMemoryCandidates {

    /** 记忆层（候选映射的三个来源）。 */
    val LAYER_KINDS = listOf("current-state", "fact", "timeline")

    /** 时间线单块目标 token（贪心装填上限）。 */
    const val MEMORY_TIMELINE_TARGET_CHUNK_TOKENS = 90

    /** 时间线单块硬上限：超过则按句子再切，避免「一条超长事件」变成全有或全无的块。 */
    const val MEMORY_TIMELINE_MAX_CHUNK_TOKENS = 180

    /** 时间线候选条数上限：超出部分并进最早的一块（保留文本，只减少候选数量）。 */
    const val MEMORY_TIMELINE_MAX_CHUNKS = 48

    /** 当前状态候选评分：当前状态是「必须优先于低价值记忆」的层。 */
    const val MEMORY_STATE_RELEVANCE = 0.9
    const val MEMORY_STATE_RECENCY = 1.0
    const val MEMORY_STATE_IMPORTANCE = 0.9
    const val MEMORY_STATE_CONTINUITY = 0.9

    /** 时间线候选评分：相关度固定进入「相关上下文」顺位，块内按近因排序。 */
    const val MEMORY_TIMELINE_RELEVANCE = 0.6
    const val MEMORY_TIMELINE_IMPORTANCE = 0.6

    /** 事实候选连续性（与最近对话的衔接强度低于原始历史）。 */
    const val MEMORY_FACT_CONTINUITY = 0.4

    data class TimelineChunk(
        /** 稳定 id：`memory:timeline:<index>`（不含内容） */
        val id: String,
        val index: Int,
        val text: String,
        val tokens: Int,
    )

    /**
     * 时间线 → 有序候选块（纯函数、确定性）：
     * 1. 按行切分；
     * 2. 超过硬上限的长行按句末标点再切，尽量装到目标大小；
     * 3. 相邻小块贪心合并到目标大小，避免碎块；
     * 4. 条数超上限时把最早的若干块并成一块（保留文本，只减少候选数量）。
     */
    fun splitTimelineIntoChunks(
        timeline: String?,
        model: String? = null,
        estimateTokens: (String) -> Int = { ChatTokenCounter.estimateTokens(it, model) },
    ): List<TimelineChunk> {
        val text = (timeline ?: "").replace("\r\n", "\n").trim()
        if (text.isEmpty()) return emptyList()

        val segments = text.split("\n").map { it.trim() }.filter { it.isNotEmpty() }

        val packed = mutableListOf<String>()
        var buffer = mutableListOf<String>()
        var bufferTokens = 0
        fun flush() {
            if (buffer.isNotEmpty()) {
                packed += buffer.joinToString("\n")
                buffer = mutableListOf()
                bufferTokens = 0
            }
        }

        for (segment in segments) {
            val segmentTokens = estimateTokens(segment)
            if (segmentTokens > MEMORY_TIMELINE_MAX_CHUNK_TOKENS) {
                flush()
                packed += packSentences(segment, estimateTokens)
                continue
            }
            if (bufferTokens > 0 && bufferTokens + segmentTokens > MEMORY_TIMELINE_TARGET_CHUNK_TOKENS) flush()
            buffer += segment
            bufferTokens += segmentTokens
        }
        flush()

        if (packed.size > MEMORY_TIMELINE_MAX_CHUNKS) {
            // 与 JS `splice(0, overflow, joined)` 等价：前 overflow 块并成一块，总数落到上限
            val overflow = packed.size - MEMORY_TIMELINE_MAX_CHUNKS + 1
            val joined = packed.take(overflow).joinToString("\n")
            val rest = packed.drop(overflow)
            packed.clear()
            packed += joined
            packed += rest
        }

        return packed.mapIndexed { index, chunkText ->
            TimelineChunk(
                id = "memory:timeline:$index",
                index = index,
                text = chunkText,
                tokens = estimateTokens(chunkText),
            )
        }
    }

    /** 按句末标点切句（不依赖正则 lookbehind，保证各端一致）。 */
    fun splitSentences(text: String): List<String> {
        val terminators = "。！？；!?;…\n"
        val out = mutableListOf<String>()
        var current = StringBuilder()
        for (char in text) {
            if (char == '\n') {
                val trimmed = current.toString().trim()
                if (trimmed.isNotEmpty()) out += trimmed
                current = StringBuilder()
                continue
            }
            current.append(char)
            if (terminators.contains(char)) {
                val trimmed = current.toString().trim()
                if (trimmed.isNotEmpty()) out += trimmed
                current = StringBuilder()
            }
        }
        val tail = current.toString().trim()
        if (tail.isNotEmpty()) out += tail
        return out
    }

    /** 句子贪心装填到目标大小（保持原顺序与原文）。 */
    fun packSentences(text: String, estimateTokens: (String) -> Int): List<String> {
        val sentences = splitSentences(text)
        if (sentences.size <= 1) return listOf(text.trim()).filter { it.isNotEmpty() }
        val pieces = mutableListOf<String>()
        var buffer = StringBuilder()
        var bufferTokens = 0
        for (sentence in sentences) {
            val tokens = estimateTokens(sentence)
            if (bufferTokens > 0 && bufferTokens + tokens > MEMORY_TIMELINE_TARGET_CHUNK_TOKENS) {
                pieces += buffer.toString()
                buffer = StringBuilder()
                bufferTokens = 0
            }
            buffer.append(sentence)
            bufferTokens += tokens
        }
        if (buffer.isNotEmpty()) pieces += buffer.toString()
        return pieces
    }

    data class Input(
        val currentState: String? = null,
        val timeline: String? = null,
        /** 待注入的事实（语义命中或全量，与 semanticScores 等长） */
        val facts: List<ChatMemoryFacts.FactRecord>? = null,
        /** 与 facts 等长的语义相似度；缺失/全 0 时走回退口径 */
        val semanticScores: List<Double>? = null,
        val model: String? = null,
    )

    data class Described(
        val stateTokens: Int,
        val factCount: Int,
        val factTokens: Int,
        val timelineChunkCount: Int,
        val timelineTokens: Int,
        val totalTokens: Int,
    )

    data class CandidateSet(
        val candidates: List<ChatContextCandidates.Candidate>,
        /** 候选 id → 记忆层（供影子报告与接管时分层取回） */
        val layerByCandidateId: Map<String, String>,
        /** semantic | fallback */
        val retrievalMode: String,
        /** 未被分配截断前的描述量（「简单话题可少注入」的对照基线） */
        val described: Described,
    )

    /** 结构化事实的稳定 id；旧字符串事实用位置 id（不把内容写进 id）。 */
    fun factCandidateId(fact: ChatMemoryFacts.FactRecord, index: Int): String =
        if (fact is ChatMemoryFacts.FactRecord.Structured) fact.id else "legacy-$index"

    /**
     * 三层 → 候选集合（确定性）：
     * - 当前状态：单块，评分固定为「相关上下文」顺位中的最高档；
     * - 事实：逐条候选，`relevance` 直接复用官方评分；非 active 事实不参与；
     * - 时间线：按行/句切成有序候选，块内按近因排序（新事件先保留）。
     */
    fun buildMemoryCandidateSet(
        input: Input,
        /** 显式「现在」；生产传当前时间。fixture 用无 updatedAt 的事实使 recency 恒定。 */
        now: Long = System.currentTimeMillis(),
        estimateTokens: (String) -> Int = { ChatTokenCounter.estimateTokens(it, input.model) },
    ): CandidateSet {
        val candidates = mutableListOf<ChatContextCandidates.Candidate>()
        val layerByCandidateId = LinkedHashMap<String, String>()

        val stateText = (input.currentState ?: "").trim()
        if (stateText.isNotEmpty()) {
            val tokens = estimateTokens(stateText)
            candidates += ChatContextCandidates.Candidate(
                id = "memory:current-state",
                kind = "current-state",
                estimatedTokens = tokens,
                mandatory = false,
                stablePrefix = false,
                relevance = MEMORY_STATE_RELEVANCE,
                recency = MEMORY_STATE_RECENCY,
                importance = MEMORY_STATE_IMPORTANCE,
                continuity = MEMORY_STATE_CONTINUITY,
                dedupeKey = "memory:state",
                originalOrder = 0,
                origin = "memory:state",
            )
            layerByCandidateId["memory:current-state"] = "current-state"
        }

        val facts = input.facts ?: emptyList()
        val semanticScores = input.semanticScores
        val hasSemantic = semanticScores != null &&
            semanticScores.size == facts.size &&
            semanticScores.any { it > 0.0 }
        val retrievalMode = if (hasSemantic) "semantic" else "fallback"
        // 官方评分是唯一事实排序来源；这里只做「评分结果 → 原始下标」的稳定回填
        val ranked = ChatMemoryRanking.scoreAndRankFacts(facts, semanticScores, now)
        val consumed = mutableSetOf<Int>()
        var factTokens = 0
        for (entry in ranked) {
            val structured = entry.fact as? ChatMemoryFacts.FactRecord.Structured
            if (structured != null && structured.status != "active") continue
            var index = -1
            for (i in facts.indices) {
                if (i in consumed) continue
                // 同单测说明：结构化事实按值相等匹配；重复且等值的事实可互换，结果一致
                if (facts[i] == entry.fact) {
                    index = i
                    break
                }
            }
            if (index < 0) continue
            consumed += index
            val candidateId = factCandidateId(entry.fact, index)
            val text = ChatMemoryFacts.memoryFactToText(entry.fact)
            if (text.isEmpty()) continue
            val tokens = estimateTokens(text)
            factTokens += tokens
            val id = "memory:fact:$candidateId"
            candidates += ChatContextCandidates.Candidate(
                id = id,
                kind = "memory",
                estimatedTokens = tokens,
                mandatory = false,
                stablePrefix = false,
                relevance = entry.score,
                recency = entry.recency,
                importance = min(1.0, max(0.0, entry.importance / 5.0)),
                continuity = MEMORY_FACT_CONTINUITY,
                dedupeKey = "fact:$candidateId",
                originalOrder = candidates.size,
                origin = "memory:fact:$retrievalMode",
            )
            layerByCandidateId[id] = "fact"
        }

        val chunks = splitTimelineIntoChunks(input.timeline, input.model, estimateTokens)
        var timelineTokens = 0
        chunks.forEach { chunk ->
            val recency = if (chunks.size <= 1) 1.0 else (chunk.index + 1).toDouble() / chunks.size
            timelineTokens += chunk.tokens
            candidates += ChatContextCandidates.Candidate(
                id = chunk.id,
                kind = "memory",
                estimatedTokens = chunk.tokens,
                mandatory = false,
                stablePrefix = false,
                relevance = MEMORY_TIMELINE_RELEVANCE,
                recency = recency,
                importance = MEMORY_TIMELINE_IMPORTANCE,
                continuity = 0.3 + 0.4 * recency,
                dedupeKey = "timeline:${chunk.index}",
                originalOrder = candidates.size,
                origin = "memory:timeline",
            )
            layerByCandidateId[chunk.id] = "timeline"
        }

        val stateTokens = if (stateText.isNotEmpty()) estimateTokens(stateText) else 0
        val factCount = candidates.count { layerByCandidateId[it.id] == "fact" }
        return CandidateSet(
            candidates = candidates,
            layerByCandidateId = layerByCandidateId,
            retrievalMode = retrievalMode,
            described = Described(
                stateTokens = stateTokens,
                factCount = factCount,
                factTokens = factTokens,
                timelineChunkCount = chunks.size,
                timelineTokens = timelineTokens,
                totalTokens = stateTokens + factTokens + timelineTokens,
            ),
        )
    }

    /** 既有实现（`fitLayeredMemoryBudget`）本轮实际注入的记忆统计。 */
    data class InjectionStats(
        /** 既有实现的记忆专属上限（候选侧没有这个上限） */
        val capTokens: Int = 0,
        val stateTokens: Int = 0,
        val factCount: Int = 0,
        val factTokens: Int = 0,
        val timelineChunkCount: Int = 0,
        val timelineTokens: Int = 0,
        val totalTokens: Int = 0,
        val retrievalMode: String = "fallback",
    )

    data class LayerTotals(val count: Int, val tokens: Int)

    data class LayerSelection(
        /** 该层入选块数与 token */
        val selected: LayerTotals,
        /** 该层被分配截断（本轮不注入）的块数——不是删除，存储不变 */
        val dropped: Int,
    )

    data class CompetitorStats(val describedTokens: Int, val selectedTokens: Int, val deltaTokens: Int)

    data class CandidateSelection(
        val budgetTokens: Int,
        val selectedTokens: Int,
        val byLayer: Map<String, LayerSelection>,
        val overBudget: Boolean,
        /** 记忆块在全局竞争中的对手（协议/角色/世界书/历史/示例） */
        val competitor: CompetitorStats,
    )

    private fun emptyLayerSelection(): MutableMap<String, LayerSelection> = linkedMapOf(
        "current-state" to LayerSelection(LayerTotals(0, 0), 0),
        "fact" to LayerSelection(LayerTotals(0, 0), 0),
        "timeline" to LayerSelection(LayerTotals(0, 0), 0),
    )

    /**
     * 记忆候选与对手块在同一预算内竞争：
     * 报告「哪一层保留了多少、被截断多少、是否因 mandatory 而超预算」。
     */
    fun selectMemoryCandidates(
        plan: CandidateSet,
        budgetTokens: Double,
        competitors: List<ChatContextCandidates.Candidate> = emptyList(),
    ): CandidateSelection {
        val allocation = ChatContextCandidates.allocateContextCandidates(
            candidates = plan.candidates + competitors,
            options = ChatContextCandidates.AllocationOptions(budgetTokens = budgetTokens),
        )
        val byLayer = emptyLayerSelection()
        var selectedTokens = 0
        for (candidate in allocation.selected) {
            val layer = plan.layerByCandidateId[candidate.id] ?: continue
            val current = byLayer.getValue(layer)
            byLayer[layer] = LayerSelection(
                selected = LayerTotals(
                    count = current.selected.count + 1,
                    tokens = current.selected.tokens + candidate.estimatedTokens,
                ),
                dropped = current.dropped,
            )
            selectedTokens += candidate.estimatedTokens
        }
        byLayer["current-state"] = byLayer.getValue("current-state").let {
            it.copy(dropped = if (plan.described.stateTokens > 0 && it.selected.count == 0) 1 else 0)
        }
        byLayer["fact"] = byLayer.getValue("fact").let {
            it.copy(dropped = max(0, plan.described.factCount - it.selected.count))
        }
        byLayer["timeline"] = byLayer.getValue("timeline").let {
            it.copy(dropped = max(0, plan.described.timelineChunkCount - it.selected.count))
        }

        val competitorSummary = ChatContextCandidates.summarizeCandidates(competitors)
        val competitorSelectedTokens = max(0, allocation.selectedTokens - selectedTokens)
        return CandidateSelection(
            budgetTokens = allocation.effectiveBudgetTokens,
            selectedTokens = selectedTokens,
            byLayer = byLayer,
            overBudget = allocation.overBudget,
            competitor = CompetitorStats(
                describedTokens = competitorSummary.tokens,
                selectedTokens = competitorSelectedTokens,
                deltaTokens = competitorSelectedTokens - competitorSummary.tokens,
            ),
        )
    }

    data class LayerDiff(
        val layer: String,
        val existingCount: Int,
        val existingTokens: Int,
        val candidateCount: Int,
        val candidateTokens: Int,
        val candidateDroppedCount: Int,
    )

    data class CandidateShadowStats(
        val stateTokens: Int,
        val factCount: Int,
        val factTokens: Int,
        val timelineChunkCount: Int,
        val timelineTokens: Int,
        val totalTokens: Int,
        val retrievalMode: String,
        val droppedFactCount: Int,
        val droppedTimelineChunkCount: Int,
        val overBudget: Boolean,
    )

    data class ShadowReport(
        val mode: String = "memory-shadow",
        val budgetTokens: Int,
        /** 既有实现的记忆上限（`min(800, budgetBase*0.1)` 的实际取值） */
        val legacyCapTokens: Int,
        val retrievalMode: String,
        val existing: InjectionStats,
        val candidate: CandidateShadowStats,
        /** candidate.totalTokens − existing.totalTokens */
        val deltaTokens: Int,
        /** 候选侧是否突破既有的 800 口径上限 */
        val exceedsLegacyCap: Boolean,
        val competitor: CompetitorStats,
        val byLayer: List<LayerDiff>,
        /** 采集/选择异常兜底（true 时数值为零值，生成不受影响） */
        val degraded: Boolean,
    )

    /**
     * 分配失败时的兜底报告：既有口径原样保留，候选侧归零并标记 `degraded`。
     * 生成链路的注入仍来自既有实现，因此「失败退回原选择」是结构性的。
     */
    private fun degradedMemoryShadow(existing: InjectionStats, budgetTokens: Double): ShadowReport =
        ShadowReport(
            budgetTokens = max(0, Math.floor(if (budgetTokens.isFinite()) budgetTokens else 0.0).toInt()),
            legacyCapTokens = max(0, Math.floor(existing.capTokens.toDouble()).toInt()),
            retrievalMode = existing.retrievalMode,
            existing = existing,
            candidate = CandidateShadowStats(
                stateTokens = 0,
                factCount = 0,
                factTokens = 0,
                timelineChunkCount = 0,
                timelineTokens = 0,
                totalTokens = 0,
                retrievalMode = existing.retrievalMode,
                droppedFactCount = 0,
                droppedTimelineChunkCount = 0,
                overBudget = false,
            ),
            deltaTokens = -existing.totalTokens,
            exceedsLegacyCap = false,
            competitor = CompetitorStats(0, 0, 0),
            byLayer = listOf(
                LayerDiff("current-state", if (existing.stateTokens > 0) 1 else 0, existing.stateTokens, 0, 0, 0),
                LayerDiff("fact", existing.factCount, existing.factTokens, 0, 0, 0),
                LayerDiff("timeline", existing.timelineChunkCount, existing.timelineTokens, 0, 0, 0),
            ),
            degraded = true,
        )

    /**
     * 记忆专项影子报告：既有实现（固定上限 + 层内截断）与「候选动态分配」在同一输入、同一预算下的分层差异。
     */
    fun buildMemoryShadowReport(
        plan: CandidateSet,
        existing: InjectionStats,
        budgetTokens: Double,
        competitors: List<ChatContextCandidates.Candidate> = emptyList(),
    ): ShadowReport = try {
        val selection = selectMemoryCandidates(plan, budgetTokens, competitors)
        val candidateTotal = selection.selectedTokens
        val stateLayer = selection.byLayer.getValue("current-state")
        val factLayer = selection.byLayer.getValue("fact")
        val timelineLayer = selection.byLayer.getValue("timeline")
        ShadowReport(
            budgetTokens = selection.budgetTokens,
            legacyCapTokens = existing.capTokens,
            retrievalMode = plan.retrievalMode,
            existing = existing,
            candidate = CandidateShadowStats(
                stateTokens = stateLayer.selected.tokens,
                factCount = factLayer.selected.count,
                factTokens = factLayer.selected.tokens,
                timelineChunkCount = timelineLayer.selected.count,
                timelineTokens = timelineLayer.selected.tokens,
                totalTokens = candidateTotal,
                retrievalMode = plan.retrievalMode,
                droppedFactCount = factLayer.dropped,
                droppedTimelineChunkCount = timelineLayer.dropped,
                overBudget = selection.overBudget,
            ),
            deltaTokens = candidateTotal - existing.totalTokens,
            exceedsLegacyCap = candidateTotal > existing.capTokens,
            competitor = selection.competitor,
            byLayer = listOf(
                LayerDiff(
                    "current-state",
                    if (existing.stateTokens > 0) 1 else 0,
                    existing.stateTokens,
                    stateLayer.selected.count,
                    stateLayer.selected.tokens,
                    stateLayer.dropped,
                ),
                LayerDiff(
                    "fact",
                    existing.factCount,
                    existing.factTokens,
                    factLayer.selected.count,
                    factLayer.selected.tokens,
                    factLayer.dropped,
                ),
                LayerDiff(
                    "timeline",
                    existing.timelineChunkCount,
                    existing.timelineTokens,
                    timelineLayer.selected.count,
                    timelineLayer.selected.tokens,
                    timelineLayer.dropped,
                ),
            ),
            degraded = false,
        )
    } catch (_: Throwable) {
        degradedMemoryShadow(existing, budgetTokens)
    }

    /** 数值化日志串（不含正文/事实文本/提示词）。 */
    fun formatMemoryShadowSummary(report: ShadowReport): String {
        val layers = report.byLayer.joinToString(",") { diff ->
            "${diff.layer}:${diff.existingTokens}->${diff.candidateTokens}/" +
                "${diff.existingCount}->${diff.candidateCount}"
        }
        return listOf(
            "mode=memory-shadow",
            "budget=${report.budgetTokens}",
            "cap=${report.legacyCapTokens}",
            "existing=${report.existing.totalTokens}",
            "candidate=${report.candidate.totalTokens}",
            "delta=${report.deltaTokens}",
            "exceedsCap=${if (report.exceedsLegacyCap) 1 else 0}",
            "droppedFacts=${report.candidate.droppedFactCount}",
            "droppedTimeline=${report.candidate.droppedTimelineChunkCount}",
            "retrieval=${report.retrievalMode}",
            "degraded=${if (report.degraded) 1 else 0}",
            "layers=$layers",
        ).joinToString(" ")
    }

    /** 接管后可直接注入 systemContent 的记忆三段。 */
    data class MaterializedInjection(
        val currentState: String,
        val facts: List<ChatMemoryFacts.FactRecord>,
        val timeline: String,
        val retrievalMode: String,
    )

    /**
     * 把分配器入选的候选 id 还原为可注入三段。
     * - current-state：入选则注入完整 trim 状态（不再按 240 token 截断状态段）；
     * - facts：按官方评分序过滤入选 id，还原原始事实（不改存储）；
     * - timeline：按候选顺序拼接入选 chunk 文本（chunk 序即最新优先）。
     * 入选集合为空时对应层为空——**不是**删除存储，只是本轮不注入。
     */
    fun materializeMemoryInjection(
        plan: CandidateSet,
        selectedIds: Set<String>,
        currentState: String?,
        facts: List<ChatMemoryFacts.FactRecord>,
        timeline: String?,
        semanticScores: List<Double>?,
        model: String? = null,
        now: Long = System.currentTimeMillis(),
        estimateTokens: (String) -> Int = { ChatTokenCounter.estimateTokens(it, model) },
    ): MaterializedInjection {
        val stateText = (currentState ?: "").trim()
        val resolvedState = if (stateText.isNotEmpty() && "memory:current-state" in selectedIds) stateText else ""

        val factList = facts.toList()
        val ranked = ChatMemoryRanking.scoreAndRankFacts(factList, semanticScores, now)
        val consumed = mutableSetOf<Int>()
        val selectedFacts = mutableListOf<ChatMemoryFacts.FactRecord>()
        for (entry in ranked) {
            val structured = entry.fact as? ChatMemoryFacts.FactRecord.Structured
            if (structured != null && structured.status != "active") continue
            var index = -1
            for (i in factList.indices) {
                if (i in consumed) continue
                if (factList[i] == entry.fact) {
                    index = i
                    break
                }
            }
            if (index < 0) continue
            consumed += index
            val candidateId = factCandidateId(entry.fact, index)
            if ("memory:fact:$candidateId" in selectedIds) selectedFacts += entry.fact
        }

        val chunks = splitTimelineIntoChunks(timeline, model, estimateTokens)
        // 与 plan 同源的 timeline id 集合：source 切块结果必须与候选构造一致才可物化
        val planTimelineIds = plan.candidates
            .filter { it.origin == "memory:timeline" }
            .map { it.id }
            .toSet()
        val resolvedTimeline = chunks
            .filter { it.id in planTimelineIds && it.id in selectedIds }
            .joinToString("\n") { it.text }

        val hasSemantic = semanticScores != null &&
            semanticScores.size == factList.size &&
            semanticScores.any { it > 0.0 }

        return MaterializedInjection(
            currentState = resolvedState,
            facts = selectedFacts,
            timeline = resolvedTimeline,
            retrievalMode = if (hasSemantic) "semantic" else "fallback",
        )
    }
}
