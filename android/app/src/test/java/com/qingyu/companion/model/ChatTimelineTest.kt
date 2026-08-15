package com.qingyu.companion.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * buildTimeline 单测：日期分组、pending 合并、底->上顺序约定。
 * 返回列表为底->上顺序（配合 LazyColumn reverseLayout=true）。
 */
class ChatTimelineTest {

    /** 固定基准：day 1 = 2026-08-01（注入 dateOf/labelOf，不依赖系统时区与时钟） */
    private val baseTs = 1785513600000L

    private fun msg(id: String, ts: Long) = Message(
        id = id,
        sessionId = "s1",
        characterId = "c1",
        role = Role.assistant,
        content = id,
        timestamp = ts,
    )

    private fun ts(day: Int, hour: Int): Long =
        baseTs + (day - 1) * 86_400_000L + hour * 3_600_000L

    /** 注入的日期键实现（测试稳定） */
    private fun dayOf(ts: Long): String {
        val day = ((ts - baseTs) / 86_400_000L).toInt() + 1
        return "2026-08-${"%02d".format(day)}"
    }

    private fun labelOf(key: String): String = key.substring(5) // "MM-dd"

    @Test
    fun `空列表返回空`() {
        assertTrue(buildTimeline(emptyList()).isEmpty())
    }

    @Test
    fun `单日多条消息只插一个日期头`() {
        val items = buildTimeline(
            messages = listOf(msg("a", ts(1, 10)), msg("b", ts(1, 9))),
            dateOf = ::dayOf,
            labelOf = ::labelOf,
        )
        // 底->上：最旧消息在底，日期头在最上
        assertEquals(3, items.size)
        assertEquals(TimelineItem.Entry(msg("b", ts(1, 9))), items[0])
        assertEquals(TimelineItem.Entry(msg("a", ts(1, 10))), items[1])
        assertEquals(TimelineItem.DateHeader("08-01"), items[2])
    }

    @Test
    fun `跨日按日期分组并各自插头`() {
        val items = buildTimeline(
            messages = listOf(msg("a", ts(2, 10)), msg("b", ts(1, 9)), msg("c", ts(1, 8))),
            dateOf = ::dayOf,
            labelOf = ::labelOf,
        )
        // 底->上：c, b, 08-01 头, a, 08-02 头
        assertEquals(5, items.size)
        assertEquals(TimelineItem.Entry(msg("c", ts(1, 8))), items[0])
        assertEquals(TimelineItem.Entry(msg("b", ts(1, 9))), items[1])
        assertEquals(TimelineItem.DateHeader("08-01"), items[2])
        assertEquals(TimelineItem.Entry(msg("a", ts(2, 10))), items[3])
        assertEquals(TimelineItem.DateHeader("08-02"), items[4])
    }

    @Test
    fun `pending 与消息合并按时间排序`() {
        val items = buildTimeline(
            messages = listOf(msg("m1", ts(1, 10))),
            pending = listOf(
                PendingMessage(requestId = "r1", content = "pending", timestamp = ts(1, 11), failed = false),
            ),
            dateOf = ::dayOf,
            labelOf = ::labelOf,
        )
        // 底->上：m1, pending（pending 时间更新在上方），日期头最上
        assertEquals(3, items.size)
        assertEquals(TimelineItem.Entry(msg("m1", ts(1, 10))), items[0])
        assertEquals(
            TimelineItem.PendingEntry(PendingMessage("r1", "pending", ts(1, 11), false)),
            items[1],
        )
        assertEquals(TimelineItem.DateHeader("08-01"), items[2])
    }

    @Test
    fun `失败 pending 保留 failed 标记`() {
        val pending = PendingMessage("r9", "重试内容", ts(1, 12), failed = true)
        val items = buildTimeline(
            messages = emptyList(),
            pending = listOf(pending),
            dateOf = ::dayOf,
            labelOf = ::labelOf,
        )
        val entry = items.filterIsInstance<TimelineItem.PendingEntry>().single()
        assertTrue(entry.pending.failed)
    }

    @Test
    fun `跨年日期显示完整年月日`() {
        assertEquals("2025-12-31", formatDateLabel("2025-12-31"))
    }

    @Test
    fun `今天与昨天显示相对文案`() {
        val now = System.currentTimeMillis()
        assertEquals("今天", formatDateLabel(dateKeyOf(now)))
        assertEquals("昨天", formatDateLabel(dateKeyOf(now - 24 * 60 * 60 * 1000)))
    }
}
