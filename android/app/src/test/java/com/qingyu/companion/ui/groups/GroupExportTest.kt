package com.qingyu.companion.ui.groups

import com.qingyu.companion.model.GroupMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 群导出（D-14 群口径 Markdown）JVM 单测。 */
class GroupExportTest {

    private fun msg(
        id: String,
        characterId: String,
        content: String,
        round: Int = 1,
        timestamp: Long = 1000L,
        notice: String? = null,
        error: String? = null,
    ) = GroupMessage(
        id = id, groupId = "g1", characterId = characterId, content = content,
        timestamp = timestamp, round = round,
        generationNotice = notice, generationError = error,
    )

    private val names = mapOf("c1" to "爱丽丝", "c2" to "鲍勃")

    @Test
    fun `speakerLabel 用户取用户名 旁白取旁白 成员取显示名`() {
        assertEquals("用户消息显示用户名", "小明", GroupExport.speakerLabel("__user__", names, "小明"))
        assertEquals("旁白归属显示旁白", "旁白", GroupExport.speakerLabel("__narrator__", names, "小明"))
        assertEquals("成员归属显示成员名", "爱丽丝", GroupExport.speakerLabel("c1", names, "小明"))
        assertEquals("未知成员回退 characterId", "cx", GroupExport.speakerLabel("cx", names, "小明"))
    }

    @Test
    fun `群口径导出按发言者列出正文`() {
        val md = GroupExport.build(
            groupName = "三人组",
            sessionTitle = "第一幕",
            memberNames = names,
            userName = "小明",
            messages = listOf(
                msg("m1", "__user__", "出发吧", round = 1),
                msg("m2", "c1", "好的", round = 1, timestamp = 2000L),
            ),
            exportedAt = 999L,
        )
        assertTrue("含群名标题", md.contains("# 三人组"))
        assertTrue("用户正文带用户名", md.contains("【小明】出发吧"))
        assertTrue("成员正文带成员名", md.contains("【爱丽丝】好的"))
    }

    @Test
    fun `导出按 round timestamp id 稳定排序`() {
        val md = GroupExport.build(
            groupName = "g", sessionTitle = "s", memberNames = names, userName = "u",
            messages = listOf(
                msg("b", "c1", "后", round = 2),
                msg("a", "c1", "先", round = 1),
            ),
            exportedAt = 0L,
        )
        val first = md.indexOf("【爱丽丝】先")
        val second = md.indexOf("【爱丽丝】后")
        assertTrue("低轮次在前", first in 0 until second)
    }

    @Test
    fun `generationError 与 generationNotice 绝不进正文行（语义钉子）`() {
        val md = GroupExport.build(
            groupName = "g", sessionTitle = "s", memberNames = names, userName = "u",
            messages = listOf(
                msg("m1", "c1", "正文", notice = "已停止生成", error = "网络中断"),
            ),
            exportedAt = 0L,
        )
        assertTrue("正文保留", md.contains("【爱丽丝】正文"))
        assertFalse("错误绝不进导出正文", md.contains("网络中断"))
        assertFalse("收尾提示不混入正文行", md.contains("已停止生成"))
    }

    @Test
    fun `空成员名时列表省略成员行`() {
        val md = GroupExport.build(
            groupName = "g", sessionTitle = "s", memberNames = emptyMap(), userName = "u",
            messages = emptyList(), exportedAt = 0L,
        )
        assertFalse("无成员省略成员行", md.contains("- 成员"))
    }
}
