package com.qingyu.companion.chatcore

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * 阶段 4 S4-01 第 4 层：长记忆摘要窗口与输入预算
 * （对齐 `shared/chat-core/memoryWindow.ts`）。
 *
 * 关键语义（与 PC 一致，且都是「不能猜」的边界）：
 * - 单次摘要新增对话预算上限 6000，下限 128；真实可用 = 上下文 − 系统提示 − 预留输出 − 安全余量(≥128 或 5%)；
 * - 单条超长消息保留首尾 60%/40% 并在中间插入省略标记，避免请求永久失败；
 * - 窗口不按固定条数截断：新增消息从旧到新进入直到耗尽预算；
 *   **首条新增消息即使超预算也完整保留**（否则游标会被一条超长消息永久卡住），此时游标只推进到它本身；
 * - 重叠上下文（默认最近 2 条已总结消息）最多占 1/4 预算，过长旧消息直接略过。
 */
object ChatMemoryWindow {

    const val MEMORY_SUMMARY_INPUT_TOKEN_BUDGET = 6000
    const val MEMORY_SUMMARY_MIN_INPUT_TOKEN_BUDGET = 128
    const val MEMORY_SUMMARY_OVERLAP_COUNT = 2

    /** 供窗口构建使用的最小消息视图。 */
    interface WindowMessage {
        val id: String
        val content: String
    }

    data class Window<T : WindowMessage>(
        /** 游标之后的全部未总结消息。 */
        val pending: List<T>,
        /** 已总结、仅供语义衔接的最近消息。 */
        val overlap: List<T>,
        /** 本次实际发送给摘要模型的新增消息，始终是 pending 的前缀。 */
        val selected: List<T>,
        /** 本次可安全持久化的游标；只推进到 selected 末尾。 */
        val processedThroughMessageId: String?,
    )

    /** 模型上下文减去系统提示、预留输出与安全余量后，本次摘要真实可用的输入预算。 */
    fun resolveMemorySummaryInputBudget(
        maxContext: Double,
        systemPromptTokens: Double,
        reservedOutputTokens: Double,
    ): Int {
        val context = if (maxContext.isFinite() && maxContext > 0) floor(maxContext).toInt() else 8192
        val prompt = if (systemPromptTokens.isFinite()) max(0, floor(systemPromptTokens).toInt()) else 0
        val output = if (reservedOutputTokens.isFinite()) max(0, floor(reservedOutputTokens).toInt()) else 0
        val safety = max(128, floor(context * 0.05).toInt())
        return min(
            MEMORY_SUMMARY_INPUT_TOKEN_BUDGET,
            max(MEMORY_SUMMARY_MIN_INPUT_TOKEN_BUDGET, context - prompt - output - safety),
        )
    }

    const val OVERSIZED_MARKER = "\n…【消息过长，中间内容已省略】…\n"

    /**
     * 单条消息超预算时保留首尾并标记省略。
     * 与 PC 相同的二分：对「保留字符数」做单调二分，取满足预算的最大值。
     */
    fun fitOversizedMemoryMessage(
        text: String,
        tokenBudget: Int,
        estimateTokens: (String) -> Int,
    ): String {
        if (estimateTokens(text) <= tokenBudget) return text
        var low = 0
        var high = text.length
        var best = OVERSIZED_MARKER
        while (low <= high) {
            val retained = floor((low + high) / 2.0).toInt()
            val headLength = ceil(retained * 0.6).toInt()
            val tailLength = retained - headLength
            val tail = if (tailLength > 0) text.substring(text.length - tailLength) else ""
            val candidate = text.substring(0, headLength) + OVERSIZED_MARKER + tail
            if (estimateTokens(candidate) <= tokenBudget) {
                best = candidate
                low = retained + 1
            } else {
                high = retained - 1
            }
        }
        return best
    }

    data class Options(val tokenBudget: Int? = null, val overlapCount: Int? = null)

    /** 按游标构建摘要窗口。 */
    fun <T : WindowMessage> buildSummaryWindow(
        messages: List<T>,
        cursorId: String?,
        formatMessage: (T) -> String,
        estimateTokens: (String) -> Int,
        options: Options = Options(),
    ): Window<T> {
        val tokenBudget = max(1, floor(options.tokenBudget?.toDouble() ?: MEMORY_SUMMARY_INPUT_TOKEN_BUDGET.toDouble()).toInt())
        val overlapCount = max(0, floor(options.overlapCount?.toDouble() ?: MEMORY_SUMMARY_OVERLAP_COUNT.toDouble()).toInt())
        val cursorIndex = if (cursorId != null) messages.indexOfFirst { it.id == cursorId } else -1

        val pending = if (cursorIndex >= 0) messages.subList(cursorIndex + 1, messages.size).toList() else messages.toList()
        val rawOverlap = if (cursorIndex >= 0) {
            messages.subList(max(0, cursorIndex - overlapCount + 1), cursorIndex + 1).toList()
        } else {
            emptyList()
        }

        // 重叠上下文最多占 1/4 预算
        val overlapBudget = max(1, floor(tokenBudget * 0.25).toInt())
        val overlap = mutableListOf<T>()
        var overlapTokens = 0
        for (index in rawOverlap.indices.reversed()) {
            val message = rawOverlap[index]
            val tokens = max(1, estimateTokens(formatMessage(message)))
            if (overlapTokens + tokens > overlapBudget) continue
            overlap.add(0, message)
            overlapTokens += tokens
        }

        val selected = mutableListOf<T>()
        var usedTokens = overlapTokens
        for (message in pending) {
            val tokens = max(1, estimateTokens(formatMessage(message)))
            if (selected.isNotEmpty() && usedTokens + tokens > tokenBudget) break
            selected += message
            usedTokens += tokens
        }

        return Window(
            pending = pending,
            overlap = overlap.toList(),
            selected = selected.toList(),
            processedThroughMessageId = selected.lastOrNull()?.id,
        )
    }
}
