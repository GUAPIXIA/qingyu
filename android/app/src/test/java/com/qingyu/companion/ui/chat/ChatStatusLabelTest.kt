package com.qingyu.companion.ui.chat

import com.qingyu.companion.data.ChatRepository
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 阶段 4 S4-06：状态标签纯映射测试。
 *
 * 为什么先测这层：S4-06 要求「本地生成任务状态与模型连接状态有清晰标签」，
 * 若把文案直接写在 Compose 里就只能靠人工看界面。这里用纯函数把文案与优先级穷举锁定，
 * 界面只负责放置与着色。
 */
class ChatStatusLabelTest {

    private fun local(configured: Boolean, model: String? = null) =
        ChatRepository.DataSourceStatus(local = true, modelConfigured = configured, model = model)

    private val remote = ChatRepository.DataSourceStatus(local = false)

    // ---------------------------------------------------------------- 数据源标签

    @Test
    fun remoteSourceIsLabelledAsPcRemote() {
        assertEquals("PC 远程", ChatStatusLabel.source(remote))
    }

    @Test
    fun localSourceIncludesModelNameSoUserCanConfirmDirectTarget() {
        assertEquals(
            "本地直连 · gpt-4o-mini",
            ChatStatusLabel.source(local(configured = true, model = "gpt-4o-mini")),
        )
    }

    @Test
    fun localWithBlankModelNameStillReportsLocal() {
        assertEquals("本地直连", ChatStatusLabel.source(local(configured = true, model = "")))
        assertEquals("本地直连", ChatStatusLabel.source(local(configured = true, model = null)))
    }

    @Test
    fun localWithoutProfileIsExplicitlyUnconfigured() {
        assertEquals("本地直连 · 未配置模型", ChatStatusLabel.source(local(configured = false)))
    }

    // ---------------------------------------------------------------- 生成状态

    @Test
    fun generatingLabelOnlyAppearsWhileGenerating() {
        assertNull("空闲时不应出现生成标签，避免常态噪声", ChatStatusLabel.generating(false))
        assertEquals("正在生成…", ChatStatusLabel.generating(true))
    }

    // ---------------------------------------------------------------- 可行动作

    @Test
    fun actionHintOnlyWhenLocalAndUnconfigured() {
        assertEquals(
            "请到「连接」页添加模型连接后再发送",
            ChatStatusLabel.actionHint(local(configured = false)),
        )
        assertNull("已配置模型时无需动作提示", ChatStatusLabel.actionHint(local(configured = true, model = "m")))
        assertNull("远程模式未配置模型不由本标签负责", ChatStatusLabel.actionHint(remote))
    }

    // ---------------------------------------------------------------- 未迁移能力提示

    @Test
    fun unsupportedNoteIgnoresBlank() {
        assertNull(ChatStatusLabel.unsupportedNote(null))
        assertNull(ChatStatusLabel.unsupportedNote(""))
        assertNull(ChatStatusLabel.unsupportedNote("   "))
        assertEquals("世界书列表尚未提供", ChatStatusLabel.unsupportedNote("世界书列表尚未提供"))
    }

    // ---------------------------------------------------------------- 顶栏副标题行

    @Test
    fun secondaryLineIsJustSourceWhenNoSessionTitle() {
        assertEquals(
            "本地直连 · gpt-4o-mini",
            ChatStatusLabel.secondaryLine("", local(configured = true, model = "gpt-4o-mini"), isGenerating = false),
        )
    }

    @Test
    fun secondaryLineJoinsTitleAndSource() {
        assertEquals(
            "第一次相遇 · 本地直连 · gpt-4o-mini",
            ChatStatusLabel.secondaryLine(
                "第一次相遇",
                local(configured = true, model = "gpt-4o-mini"),
                isGenerating = false,
            ),
        )
        assertEquals(
            "标题 · PC 远程",
            ChatStatusLabel.secondaryLine("标题", remote, isGenerating = false),
        )
    }

    @Test
    fun secondaryLineTrimsSessionTitle() {
        assertEquals(
            "第一次相遇 · PC 远程",
            ChatStatusLabel.secondaryLine("  第一次相遇  ", remote, isGenerating = false),
        )
        assertEquals("空白标题不应产生前导分隔符", "PC 远程", ChatStatusLabel.secondaryLine("   ", remote, false))
    }

    @Test
    fun generatingTakesPriorityOverSourceLabel() {
        assertEquals(
            "标题 · 正在生成…",
            ChatStatusLabel.secondaryLine(
                "标题",
                local(configured = true, model = "gpt-4o-mini"),
                isGenerating = true,
            ),
        )
    }

    @Test
    fun actionHintTakesPriorityOverPlainSourceLabel() {
        assertEquals(
            "标题 · 请到「连接」页添加模型连接后再发送",
            ChatStatusLabel.secondaryLine("标题", local(configured = false), isGenerating = false),
        )
    }
}
