package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-03：GenerationTask 状态机。
 *
 * 状态固定为（阶段 4 实施文档 §2 S4-03）：
 * ```
 * queued -> preparing -> streaming -> finalizing -> completed
 *                                   -> cancelled
 *                                   -> failed(retryable / non_retryable)
 * ```
 *
 * 设计约束（与阶段文档逐条对应）：
 * 1. **taskId / requestId 在重试语义上分离**：同一次网络重试保持 requestId；
 *    逻辑级重试（失败后用户再点重试）保留 taskId、生成新 requestId。
 * 2. **草稿 chunk 写入节流缓存**，完成时一次性生成 final message：
 *    [appendChunk] 只累加到内存缓冲，[takeFinalMessage] 才把它变成可落盘正文。
 * 3. **进程死亡后未完成任务标记 interrupted，不自动重发**（以免重复计费）：
 *    [recover] 把非终态任务落到 `failed` + `TASK_INTERRUPTED`，且 `retryable = false`。
 * 4. 终止原因与提示文案复用 [ChatGenerationTermination]（与 PC `generationTermination.ts` 同口径），
 *    本状态机不另立第二套分类。
 * 5. 状态迁移是**一次性**的：终态不可再迁移；active 状态不可"回退"到 queued/preparing。
 */
object ChatGenerationTask {

    /** 状态枚举（字面量与阶段文档一致）。 */
    val STATES = listOf(
        "queued",
        "preparing",
        "streaming",
        "finalizing",
        "completed",
        "cancelled",
        "failed",
    )

    /** 终态：进入后不可再迁移。 */
    val TERMINAL_STATES = setOf("completed", "cancelled", "failed")

    /**
     * active（非终态）状态。
     * `interrupted` 不是状态而是 [Snapshot.failureCode]，避免与阶段文档的固定状态集冲突。
     */
    val ACTIVE_STATES = setOf("queued", "preparing", "streaming", "finalizing")

    /** 进程死亡恢复时写入的失败码（不自动重发）。 */
    const val CODE_INTERRUPTED = "TASK_INTERRUPTED"

    /** 生成正文落盘的唯一形态。 */
    data class FinalMessage(
        val taskId: String,
        val requestId: String,
        val content: String,
        /** 终止原因（[ChatGenerationTermination] 口径） */
        val terminationCause: String,
        /** 提示字段：generationNotice / generationError（不拼入 content） */
        val noticeField: String? = null,
        val noticeText: String? = null,
        /** 是否允许落盘；审核拦截与空正文为 false */
        val persistable: Boolean = true,
        val usage: Map<String, Int> = emptyMap(),
    )

    /** 任务快照（不可变；每次迁移产出新实例，便于观测与测试）。 */
    data class Snapshot(
        /** 逻辑任务标识：跨重试保持不变（用于关联会话消息） */
        val taskId: String,
        /** 单次请求标识：网络重试保持不变；逻辑级重试换新值 */
        val requestId: String,
        val status: String,
        /** 供应商 finishReason（最近一次） */
        val finishReason: String? = null,
        /** 终止原因（终态时非空） */
        val terminationCause: String? = null,
        /** 失败码（failed 时非空，如 TASK_INTERRUPTED / HTTP_429） */
        val failureCode: String? = null,
        /** 失败是否可重试（由 [ChatDomainErrors] 口径决定） */
        val retryable: Boolean = false,
        /** 提示字段与文案（不拼入正文） */
        val noticeField: String? = null,
        val noticeText: String? = null,
        /** 是否允许把正文落盘 */
        val persistable: Boolean = false,
        /** 是否已被抢占终止（迟到 chunk 一律忽略） */
        val terminationClaimed: Boolean = false,
        val streamedChars: Int = 0,
        val usage: Map<String, Int> = emptyMap(),
    ) {
        val isTerminal: Boolean get() = status in TERMINAL_STATES
        val isActive: Boolean get() = status in ACTIVE_STATES
    }

    /**
     * 生成任务状态机（单实例对应一个 taskId）。
     *
     * 非线程安全：调用方（生成任务持有者）负责串行化事件。
     */
    class Machine(
        val taskId: String,
        /** requestId 生成器：生产传入真实随机/ULID 生成器，测试传入确定性序列 */
        requestIdFactory: (String) -> String = { "$it#${System.nanoTime()}" },
    ) {
        private val newRequestId = requestIdFactory

        private var status: String = "queued"
        private var currentRequestId: String = newRequestId(taskId)
        private var finishReason: String? = null
        private var terminationCause: String? = null
        private var failureCodeValue: String? = null
        /** 注意：与构造函数参数不同名，避免在实例方法里被解析为 val 形参 */
        private var failureRetryable: Boolean = false
        private var noticeField: String? = null
        private var noticeText: String? = null
        private var persistable: Boolean = false
        private var terminationClaimed: Boolean = false
        private var streamedChars: Int = 0
        private var usage: Map<String, Int> = emptyMap()

        /** 流式草稿（节流缓存）：只在 [appendChunk] 累加，终态时才物化为最终正文。 */
        private val draft = StringBuilder()

        val requestId: String get() = currentRequestId

        fun snapshot(): Snapshot = Snapshot(
            taskId = taskId,
            requestId = currentRequestId,
            status = status,
            finishReason = finishReason,
            terminationCause = terminationCause,
            failureCode = failureCodeValue,
            retryable = failureRetryable,
            noticeField = noticeField,
            noticeText = noticeText,
            persistable = persistable,
            terminationClaimed = terminationClaimed,
            streamedChars = streamedChars,
            usage = usage,
        )

        /** 当前是否接受流式 chunk（仅 streaming 且未被抢占）。 */
        fun acceptsStreamEvent(): Boolean = status == "streaming" && !terminationClaimed

        /** 当前草稿（仅观测/诊断用；落盘走 [takeFinalMessage]）。 */
        fun draftText(): String = draft.toString()

        // ------------------------------------------------------------ 迁移

        /** queued -> preparing。仅在 queued 有效。 */
        fun prepare(): Boolean {
            if (status != "queued") return false
            status = "preparing"
            return true
        }

        /**
         * preparing -> streaming。
         * 若上下文/参数未就绪，调用方用 [fail] 结束。
         */
        fun startStreaming(): Boolean {
            if (status != "preparing") return false
            status = "streaming"
            return true
        }

        /** 累加流式 chunk；仅 streaming 且未抢占时生效。返回是否被接受。 */
        fun appendChunk(text: String): Boolean {
            if (!acceptsStreamEvent()) return false
            draft.append(text)
            streamedChars = draft.length
            return true
        }

        /** 记录本轮流式用量（供应商回报）。 */
        fun recordUsage(promptTokens: Int, completionTokens: Int) {
            usage = mapOf("promptTokens" to promptTokens, "completionTokens" to completionTokens)
        }

        // ------------------------------------------------------------ 终止

        /**
         * 正常完成路径：preparing/streaming -> finalizing。
         * 进入 finalizing 后迟到 chunk 被忽略（一次性闸门）。
         */
        fun beginFinalizing(reason: String): Boolean {
            if (status != "streaming" && status != "preparing") return false
            if (terminationClaimed) return false
            terminationClaimed = true
            finishReason = reason
            status = "finalizing"
            return true
        }

        /**
         * 失败/取消路径：active -> cancelled | failed。
         *
         * 提示与可重试性由 [ChatGenerationTermination] + [ChatDomainErrors] 口径决定，
         * 不在此另立分类。
         */
        fun terminate(cause: String, errorMessage: String? = null, failureCode: String? = null): Boolean {
            if (!isActive()) return false
            if (terminationClaimed && status == "finalizing") return false
            terminationClaimed = true
            terminationCause = cause

            if (cause == "user_cancel") {
                status = "cancelled"
                persistable = draft.isNotEmpty()
                terminationPromptWithContent(cause)?.let {
                    noticeField = it.field
                    noticeText = it.text
                }
                return true
            }

            status = "failed"
            failureCodeValue = failureCode ?: failureCodeForCause(cause)
            failureRetryable = ChatDomainErrors.createDomainError(failureCodeValue!!, "").retryable
            // 审核拦截整条不可信：不保留正文；其余情况保留已看到的部分正文
            persistable = draft.isNotEmpty() && ChatGenerationTermination.contentFilterPreservesBody()
            noticeField = "generationError"
            noticeText = ChatGenerationTermination.terminationPromptWithoutContent(cause, errorMessage)
            return true
        }

        /**
         * finalizing/cancelled -> completed。
         * 只有 [ChatGenerationTermination.contentFilterPreservesBody] 为 true 或存在正文时才允许落盘。
         */
        fun markCompleted(): Boolean {
            if (status != "finalizing" && status != "cancelled") return false
            status = "completed"
            persistable = draft.isNotEmpty()
            return true
        }

        /**
         * 逻辑级重试：保留 taskId，生成**新** requestId，回到 `queued`。
         *
         * 只允许在 `failed` 且 `retryable` 时调用；`TASK_INTERRUPTED` 不可重试
         * （阶段 4 §S4-03：进程死亡后不自动重发，必须由用户显式发起）。
         * 重试会清空草稿与上一轮失败信息。
         */
        fun retry(): Boolean {
            if (status != "failed" || !failureRetryable) return false
            currentRequestId = newRequestId(taskId)
            status = "queued"
            finishReason = null
            terminationCause = null
            failureCodeValue = null
            failureRetryable = false
            noticeField = null
            noticeText = null
            persistable = false
            terminationClaimed = false
            streamedChars = 0
            usage = emptyMap()
            draft.setLength(0)
            return true
        }

        /** 供调用方（如生成任务持有者）在需要时清空草稿（例如 finalizing 后落盘完成）。 */
        fun clearDraft() {
            draft.setLength(0)
            streamedChars = 0
        }

        /**
         * 生成正文落盘的唯一出口：`completed` 或 `cancelled`（有正文）时返回最终消息。
         *
         * `cancelled` 且无正文、`failed` 时返回 null（不创建空消息）。
         */
        fun takeFinalMessage(): FinalMessage? {
            if (status != "completed" && status != "cancelled") return null
            if (draft.isEmpty() || !persistable) return null
            return FinalMessage(
                taskId = taskId,
                requestId = currentRequestId,
                content = draft.toString(),
                terminationCause = terminationCause ?: if (status == "completed") "provider_stop" else "user_cancel",
                noticeField = noticeField,
                noticeText = noticeText,
                persistable = persistable,
                usage = usage,
            )
        }

        /**
         * 进程死亡恢复：非终态任务落到 `failed` + `TASK_INTERRUPTED`，**不自动重发**。
         *
         * 返回 false 表示任务已是终态（无需恢复）。恢复后草稿丢弃——进程已死，
         * 内存中的半截正文不可信；`persistable = false` 保证不会写出残缺消息。
         */
        fun recover(): Boolean {
            if (isTerminal()) return false
            draft.setLength(0)
            streamedChars = 0
            terminationClaimed = true
            terminationCause = "unknown"
            status = "failed"
            failureCodeValue = CODE_INTERRUPTED
            // TASK_INTERRUPTED 不在可重试集合：避免进程恢复后自动重发造成重复计费
            failureRetryable = false
            persistable = false
            noticeField = "generationError"
            noticeText = ChatGenerationTermination.terminationPromptWithoutContent("unknown")
            return true
        }

        private fun isActive(): Boolean = status in ACTIVE_STATES

        private fun isTerminal(): Boolean = status in TERMINAL_STATES

        private fun terminationPromptWithContent(cause: String) = ChatGenerationTermination.terminationPromptWithContent(cause)

        /**
         * 终止原因 → 域错误码（[ChatDomainErrors.CODES] 口径）。
         * 未知原因归入 `UNKNOWN`；可重试性随后由域错误表统一决定，不在此另判。
         */
        private fun failureCodeForCause(cause: String): String = when (cause) {
            "idle_timeout" -> "PROVIDER_TIMEOUT"
            "transport_error" -> "PROVIDER_UNAVAILABLE"
            "protocol_error" -> "INVALID_MODEL_RESPONSE"
            "provider_content_filter" -> "INVALID_MODEL_RESPONSE"
            "reasoning_gate_exceeded" -> "CONTEXT_TOO_LARGE"
            "provider_length" -> "INVALID_MODEL_RESPONSE"
            else -> "UNKNOWN"
        }
    }

    fun createMachine(taskId: String, requestIdFactory: (String) -> String = { "$it#0" }): Machine =
        Machine(taskId, requestIdFactory)
}
