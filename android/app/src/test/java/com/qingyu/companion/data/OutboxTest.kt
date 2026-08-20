package com.qingyu.companion.data

import com.qingyu.companion.model.PendingMessage
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Test

/**
 * P1-4.1 B1-2 持久化发件箱测试：不依赖 Android Room（JVM 纯内存 Fake），验证
 * - 状态机 queued to sending to awaiting_ai to completed/failed
 * - 重试计数与幂等
 * - 恢复（restoreOutbox）与清理
 * - 孤儿清理与裁剪逻辑（模拟 DAO SQL）
 */
class OutboxTest {

    // 内存 Fake DAO，模拟 Room OutboxDao 行为
    private class FakeOutboxDao {
        private val store = mutableMapOf<String, OutboxMessage>()
        private val flow = MutableStateFlow<List<OutboxMessage>>(emptyList())
        private fun emit() { flow.value = store.values.sortedBy { it.createdAt } }

        suspend fun upsert(item: OutboxMessage) { store[item.requestId] = item; emit() }
        suspend fun listForSession(sessionId: String) = store.values.filter { it.sessionId == sessionId }.sortedBy { it.createdAt }
        fun observeForSession(sessionId: String) = flow.map { list -> list.filter { it.sessionId == sessionId }.sortedBy { it.createdAt } }
        suspend fun listAll() = store.values.sortedBy { it.createdAt }
        suspend fun listPending() = store.values.filter { it.state in setOf("queued","sending","awaiting_ai","failed") }.sortedBy { it.createdAt }
        suspend fun updateState(requestId: String, state: String, error: String?, retryCount: Int) {
            store[requestId]?.let { store[requestId] = it.copy(state = state, error = error, retryCount = retryCount); emit() }
        }
        suspend fun delete(requestId: String) { store.remove(requestId); emit() }
        suspend fun clearCompleted(sessionId: String) { store.entries.removeIf { it.value.sessionId == sessionId && it.value.state == "completed" }; emit() }
        suspend fun deleteOrphan(validSessionIds: Set<String>) { store.entries.removeIf { it.value.sessionId !in validSessionIds }; emit() }
        suspend fun clear() { store.clear(); emit() }
        suspend fun trimSessions(sessions: List<CachedSession>, limit: Int) {
            val keep = sessions.sortedByDescending { it.updatedAt }.take(limit).map { it.id }.toSet()
            // 模拟 sessionDao.trimTo 的孤儿清理触发
            deleteOrphan(keep)
        }
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
        val dao = FakeOutboxDao()
        val req = "req-1"
        dao.upsert(makeOutbox(req, state = "queued"))
        assertEquals("queued", dao.listForSession("s1").first().state)

        dao.updateState(req, "sending", null, 0)
        assertEquals("sending", dao.listForSession("s1").first().state)

        dao.updateState(req, "awaiting_ai", null, 0)
        assertEquals("awaiting_ai", dao.listForSession("s1").first().state)

        dao.updateState(req, "completed", null, 0)
        dao.clearCompleted("s1")
        assertTrue(dao.listForSession("s1").isEmpty())
    }

    @Test
    fun `failed 重试计数递增且幂等重发复用 requestId`() = runTest {
        val dao = FakeOutboxDao()
        val req = "req-dup"
        dao.upsert(makeOutbox(req, state = "queued"))
        // 模拟发送失败
        dao.updateState(req, "failed", "timeout", 1)
        val failed = dao.listForSession("s1").first()
        assertEquals("failed", failed.state)
        assertEquals(1, failed.retryCount)
        assertEquals("timeout", failed.error)

        // 重试：幂等，同一 requestId 更新为 queued，retryCount 保持
        dao.updateState(req, "queued", null, failed.retryCount)
        val queued = dao.listForSession("s1").first()
        assertEquals("queued", queued.state)
        assertEquals(1, queued.retryCount)

        // 再次失败递增
        dao.updateState(req, "failed", "timeout2", 2)
        assertEquals(2, dao.listForSession("s1").first().retryCount)

        // 同一 requestId 重复 upsert 不产生重复（REPLACE）
        dao.upsert(makeOutbox(req, state = "queued", retryCount = 2))
        assertEquals(1, dao.listAll().count { it.requestId == req })
    }

    @Test
    fun `restoreOutbox 将 queued failed 重置为 queued 等待重发`() = runTest {
        val dao = FakeOutboxDao()
        dao.upsert(makeOutbox("r1", state = "queued"))
        dao.upsert(makeOutbox("r2", state = "failed", retryCount = 1))
        dao.upsert(makeOutbox("r3", state = "sending"))
        dao.upsert(makeOutbox("r4", state = "awaiting_ai"))

        // 模拟 restoreOutbox：queued/failed -> queued
        val pending = dao.listPending()
        for (item in pending) {
            if (item.state == "failed" || item.state == "queued") {
                dao.updateState(item.requestId, "queued", null, item.retryCount)
            }
        }
        val after = dao.listAll()
        assertEquals("queued", after.first { it.requestId == "r1" }.state)
        assertEquals("queued", after.first { it.requestId == "r2" }.state)
        // sending/awaiting_ai 保持（由 ViewModel 重连后按需处理）
        assertEquals("sending", after.first { it.requestId == "r3" }.state)
    }

    @Test
    fun `replyToId 持久化往返`() = runTest {
        val dao = FakeOutboxDao()
        dao.upsert(OutboxMessage("req-reply", "s1", "hi", "[]", "msg-123", System.currentTimeMillis(), 0, "queued"))
        val loaded = dao.listForSession("s1").first()
        assertEquals("msg-123", loaded.replyToId)
        // 模拟 PendingMessage 映射
        val pending = PendingMessage(loaded.requestId, loaded.content, loaded.createdAt, false, emptyList(), loaded.replyToId)
        assertEquals("msg-123", pending.replyToId)
    }

    @Test
    fun `Room 裁剪与孤儿清理测试`() = runTest {
        val dao = FakeOutboxDao()
        // 模拟会话裁剪：仅保留最近 10 条会话，孤儿 outbox 被清
        val sessions = (1..12).map { i -> CachedSession("s$i", "c1", "name", "title $i", i.toLong(), i.toLong(), 0, "") }
        // 为每个会话创建一条 outbox
        for (s in sessions) dao.upsert(makeOutbox("req-${s.id}", sessionId = s.id))
        assertEquals(12, dao.listAll().size)

        dao.trimSessions(sessions, 10)
        // 仅保留 s3..s12（updatedAt 最大的 10 个），s1/s2 的 outbox 被视为孤儿删除
        val remaining = dao.listAll().map { it.sessionId }.toSet()
        assertFalse(remaining.contains("s1"))
        assertFalse(remaining.contains("s2"))
        assertTrue(remaining.contains("s3"))
        assertEquals(10, remaining.size)

        // 消息表孤儿清理：sessionDao.trimTo 后 deleteOrphanMessages 同理（此处以 outbox 模拟）
        dao.deleteOrphan(setOf("s3","s4"))
        assertEquals(2, dao.listAll().size)
    }

    @Test
    fun `observeForSession 按 sessionId 过滤且 completed 不展示`() = runTest {
        val dao = FakeOutboxDao()
        dao.upsert(makeOutbox("a1", sessionId = "s1", state = "queued"))
        dao.upsert(makeOutbox("a2", sessionId = "s1", state = "failed"))
        dao.upsert(makeOutbox("b1", sessionId = "s2", state = "queued"))
        dao.upsert(makeOutbox("a3", sessionId = "s1", state = "completed"))

        val forS1 = dao.observeForSession("s1").first().filter { it.state != "completed" }
        assertEquals(2, forS1.size)
        assertTrue(forS1.all { it.sessionId == "s1" })
        val mapped = forS1.map { PendingMessage(it.requestId, it.content, it.createdAt, it.state == "failed", emptyList(), it.replyToId) }
        assertEquals(1, mapped.count { it.failed })
    }

    @Test
    fun `图片 base64 往返（JSON 数组）`() = runTest {
        val dao = FakeOutboxDao()
        val images = listOf("base64-111", "base64-222")
        val jsonInstance = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
        val jsonStr = jsonInstance.encodeToString<List<String>>(images)
        dao.upsert(OutboxMessage("req-img", "s1", "hi", jsonStr, null, System.currentTimeMillis(), 0, "queued"))
        val loaded = dao.listForSession("s1").first()
        val decoded = jsonInstance.decodeFromString<List<String>>(loaded.imagesJson)
        assertEquals(images, decoded)
    }
}
