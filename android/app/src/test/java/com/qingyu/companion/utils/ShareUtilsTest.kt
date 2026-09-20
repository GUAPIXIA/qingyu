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
        // 纯文本分支仍是本地格式
        assertEquals(ShareUtils.sessionToPlainText(msgs), ShareUtils.sessionExportText(msgs, false))
        // Markdown 分支已切到与 PC 共用的导出契约：不再等于本地简化格式，
        // 而是 `# 对话记录` + 角色标签 + 时间 + 转义正文（结构由 fixture 锁定）
        val markdown = ShareUtils.sessionExportText(msgs, true)
        assertTrue(markdown.startsWith("# 对话记录\n\n"))
        assertTrue(markdown.contains("### 🧑 用户 · "))
        assertTrue(markdown.endsWith("\n\n---\n\n"))
        // 本地简化格式仍在（供其他用途），但导出不再使用它
        assertTrue(ShareUtils.sessionToMarkdown(msgs).isNotEmpty())
        assertTrue(markdown != ShareUtils.sessionToMarkdown(msgs))
    }

    @Test
    fun `sessionExportJson 与 PC 的规范键序一致`() {
        val msgs = listOf(msg("hi"))
        val json = ShareUtils.sessionExportJson(msgs)
        // 键序 id → role → content → timestamp；斜杠不转义（org.json 会转义，故不能用它）
        assertTrue(json.contains("\"id\""))
        assertTrue(json.indexOf("\"id\"") < json.indexOf("\"role\""))
        assertTrue(json.indexOf("\"role\"") < json.indexOf("\"content\""))
        assertTrue(json.indexOf("\"content\"") < json.indexOf("\"timestamp\""))
        assertTrue(!json.contains("\\/"))
    }
}
