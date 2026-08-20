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
        // reverseLayout 的 index 0 位于视觉底部，因此最新消息必须排在 index 0。
        assertEquals(3, items.size)
        assertEquals(TimelineItem.Entry(msg("a", ts(1, 10))), items[0])
        assertEquals(TimelineItem.Entry(msg("b", ts(1, 9))), items[1])
        assertEquals(TimelineItem.DateHeader("08-01"), items[2])
    }

    @Test
    fun `跨日按日期分组并各自插头`() {
        val items = buildTimeline(
            messages = listOf(msg("a", ts(2, 10)), msg("b", ts(1, 9)), msg("c", ts(1, 8))),
            dateOf = ::dayOf,
            labelOf = ::labelOf,
        )
        // 底->上：最新日的最新消息优先，最旧日位于顶部。
        assertEquals(5, items.size)
        assertEquals(TimelineItem.Entry(msg("a", ts(2, 10))), items[0])
        assertEquals(TimelineItem.DateHeader("08-02"), items[1])
        assertEquals(TimelineItem.Entry(msg("b", ts(1, 9))), items[2])
        assertEquals(TimelineItem.Entry(msg("c", ts(1, 8))), items[3])
        assertEquals(TimelineItem.DateHeader("08-01"), items[4])
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
        // pending 时间更新，位于视觉底部（index 0）。
        assertEquals(3, items.size)
        assertEquals(
            TimelineItem.PendingEntry(PendingMessage("r1", "pending", ts(1, 11), false)),
            items[0],
        )
        assertEquals(TimelineItem.Entry(msg("m1", ts(1, 10))), items[1])
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

    @Test
    fun `dateKeyOf 生成日期键`() {
        assertEquals("2026-08-01", dateKeyOf(baseTs))
        // 同年 8 月 2 日
        assertEquals("2026-08-02", dateKeyOf(baseTs + 86_400_000L))
    }

    @Test
    fun `同日不同时间戳合并排序稳定`() {
        // reverseLayout 的底部从 index 0 开始，最新消息必须最先。
        val items = buildTimeline(
            messages = listOf(msg("a", ts(1, 8)), msg("b", ts(1, 10)), msg("c", ts(1, 9))),
            dateOf = ::dayOf,
            labelOf = ::labelOf,
        )
        // 底->上：b(10点), c(9点), a(8点), 日期头
        assertEquals(4, items.size)
        assertEquals(TimelineItem.Entry(msg("b", ts(1, 10))), items[0])
        assertEquals(TimelineItem.Entry(msg("c", ts(1, 9))), items[1])
        assertEquals(TimelineItem.Entry(msg("a", ts(1, 8))), items[2])
        assertEquals(TimelineItem.DateHeader("08-01"), items[3])
    }

    @Test
    fun `仅 pending 也生成时间线`() {
        val items = buildTimeline(
            messages = emptyList(),
            pending = listOf(PendingMessage("r1", "内容", ts(1, 10), failed = false)),
            dateOf = ::dayOf,
            labelOf = ::labelOf,
        )
        assertEquals(2, items.size)
        assertTrue(items[0] is TimelineItem.PendingEntry)
        assertTrue(items[1] is TimelineItem.DateHeader)
    }

    @Test
    fun `同年非今昨显示 MM-dd`() {
        // 注入式测不了 formatDateLabel 的相对文案，这里验证同年非今昨格式
        val key = "2026-08-01"
        val label = formatDateLabel(key)
        assertTrue(label == "08-01" || label == key)
    }

    @Test
    fun `跨多个日期插入对应日期头`() {
        val items = buildTimeline(
            messages = listOf(msg("a", ts(3, 10)), msg("b", ts(2, 9)), msg("c", ts(1, 8))),
            dateOf = ::dayOf,
            labelOf = ::labelOf,
        )
        // 底->上：a, 08-03, b, 08-02, c, 08-01
        assertEquals(6, items.size)
        assertEquals(TimelineItem.DateHeader("08-03"), items[1])
        assertEquals(TimelineItem.DateHeader("08-02"), items[3])
        assertEquals(TimelineItem.DateHeader("08-01"), items[5])
    }
}
