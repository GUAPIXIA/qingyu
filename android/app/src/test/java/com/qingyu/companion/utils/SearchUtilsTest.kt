package com.qingyu.companion.utils

import com.qingyu.companion.model.Character
import com.qingyu.companion.model.Message
import com.qingyu.companion.model.Role
import com.qingyu.companion.model.SessionPreview
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SearchUtilsTest {

    @Test
    fun `会话搜索按标题`() {
        val sessions = listOf(
            SessionPreview(id = "s1", characterId = "c1", title = "冒险之旅", characterName = "A", messageCount = 1, lastMessage = "", createdAt = 0, updatedAt = 0),
            SessionPreview(id = "s2", characterId = "c2", title = "日常", characterName = "B", messageCount = 1, lastMessage = "", createdAt = 0, updatedAt = 0),
        )
        val filtered = SearchUtils.filterSessions(sessions, "冒险")
        assertEquals(1, filtered.size)
        assertEquals("s1", filtered[0].id)
    }

    @Test
    fun `会话空查询返回全部`() {
        val sessions = listOf(SessionPreview(id = "s1", characterId = "c1", title = "a", characterName = "A", messageCount = 1, lastMessage = "", createdAt = 0, updatedAt = 0))
        assertEquals(1, SearchUtils.filterSessions(sessions, "").size)
        assertEquals(1, SearchUtils.filterSessions(sessions, "   ").size)
    }

    @Test
    fun `角色搜索按名与标签`() {
        val chars = listOf(
            Character(id = "c1", name = "林晚晴", description = "咖啡店老板", tags = listOf("治愈")),
            Character(id = "c2", name = "艾琳", description = "法师", tags = listOf("冒险")),
        )
        assertEquals(1, SearchUtils.filterCharacters(chars, "林晚晴").size)
        assertEquals(1, SearchUtils.filterCharacters(chars, "治愈").size)
        assertEquals(2, SearchUtils.filterCharacters(chars, "").size)
    }

    @Test
    fun `消息搜索含翻译`() {
        val msgs = listOf(
            Message(id = "m1", sessionId = "s1", characterId = "c1", role = Role.user, content = "你好世界", timestamp = 1),
            Message(id = "m2", sessionId = "s1", characterId = "c1", role = Role.assistant, content = "hello", translation = "你好", timestamp = 2),
        )
        assertEquals(2, SearchUtils.filterMessages(msgs, "你好").size)
        assertEquals(1, SearchUtils.filterMessages(msgs, "hello").size)
        assertEquals(0, SearchUtils.filterMessages(msgs, "不存在").size)
    }

    @Test
    fun `高亮分割正确`() {
        val parts = SearchUtils.highlightMatches("hello world hello", "hello")
        // hello(高亮) + " world "(非) + hello(高亮)
        assertEquals(3, parts.size)
        assertTrue(parts[0].second)
        assertEquals("hello", parts[0].first)
        assertEquals(" world ", parts[1].first)
        assertTrue(parts[2].second)
    }

    @Test
    fun `空查询高亮返回整体非高亮`() {
        val parts = SearchUtils.highlightMatches("abc", "")
        assertEquals(1, parts.size)
        assertEquals(false, parts[0].second)
    }
}
