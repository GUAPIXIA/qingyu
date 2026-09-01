package com.qingyu.companion.data.send

import com.qingyu.companion.data.OutboxMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * F-04：Outbox 八态状态机转换矩阵测试。
 * 状态：queued/sending/user_committed/awaiting_ai/completed/failed_send/failed_generation/cancelled。
 */
class OutboxStateMachineTest {

    private fun row(
        state: String,
        retryCount: Int = 0,
        nextAttemptAt: Long? = null,
        taskId: String? = null,
        remoteUserMessageId: String? = null,
    ) = OutboxMessage(
        requestId = "req",
        sessionId = "s1",
        content = "hello",
        imagesJson = "[]",
        replyToId = null,
        createdAt = 1L,
        retryCount = retryCount,
        state = state,
        deviceId = "pc-1",
        updatedAt = 1L,
        nextAttemptAt = nextAttemptAt,
        taskId = taskId,
        remoteUserMessageId = remoteUserMessageId,
    )

    // ---------- 转换矩阵 ----------

    @Test
    fun `八态转换矩阵-合法转换全部通过`() {
        val matrix = listOf(
            "queued" to "sending",
            "queued" to "cancelled",
            "sending" to "user_committed",
            "sending" to "relay_queued",
            "relay_queued" to "completed",
            "relay_queued" to "failed_send",
            "relay_queued" to "queued",
            "relay_queued" to "cancelled",
            "sending" to "awaiting_ai",
            "sending" to "completed",
            "sending" to "failed_send",
            "sending" to "cancelled",
            "user_committed" to "awaiting_ai",
            "user_committed" to "completed",
            "user_committed" to "failed_generation",
            "user_committed" to "cancelled",
            "awaiting_ai" to "completed",
            "awaiting_ai" to "failed_generation",
            "awaiting_ai" to "cancelled",
            "failed_send" to "queued",
            "failed_send" to "cancelled",
            "failed_generation" to "awaiting_ai",
            "failed_generation" to "cancelled",
        )
        matrix.forEach { (from, to) ->
            try {
                OutboxStateMachine.advance(row(from), to, now = 100L)
            } catch (e: Exception) {
                fail("转换 $from -> $to 应合法：${e.message}")
            }
        }
    }

    @Test
    fun `八态转换矩阵-非法转换全部拒绝`() {
        val illegal = listOf(
            "queued" to "completed", // 未发送不能完成
            "queued" to "user_committed",
            "queued" to "awaiting_ai",
            "queued" to "failed_generation", // 发送都没开始，不存在生成失败
            "sending" to "failed_generation",
            "user_committed" to "failed_send", // 用户消息已落盘，发送阶段已结束
            "user_committed" to "queued",
            "awaiting_ai" to "sending",
            "awaiting_ai" to "failed_send",
            "awaiting_ai" to "queued",
            "failed_send" to "sending", // 必须先回 queued
            "failed_generation" to "queued", // 生成重试不重发用户消息
            "failed_generation" to "sending",
            "completed" to "queued",
            "completed" to "sending",
            "cancelled" to "queued",
            "cancelled" to "sending",
            "cancelled" to "completed",
        )
        illegal.forEach { (from, to) ->
            try {
                OutboxStateMachine.advance(row(from), to, now = 100L)
                fail("转换 $from -> $to 应被拒绝")
            } catch (e: IllegalStateException) {
                assertTrue(e.message!!.contains("非法状态转换"))
            }
        }
    }

    // ---------- 语义细节 ----------

    @Test
    fun `同状态幂等转换不抛错仅刷新时间`() {
        val advanced = OutboxStateMachine.advance(row("sending"), "sending", now = 999L)
        assertEquals("sending", advanced.state)
        assertEquals(999L, advanced.updatedAt)
    }

    @Test
    fun `v5 列接线-远程消息id与任务id保持并允许覆写`() {
        val committed = OutboxStateMachine.advance(
            row("sending"),
            "user_committed",
            now = 100L,
            taskId = "task-1",
            remoteUserMessageId = "um-1",
        )
        assertEquals("um-1", committed.remoteUserMessageId)
        assertEquals("task-1", committed.taskId)
        assertEquals(100L, committed.updatedAt)

        // 新任务覆写 taskId（生成重试换任务）；传 null 保持
        val retried = OutboxStateMachine.advance(committed, "failed_generation", now = 200L, countRetry = true)
        assertEquals("task-1", retried.taskId)
        val regenerated = OutboxStateMachine.advance(retried, "awaiting_ai", now = 300L, taskId = "task-2")
        assertEquals("task-2", regenerated.taskId)
        assertEquals("um-1", regenerated.remoteUserMessageId)
    }

    @Test
    fun `失败退避序列 1s2s4s8s15s30s 封顶`() {
        assertEquals(1_000L, OutboxStateMachine.backoffMs(1))
        assertEquals(2_000L, OutboxStateMachine.backoffMs(2))
        assertEquals(4_000L, OutboxStateMachine.backoffMs(3))
        assertEquals(8_000L, OutboxStateMachine.backoffMs(4))
        assertEquals(15_000L, OutboxStateMachine.backoffMs(5))
        assertEquals(30_000L, OutboxStateMachine.backoffMs(6))
        assertEquals(30_000L, OutboxStateMachine.backoffMs(7))
        assertEquals(30_000L, OutboxStateMachine.backoffMs(100))
    }

    @Test
    fun `失败转换写入错误与退避调度-成功转换清除`() {
        val failed = OutboxStateMachine.advance(
            row("sending"), "failed_send", now = 1_000L,
            errorCode = "network_error", errorMessage = "超时", countRetry = true,
        )
        assertEquals(1, failed.retryCount)
        assertEquals(2_000L, failed.nextAttemptAt)
        assertEquals("network_error", failed.lastErrorCode)
        assertEquals("超时", failed.lastErrorMessage)

        // 重试回队：退避清除、错误清除、计数保留
        val requeued = OutboxStateMachine.advance(failed, "queued", now = 2_500L)
        assertNull(requeued.nextAttemptAt)
        assertNull(requeued.lastErrorCode)
        assertNull(requeued.lastErrorMessage)
        assertEquals(1, requeued.retryCount)

        // 完成：终态清除调度
        val done = OutboxStateMachine.advance(row("awaiting_ai", nextAttemptAt = 5L), "completed", now = 10L)
        assertNull(done.nextAttemptAt)
    }

    @Test
    fun `错误文案截断至200字符`() {
        val long = "x".repeat(500)
        val failed = OutboxStateMachine.advance(row("sending"), "failed_send", now = 1L, errorMessage = long, countRetry = true)
        assertEquals(200, failed.lastErrorMessage!!.length)
    }

    @Test
    fun `v4 遗留 error 列状态机写入时清空`() {
        val legacy = row("sending").copy(error = "旧错误")
        val failed = OutboxStateMachine.advance(legacy, "failed_send", now = 1L, errorCode = "E", errorMessage = "新错误", countRetry = true)
        assertNull(failed.error)
        assertEquals("新错误", failed.lastErrorMessage)
    }

    @Test
    fun `未知目标态被拒绝`() {
        try {
            OutboxStateMachine.advance(row("queued"), "unknown_state", now = 1L)
            fail("未知状态应被拒绝")
        } catch (e: IllegalArgumentException) {
            assertNotNull(e.message)
        }
    }
}
