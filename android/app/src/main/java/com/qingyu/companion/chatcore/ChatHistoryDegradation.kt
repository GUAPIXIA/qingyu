package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-01 第 4 层：历史分级降级影子计划与序列化输入审计接线
 * （对齐 `shared/chat-core/historyDegradation.ts`）。
 *
 * 降级顺序：
 * 1. 保留预算内最近对话（既有 `cropHistory` 语义）；
 * 2. 被裁剪的旧历史若已有**覆盖该时间范围**的压缩摘要 → 用摘要替代原文；
 * 3. 无摘要（或摘要未覆盖）→ 视为原文直接删除。
 *
 * 覆盖判定与 `contextBuilder` 同口径：`droppedStartTs >= range.startTs && droppedEndTs <= range.endTs`。
 */
object ChatHistoryDegradation {

    data class DegradationItem(
        /** 稳定 id（消息 id 或 `history:summary`）；不含正文 */
        val id: String,
        /** keep-raw | replace-with-summary | drop-raw */
        val action: String,
        val tokens: Int,
        val coveredBySummary: Boolean,
    )

    data class Existing(
        val keptCount: Int,
        val keptTokens: Int,
        val droppedCount: Int,
        val droppedTokens: Int,
        val summaryInjected: Boolean,
        val summaryTokens: Int,
    )

    data class Candidate(
        val keptRawCount: Int,
        val keptRawTokens: Int,
        val summaryReplacedCount: Int,
        val summaryTokens: Int,
        val droppedRawCount: Int,
        val droppedRawTokens: Int,
        val totalTokens: Int,
    )

    data class Plan(
        val mode: String = "history-degradation",
        val budgetTokens: Int,
        val existing: Existing,
        val candidate: Candidate,
        /** `candidate.totalTokens − (existing.keptTokens + existing.summaryTokens)` */
        val deltaTokens: Int,
        val items: List<DegradationItem>,
        val degraded: Boolean,
    )

    data class Range(val startTs: Long, val endTs: Long)

    /** 复用调用方已有的 crop 结果，避免二次裁剪口径漂移。 */
    data class CropSlice(
        val recent: List<ChatContextShared.CropableMessage>,
        val droppedTokens: Int,
        val droppedEndIndex: Int,
        val droppedStartTs: Long,
        val droppedEndTs: Long,
    )

    private fun degradedPlan(budgetTokens: Double): Plan = Plan(
        budgetTokens = kotlin.math.max(0, kotlin.math.floor(budgetTokens.takeIf { it.isFinite() } ?: 0.0).toInt()),
        existing = Existing(0, 0, 0, 0, false, 0),
        candidate = Candidate(0, 0, 0, 0, 0, 0, 0),
        deltaTokens = 0,
        items = emptyList(),
        degraded = true,
    )

    /**
     * 历史分级降级计划（纯函数）：不修改消息，只产出「摘要替代 vs 原文删除」的可解释对照。
     */
    fun plan(
        messages: List<ChatContextShared.CropableMessage>,
        usedTokens: Int,
        budgetTokens: Double,
        model: String,
        compressedSummary: String? = null,
        compressedRange: Range? = null,
        crop: ChatContextShared.CropResult<ChatContextShared.CropableMessage>? = null,
    ): Plan {
        return try {
            val budget = kotlin.math.max(0, kotlin.math.floor(budgetTokens.takeIf { it.isFinite() } ?: 0.0).toInt())
            val effectiveCrop = crop ?: ChatContextShared.cropHistory(
                messages,
                kotlin.math.max(0, usedTokens),
                budget,
                model,
            )
            val recent = effectiveCrop.recent
            val keptRawTokens = recent.sumOf { message ->
                ChatTokenCounter.estimateTokens(message.content, model) +
                    (message.images?.size?.let { it * ChatContextShared.IMAGE_TOKEN_ESTIMATE_FOR_CROP } ?: 0)
            }
            val droppedCount = kotlin.math.max(0, messages.size - recent.size)
            val droppedTokens = kotlin.math.max(0, effectiveCrop.droppedTokens)

            val summaryText = compressedSummary?.trim().orEmpty()
            val summaryTokens = if (summaryText.isNotEmpty()) ChatTokenCounter.estimateTokens(summaryText, model) else 0
            val covered = summaryText.isNotEmpty() &&
                droppedCount > 0 &&
                compressedRange != null &&
                effectiveCrop.droppedStartTs >= compressedRange.startTs &&
                effectiveCrop.droppedEndTs <= compressedRange.endTs

            val items = mutableListOf<DegradationItem>()
            recent.forEachIndexed { index, message ->
                val tokens = ChatTokenCounter.estimateTokens(message.content, model) +
                    (message.images?.size?.let { it * ChatContextShared.IMAGE_TOKEN_ESTIMATE_FOR_CROP } ?: 0)
                items += DegradationItem("history:msg:$index", "keep-raw", tokens, false)
            }
            if (droppedCount > 0) {
                if (covered) {
                    items += DegradationItem("history:summary", "replace-with-summary", summaryTokens, true)
                } else {
                    items += DegradationItem("history:dropped-raw", "drop-raw", droppedTokens, false)
                }
            }

            val candidate = Candidate(
                keptRawCount = recent.size,
                keptRawTokens = keptRawTokens,
                summaryReplacedCount = if (covered) droppedCount else 0,
                summaryTokens = if (covered) summaryTokens else 0,
                droppedRawCount = if (covered) 0 else droppedCount,
                droppedRawTokens = if (covered) 0 else droppedTokens,
                totalTokens = keptRawTokens + (if (covered) summaryTokens else 0),
            )
            val existing = Existing(
                keptCount = recent.size,
                keptTokens = keptRawTokens,
                droppedCount = droppedCount,
                droppedTokens = droppedTokens,
                summaryInjected = covered,
                summaryTokens = if (covered) summaryTokens else 0,
            )
            Plan(
                budgetTokens = budget,
                existing = existing,
                candidate = candidate,
                deltaTokens = candidate.totalTokens - (existing.keptTokens + existing.summaryTokens),
                items = items,
                degraded = false,
            )
        } catch (_: Throwable) {
            degradedPlan(budgetTokens)
        }
    }

    /** 数值化日志串（不含正文/消息内容）。 */
    fun formatSummary(plan: Plan): String = listOf(
        "mode=history-degradation",
        "budget=${plan.budgetTokens}",
        "existingKept=${plan.existing.keptTokens}",
        "existingSummary=${plan.existing.summaryTokens}",
        "candRaw=${plan.candidate.keptRawTokens}",
        "candSummary=${plan.candidate.summaryTokens}",
        "replace=${plan.candidate.summaryReplacedCount}",
        "drop=${plan.candidate.droppedRawCount}",
        "delta=${plan.deltaTokens}",
        "degraded=${if (plan.degraded) 1 else 0}",
    ).joinToString(" ")

    /**
     * 把已合并/转换后的消息映射为无正文的估算视图（`serialized = false`）。
     */
    fun buildSerializedInputViewFromMessages(
        messages: List<ChatInputAudit.Part>,
        provider: String,
        model: String,
    ): ChatInputAudit.View = ChatInputAudit.View(
        provider = provider,
        model = model,
        parts = messages,
        serialized = false,
    )

    /** 序列化输入审计接线：估算视图 → 审计（超限只报告，不裁剪）。 */
    fun auditMessagesAsSerializedInput(
        messages: List<ChatInputAudit.Part>,
        provider: String,
        model: String,
        reservedOutputTokens: Double,
        contextLimit: Double,
    ): ChatInputAudit.Audit = ChatInputAudit.audit(
        view = ChatInputAudit.View(provider, model, messages, serialized = false),
        reservedOutputTokens = reservedOutputTokens,
        contextLimit = contextLimit,
    )
}
