package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-03：统一异常终止收口
 * （对齐 `shared/generationTermination.ts`）。
 *
 * 职责：
 * - 应用层终止原因与供应商 finishReason 映射，两者互不覆盖；
 * - 终止行为矩阵的用户提示文案（提示只进 generationNotice/generationError，**绝不拼入正文**）；
 * - `requestId + terminalState` 一次性终止闸门：只有 streaming 能进入终止分支，
 *   进入 finalizing 后忽略迟到 chunk/done/error，保证同一 requestId 最多落盘一次。
 */
object ChatGenerationTermination {

    /** 终止状态机的合法状态（对齐 PC `GenerationTerminalState`）。 */
    val TERMINAL_STATES = listOf("streaming", "finalizing", "persisted", "cancelled", "failed")

    /**
     * 观测口径的终止原因推导（只记录枚举，不记录正文）。
     * 输入为观测层结局分类，主进程与渲染层共用，保证 terminationCause 单一口径。
     */
    fun observationTerminationCause(
        outcome: String,
        finishReason: String?,
        errorKind: String? = null,
        cancelReason: String? = null,
    ): String {
        if (outcome == "user_cancelled" || errorKind == "aborted") {
            return if (cancelReason == "timeout") "idle_timeout" else "user_cancel"
        }
        if (errorKind == "timeout") return "idle_timeout"
        if (errorKind == "network" || finishReason == "network_error") return "transport_error"
        if (errorKind == "content_filter" || finishReason == "content_filter") return "provider_content_filter"
        // 推理挤占是独立终局（旧文本判定路径收编为结构化原因）
        if (errorKind == "reasoning_budget_exhausted") return "reasoning_gate_exceeded"
        if (outcome == "truncated" || errorKind == "length_limit" || finishReason == "length") return "provider_length"
        return terminationCauseFromFinishReason(finishReason)
    }

    /** 供应商 finishReason → 应用层终止原因（正常完成事件口径）。 */
    fun terminationCauseFromFinishReason(reason: String?): String = when (reason) {
        "stop" -> "provider_stop"
        "length" -> "provider_length"
        "content_filter" -> "provider_content_filter"
        "tool_calls" -> "provider_tool_calls"
        "cancelled" -> "user_cancel"
        // 主进程把传输失败归类为 network_error；应用层同名映射
        "network_error" -> "transport_error"
        else -> "unknown"
    }

    /** 终止原因 → 传给收尾管线的有效 finishReason（收尾器按供应商口径判断）。 */
    fun effectiveFinishReasonForCause(cause: String, providerFinishReason: String?): String = when (cause) {
        "transport_error", "idle_timeout", "protocol_error" -> "network_error"
        "provider_stop" -> "stop"
        // 提前中止是零正文的 length 类截断，收尾器按 length 处理
        "provider_length", "reasoning_gate_exceeded" -> "length"
        "provider_content_filter" -> "content_filter"
        "provider_tool_calls" -> "tool_calls"
        "user_cancel" -> "cancelled"
        else -> providerFinishReason ?: "unknown"
    }

    data class Prompt(val field: String, val text: String)

    /** 终止原因 → 有可用部分正文时的用户提示。 */
    fun terminationPromptWithContent(cause: String): Prompt? = when (cause) {
        "transport_error" -> Prompt("generationError", "生成中断，已保留完整部分")
        "idle_timeout" -> Prompt("generationError", "请求超时，已保留完整部分")
        "protocol_error" -> Prompt("generationError", "响应格式异常，已保留完整部分")
        "user_cancel" -> Prompt("generationNotice", "已停止生成")
        else -> null
    }

    /** 终止原因 → 无可用正文时写入 error 的基础提示（附重试入口由界面层负责）。 */
    fun terminationPromptWithoutContent(cause: String, errorMessage: String? = null): String {
        val trimmed = errorMessage?.trim()
        if (!trimmed.isNullOrEmpty()) return trimmed
        return when (cause) {
            "transport_error" -> "生成中断，请重试"
            "idle_timeout" -> "请求超时，请重试"
            "protocol_error" -> "响应格式异常，请重试"
            "provider_content_filter" -> "回复被内容审核拦截"
            "user_cancel" -> "已停止生成"
            "reasoning_gate_exceeded" -> "该模型推理占满输出预算，请重试或更换模型"
            else -> "模型未返回可用内容，请重试"
        }
    }

    /**
     * 内容审核拦截时是否保留部分正文。
     * 本产品口径：审核拦截视为整条回复不可信，不保存正文，只给明确审核提示。
     */
    fun contentFilterPreservesBody(): Boolean = false

    /**
     * 终止协调的一次性闸门（§4.3 状态机的最小实现）。
     *
     * 语义：
     * - 初始 `streaming`；`claim` 仅在 streaming 时成功，`user_cancel` → `cancelled`，其余 → `finalizing`；
     * - `markPersisted` 仅从 `finalizing`/`cancelled` 进入 `persisted`（其它状态无效）；
     * - `acceptsStreamEvent` 仅 streaming 为 true（迟到 chunk/done/error 一律忽略）。
     */
    class Latch(val requestId: String) {
        var state: String = "streaming"
            private set

        /** 已抢占的终止原因（诊断与观测用）。 */
        var claimedCause: String? = null
            private set

        /** 抢占终止权：仅 streaming 能进入某个终止分支；迟到事件返回 false。 */
        fun claim(cause: String): Boolean {
            if (state != "streaming") return false
            claimedCause = cause
            state = if (cause == "user_cancel") "cancelled" else "finalizing"
            return true
        }

        /** 落盘完成，同一 requestId 不得再次保存。 */
        fun markPersisted() {
            if (state == "finalizing" || state == "cancelled") state = "persisted"
        }

        /** 是否仍可接收流式事件（chunk 累加只在 streaming 状态进行）。 */
        fun acceptsStreamEvent(): Boolean = state == "streaming"

        override fun toString(): String = "Latch(requestId=$requestId, state=$state)"
    }

    fun createLatch(requestId: String): Latch = Latch(requestId)
}
