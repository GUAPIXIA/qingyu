package com.qingyu.companion.data.send

import com.qingyu.companion.model.ServerInfo

/**
 * F-01：发送链路选择（纯函数，JVM 可测）。
 * 能力门控唯一权威：capabilities 含 task_events_v2 → v2 task 链路；否则完全走 v1 ai:*。
 * 同一 requestId 只允许走一条链路（判定在入队时完成，之后重试沿用同一链路，
 * 由 outbox 行上的 taskId/remoteUserMessageId 标识——双发禁止由此保证）。
 */
object SendPathSelector {

    enum class SendPath {
        /** v1：POST /api/v1/sessions/:id/messages + WS ai:* 事件 */
        LEGACY_V1,

        /** v2：POST /api/v2/sessions/:id/tasks + task 事件（WS task:* / REST events 补拉） */
        TASK_V2,
    }

    fun select(capabilities: Set<String>): SendPath =
        if (ServerInfo.CAP_TASK_EVENTS_V2 in capabilities) SendPath.TASK_V2 else SendPath.LEGACY_V1
}
