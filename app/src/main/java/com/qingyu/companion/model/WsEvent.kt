package com.qingyu.companion.model

import kotlinx.serialization.Serializable

/**
 * WebSocket 事件（方案 §4.3）。
 * 事件名一对一映射现有 IPC 事件（shared/ipc-channels.ts）：
 * ai:chunk / ai:done / ai:error，外加 session:updated 与 connection:heartbeat。
 */

/** WS 帧统一信封：{ event, payload } */
@Serializable
data class WsEnvelope(
    val event: String,
    /** 原始 JSON，按 event 类型二次解析 */
    val payload: kotlinx.serialization.json.JsonObject? = null,
)

object WsEvents {
    const val AI_CHUNK = "ai:chunk"
    const val AI_DONE = "ai:done"
    const val AI_ERROR = "ai:error"
    /** 生成完成时的 token 用量（对齐 PC 侧 ai:usage 事件） */
    const val AI_USAGE = "ai:usage"
    /** 客户端 -> 服务端：停止当前生成（映射 PC 侧 abort） */
    const val AI_STOP = "ai:stop"
    const val SESSION_UPDATED = "session:updated"
    const val CONNECTION_HEARTBEAT = "connection:heartbeat"
}

/** ai:chunk 载荷：流式 token（单聊/群聊共用） */
@Serializable
data class AiChunkPayload(
    val requestId: String,
    val sessionId: String,
    /** 增量文本片段 */
    val delta: String,
)

/** ai:done 载荷 */
@Serializable
data class AiDonePayload(
    val requestId: String,
    val sessionId: String,
    /** 完整消息（含落盘后的 id） */
    val message: Message,
)

/** ai:error 载荷（错误消息已经 PC 侧 sanitizeApiKey 脱敏） */
@Serializable
data class AiErrorPayload(
    val requestId: String,
    val sessionId: String,
    val message: String,
)

/** ai:usage 载荷：token 用量（对齐 PC 侧 electron/services/ai.ts 的 ai:usage 事件） */
@Serializable
data class AiUsagePayload(
    val requestId: String,
    val promptTokens: Int,
    val completionTokens: Int,
    val totalTokens: Int,
)

/** session:updated 载荷：标题/删除/新消息等会话变更 */
@Serializable
data class SessionUpdatedPayload(
    val sessionId: String,
    /** created / message / title / deleted */
    val change: String,
)
