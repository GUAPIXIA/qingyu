package com.qingyu.companion.chatcore

import kotlin.math.max
import kotlin.math.min

/**
 * 阶段 4 S4-01 第 4—5 层：上下文共享工具与序列化后输入审计
 * （对齐 `shared/chat-core/contextShared.ts` 与 `inputAudit.ts`）。
 *
 * **PC 侧同名常量的坑（必须按调用点分别对齐，不能统一）**：
 * - `shared/chat-core/chatConstants.ts` 的 `IMAGE_TOKEN_ESTIMATE = 200`
 *   → 被 `cropHistory` 与 `historyDegradation` 使用；
 * - `shared/chat-core/tokenCounter.ts` 自己定义了一个**同名但值不同**的 `IMAGE_TOKEN_ESTIMATE = 500`
 *   → 被 `estimateImageTokens` 使用。
 * 两端若不区分就会在同一份 fixture 上产生稳定偏差。Kotlin 侧因此保留两个显式不同的常量。
 */
object ChatContextShared {

    /** `chatConstants.TOKEN_BUDGET_SAFETY`：启发式估算安全系数。 */
    const val TOKEN_BUDGET_SAFETY = 0.95

    /** `chatConstants.IMAGE_TOKEN_ESTIMATE`：裁剪/降级路径使用的每张图片估算。 */
    const val IMAGE_TOKEN_ESTIMATE_FOR_CROP = 200

    /** `tokenCounter.IMAGE_TOKEN_ESTIMATE`：独立估算入口使用的每张图片估算（与上者不同，见类注释）。 */
    const val IMAGE_TOKEN_ESTIMATE_FOR_COUNTER = 500

    /** 参与裁剪的消息最小结构。 */
    interface CropableMessage {
        val content: String
        val images: List<String>?
        val timestamp: Long
    }

    data class CropResult<T : CropableMessage>(
        /** 保留（预算内）的消息，按原顺序 */
        val recent: List<T>,
        val droppedStartTs: Long,
        val droppedEndTs: Long,
        /** 被裁剪内容的估算 token 数（**不含**图片 token，与 PC 一致） */
        val droppedTokens: Int,
        /** 被裁剪的最后一个消息索引（0..i），无裁剪时为 -1 */
        val droppedEndIndex: Int,
    )

    /** 单条消息的裁剪口径 token：正文估算 + 图片数量 × 200。 */
    fun cropTokenCount(message: CropableMessage, model: String): Int =
        ChatTokenCounter.estimateTokens(message.content, model) +
            (message.images?.size?.let { it * IMAGE_TOKEN_ESTIMATE_FOR_CROP } ?: 0)

    /**
     * 按 token 预算裁剪历史（从最新往最旧累计，超预算即裁剪更早的）。
     * `usedTokens` 为系统提示等已占用预算。
     */
    fun <T : CropableMessage> cropHistory(
        messages: List<T>,
        usedTokens: Int,
        budgetBase: Int,
        model: String,
    ): CropResult<T> {
        val recent = mutableListOf<T>()
        var droppedStartTs = 0L
        var droppedEndTs = 0L
        var droppedTokens = 0
        var droppedEndIndex = -1
        var used = usedTokens

        for (i in messages.indices.reversed()) {
            val message = messages[i]
            val tokenCount = cropTokenCount(message, model)
            if (used + tokenCount > budgetBase) {
                val dropped = messages.subList(0, i + 1)
                droppedTokens = dropped.sumOf { ChatTokenCounter.estimateTokens(it.content, model) }
                droppedStartTs = dropped.firstOrNull()?.timestamp ?: 0L
                droppedEndTs = dropped.lastOrNull()?.timestamp ?: 0L
                droppedEndIndex = i
                break
            }
            recent.add(0, message)
            used += tokenCount
        }
        return CropResult(recent.toList(), droppedStartTs, droppedEndTs, droppedTokens, droppedEndIndex)
    }

    /** 可被深度注入的内容项。 */
    data class DepthInsertItem(
        val content: String,
        val depth: Int,
        val order: Int,
        /** 注入消息角色（ST at_depth 的 role）；null 用默认 system 侧。 */
        val role: String? = null,
    )

    /**
     * 按深度注入内容（at_depth 世界书 + 作者注释）。
     * depth 0 = 对话末尾（最新消息之后），n = 从末尾数 n 条之后；
     * 插入位置 `max(0, min(len, len - depth))`，同深度按 order 稳定排序，从后往前落位避免索引偏移。
     */
    fun <T> applyDepthInserts(
        history: List<T>,
        inserts: List<DepthInsertItem>,
        itemFactory: (content: String, role: String?) -> T,
    ): List<T> {
        if (inserts.isEmpty()) return history
        val result = history.toMutableList()
        val sorted = inserts.sortedWith(compareBy({ it.depth }, { it.order }))
        val insertMap = LinkedHashMap<Int, MutableList<DepthInsertItem>>()
        for (item in sorted) {
            val idx = max(0, min(result.size, result.size - item.depth))
            insertMap.getOrPut(idx) { mutableListOf() } += item
        }
        for (idx in insertMap.keys.sortedDescending()) {
            val items = insertMap.getValue(idx)
            result.addAll(idx, items.map { itemFactory(it.content, it.role) })
        }
        return result
    }
}

/**
 * 阶段 4 S4-01 第 4—5 层：序列化后最终输入审计（纯聚合，无 IO）
 * （对齐 `shared/chat-core/inputAudit.ts`）。
 *
 * 硬约束（§5.6）：计数精度只允许 `exact` / `provider-reported` / `estimated` 三档；
 * 超限时**不在此裁剪**，只报告 `overBudget` 与剩余重分配额度（最多一次）。
 */
object ChatInputAudit {

    val ROLE_ORDER = listOf("system", "user", "assistant", "tool")

    /** §5.6：审计超限时只允许回到 ContextAllocator 降级一次。 */
    const val MAX_INPUT_REALLOCATIONS = 1

    data class Part(
        val id: String,
        val role: String,
        val tokens: Int,
        val confidence: String = "estimated",
    )

    data class View(
        val provider: String,
        val model: String,
        val parts: List<Part>,
        val serialized: Boolean = false,
    )

    data class RoleStat(val role: String, val parts: Int, val tokens: Int)

    data class Audit(
        val inputTokens: Int,
        val reservedOutputTokens: Int,
        val protocolSafetyTokens: Int,
        val totalTokens: Int,
        val contextLimit: Int,
        val overBudget: Boolean,
        val remainingReallocations: Int,
        val accountingConfidence: String,
        val serializedViewMissing: Boolean,
        val byRole: List<RoleStat>,
    )

    /** 取最弱精度：只要有一处估算，整体就不能宣称精确。 */
    fun weakestAccountingConfidence(confidences: List<String>): String {
        if (confidences.any { it == "estimated" }) return "estimated"
        if (confidences.any { it == "provider-reported" }) return "provider-reported"
        return "exact"
    }

    private fun normalizePartTokens(value: Double): Int {
        if (!value.isFinite() || value <= 0) return 0
        return kotlin.math.ceil(value).toInt()
    }

    fun audit(
        view: View,
        reservedOutputTokens: Double,
        contextLimit: Double,
        protocolSafetyRatio: Double? = null,
    ): Audit {
        val reserved = normalizePartTokens(reservedOutputTokens)
        val limit = normalizePartTokens(contextLimit)
        val safetyRatio = protocolSafetyRatio
            ?.takeIf { it.isFinite() && it > 0 }
            ?: (1 - ChatContextShared.TOKEN_BUDGET_SAFETY)

        var inputTokens = 0
        val confidences = mutableListOf<String>()
        val byRoleMap = LinkedHashMap<String, RoleStat>()
        for (part in view.parts) {
            val tokens = normalizePartTokens(part.tokens.toDouble())
            inputTokens += tokens
            confidences += part.confidence
            val role = if (part.role in ROLE_ORDER) part.role else "system"
            val stat = byRoleMap[role] ?: RoleStat(role, 0, 0)
            byRoleMap[role] = stat.copy(parts = stat.parts + 1, tokens = stat.tokens + tokens)
        }

        val protocolSafetyTokens = kotlin.math.ceil(limit * safetyRatio).toInt()
        val totalTokens = inputTokens + reserved + protocolSafetyTokens
        return Audit(
            inputTokens = inputTokens,
            reservedOutputTokens = reserved,
            protocolSafetyTokens = protocolSafetyTokens,
            totalTokens = totalTokens,
            contextLimit = limit,
            overBudget = limit > 0 && totalTokens > limit,
            remainingReallocations = MAX_INPUT_REALLOCATIONS,
            accountingConfidence = if (view.parts.isEmpty()) "estimated" else weakestAccountingConfidence(confidences),
            serializedViewMissing = !view.serialized,
            byRole = byRoleMap.values.sortedBy { ROLE_ORDER.indexOf(it.role) },
        )
    }

    /** 数值化日志串（不含正文/提示词/URL）。 */
    fun formatSummary(audit: Audit): String = listOf(
        "input=${audit.inputTokens}",
        "reserved=${audit.reservedOutputTokens}",
        "safety=${audit.protocolSafetyTokens}",
        "total=${audit.totalTokens}/${audit.contextLimit}",
        "over=${if (audit.overBudget) 1 else 0}",
        "accounting=${audit.accountingConfidence}",
        "serialized=${if (audit.serializedViewMissing) 0 else 1}",
    ).joinToString(" ")
}
