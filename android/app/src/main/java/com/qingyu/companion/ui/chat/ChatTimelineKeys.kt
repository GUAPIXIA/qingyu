package com.qingyu.companion.ui.chat

import com.qingyu.companion.model.TimelineItem

/**
 * 聊天时间线的 LazyColumn 稳定 key。
 *
 * 为什么单独成文件并单独测试：**流式草稿不导致整表重组**靠两件事共同保证——
 * 1) 生成中的草稿是**独立 item**（不参与消息列表）；
 * 2) 消息条目的 key 稳定且与内容无关（用 id，而不是下标）。
 *
 * 一旦 key 退化成下标：新消息插入到中间时，其后所有条目的 key 都会平移，
 * Compose 会把它们当作「不同的条目」重建，用户看到的就是整表闪动 + 滚动位置跳动。
 * 这类回归在编译期与常规门禁上都不会报错，因此把 key 计算提成纯函数并锁定。
 */
object ChatTimelineKeys {

    /** 生成中草稿的独立 item key：必须与任何消息 key 都不同。 */
    const val STREAMING_DRAFT = "streaming"

    /** 时间线条目 → 稳定 key。 */
    fun of(item: TimelineItem): String = when (item) {
        is TimelineItem.DateHeader -> "date:${item.label}"
        // 带 sessionId 前缀：同一对话框内分叉/切换会话时 id 可能重复，仅用 message.id 会撞 key
        is TimelineItem.Entry -> "${item.message.sessionId}:${item.message.id}"
        is TimelineItem.PendingEntry -> "pending:${item.pending.requestId}"
    }
}
