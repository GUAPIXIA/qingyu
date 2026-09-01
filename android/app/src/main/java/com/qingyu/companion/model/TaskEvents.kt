package com.qingyu.companion.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * F-01：PC Task v2 契约 DTO（对齐 shared/chat-core/events.ts + electron/bridge/taskRoutes.ts）。
 *
 * 契约来源（已逐字段核对 PC 实现）：
 * - POST /api/v2/sessions/:sessionId/tasks → 202 { task: { taskId, state, lastSequence }, userMessage: { id, requestId } }
 * - GET  /api/v2/tasks/:taskId             → { task: TaskSnapshot }
 * - GET  /api/v2/tasks/:taskId/events?afterSequence=&limit= → EventPage { events, nextAfterSequence, resyncRequired?, snapshot? }
 * - GET  /api/v2/sessions/:sessionId/tasks → { tasks: TaskSnapshot[] }
 * - POST /api/v2/tasks/:taskId/cancel      → { task: TaskSnapshot }
 * - POST /api/v2/tasks/:taskId/retry       → 202 { task: { taskId, state } }（快照子集，其余字段缺省）
 * - WS task:subscribe 载荷 { sessionIds: string[], cursors: Record<taskId, number> }（taskWsAdapter.handleTaskSubscribe）
 * - WS task:* 帧载荷 = TaskEventEnvelope（taskWsAdapter 定向转发 envelope 本体）
 *
 * 全字段带默认值：PC 侧字段演进/子集响应（如 retry 只回 taskId/state）均可解码；
 * 未知字段由 NetworkModule.json 的 ignoreUnknownKeys = true 容错。
 */

/** WS task:subscribe 出站帧载荷（cursors 以 taskId 为键，对齐 taskWsAdapter 的 Map<string, number>） */
@Serializable
data class TaskSubscribePayload(
    val sessionIds: List<String> = emptyList(),
    val cursors: Map<String, Long> = emptyMap(),
)

/** TaskEventEnvelope（shared/chat-core/events.ts §9.1-9.2） */
@Serializable
data class TaskEventEnvelopeDto(
    val protocolVersion: Int = 2,
    val eventId: String = "",
    val taskId: String = "",
    val requestId: String = "",
    val sessionId: String = "",
    val sequence: Long = 0,
    /** task:accepted/started/chunk/usage/approval_required/approval_resolved/completed/failed/cancelled/interrupted */
    val type: String = "",
    /** PC 侧 epoch millis */
    val timestamp: Long = 0,
    /** 各 type 专属载荷（chunk: {delta, accumulatedLength}; failed: {error}; cancelled: {partial}），原样保留 */
    val payload: JsonObject? = null,
) {
    /** chunk 类事件可合并丢失（F-03）；其余（done/checkpoint/task 生命周期）不得静默丢 */
    val isChunkLike: Boolean get() = type == TaskEventType.CHUNK

    /** payload.delta（task:chunk 增量文本） */
    val chunkDelta: String?
        get() = (payload?.get("delta") as? kotlinx.serialization.json.JsonPrimitive)?.content

    /** payload.error.message（task:failed/interrupted） */
    val errorMessage: String?
        get() = ((payload?.get("error") as? JsonObject)?.get("message") as? kotlinx.serialization.json.JsonPrimitive)?.content

    /** payload.partial（task:cancelled 的已生成部分文本） */
    val partialText: String?
        get() = (payload?.get("partial") as? kotlinx.serialization.json.JsonPrimitive)?.content
}

/** task:* 事件类型名（与 PC TaskEventType 一一对应；PC 不存在 task:done/task:error，终态为 completed/failed/cancelled/interrupted） */
object TaskEventType {
    const val ACCEPTED = "task:accepted"
    const val STARTED = "task:started"
    const val CHUNK = "task:chunk"
    const val USAGE = "task:usage"
    const val COMPLETED = "task:completed"
    const val FAILED = "task:failed"
    const val CANCELLED = "task:cancelled"
    const val INTERRUPTED = "task:interrupted"
}

/** POST /api/v2/sessions/:sessionId/tasks 请求体 */
@Serializable
data class CreateTaskRequest(
    val type: String = "send",
    /** 空则 PC 回退为会话所属角色（taskRoutes.ts） */
    val characterId: String? = null,
    val content: String = "",
    /** base64 图片数组（与 v1 SendMessageRequest.images 同语义） */
    val images: List<String> = emptyList(),
    val replyToId: String? = null,
    /** 冗余幂等键：PC 优先取 Idempotency-Key header，其次 body.requestId */
    val requestId: String? = null,
)

/** 202 响应中的 task 引用（taskRoutes.ts：{ taskId, state, lastSequence }） */
@Serializable
data class TaskRefDto(
    val taskId: String = "",
    val state: String = "",
    val lastSequence: Long = 0,
)

/** 202 响应中的用户消息回执（已落盘或幂等命中既有消息） */
@Serializable
data class TaskUserMessageDto(
    val id: String? = null,
    val requestId: String? = null,
)

@Serializable
data class CreateTaskResponse(
    val task: TaskRefDto = TaskRefDto(),
    val userMessage: TaskUserMessageDto? = null,
)

/** TaskSnapshot（shared/chat-core/events.ts §8.2；字段全部默认值以容忍子集响应） */
@Serializable
data class TaskSnapshotDto(
    val schemaVersion: Int = 1,
    val taskId: String = "",
    val requestId: String = "",
    val type: String = "",
    /** queued/preparing/streaming/waiting_approval/finalizing/completed/failed/cancelled/interrupted */
    val state: String = "",
    val sessionId: String = "",
    val characterId: String = "",
    val userMessageId: String? = null,
    val assistantMessageId: String? = null,
    val retryOfTaskId: String? = null,
    val accumulatedText: String = "",
    val lastSequence: Long = 0,
    val usage: TaskUsageDto? = null,
    val error: TaskErrorDto? = null,
    val createdAt: Long = 0,
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
    val updatedAt: Long = 0,
) {
    val isTerminal: Boolean
        get() = state == "completed" || state == "failed" || state == "cancelled" || state == "interrupted"
}

@Serializable
data class TaskUsageDto(
    val promptTokens: Int = 0,
    val completionTokens: Int = 0,
    val totalTokens: Int = 0,
)

/** DomainError 精简投影（shared/chat-core/errors.ts：code/message/retryable/safeDetails） */
@Serializable
data class TaskErrorDto(
    val code: String? = null,
    val message: String? = null,
    val retryable: Boolean? = null,
)

/** { task: TaskSnapshot } 信封（GET /api/v2/tasks/:taskId、cancel） */
@Serializable
data class TaskSnapshotEnvelopeDto(
    val task: TaskSnapshotDto = TaskSnapshotDto(),
)

/** { tasks: TaskSnapshot[] } 信封（GET /api/v2/sessions/:sessionId/tasks） */
@Serializable
data class TaskListEnvelopeDto(
    val tasks: List<TaskSnapshotDto> = emptyList(),
)

/** EventPage（GET /api/v2/tasks/:taskId/events?afterSequence=，§9 EventPage） */
@Serializable
data class TaskEventPageDto(
    val events: List<TaskEventEnvelopeDto> = emptyList(),
    /** null = 本页到头 */
    val nextAfterSequence: Long? = null,
    /** true = afterSequence 已被压缩/缺失，需以 snapshot 兜底重建 */
    val resyncRequired: Boolean = false,
    val snapshot: TaskSnapshotDto? = null,
)
