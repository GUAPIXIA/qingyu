package com.qingyu.companion.model

/**
 * WS 事件在应用内的领域表示（从 [WsEnvelope] 解析后分发）。
 * 与 model/WsEvent.kt 的 payload DTO 一一对应，这里以 sealed interface
 * 形式便于 UI 层 when 穷举处理。
 */
sealed interface CompanionEvent {

    /** ai:chunk —— 流式 token 增量 */
    data class Chunk(
        val requestId: String,
        val sessionId: String,
        val delta: String,
    ) : CompanionEvent

    /** ai:done —— 生成完成，携带落盘后的完整消息 */
    data class Done(
        val requestId: String,
        val sessionId: String,
        val message: Message,
    ) : CompanionEvent

    /** ai:error —— 生成失败（错误消息已经 PC 侧脱敏） */
    data class Error(
        val requestId: String,
        val sessionId: String,
        val message: String,
    ) : CompanionEvent

    /** ai:usage —— 生成完成的 token 用量（对齐 PC 侧 ai:usage，桥接层映射后转发） */
    data class Usage(
        val requestId: String,
        val promptTokens: Int,
        val completionTokens: Int,
        val totalTokens: Int,
    ) : CompanionEvent

    /** session:updated —— 会话标题/删除/新消息等变更 */
    data class SessionUpdated(
        val sessionId: String,
        val change: String,
    ) : CompanionEvent
}
