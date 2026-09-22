package com.qingyu.companion.ui.groups

import com.qingyu.companion.chatcore.LocalGroupMemoryService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 群记忆面板可见反馈（S6-01(f) 第 7 项）JVM 单测。 */
class GroupMemoryFeedbackTest {

    @Test
    fun `Summarized 投影为成功摘要反馈`() {
        val feedback = GroupMemoryFeedback.from(
            LocalGroupMemoryService.Outcome.Summarized(
                summary = "众人已抵达山门", currentState = "推进中", factCount = 3,
                memoryVersion = 2, cursorMessageId = "m9",
            ),
        )
        assertTrue("标记为已产出摘要", feedback.summarized)
        assertFalse("成功反馈非错误", feedback.isError)
        assertTrue("反馈含摘要正文", feedback.text.contains("众人已抵达山门"))
    }

    @Test
    fun `Skipped 投影为跳过原因（保留字面量文案）`() {
        val feedback = GroupMemoryFeedback.from(
            LocalGroupMemoryService.Outcome.Skipped("消息不足 4 条，跳过总结"),
        )
        assertFalse("跳过不算已产出", feedback.summarized)
        assertFalse("跳过非错误", feedback.isError)
        assertEquals("跳过原因原样可见", "消息不足 4 条，跳过总结", feedback.text)
    }

    @Test
    fun `Failed 投影为错误提示（字面量文案可见）`() {
        val feedback = GroupMemoryFeedback.from(
            LocalGroupMemoryService.Outcome.Failed("群聊长记忆总结未产出可解析内容"),
        )
        assertTrue("失败标记为错误", feedback.isError)
        assertFalse("失败不算已产出", feedback.summarized)
        assertEquals("失败文案原样可见", "群聊长记忆总结未产出可解析内容", feedback.text)
    }

    @Test
    fun `CAS stale 丢弃文案原样可见`() {
        val feedback = GroupMemoryFeedback.from(
            LocalGroupMemoryService.Outcome.Failed("群聊长记忆已被其他操作更新，本次旧摘要未写入。请重试总结。"),
        )
        assertTrue("CAS stale 丢弃按错误提示", feedback.isError)
        assertTrue("含 PC 字面量", feedback.text.contains("本次旧摘要未写入"))
    }
}
