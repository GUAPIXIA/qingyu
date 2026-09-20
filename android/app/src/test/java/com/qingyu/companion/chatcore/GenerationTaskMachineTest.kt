package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-03：GenerationTask 状态机行为测试。
 *
 * 覆盖阶段文档 §2 S4-03 的四条硬约束：
 * 1. taskId / requestId 在重试语义上分离；
 * 2. 草稿 chunk 节流缓存，完成时一次性生成 final message；
 * 3. 进程死亡后未完成任务标记 interrupted，**不自动重发**；
 * 4. 状态固定为文档给出的集合，终态不可再迁移。
 *
 * 终止原因与提示文案的口径由 `ChatGenerationTermination` 提供，
 * 其跨语言一致性由 `ChatCoreGoldenTest.generationTerminationMatchesGolden` 锁定。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class GenerationTaskMachineTest {

    /** 确定性 requestId 生成器：便于断言「网络重试保持 requestId、逻辑重试换新」。 */
    private class Sequencer {
        private var counter = 0
        fun next(taskId: String): String = "$taskId#${++counter}"
    }

    private fun machineWith(taskId: String = "task-1"): Pair<ChatGenerationTask.Machine, Sequencer> {
        val seq = Sequencer()
        return ChatGenerationTask.createMachine(taskId) { id -> seq.next(id) } to seq
    }

    @Test
    fun happyPathGoesThroughEveryStateInOrder() {
        val (machine, _) = machineWith()
        assertEquals("queued", machine.snapshot().status)

        assertTrue(machine.prepare())
        assertEquals("preparing", machine.snapshot().status)

        assertTrue(machine.startStreaming())
        assertEquals("streaming", machine.snapshot().status)

        assertTrue(machine.appendChunk("你"))
        assertTrue(machine.appendChunk("好"))
        assertEquals(2, machine.snapshot().streamedChars)

        assertTrue(machine.beginFinalizing("stop"))
        assertEquals("finalizing", machine.snapshot().status)

        assertTrue(machine.markCompleted())
        val snapshot = machine.snapshot()
        assertEquals("completed", snapshot.status)
        assertTrue(snapshot.isTerminal)

        val final = machine.takeFinalMessage()
        assertNotNull(final)
        assertEquals("你好", final!!.content)
        assertEquals("task-1", final.taskId)
        assertEquals("provider_stop", final.terminationCause)
    }

    @Test
    fun draftIsBufferedAndOnlyMaterializedOnCompletion() {
        val (machine, _) = machineWith()
        machine.prepare()
        machine.startStreaming()
        machine.appendChunk("半截")

        // 流式期间不得产出可落盘正文（节流缓存语义）
        assertNull("流式期间不应有 final message", machine.takeFinalMessage())
        assertEquals("半截", machine.draftText())

        machine.beginFinalizing("stop")
        assertNull("finalizing 期间仍不应落盘", machine.takeFinalMessage())

        machine.markCompleted()
        assertEquals("半截", machine.takeFinalMessage()?.content)
    }

    @Test
    fun lateChunksAfterTerminationAreIgnored() {
        val (machine, _) = machineWith()
        machine.prepare()
        machine.startStreaming()
        machine.appendChunk("正常")

        assertTrue(machine.beginFinalizing("stop"))
        assertFalse("finalizing 后必须拒绝迟到 chunk", machine.acceptsStreamEvent())
        assertFalse(machine.appendChunk("迟到"))
        assertEquals("正常", machine.draftText())

        // 已经 finalizing 后不允许再走失败/取消分支
        assertFalse(machine.terminate("transport_error"))
        assertTrue(machine.markCompleted())
        assertEquals("正常", machine.takeFinalMessage()?.content)
    }

    @Test
    fun userCancelKeepsVisibleBodyAndIsNotRetryableTransition() {
        val (machine, _) = machineWith()
        machine.prepare()
        machine.startStreaming()
        machine.appendChunk("已经看到的内容")

        assertTrue(machine.terminate("user_cancel"))
        val snapshot = machine.snapshot()
        assertEquals("cancelled", snapshot.status)
        assertEquals("generationNotice", snapshot.noticeField)
        assertEquals("已停止生成", snapshot.noticeText)

        // 取消后仍可 markCompleted（保留正文），且不得回退到 active
        assertTrue(machine.markCompleted())
        val final = machine.takeFinalMessage()
        assertEquals("已经看到的内容", final?.content)
        assertEquals("user_cancel", final?.terminationCause)
    }

    @Test
    fun cancelWithoutBodyProducesNoMessage() {
        val (machine, _) = machineWith()
        machine.prepare()
        machine.startStreaming()
        assertTrue(machine.terminate("user_cancel"))
        assertNull("取消且无正文时不得创建空消息", machine.takeFinalMessage())
    }

    @Test
    fun contentFilterDoesNotPersistBody() {
        val (machine, _) = machineWith()
        machine.prepare()
        machine.startStreaming()
        machine.appendChunk("被拦截的正文")

        assertTrue(machine.terminate("provider_content_filter"))
        val snapshot = machine.snapshot()
        assertEquals("failed", snapshot.status)
        assertEquals("generationError", snapshot.noticeField)
        assertEquals("回复被内容审核拦截", snapshot.noticeText)
        assertFalse("审核拦截整条不可信，不保留正文", snapshot.persistable)
        assertNull(machine.takeFinalMessage())
    }

    @Test
    fun transportErrorIsRetryableAndKeepsBody() {
        val (machine, _) = machineWith()
        machine.prepare()
        machine.startStreaming()
        machine.appendChunk("部分正文")

        assertTrue(machine.terminate("transport_error"))
        val snapshot = machine.snapshot()
        assertEquals("failed", snapshot.status)
        assertEquals("PROVIDER_UNAVAILABLE", snapshot.failureCode)
        assertTrue("传输失败可重试", snapshot.retryable)
        assertEquals("生成中断，请重试", snapshot.noticeText)
    }

    @Test
    fun logicalRetryKeepsTaskIdAndIssuesNewRequestId() {
        val (machine, _) = machineWith("task-9")
        val firstRequestId = machine.requestId
        assertEquals("task-9#1", firstRequestId)

        machine.prepare()
        machine.startStreaming()
        machine.appendChunk("失败前的草稿")
        assertTrue(machine.terminate("transport_error"))

        assertTrue(machine.retry())
        val afterRetry = machine.snapshot()
        assertEquals("queued", afterRetry.status)
        assertEquals("task-9", afterRetry.taskId)
        assertEquals("逻辑重试必须换新 requestId", "task-9#2", machine.requestId)
        assertNull(afterRetry.failureCode)
        assertFalse(afterRetry.retryable)
        assertEquals("重试必须清空上一轮草稿", 0, afterRetry.streamedChars)
        assertNull("重试后不得残留上一轮正文", machine.takeFinalMessage())
    }

    @Test
    fun retryIsRejectedForNonRetryableFailureOrNonTerminalState() {
        val (machine, _) = machineWith()
        // 非终态不可重试
        assertFalse(machine.retry())

        machine.prepare()
        machine.startStreaming()
        machine.appendChunk("内容")
        machine.terminate("protocol_error")
        assertFalse("协议错误不可重试", machine.snapshot().retryable)
        assertFalse(machine.retry())
    }

    @Test
    fun processDeathMarksInterruptedWithoutAutoResend() {
        val (machine, _) = machineWith()
        machine.prepare()
        machine.startStreaming()
        machine.appendChunk("进程死前的半截正文")

        val beforeRequestId = machine.requestId
        assertTrue(machine.recover())

        val snapshot = machine.snapshot()
        assertEquals("failed", snapshot.status)
        assertEquals(ChatGenerationTask.CODE_INTERRUPTED, snapshot.failureCode)
        assertFalse("interrupted 不得自动重发（避免重复计费）", snapshot.retryable)
        assertFalse(snapshot.persistable)
        assertNull("进程恢复后不得落盘残缺正文", machine.takeFinalMessage())
        assertEquals("恢复不得改变 requestId", beforeRequestId, machine.requestId)
        assertFalse("interrupted 任务不可自动重试", machine.retry())
    }

    @Test
    fun recoverIsNoOpForTerminalTasks() {
        val (machine, _) = machineWith()
        machine.prepare()
        machine.startStreaming()
        machine.appendChunk("完成内容")
        machine.beginFinalizing("stop")
        machine.markCompleted()

        assertFalse("终态任务无需恢复", machine.recover())
        assertEquals("completed", machine.snapshot().status)
    }

    @Test
    fun stateSetMatchesStageDocument() {
        assertEquals(
            listOf("queued", "preparing", "streaming", "finalizing", "completed", "cancelled", "failed"),
            ChatGenerationTask.STATES,
        )
        assertEquals(
            setOf("completed", "cancelled", "failed"),
            ChatGenerationTask.TERMINAL_STATES,
        )
        assertEquals(
            setOf("queued", "preparing", "streaming", "finalizing"),
            ChatGenerationTask.ACTIVE_STATES,
        )
        // interrupted 是失败码而非状态，避免与固定状态集冲突
        assertFalse(ChatGenerationTask.CODE_INTERRUPTED in ChatGenerationTask.STATES)
    }

    @Test
    fun terminalStatesRejectFurtherTransitions() {
        val (machine, _) = machineWith()
        machine.prepare()
        machine.startStreaming()
        machine.appendChunk("x")
        machine.beginFinalizing("stop")
        machine.markCompleted()
        assertEquals("completed", machine.snapshot().status)

        assertFalse(machine.prepare())
        assertFalse(machine.startStreaming())
        assertFalse(machine.beginFinalizing("stop"))
        assertFalse(machine.terminate("transport_error"))
        assertFalse(machine.appendChunk("y"))
        assertEquals("completed", machine.snapshot().status)
    }

    @Test
    fun usageIsRecordedForFinalMessage() {
        val (machine, _) = machineWith()
        machine.prepare()
        machine.startStreaming()
        machine.appendChunk("正文")
        machine.recordUsage(promptTokens = 120, completionTokens = 45)
        machine.beginFinalizing("stop")
        machine.markCompleted()

        val final = machine.takeFinalMessage()!!
        assertEquals(120, final.usage["promptTokens"])
        assertEquals(45, final.usage["completionTokens"])
    }

    @Test
    fun reasonCodesMapToDomainErrorTaxonomy() {
        val cases = mapOf(
            "idle_timeout" to "PROVIDER_TIMEOUT",
            "transport_error" to "PROVIDER_UNAVAILABLE",
            "protocol_error" to "INVALID_MODEL_RESPONSE",
            "provider_content_filter" to "INVALID_MODEL_RESPONSE",
            "reasoning_gate_exceeded" to "CONTEXT_TOO_LARGE",
            "provider_length" to "INVALID_MODEL_RESPONSE",
            "something_else" to "UNKNOWN",
        )
        for ((cause, expectedCode) in cases) {
            val (machine, _) = machineWith()
            machine.prepare()
            machine.startStreaming()
            machine.appendChunk("x")
            machine.terminate(cause)
            val snapshot = machine.snapshot()
            assertEquals("cause=$cause 的失败码", expectedCode, snapshot.failureCode)
            assertTrue(
                "失败码必须属于域错误表：$expectedCode",
                snapshot.failureCode in ChatDomainErrors.CODES,
            )
            assertEquals(
                "可重试性必须与域错误表一致：$expectedCode",
                ChatDomainErrors.createDomainError(expectedCode, "").retryable,
                snapshot.retryable,
            )
        }
    }

    @Test
    fun timeoutIsRetryableWhileInterruptedIsNot() {
        val (timeoutMachine, _) = machineWith("t-timeout")
        timeoutMachine.prepare()
        timeoutMachine.startStreaming()
        timeoutMachine.appendChunk("x")
        timeoutMachine.terminate("idle_timeout")
        assertEquals("PROVIDER_TIMEOUT", timeoutMachine.snapshot().failureCode)
        assertTrue("超时可重试", timeoutMachine.snapshot().retryable)
        assertTrue(timeoutMachine.retry())

        val (interruptedMachine, _) = machineWith("t-interrupted")
        interruptedMachine.prepare()
        interruptedMachine.recover()
        assertEquals(ChatGenerationTask.CODE_INTERRUPTED, interruptedMachine.snapshot().failureCode)
        assertFalse("interrupted 不可重试", interruptedMachine.snapshot().retryable)
    }
}
