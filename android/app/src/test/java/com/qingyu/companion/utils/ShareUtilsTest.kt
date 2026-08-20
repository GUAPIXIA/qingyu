package com.qingyu.companion.utils

import com.qingyu.companion.model.Message
import com.qingyu.companion.model.Role
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ShareUtilsTest {

    private fun msg(content: String, role: Role = Role.user, images: List<String> = emptyList()) = Message(
        id = "m1", sessionId = "s1", characterId = "c1", role = role, content = content, timestamp = 1000, images = images
    )

    @Test
    fun `单条纯文本转 plain`() {
        val m = msg("你好世界")
        val text = ShareUtils.messageToPlainText(m)
        assertTrue(text.contains("你好世界"))
        assertTrue(text.contains("我"))
    }

    @Test
    fun `单条带图转 plain 含图片标记`() {
        val m = msg("看图", images = listOf("a", "b"))
        val text = ShareUtils.messageToPlainText(m)
        assertTrue(text.contains("[图片 x2]"))
    }

    @Test
    fun `单条转 markdown 含角色标记`() {
        val m = msg("hello", role = Role.assistant)
        val md = ShareUtils.messageToMarkdown(m)
        assertTrue(md.contains("**角色**"))
        assertTrue(md.contains("hello"))
    }

    @Test
    fun `整段会话纯文本导出`() {
        val msgs = listOf(msg("a"), msg("b", role = Role.assistant))
        val text = ShareUtils.sessionToPlainText(msgs)
        assertTrue(text.contains("a"))
        assertTrue(text.contains("b"))
        assertTrue(text.contains("\n\n"))
    }

    @Test
    fun `整段会话 markdown 导出含分隔`() {
        val msgs = listOf(msg("a"), msg("b"))
        val md = ShareUtils.sessionToMarkdown(msgs)
        assertTrue(md.contains("---"))
    }

    @Test
    fun `空会话导出为空`() {
        assertEquals("", ShareUtils.sessionToPlainText(emptyList()))
        assertEquals("", ShareUtils.sessionToMarkdown(emptyList()))
    }

    @Test
    fun `sessionExportText 按 markdown 开关`() {
        val msgs = listOf(msg("hi"))
        assertEquals(ShareUtils.sessionToPlainText(msgs), ShareUtils.sessionExportText(msgs, false))
        assertEquals(ShareUtils.sessionToMarkdown(msgs), ShareUtils.sessionExportText(msgs, true))
    }
}
