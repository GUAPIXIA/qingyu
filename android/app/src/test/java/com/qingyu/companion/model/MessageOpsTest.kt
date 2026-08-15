package com.qingyu.companion.model

import org.junit.Assert.assertEquals
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
}
