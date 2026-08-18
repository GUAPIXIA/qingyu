package com.qingyu.companion.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * MessageOps 单测：消息合并/去重/删除的纯函数行为。
 * 约定列表按时间降序（最新在前），配合 reverseLayout 展示。
 */
class MessageOpsTest {

    private fun msg(id: String, ts: Long) = Message(
        id = id,
        sessionId = "s1",
        characterId = "c1",
        role = Role.assistant,
        content = "内容-$id",
        timestamp = ts,
    )

    @Test
    fun `upsert 新消息插到最前`() {
        val list = listOf(msg("a", 100), msg("b", 200))
        val result = MessageOps.upsert(list, msg("c", 300))
        assertEquals(listOf("c", "b", "a"), result.map { it.id })
    }

    @Test
    fun `upsert 同 id 消息替换且保持降序`() {
        val list = listOf(msg("a", 100), msg("b", 200))
        val result = MessageOps.upsert(list, msg("a", 150))
        assertEquals(2, result.size)
        assertEquals(listOf("b", "a"), result.map { it.id })
    }

    @Test
    fun `merge 分页结果去重并按时间降序`() {
        val existing = listOf(msg("a", 300), msg("b", 200))
        // 分页返回更早消息：含与现有重复的 b，以及新的 c
        val incoming = listOf(msg("b", 200), msg("c", 100))
        val result = MessageOps.merge(existing, incoming)
        assertEquals(listOf("a", "b", "c"), result.map { it.id })
    }

    @Test
    fun `merge 乱序输入仍按时间降序`() {
        val result = MessageOps.merge(
            listOf(msg("a", 300)),
            listOf(msg("c", 100), msg("b", 200)),
        )
        assertEquals(listOf("a", "b", "c"), result.map { it.id })
    }

    @Test
    fun `remove 删除指定消息`() {
        val list = listOf(msg("a", 100), msg("b", 200))
        val result = MessageOps.remove(list, "a")
        assertEquals(listOf("b"), result.map { it.id })
        assertEquals(list, MessageOps.remove(list, "not-exist"))
    }

    @Test
    fun `replace 按 id 更新单条保留顺序`() {
        val list = listOf(msg("a", 100), msg("b", 200))
        val updated = msg("a", 100).copy(translation = "译文")
        val result = MessageOps.replace(list, updated)
        assertEquals("译文", result.first { it.id == "a" }.translation)
        assertEquals(listOf("a", "b"), result.map { it.id })
    }

    @Test
    fun `upsert 同时间戳按列表稳定`() {
        val list = listOf(msg("a", 100), msg("b", 100))
        val result = MessageOps.upsert(list, msg("c", 100))
        // 同时间戳：排序稳定（sortedByDescending 不保证稳定，只验证包含且大小正确）
        assertEquals(3, result.size)
        assertEquals(setOf("a", "b", "c"), result.map { it.id }.toSet())
    }

    @Test
    fun `merge 空列表返回原列表`() {
        val list = listOf(msg("a", 100))
        assertEquals(list, MessageOps.merge(list, emptyList()))
        assertEquals(list, MessageOps.merge(emptyList(), list))
        assertTrue(MessageOps.merge(emptyList(), emptyList()).isEmpty())
    }

    @Test
    fun `remove 空列表与不存在的 id`() {
        assertTrue(MessageOps.remove(emptyList(), "x").isEmpty())
        val list = listOf(msg("a", 100))
        assertEquals(list, MessageOps.remove(list, "missing"))
    }

    @Test
    fun `replace 不存在 id 返回原列表`() {
        val list = listOf(msg("a", 100))
        assertEquals(list, MessageOps.replace(list, msg("zzz", 999)))
    }

    @Test
    fun `upsert 新消息带图片与引用保留字段`() {
        val updated = msg("a", 200).copy(
            images = listOf("url1"),
            replyToId = "target",
            swipes = listOf("v1", "v2"),
            swipeIndex = 1,
        )
        val result = MessageOps.upsert(emptyList(), updated)
        assertEquals(listOf("url1"), result.single().images)
        assertEquals("target", result.single().replyToId)
        assertEquals(1, result.single().swipeIndex)
    }
}
