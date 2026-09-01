package com.qingyu.companion.data

import com.qingyu.companion.data.send.OutboxStateMachine
import com.qingyu.companion.model.PendingMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

/**
 * P1-4.1 B1-2 持久化发件箱测试（JVM 纯内存 Fake，不依赖 Android Room）：
 * - F-04 八态状态机转换（经 OutboxStateMachine 唯一写入权威）
 * - 重试计数与退避调度（1s/2s/4s/8s/15s/30s 封顶）
 * - 发送链路时序（queued→sending→user_committed→awaiting_ai→completed；发送失败 failed_send）
 * - 恢复（restoreOutbox）与清理
 * - 图片/引用持久化往返（requestId/replyToId/imagesJson 在重试路径保持）
 */
class OutboxTest {

    // 内存 Fake DAO，模拟 Room OutboxDao 行为（F-04 八态查询）
    private class FakeOutboxDao {
        private val store = mutableMapOf<String, OutboxMessage>()
        private val flow = MutableStateFlow<List<OutboxMessage>>(emptyList())
        private fun emit() { flow.value = store.values.sortedBy { it.createdAt } }

        suspend fun upsert(item: OutboxMessage) { store[item.requestId] = item; emit() }
        suspend fun getById(requestId: String) = store[requestId]
        suspend fun listForSession(sessionId: String) = store.values.filter { it.sessionId == sessionId }.sortedBy { it.createdAt }
        fun observeForSession(sessionId: String) = flow.map { list -> list.filter { it.sessionId == sessionId }.sortedBy { it.createdAt } }
        suspend fun listAll() = store.values.sortedBy { it.createdAt }
        suspend fun listPending() = store.values.filter { it.state in OutboxStateMachine.PENDING }.sortedBy { it.createdAt }
        suspend fun delete(requestId: String) { store.remove(requestId); emit() }
        suspend fun clearCompleted(sessionId: String) { store.entries.removeIf { it.value.sessionId == sessionId && it.value.state == "completed" }; emit() }
        suspend fun deleteOrphan(validSessionIds: Set<String>) { store.entries.removeIf { it.value.sessionId !in validSessionIds }; emit() }
        suspend fun clear() { store.clear(); emit() }
        suspend fun trimSessions(sessions: List<CachedSession>, limit: Int) {
            val keep = sessions.sortedByDescending { it.updatedAt }.take(limit).map { it.id }.toSet()
            deleteOrphan(keep)
        }
    }

    private val dao = FakeOutboxDao()

    /** 事务直执行（测试替代 db.withTransaction） */
    private suspend fun tx(block: suspend () -> Unit) = block()

    /** 与 OnlineChatRepository.transitionOutbox 相同的状态机推进路径 */
    private suspend fun advance(requestId: String, to: String, now: Long = 1000L, countRetry: Boolean = false) {
        val current = dao.getById(requestId) ?: return
        dao.upsert(OutboxStateMachine.advance(current, to, now, errorCode = "E", errorMessage = "err", countRetry = countRetry))
    }

    private fun makeOutbox(requestId: String, sessionId: String = "s1", state: String = "queued", retryCount: Int = 0) =
        OutboxMessage(
            requestId = requestId,
            sessionId = sessionId,
            content = "hi $requestId",
            imagesJson = "[]",
            replyToId = null,
            createdAt = System.currentTimeMillis(),
            retryCount = retryCount,
            state = state,
        )

    @Test
    fun `outbox 状态机 queued to sending to awaiting_ai to completed 并清理`() = runTest {
        dao.upsert(makeOutbox("req-1", state = "queued"))
        assertEquals("queued", dao.listForSession("s1").first().state)

        advance("req-1", OutboxStateMachine.SENDING)
        assertEquals("sending", dao.listForSession("s1").first().state)

        advance("req-1", OutboxStateMachine.AWAITING_AI)
        assertEquals("awaiting_ai", dao.listForSession("s1").first().state)

        advance("req-1", OutboxStateMachine.COMPLETED)
        dao.clearCompleted("s1")
        assertTrue(dao.listForSession("s1").isEmpty())
    }

    @Test
    fun `v2 发送时序 queued to sending to user_committed to awaiting_ai to completed 接线 v5 列`() = runTest {
        dao.upsert(makeOutbox("req-v2").copy(deviceId = "pc-1"))
        advance("req-v2", OutboxStateMachine.SENDING)
        // PC 已确认用户消息落盘：接线 remoteUserMessageId/taskId
        val row = dao.getById("req-v2")!!
        dao.upsert(
            OutboxStateMachine.advance(
                row, OutboxStateMachine.USER_COMMITTED, 1000L,
                taskId = "task-9", remoteUserMessageId = "um-1",
            )
        )
        advance("req-v2", OutboxStateMachine.AWAITING_AI)
        advance("req-v2", OutboxStateMachine.COMPLETED)

        val done = dao.getById("req-v2")!!
        assertEquals("completed", done.state)
        assertEquals("task-9", done.taskId)
        assertEquals("um-1", done.remoteUserMessageId)
        assertEquals(1000L, done.updatedAt)
        assertNull(done.lastErrorCode)
    }

    @Test
    fun `发送失败 failed_send 重试计数递增且退避递增封顶`() = runTest {
        dao.upsert(makeOutbox("req-dup", state = "queued"))
        advance("req-dup", OutboxStateMachine.SENDING)
        // 第 1 次失败
        advance("req-dup", OutboxStateMachine.FAILED_SEND, now = 10_000L, countRetry = true)
        val failed = dao.getById("req-dup")!!
        assertEquals(OutboxStateMachine.FAILED_SEND, failed.state)
        assertEquals(1, failed.retryCount)
        assertEquals(10_000L + 1_000L, failed.nextAttemptAt)

        // 重试：failed_send → queued（幂等键保持，退避清除）
        advance("req-dup", OutboxStateMachine.QUEUED)
        val queued = dao.getById("req-dup")!!
        assertEquals(OutboxStateMachine.QUEUED, queued.state)
        assertEquals(1, queued.retryCount)
        assertNull(queued.nextAttemptAt)

        // 再次失败退避翻倍
        advance("req-dup", OutboxStateMachine.SENDING)
        advance("req-dup", OutboxStateMachine.FAILED_SEND, now = 20_000L, countRetry = true)
        assertEquals(2, dao.getById("req-dup")!!.retryCount)
        assertEquals(20_000L + 2_000L, dao.getById("req-dup")!!.nextAttemptAt)
    }

    @Test
    fun `生成失败 failed_generation 与发送失败状态区分`() = runTest {
        dao.upsert(makeOutbox("req-gen").copy(deviceId = "pc-1"))
        advance("req-gen", OutboxStateMachine.SENDING)
        advance("req-gen", OutboxStateMachine.USER_COMMITTED)
        advance("req-gen", OutboxStateMachine.AWAITING_AI)
        advance("req-gen", OutboxStateMachine.FAILED_GENERATION, now = 5_000L, countRetry = true)

        val row = dao.getById("req-gen")!!
        assertEquals(OutboxStateMachine.FAILED_GENERATION, row.state)
        assertEquals("E", row.lastErrorCode)
        assertEquals(1, row.retryCount)
        // 生成重试：failed_generation → awaiting_ai（不重发用户消息）
        advance("req-gen", OutboxStateMachine.AWAITING_AI)
        assertEquals(OutboxStateMachine.AWAITING_AI, dao.getById("req-gen")!!.state)
    }

    @Test
    fun `恢复矩阵 sending 回 queued user_committed 转 awaiting_ai awaiting_ai 无 taskId 保持`() = runTest {
        dao.upsert(makeOutbox("r1", state = OutboxStateMachine.QUEUED))
        dao.upsert(makeOutbox("r2", state = OutboxStateMachine.FAILED_SEND, retryCount = 1))
        dao.upsert(makeOutbox("r3", state = OutboxStateMachine.SENDING))
        dao.upsert(makeOutbox("r4", state = OutboxStateMachine.USER_COMMITTED))
        dao.upsert(makeOutbox("r5", state = OutboxStateMachine.AWAITING_AI))

        // 模拟 restoreOutbox 恢复矩阵（legacy 行除外，同 OnlineChatRepository.restoreOutbox）
        for (item in dao.listPending()) {
            when (item.state) {
                OutboxStateMachine.SENDING -> advance(item.requestId, OutboxStateMachine.QUEUED)
                OutboxStateMachine.USER_COMMITTED -> advance(item.requestId, OutboxStateMachine.AWAITING_AI)
                else -> Unit
            }
        }
        assertEquals(OutboxStateMachine.QUEUED, dao.getById("r1")!!.state)
        // failed_send 保持（同生产 restoreOutbox：failed_* 不自动回队，由重连自动重试/用户点重试）
        assertEquals(OutboxStateMachine.FAILED_SEND, dao.getById("r2")!!.state)
        // 强杀时序：sending 回退 queued（同 requestId 重发）
        assertEquals(OutboxStateMachine.QUEUED, dao.getById("r3")!!.state)
        assertEquals(OutboxStateMachine.AWAITING_AI, dao.getById("r4")!!.state) // 不重发用户消息
        assertEquals(OutboxStateMachine.AWAITING_AI, dao.getById("r5")!!.state) // 保持等待
    }

    @Test
    fun `同状态幂等转换不抛错且终态不可转换`() = runTest {
        dao.upsert(makeOutbox("req-idem", state = OutboxStateMachine.SENDING))
        // 并发双发幂等：sending→sending 不抛
        advance("req-idem", OutboxStateMachine.SENDING)
        assertEquals(OutboxStateMachine.SENDING, dao.getById("req-idem")!!.state)

        dao.upsert(makeOutbox("req-term", state = OutboxStateMachine.COMPLETED))
        try {
            advance("req-term", OutboxStateMachine.SENDING)
            fail("终态转换必须被拒绝")
        } catch (e: IllegalStateException) {
            assertTrue(e.message!!.contains("非法状态转换"))
        }
        // 非法跳变（queued→completed）拒绝
        dao.upsert(makeOutbox("req-skip", state = OutboxStateMachine.QUEUED))
        try {
            advance("req-skip", OutboxStateMachine.COMPLETED)
            fail("queued→completed 必须被拒绝")
        } catch (e: IllegalStateException) {
            assertTrue(e.message!!.contains("非法状态转换"))
        }
    }

    @Test
    fun `取消 cancelled 为终态且清除退避`() = runTest {
        dao.upsert(makeOutbox("req-cancel", state = OutboxStateMachine.QUEUED))
        advance("req-cancel", OutboxStateMachine.SENDING)
        advance("req-cancel", OutboxStateMachine.CANCELLED)
        val row = dao.getById("req-cancel")!!
        assertEquals(OutboxStateMachine.CANCELLED, row.state)
        assertNull(row.nextAttemptAt)
        assertTrue(OutboxStateMachine.TERMINAL.contains(row.state))
    }

    @Test
    fun `replyToId 持久化往返`() = runTest {
        dao.upsert(OutboxMessage("req-reply", "s1", "hi", "[]", "msg-123", System.currentTimeMillis(), 0, "queued"))
        val loaded = dao.listForSession("s1").first()
        assertEquals("msg-123", loaded.replyToId)
        // 状态机推进保持引用语义
        advance("req-reply", OutboxStateMachine.SENDING)
        assertEquals("msg-123", dao.getById("req-reply")!!.replyToId)
        val pending = PendingMessage(loaded.requestId, loaded.content, loaded.createdAt, false, emptyList(), loaded.replyToId)
        assertEquals("msg-123", pending.replyToId)
    }

    @Test
    fun `Room 裁剪与孤儿清理测试`() = runTest {
        val sessions = (1..12).map { i -> CachedSession("s$i", "c1", "name", "title $i", i.toLong(), i.toLong(), 0, "") }
        for (s in sessions) dao.upsert(makeOutbox("req-${s.id}", sessionId = s.id))
        assertEquals(12, dao.listAll().size)

        dao.trimSessions(sessions, 10)
        val remaining = dao.listAll().map { it.sessionId }.toSet()
        assertFalse(remaining.contains("s1"))
        assertFalse(remaining.contains("s2"))
        assertTrue(remaining.contains("s3"))
        assertEquals(10, remaining.size)

        dao.deleteOrphan(setOf("s3","s4"))
        assertEquals(2, dao.listAll().size)
    }

    @Test
    fun `observeForSession 按 sessionId 过滤且 completed 不展示`() = runTest {
        dao.upsert(makeOutbox("a1", sessionId = "s1", state = "queued"))
        dao.upsert(makeOutbox("a2", sessionId = "s1", state = OutboxStateMachine.FAILED_SEND))
        dao.upsert(makeOutbox("b1", sessionId = "s2", state = "queued"))
        dao.upsert(makeOutbox("a3", sessionId = "s1", state = "completed"))

        val forS1 = dao.observeForSession("s1").first().filter { it.state != "completed" }
        assertEquals(2, forS1.size)
        assertTrue(forS1.all { it.sessionId == "s1" })
        val mapped = forS1.map { PendingMessage(it.requestId, it.content, it.createdAt, it.state == OutboxStateMachine.FAILED_SEND, emptyList(), it.replyToId) }
        assertEquals(1, mapped.count { it.failed })
    }

    @Test
    fun `图片 base64 往返（JSON 数组）`() = runTest {
        val images = listOf("base64-111", "base64-222")
        val jsonInstance = Json { ignoreUnknownKeys = true }
        val jsonStr = jsonInstance.encodeToString<List<String>>(images)
        dao.upsert(OutboxMessage("req-img", "s1", "hi", jsonStr, null, System.currentTimeMillis(), 0, "queued"))
        val loaded = dao.getById("req-img")!!
        // 状态机推进保持 imagesJson 原样（重试路径不丢图）
        advance("req-img", OutboxStateMachine.SENDING)
        assertEquals(jsonStr, dao.getById("req-img")!!.imagesJson)
        val decoded = jsonInstance.decodeFromString<List<String>>(loaded.imagesJson)
        assertEquals(images, decoded)
    }
}
