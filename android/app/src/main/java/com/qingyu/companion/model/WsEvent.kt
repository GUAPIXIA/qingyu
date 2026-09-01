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

/** Relay v1 outer frame; bridge events are unwrapped back into [WsEnvelope]. */
@Serializable
data class RelayWsFrame(
    val v: Int,
    val type: String,
    val id: String? = null,
    val replyTo: String? = null,
    val sentAt: Long,
    val payload: kotlinx.serialization.json.JsonObject? = null,
)

@Serializable
data class RelayBridgeEventPayload(
    val eventSeq: Long,
    val event: String,
    val data: kotlinx.serialization.json.JsonObject? = null,
    val targetDeviceId: String? = null,
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
    /** 设置同步 v2（方案 §7 C-04）：PC/其他端设置变更后服务端广播，携带新 revision */
    const val SETTINGS_UPDATED = "settings:updated"
    const val RELAY_COMMAND_COMPLETED = "command:completed"
    const val RELAY_COMMAND_EXPIRED = "command:expired"
    /** F-01：客户端 -> 服务端 task v2 订阅（taskWsAdapter.handleTaskSubscribe） */
    const val TASK_SUBSCRIBE = "task:subscribe"
    /** F-01：task v2 事件帧前缀（task:chunk/task:completed/… 载荷为 TaskEventEnvelope） */
    const val TASK_EVENT_PREFIX = "task:"
    const val CONNECTION_HEARTBEAT = "connection:heartbeat"
    /** 客户端 -> 服务端：心跳响应（收到 heartbeat 后立即回复，防服务端 pong 超时误断） */
    const val CONNECTION_PONG = "connection:pong"
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

/**
 * session:updated 载荷：标题/删除/新消息等会话变更。
 * F-01 v1 兼容（2026-08 核对）：PC 侧 broadcastSessionChange 仅发送 { sessionId, change }，
 * 【未携带】revision/变更时间戳 —— Android 无法据帧内信息检测跳变补拉，暂以
 * "message" 变更触发整页 loadLatest 兜底。待 PC 侧补充 revision 后（届时 JSON 会多出
 * 该字段，默认 null 可直接解码），再启用 revision 对比跳变检测（见 WsClientImpl TODO）。
 */
@Serializable
data class SessionUpdatedPayload(
    val sessionId: String,
    /** created / message / title / deleted */
    val change: String,
    /** 预留：PC 侧会话 revision（当前 PC 不发送，恒 null） */
    val revision: String? = null,
)

/** settings:updated 载荷（方案 §7 C-04）：revision 为不透明字符串，客户端仅做等值去重 */
@Serializable
data class SettingsUpdatedPayload(
    val revision: String = "",
    val changedFields: List<String> = emptyList(),
    val sourceDeviceId: String? = null,
)

/** Relay 离线消息队列完成回执；resultBody 仅在形状匹配时解析为正式消息。 */
@Serializable
data class RelayCommandCompletedPayload(
    val commandId: String,
    val resultStatus: Int,
    val resultBody: Message? = null,
)

@Serializable
data class RelayCommandExpiredPayload(val commandId: String)
