package com.qingyu.companion.ui.groups

import com.qingyu.companion.chatcore.ChatGroupTurnMachine
import com.qingyu.companion.chatcore.LocalGroupGenerationUseCase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 群生成流式归约语义（S6-01(f) 停止按钮 + 流式事件转发）JVM 单测。
 * 断言消息写后果（阶段 6 §3 验收：Chunk 实时上屏 / TurnFinished 落库可见 /
 * WaitingUser 交还用户 / Stopped 保留已见正文并标已停止生成 / 错误绝不进正文）。
 */
class GroupStreamingReducerTest {

    private fun turn(speakerId: String? = "c1", round: Long = 1) =
        ChatGroupTurnMachine.Turn(kind = "assistant", speakerId = speakerId, round = round)

    private fun start(state: GroupStreamingUi = GroupStreamingReducer.initial()) =
        GroupStreamingReducer.reduce(state, LocalGroupGenerationUseCase.Delta.TurnStarted(turn(), "r#t0"))

    private fun chunk(state: GroupStreamingUi, text: String) =
        GroupStreamingReducer.reduce(state, LocalGroupGenerationUseCase.Delta.Chunk("r#t0", text))

    @Test
    fun `Chunk 累积上屏（实时可见正文）`() {
        var s = start()
        s = chunk(s, "你")
        s = chunk(s, "好")
        assertEquals("流式正文按到达顺序累积", "你好", s.streamingText)
        assertTrue("生成中停止按钮可见", s.showStop)
    }

    @Test
    fun `TurnFinished 清零流式缓冲并计数（落库正文由仓库消息承载）`() {
        var s = start()
        s = chunk(s, "半截")
        s = GroupStreamingReducer.reduce(
            s,
            LocalGroupGenerationUseCase.Delta.TurnFinished(turn(), listOf("m1"), emptyMap(), "complete"),
        )
        assertEquals("流式缓冲清零，改由仓库消息展示落库正文", "", s.streamingText)
        assertEquals("完成轮数递增", 1, s.finishedTurns)
    }

    @Test
    fun `TurnFinished 的 generationNotice 只进提示字段不进正文`() {
        var s = chunk(start(), "正文")
        s = GroupStreamingReducer.reduce(
            s,
            LocalGroupGenerationUseCase.Delta.TurnFinished(
                turn(), listOf("m1"), mapOf("generationNotice" to "已在完整句处收束"), "complete",
            ),
        )
        assertEquals("收尾提示进提示字段", "已在完整句处收束", s.notice)
        assertFalse("提示绝不进正文", s.streamingText.contains("已在完整句处收束"))
    }

    @Test
    fun `TurnFinished 的 generationError 只进提示字段绝不进正文（语义钉子）`() {
        var s = chunk(start(), "正文")
        s = GroupStreamingReducer.reduce(
            s,
            LocalGroupGenerationUseCase.Delta.TurnFinished(
                turn(), emptyList(), mapOf("generationError" to "网络中断"), "failed",
            ),
        )
        assertEquals("失败原因进提示字段", "网络中断", s.error)
        assertFalse("错误绝不进正文", s.streamingText.contains("网络中断"))
    }

    @Test
    fun `WaitingUser 交还用户（停止生成态）`() {
        var s = chunk(start(), "正文")
        s = GroupStreamingReducer.reduce(s, LocalGroupGenerationUseCase.Delta.WaitingUser("await_input"))
        assertFalse("交还用户后不再生成中", s.active)
        assertFalse("交还用户后停止按钮消失", s.showStop)
        assertEquals("交还原因可见", "await_input", s.waitingUserReason)
    }

    @Test
    fun `Rejected 只提示不改正文`() {
        var s = chunk(start(), "正文")
        s = GroupStreamingReducer.reduce(s, LocalGroupGenerationUseCase.Delta.Rejected("no_profile"))
        assertFalse("被拒绝后不再生成中", s.active)
        assertEquals("拒绝原因进提示", "no_profile", s.rejectedReason)
        assertFalse("拒绝原因绝不进正文", s.streamingText.contains("no_profile"))
    }

    @Test
    fun `Stopped 保留已见正文并标已停止生成（提示不进正文）`() {
        var s = chunk(start(), "已见正文")
        s = GroupStreamingReducer.reduce(s, LocalGroupGenerationUseCase.Delta.Stopped("stopped"))
        assertEquals("已见正文保留可见", "已见正文", s.streamingText)
        assertTrue("标记为已停止", s.stopped)
        assertEquals("已停止提示可见", GroupStreamingReducer.STOPPED_NOTICE, s.notice)
        assertFalse("已停止提示绝不进正文", s.streamingText.contains("已停止生成"))
    }

    @Test
    fun `footer 渲染纯函数暴露 spinner 与停止按钮`() {
        val running = start()
        assertTrue("生成中显示 spinner", running.footer().showSpinner)
        assertTrue("生成中显示停止", running.footer().showStop)
        val stopped = GroupStreamingReducer.reduce(running, LocalGroupGenerationUseCase.Delta.Stopped("stopped"))
        assertFalse("停止后不再 spinner", stopped.footer().showSpinner)
        assertFalse("停止后不再显示停止按钮", stopped.footer().showStop)
        assertTrue("停止后标记已停止", stopped.footer().stopped)
    }

    @Test
    fun `接力链连续 TurnStarted 切换发言者（autoMode 连续轮）`() {
        var s = GroupStreamingReducer.reduce(
            GroupStreamingReducer.initial(),
            LocalGroupGenerationUseCase.Delta.TurnStarted(turn("c1", 1), "r#t0"),
        )
        s = chunk(s, "A")
        s = GroupStreamingReducer.reduce(
            s,
            LocalGroupGenerationUseCase.Delta.TurnStarted(turn("c2", 2), "r#t1"),
        )
        assertEquals("下一棒发言者切换", "c2", s.streamingSpeakerId)
        assertEquals("新轮清空上一棒缓冲", "", s.streamingText)
    }
}
