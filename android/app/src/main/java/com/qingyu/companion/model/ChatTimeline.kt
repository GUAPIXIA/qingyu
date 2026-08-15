package com.qingyu.companion.model

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 聊天时间线（纯函数，便于 JVM 单测）。
 * 消息列表按时间降序（最新在前）；渲染时按自然日插入日期分隔头。
 * 与 LazyColumn(reverseLayout=true) 配合：返回的 item 列表为"底->上"顺序。
 */

/** 本地未落盘消息（发送中/失败，重试复用幂等键 requestId） */
data class PendingMessage(
    /** 幂等键：与 sendMessage 的 requestId 一致，重试复用（PC 侧去重） */
    val requestId: String,
    val content: String,
    val timestamp: Long,
    /** true = 发送失败（点击重试）；false = 发送中 */
    val failed: Boolean,
    /** 本地待发送图片（base64，展示用） */
    val images: List<String> = emptyList(),
)

/** 时间线条目 */
sealed interface TimelineItem {
    /** 日期分隔头（如 "08-14"） */
    data class DateHeader(val label: String) : TimelineItem

    /** 已落盘消息 */
    data class Entry(val message: Message) : TimelineItem

    /** 本地待发送/失败消息 */
    data class PendingEntry(val pending: PendingMessage) : TimelineItem
}

private val dateKeyFormat = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())

/** 日期分组键（同一天相同），供 buildTimeline 与测试注入 */
fun dateKeyOf(timestamp: Long): String = dateKeyFormat.format(Date(timestamp))

/**
 * 构建时间线条目。
 * @param messages 已落盘消息（降序，最新在前）
 * @param pending 本地待发送消息（降序，最新在前）
 * @param dateOf 时间戳 -> 日期分组键（测试可注入固定实现）
 * @return 底->上顺序的条目列表（配合 reverseLayout=true）
 */
fun buildTimeline(
    messages: List<Message>,
    pending: List<PendingMessage> = emptyList(),
    dateOf: (Long) -> String = ::dateKeyOf,
    labelOf: (String) -> String = ::formatDateLabel,
): List<TimelineItem> {
    if (messages.isEmpty() && pending.isEmpty()) return emptyList()

    // 合并为带时间的条目，按时间降序（最新在前）
    val merged: List<Pair<Long, TimelineItem>> =
        messages.map { it.timestamp to TimelineItem.Entry(it) } +
            pending.map { it.timestamp to TimelineItem.PendingEntry(it) }
    val sorted = merged.sortedByDescending { it.first }.map { it.second }

    // 从最新到最旧遍历：日期变化处插入该组 header（组头位于组内最新消息上方），
    // 构建出“上->下”显示顺序；最后整体反转为底->上（配合 reverseLayout）
    val display = mutableListOf<TimelineItem>()
    var prevKey: String? = null
    for (item in sorted) {
        val key = when (item) {
            is TimelineItem.Entry -> dateOf(item.message.timestamp)
            is TimelineItem.PendingEntry -> dateOf(item.pending.timestamp)
            is TimelineItem.DateHeader -> continue
        }
        if (key != prevKey) {
            display += TimelineItem.DateHeader(labelOf(key))
            prevKey = key
        }
        display += item
    }
    return display.asReversed()
}

/** 日期头显示文案：当天 -> "今天"，昨天 -> "昨天"，跨年 -> "yyyy-MM-dd"，否则 -> "MM-dd" */
fun formatDateLabel(key: String): String {
    val today = dateKeyOf(System.currentTimeMillis())
    val yesterday = dateKeyOf(System.currentTimeMillis() - 24 * 60 * 60 * 1000)
    val thisYear = today.substring(0, 4)
    return when (key) {
        today -> "今天"
        yesterday -> "昨天"
        else -> if (key.substring(0, 4) != thisYear) key else key.substring(5)
    }
}
