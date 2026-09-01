package com.qingyu.companion.data

import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.model.TaskSnapshotDto
import com.qingyu.companion.network.ConnectionManager
import com.qingyu.companion.network.QingyuApi
import com.qingyu.companion.network.WsClient
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * F-04/F-06：发件箱恢复矩阵 + legacy 归属修复测试（JVM，Fake Room 数据库与连接层）。
 * 覆盖 App 强杀场景：直接调 restoreOutbox 断言状态。
 * - sending → queued（同 requestId 重发）
 * - user_committed → awaiting_ai（不重发用户消息）
 * - awaiting_ai + taskId → 按任务快照终态落库（completed/failed/cancelled）
 * - awaiting_ai 无 taskId → 保持等待
 * - legacy 行不处理、不自动发送；修复采纳当前活跃 PC
 */
class OutboxRestoreTest {

    // ---------- Fakes ----------

    private class FakeOutboxDao : OutboxDao {
        val store = LinkedHashMap<String, OutboxMessage>()
        val flow = MutableStateFlow<List<OutboxMessage>>(emptyList())
        private fun emit() { flow.value = store.values.sortedBy { it.createdAt } }

        override suspend fun listForSession(sessionId: String) = store.values.filter { it.sessionId == sessionId }.sortedBy { it.createdAt }
        override fun observeForSession(sessionId: String): Flow<List<OutboxMessage>> =
            flow.map { list -> list.filter { it.sessionId == sessionId } }
        override suspend fun listAll() = store.values.sortedBy { it.createdAt }
        override suspend fun upsert(item: OutboxMessage) { store[item.requestId] = item; emit() }
        override suspend fun getById(requestId: String) = store[requestId]
        override suspend fun updateState(requestId: String, state: String, error: String?, retryCount: Int) {
            store[requestId]?.let { store[requestId] = it.copy(state = state, error = error, retryCount = retryCount); emit() }
        }
        override suspend fun delete(requestId: String) { store.remove(requestId); emit() }
        override suspend fun clearCompleted(sessionId: String) { store.entries.removeIf { it.value.sessionId == sessionId && it.value.state == "completed" }; emit() }
        override suspend fun clearAllCompleted() { store.entries.removeIf { it.value.state == "completed" }; emit() }
        override suspend fun deleteOrphan() { emit() }
        override suspend fun clear() { store.clear(); emit() }
        override suspend fun listPending() = store.values.filter { it.state in PENDING_STATES }.sortedBy { it.createdAt }
        override suspend fun listPendingForDevice(deviceId: String) = store.values.filter { it.deviceId == deviceId && it.state in PENDING_STATES }
        override suspend fun listLegacyPending() = store.values.filter { it.deviceId == "legacy" && it.state in PENDING_STATES }
        override suspend fun countLegacyPending() = store.values.count { it.deviceId == "legacy" && it.state in PENDING_STATES }
        override suspend fun adoptLegacyPending(deviceId: String, now: Long): Int {
            var n = 0
            store.keys.toList().forEach { key ->
                val v = store.getValue(key)
                if (v.deviceId == "legacy" && v.state in PENDING_STATES) {
                    store[key] = v.copy(deviceId = deviceId, updatedAt = now); n++
                }
            }
            emit(); return n
        }

        private companion object {
            val PENDING_STATES = setOf("queued", "sending", "relay_queued", "user_committed", "awaiting_ai", "failed_send", "failed_generation")
        }
    }

    private class FakeTaskCursorDao : TaskCursorDao {
        val store = mutableMapOf<Pair<String, String>, TaskCursorEntity>()
        override suspend fun get(deviceId: String, taskId: String) = store[deviceId to taskId]
        override suspend fun listForDevice(deviceId: String) = store.values.filter { it.deviceId == deviceId }
        override suspend fun listForSession(deviceId: String, sessionId: String) = store.values.filter { it.deviceId == deviceId && it.sessionId == sessionId }
        override suspend fun upsert(cursor: TaskCursorEntity) { store[cursor.deviceId to cursor.taskId] = cursor }
        override suspend fun clearDevice(deviceId: String) { store.entries.removeIf { it.key.first == deviceId } }
        override suspend fun clear() = store.clear()
    }

    private class FakeMessageDao : CachedMessageDao {
        val messages = mutableListOf<CachedMessage>()
        override suspend fun listRecent(sessionId: String, limit: Int) = messages.filter { it.sessionId == sessionId }.take(limit)
        override suspend fun upsertAll(messages: List<CachedMessage>) { this.messages.addAll(messages) }
        override suspend fun deleteById(messageId: String) { messages.removeAll { it.id == messageId } }
        override suspend fun deleteBySession(sessionId: String) { messages.removeAll { it.sessionId == sessionId } }
        override suspend fun clear() = messages.clear()
        override suspend fun trimTo(sessionId: String, limit: Int) = Unit
        override suspend fun deleteOrphanMessages() = Unit
    }

    private class FakeSessionDao : CachedSessionDao {
        val sessions = mutableListOf<CachedSession>()
        override suspend fun listAll() = sessions.toList()
        override suspend fun upsert(session: CachedSession) { sessions.add(session) }
        override suspend fun upsertAll(sessions: List<CachedSession>) { this.sessions.addAll(sessions) }
        override suspend fun delete(sessionId: String) { sessions.removeAll { it.id == sessionId } }
        override suspend fun clear() = sessions.clear()
        override suspend fun trimTo(limit: Int) = Unit
    }

    private class FakeCacheDatabase : CacheDatabase() {
        val outbox = FakeOutboxDao()
        val cursors = FakeTaskCursorDao()
        val messages = FakeMessageDao()
        val sessions = FakeSessionDao()
        override fun sessionDao() = sessions
        override fun messageDao() = messages
        override fun outboxDao() = outbox
        override fun taskCursorDao() = cursors
        override fun clearAllTables() = Unit
        // Fake 库不走 Room 运行时（事务经注入的 transactionRunner 直执行）。
        // Room 构造期会急切创建 InvalidationTracker，故返回真实实例（不会真正运行）；
        // 仅 OpenHelper 保持拒绝——Fake 不应触碰真实 SQLite。
        override fun createInvalidationTracker(): androidx.room.InvalidationTracker =
            androidx.room.InvalidationTracker(
                this,
                "cached_sessions", "cached_messages", "outbox_messages", "task_cursors",
            )
        override fun createOpenHelper(config: androidx.room.DatabaseConfiguration): androidx.sqlite.db.SupportSQLiteOpenHelper =
            throw UnsupportedOperationException("FakeCacheDatabase 不支持 OpenHelper")
    }

    private class FakeConnectionStore : ConnectionStore {
        var active: ServerConnection? = null
        override suspend fun loadAll() = emptyList<ServerConnection>()
        override suspend fun save(connection: ServerConnection) = Unit
        override suspend fun remove(deviceId: String) = Unit
        override suspend fun setActive(deviceId: String?) = Unit
        override suspend fun getActive() = active
        override suspend fun wipe() { active = null }
    }

    private class FakeConnectionManager : ConnectionManager {
        var connection: ServerConnection? = null
        override val activeConnection: ServerConnection? get() = connection
        override val activeFlow: StateFlow<ServerConnection?> = MutableStateFlow(connection)
        override val tokenInvalidated: MutableSharedFlow<Unit> = MutableSharedFlow()
        override suspend fun restore() = Unit
        override suspend fun listConnections() = emptyList<ServerConnection>()
        override suspend fun addConnection(connection: ServerConnection) = Unit
        override suspend fun switchTo(deviceId: String) = Unit
        override suspend fun remove(deviceId: String) = Unit
        override suspend fun disconnectAll() = Unit
        override suspend fun checkCompatibility(connection: ServerConnection): ConnectionManager.CompatibilityResult =
            ConnectionManager.CompatibilityResult.Compatible
        override fun activeApi(): QingyuApi? = null
        override fun anonApi(connection: ServerConnection): QingyuApi = throw UnsupportedOperationException()
    }

    private class FakeWsClient : WsClient {
        override val state: StateFlow<WsClient.State> = MutableStateFlow(WsClient.State.DISCONNECTED)
        override val events: SharedFlow<CompanionEvent> = MutableSharedFlow()
        override suspend fun connect(connection: ServerConnection) = Unit
        override fun disconnect() = Unit
        override suspend fun stopGeneration(requestId: String) = Unit
    }

    // ---------- 构造 ----------

    private fun row(
        requestId: String,
        state: String,
        deviceId: String = "pc-1",
        taskId: String? = null,
        sessionId: String = "s1",
    ) = OutboxMessage(
        requestId = requestId,
        sessionId = sessionId,
        content = "内容 $requestId",
        imagesJson = """["img-1"]""",
        replyToId = "reply-9",
        createdAt = 1L,
        retryCount = 0,
        state = state,
        deviceId = deviceId,
        taskId = taskId,
        updatedAt = 1L,
    )

    private fun connection(deviceId: String, capabilities: Set<String> = emptySet()) = ServerConnection(
        name = "PC", host = "192.168.1.10", port = 8321, token = "t",
        deviceId = deviceId, fingerprint = "f", capabilities = capabilities,
    )

    private fun repository(
        db: FakeCacheDatabase,
        manager: FakeConnectionManager,
        store: FakeConnectionStore,
    ): OnlineChatRepository = OnlineChatRepository(
        connectionManager = manager,
        connectionStore = store,
        wsClient = FakeWsClient(),
        db = db,
        json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true },
        // 事务直执行：JVM 测试脱离 Room（生产默认 db.withTransaction）
        transactionRunner = { block -> block() },
    )

    // ---------- 恢复矩阵 ----------

    @Test
    fun `强杀恢复矩阵-sending 回 queued 同 requestId 重发`() = runTest {
        val db = FakeCacheDatabase()
        db.outbox.upsert(row("r1", "sending"))
        val repo = repository(db, FakeConnectionManager(), FakeConnectionStore().apply { active = connection("pc-1") })

        repo.restoreOutbox()

        assertEquals("queued", db.outbox.getById("r1")!!.state)
        // requestId/图片/引用保持
        assertEquals("r1", db.outbox.getById("r1")!!.requestId)
        assertEquals("""["img-1"]""", db.outbox.getById("r1")!!.imagesJson)
        assertEquals("reply-9", db.outbox.getById("r1")!!.replyToId)
    }

    @Test
    fun `强杀恢复矩阵-user_committed 不重发用户消息 转 awaiting_ai`() = runTest {
        val db = FakeCacheDatabase()
        db.outbox.upsert(row("r2", "user_committed", taskId = "t-1").copy(remoteUserMessageId = "um-1"))
        val repo = repository(db, FakeConnectionManager(), FakeConnectionStore().apply { active = connection("pc-1") })
        repo.taskSnapshotResolver = { TaskSnapshotDto(taskId = it, state = "streaming") }

        repo.restoreOutbox()

        assertEquals("awaiting_ai", db.outbox.getById("r2")!!.state)
        assertEquals("um-1", db.outbox.getById("r2")!!.remoteUserMessageId) // 不重发，标识保持
        assertEquals("t-1", db.outbox.getById("r2")!!.taskId)
    }

    @Test
    fun `强杀恢复矩阵-awaiting_ai 有 taskId 按快照终态落库`() = runTest {
        val db = FakeCacheDatabase()
        db.outbox.upsert(row("r-done", "awaiting_ai", taskId = "t-done"))
        db.outbox.upsert(row("r-fail", "awaiting_ai", taskId = "t-fail"))
        db.outbox.upsert(row("r-cancel", "awaiting_ai", taskId = "t-cancel"))
        db.outbox.upsert(row("r-run", "awaiting_ai", taskId = "t-run"))
        db.outbox.upsert(row("r-notask", "awaiting_ai"))
        val repo = repository(db, FakeConnectionManager(), FakeConnectionStore().apply { active = connection("pc-1") })
        repo.taskSnapshotResolver = { taskId ->
            when (taskId) {
                "t-done" -> TaskSnapshotDto(taskId = taskId, state = "completed", accumulatedText = "生成结果", lastSequence = 9)
                "t-fail" -> TaskSnapshotDto(taskId = taskId, state = "failed", lastSequence = 9)
                "t-cancel" -> TaskSnapshotDto(taskId = taskId, state = "cancelled", lastSequence = 9)
                else -> TaskSnapshotDto(taskId = taskId, state = "streaming", lastSequence = 5)
            }
        }

        repo.restoreOutbox()

        assertEquals("completed", db.outbox.getById("r-done")!!.state)
        assertEquals("failed_generation", db.outbox.getById("r-fail")!!.state)
        assertEquals("cancelled", db.outbox.getById("r-cancel")!!.state)
        assertEquals("awaiting_ai", db.outbox.getById("r-run")!!.state) // 仍在生成：保持等待
        assertEquals("awaiting_ai", db.outbox.getById("r-notask")!!.state) // 无 taskId：保持等待
        // completed 行落库最终消息（短期审计，clearCompletedOutbox 清理）
        assertEquals(1, db.messages.messages.count { it.content == "生成结果" })
    }

    @Test
    fun `强杀恢复矩阵-任务快照查询失败保持 awaiting_ai 兜底不丢`() = runTest {
        val db = FakeCacheDatabase()
        db.outbox.upsert(row("r9", "awaiting_ai", taskId = "t-404"))
        val repo = repository(db, FakeConnectionManager(), FakeConnectionStore().apply { active = connection("pc-1") })
        repo.taskSnapshotResolver = { null }

        repo.restoreOutbox()

        assertEquals("awaiting_ai", db.outbox.getById("r9")!!.state)
    }

    // ---------- legacy 归属修复 ----------

    @Test
    fun `legacy 修复-有活跃连接时回填当前 deviceId 且不自动发送`() = runTest {
        val db = FakeCacheDatabase()
        db.outbox.upsert(row("lg-1", "queued", deviceId = "legacy"))
        db.outbox.upsert(row("lg-2", "sending", deviceId = "legacy"))
        val store = FakeConnectionStore().apply { active = connection("pc-1") }
        val repo = repository(db, FakeConnectionManager(), store)

        val adopted = repo.repairLegacyOutbox()

        assertEquals(2, adopted)
        assertEquals("pc-1", db.outbox.getById("lg-1")!!.deviceId)
        assertEquals("pc-1", db.outbox.getById("lg-2")!!.deviceId)
        assertFalse(repo.pendingLegacyOutbox.value)
        // 修复只改归属，不改状态——不会自动发送
        assertEquals("sending", db.outbox.getById("lg-2")!!.state)
    }

    @Test
    fun `legacy 修复-无活跃连接保持 legacy 并置位 pendingLegacyOutbox`() = runTest {
        val db = FakeCacheDatabase()
        db.outbox.upsert(row("lg-1", "queued", deviceId = "legacy"))
        val store = FakeConnectionStore() // active = null
        val repo = repository(db, FakeConnectionManager(), store)

        val adopted = repo.repairLegacyOutbox()

        assertEquals(0, adopted)
        assertEquals("legacy", db.outbox.getById("lg-1")!!.deviceId)
        assertTrue(repo.pendingLegacyOutbox.value)
        // legacy 行不参与恢复（不自动发送）
        repo.restoreOutbox()
        assertEquals("queued", db.outbox.getById("lg-1")!!.state)
    }

    @Test
    fun `restoreOutbox 刷新 pendingLegacyOutbox 状态`() = runTest {
        val db = FakeCacheDatabase()
        db.outbox.upsert(row("lg-1", "failed_send", deviceId = "legacy"))
        val repo = repository(db, FakeConnectionManager(), FakeConnectionStore().apply { active = connection("pc-1") })

        assertFalse(repo.pendingLegacyOutbox.value)
        // 修复未跑时 restore 直接暴露 legacy 提示状态
        repo.restoreOutbox()
        assertTrue(repo.pendingLegacyOutbox.value)
        // 修复后清除
        repo.repairLegacyOutbox()
        assertFalse(repo.pendingLegacyOutbox.value)
    }

    @Test
    fun `outboxEntry 不暴露 legacy 与非活跃设备行`() = runTest {
        val db = FakeCacheDatabase()
        db.outbox.upsert(row("own", "failed_send", deviceId = "pc-1"))
        db.outbox.upsert(row("other", "failed_send", deviceId = "pc-2"))
        db.outbox.upsert(row("lg", "failed_send", deviceId = "legacy"))
        val store = FakeConnectionStore().apply { active = connection("pc-1") }
        val repo = repository(db, FakeConnectionManager(), store)

        assertEquals("own", repo.outboxEntry("own")!!.requestId)
        assertNull(repo.outboxEntry("other"))
        assertNull(repo.outboxEntry("lg"))
    }

    // ---------- cursor 持久化（deviceId 隔离） ----------

    @Test
    fun `cursor 按 deviceId-taskId 隔离存储`() = runTest {
        val db = FakeCacheDatabase()
        db.cursors.upsert(TaskCursorEntity(deviceId = "pc-1", taskId = "t1", sessionId = "s1", lastSequence = 5, updatedAt = 1L))
        db.cursors.upsert(TaskCursorEntity(deviceId = "pc-2", taskId = "t1", sessionId = "s1", lastSequence = 2, updatedAt = 1L))

        // 切 PC 不共享：pc-1 的 cursor 不影响 pc-2
        assertEquals(5L, db.cursors.get("pc-1", "t1")!!.lastSequence)
        assertEquals(2L, db.cursors.get("pc-2", "t1")!!.lastSequence)
        // 覆盖更新
        db.cursors.upsert(TaskCursorEntity(deviceId = "pc-1", taskId = "t1", sessionId = "s1", lastSequence = 6, updatedAt = 2L))
        assertEquals(6L, db.cursors.get("pc-1", "t1")!!.lastSequence)
    }
}
