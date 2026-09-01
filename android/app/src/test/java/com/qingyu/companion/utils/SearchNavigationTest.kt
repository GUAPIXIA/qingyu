package com.qingyu.companion.utils

import com.qingyu.companion.model.Message
import com.qingyu.companion.model.Role
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * E-05 聊天内搜索纯函数单测：
 * - 匹配 messageId 列表（内容/译文命中、空查询、大小写）；
 * - 上一项/下一项导航（环形、越界回退、空列表）。
 */
class SearchNavigationTest {

    private fun msg(id: String, content: String, translation: String? = null) = Message(
        id = id,
        sessionId = "s1",
        characterId = "c1",
        role = Role.assistant,
        content = content,
        translation = translation,
        timestamp = 0,
    )

    private val messages = listOf(
        msg("m1", "今天天气不错"),
        msg("m2", "hello world", translation = "你好世界"),
        msg("m3", "又是新的一天"),
        msg("m4", "HELLO again"),
    )

    @Test
    fun `空查询返回空列表`() {
        assertEquals(emptyList<String>(), SearchUtils.matchingMessageIds(messages, ""))
        assertEquals(emptyList<String>(), SearchUtils.matchingMessageIds(messages, "   "))
    }

    @Test
    fun `匹配列表按输入顺序且仅含命中id`() {
        assertEquals(listOf("m1"), SearchUtils.matchingMessageIds(messages, "天气"))
        // 命中内容与译文
        assertEquals(listOf("m2"), SearchUtils.matchingMessageIds(messages, "你好世界"))
        assertEquals(listOf("m2", "m4"), SearchUtils.matchingMessageIds(messages, "hello"))
        assertEquals(emptyList<String>(), SearchUtils.matchingMessageIds(messages, "不存在"))
    }

    @Test
    fun `匹配忽略大小写`() {
        assertEquals(listOf("m2", "m4"), SearchUtils.matchingMessageIds(messages, "Hello"))
    }

    @Test
    fun `messageMatches 空查询不命中`() {
        assertEquals(false, SearchUtils.messageMatches(messages[0], " "))
    }

    @Test
    fun `下一项导航`() {
        val matches = listOf("m2", "m4")
        assertEquals(1, SearchUtils.navigateMatch(matches, 0, 1))
        // 环形回绕
        assertEquals(0, SearchUtils.navigateMatch(matches, 1, 1))
    }

    @Test
    fun `上一项导航`() {
        val matches = listOf("m2", "m4")
        assertEquals(0, SearchUtils.navigateMatch(matches, 1, -1))
        // 环形回绕
        assertEquals(1, SearchUtils.navigateMatch(matches, 0, -1))
    }

    @Test
    fun `无效当前位置回退到首项`() {
        val matches = listOf("m2", "m4")
        assertEquals(0, SearchUtils.navigateMatch(matches, -1, 1))
        assertEquals(0, SearchUtils.navigateMatch(matches, 99, -1))
    }

    @Test
    fun `空列表导航返回null`() {
        assertNull(SearchUtils.navigateMatch(emptyList(), 0, 1))
        assertNull(SearchUtils.navigateMatch(emptyList(), -1, -1))
    }
}
