package com.qingyu.companion.phase4

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.chatcore.LocalChatGenerationUseCase
import com.qingyu.companion.chatcore.ModelGateway
import com.qingyu.companion.data.local.LocalChatRepository
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalLorebookEntity
import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.domain.RoomLocalSyncRepository
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelError
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.ModelRequestHandle
import com.qingyu.companion.network.models.ModelStreamEvent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * 阶段 4 S4-06 实机验收：**本地单聊闭环在真实 SQLite 上跑通**。
 *
 * 与 JVM/Robolectric 版本的分工：
 * - `LocalChatRepositoryTest`（Robolectric + FakeLocalStore）验证**逻辑契约**；
 * - 本测试用真实 Room 库 + 真实文件系统，验证**生产数据路径**：
 *   `seq` 排序、分页游标、tombstone 写入、`listConnectionProfiles` 读取、
 *   以及「关闭 PC 与 Relay 后仍能连续多轮聊天」这条完成定义的最小可执行形式
 *   （模型调用由脚本化网关替代，其余全部是生产实现）。
 *
 * 阶段 4 §4 要求按 API 档位执行；报告需记录 API 等级与镜像版本。
 */
@RunWith(AndroidJUnit4::class)
class LocalChatFlowInstrumentedTest {

    private lateinit var database: QingyuLocalDatabase
    private lateinit var store: RoomLocalSyncRepository

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        // 必须用 deleteDatabase：它连同 `-wal`/`-shm` 旁路文件一起删除。
        // 只删主文件会留下残留 WAL，新连接读到空主库 + 旧 WAL →
        // "no such table: local_messages"（曾在本机真机门禁上造成偶发失败）。
        context.deleteDatabase(QingyuLocalDatabase.NAME)
        database = Room.databaseBuilder(context, QingyuLocalDatabase::class.java, QingyuLocalDatabase.NAME)
            .addCallback(QingyuLocalDatabase.FOREIGN_KEYS_CALLBACK)
            .build()
        store = RoomLocalSyncRepository(database, "phase4-instrumented")
    }

    @After
    fun tearDown() {
        runCatching { database.close() }
    }

    /** 脚本队列网关：每次生成消费一段脚本（与单测替身同语义）。 */
    private class ScriptedGateway(scripts: List<List<ModelStreamEvent>>) : ModelGateway {
        private val queue = ArrayDeque(scripts)
        var lastRequest: ModelChatRequest? = null
        var callCount = 0
            private set

        override fun stream(
            provider: ModelProvider,
            profile: ConnectionProfilePublic,
            request: ModelChatRequest,
            apiKey: String?,
        ): Pair<Flow<ModelStreamEvent>, ModelRequestHandle> {
            lastRequest = request
            callCount++
            val script = if (queue.isEmpty()) emptyList() else queue.removeFirst()
            val handle = object : ModelRequestHandle {
                override fun cancel() = Unit
                override val isCancelled: Boolean = false
            }
            return flow { script.forEach { emit(it) } } to handle
        }
    }

    private class Seq(private val prefix: String) {
        private var n = 0
        fun next(): String = "$prefix-${++n}"
    }

    private fun chunk(text: String) = ModelStreamEvent.Chunk(
        com.qingyu.companion.network.models.ModelChunk(deltaText = text),
    )

    private fun finish(reason: String = "stop") = ModelStreamEvent.Chunk(
        com.qingyu.companion.network.models.ModelChunk(deltaText = "", finished = true, finishReason = reason),
    )

    private class Harness(
        val store: RoomLocalSyncRepository,
        val repository: LocalChatRepository,
        val gateway: ScriptedGateway,
    )

    private suspend fun harness(scripts: List<List<ModelStreamEvent>>): Harness {
        // 角色 + 会话 + 连接档案：全部落在真实库上（模拟「已配置模型直连」的本地状态）
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "苏晚", createdAt = 0, updatedAt = 0))
        store.putSession(LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0))
        store.upsertConnectionProfile(
            LocalConnectionProfileEntity(
                id = "p1",
                provider = "openai",
                baseUrl = "https://api.example.com/v1",
                model = "gpt-4o-mini",
                createdAt = 0,
                updatedAt = 0,
            ),
        )
        val gateway = ScriptedGateway(scripts)
        val ids = Seq("id")
        val generation = LocalChatGenerationUseCase(
            store = store,
            gateway = gateway,
            profileProvider = {
                // 与 AppContainer 同路径：从真实库读档案再转 public 视图
                store.listConnectionProfiles().firstOrNull()?.let { profile ->
                    ConnectionProfilePublic(
                        id = profile.id,
                        provider = ModelProvider.fromWire(profile.provider) ?: ModelProvider.OpenAI,
                        baseUrl = profile.baseUrl,
                        model = profile.model,
                        allowHttp = profile.allowHttp,
                    )
                }
            },
            apiKeyProvider = { "sk-instrumented" },
            idFactory = { ids.next() },
        )
        return Harness(
            store,
            LocalChatRepository(
                store,
                generation,
                // 生成默认跑在仓库自有的 IO 作用域（不依赖 UI 生命周期）。
                // 本测试断言终局状态，故注入 Unconfined 让生成在 sendMessage 内尽早完成，保持确定性。
                kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined),
            ) { ids.next() },
            gateway,
        )
    }

    // ---------------------------------------------------------------- 完成定义的最小可执行形式

    /**
     * 等待 assistant 消息出现（生成在仓库自有作用域内异步进行）。
     *
     * 为什么必须轮询：生产实现把生成放在独立作用域（阶段 4 §1「生成任务独立于 Compose 生命周期」），
     * `sendMessage` 只保证用户消息落地即刻返回。用「睡固定时长」会在慢设备上偶发失败，
     * 因此按条件轮询并在超时后给出明确断言失败。
     */
    private suspend fun awaitAssistantMessageCount(sessionId: String, expected: Int, timeoutMs: Long = 10_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val count = store.listMessages(sessionId).count { it.role == "assistant" }
            if (count >= expected) return
            kotlinx.coroutines.delay(50)
        }
        val actual = store.listMessages(sessionId).count { it.role == "assistant" }
        assertEquals("等待 assistant 消息超时（期望 $expected 条）", expected, actual)
    }

    @Test
    fun multiTurnChatWorksEntirelyOnLocalDatabase() = runBlocking {
        val h = harness(
            listOf(
                listOf(chunk("夜安，"), chunk("我在。"), finish()),
                listOf(chunk("第二轮的回复"), finish()),
                listOf(chunk("第三轮的回复"), finish()),
            ),
        )

        // 第一轮：本机写入 + 本地生成 + 终局落盘
        h.repository.sendMessage("s1", "r1", "在吗")
        awaitAssistantMessageCount("s1", 1)
        // 请求由共享装配器产出：首条 system 提示 + 对话历史
        assertEquals("system", h.gateway.lastRequest!!.messages.first().role)
        assertEquals(1, h.gateway.lastRequest!!.messages.count { it.role != "system" })

        h.repository.sendMessage("s1", "r2", "继续说")
        awaitAssistantMessageCount("s1", 2)
        h.repository.sendMessage("s1", "r3", "再说一句")
        awaitAssistantMessageCount("s1", 3)

        assertEquals(3, h.gateway.callCount)
        val messages = h.repository.listMessages("s1").messages
        assertEquals("三轮共 6 条消息", 6, messages.size)
        assertEquals(
            listOf("user", "assistant", "user", "assistant", "user", "assistant"),
            messages.map { it.role.name },
        )
        assertEquals("夜安，我在。", messages[1].content)
        assertEquals("第三轮的回复", messages[5].content)

        // 第三轮请求必须带上前两轮完整历史 + 本轮输入（记忆闭环的前提）
        val conversation = h.gateway.lastRequest!!.messages.filter { it.role != "system" }
        assertEquals(5, conversation.size)
        assertEquals("在吗", conversation[0].content)
    }

    @Test
    fun pagingCursorReturnsOlderPageWithoutOverlap() = runBlocking {
        val h = harness(List(6) { listOf(chunk("ok"), finish()) })
        repeat(6) { index -> h.repository.sendMessage("s1", "r$index", "第${index + 1}句") }
        awaitAssistantMessageCount("s1", 6)

        // 12 条消息 < PAGE_SIZE(30) → 一页返回全部；游标指向更早页时为空且不重叠
        val all = h.repository.listMessages("s1").messages
        assertEquals(12, all.size)
        val older = h.repository.listMessages("s1", beforeId = all.first().id)
        assertTrue("第一条之前不应还有消息", older.messages.isEmpty())
    }

    @Test
    fun editsAndDeletesAreTombstonedOnRealSqlite() = runBlocking {
        val h = harness(listOf(listOf(chunk("原始回复"), finish())))
        h.repository.sendMessage("s1", "r1", "问")
        awaitAssistantMessageCount("s1", 1)
        val assistant = h.repository.listMessages("s1").messages.first { it.role.name == "assistant" }

        h.repository.editMessage("s1", assistant.id, "改后正文")
        assertEquals("改后正文", h.store.listMessages("s1").first { it.id == assistant.id }.content)

        h.repository.deleteMessage("s1", assistant.id)
        assertNull(h.store.listMessages("s1").firstOrNull { it.id == assistant.id })
        assertTrue("删除必须写 tombstone（跨设备同步语义）", h.store.isTombstoned("message", assistant.id))
    }

    @Test
    fun sessionDeleteCascadesAndBranchKeepsIndependentHistory() = runBlocking {
        val h = harness(listOf(listOf(chunk("回复"), finish())))
        h.repository.sendMessage("s1", "r1", "问")
        awaitAssistantMessageCount("s1", 1)
        val target = h.repository.listMessages("s1").messages[0]

        val branch = h.repository.branchSession("s1", target.id)
        assertTrue("分支必须是新会话", branch.id != "s1")
        val branchMessages = h.repository.listMessages(branch.id).messages
        assertEquals(1, branchMessages.size)
        assertTrue("分支消息必须换新 id", branchMessages[0].id != target.id)

        // 删除原会话：消息级联删除，会话进入 tombstone
        h.repository.deleteSession("s1")
        assertNull(h.store.getSession("s1"))
        assertTrue(h.store.listMessages("s1").isEmpty())
        assertTrue(h.store.isTombstoned("session", "s1"))
    }

    @Test
    fun failedGenerationKeepsUserMessageAndCreatesNoAssistantMessage() = runBlocking {
        val h = harness(
            listOf(
                listOf(
                    chunk("半截"),
                    ModelStreamEvent.Failure(ModelError("IO_ERROR", "connection reset", retryable = true)),
                ),
            ),
        )

        // 契约：生成失败经 Error 事件上报，不从 sendMessage 抛出（与在线实现一致）
        val returned = h.repository.sendMessage("s1", "r1", "问" )
        assertEquals("user", returned.role.name)
        kotlinx.coroutines.delay(500)

        val messages = h.repository.listMessages("s1").messages
        assertEquals("失败时用户消息保留、不得创建 assistant 消息", 1, messages.size)
        assertEquals("user", messages[0].role.name)
    }

    @Test
    fun charactersAndProfilesAreReadFromLocalDatabase() = runBlocking {
        val h = harness(listOf(listOf(chunk("x"), finish())))
        assertEquals(listOf("苏晚"), h.repository.listCharacters().map { it.name })
        assertEquals(listOf("gpt-4o-mini"), h.repository.listModels())
        assertEquals(1, h.repository.listSessions().size)
    }

    @Test
    fun unsupportedCapabilitiesDegradeToActionableEmptyResults() = runBlocking {
        val h = harness(listOf(listOf(chunk("x"), finish())))
        // 仍属未迁移（阶段 5/6）的能力：必须返回可行动的空结果 + 留下提示
        assertNull(h.repository.fetchVersionInfo())
        assertTrue("群聊属阶段 6", h.repository.listGroups().isEmpty())
        assertNotNull("未迁移能力必须留下可行动提示", h.repository.unsupportedNotice.value)
    }

    @Test
    fun quickSettingsReadAndWriteLocalTablesOnly() = runBlocking {
        // S4-06：快捷设置面板在本地模式下必须真的可读可写（此前一律空结果 + 保存失败）
        val h = harness(listOf(listOf(chunk("x"), finish())))
        val store = h.store
        store.putLorebook(
            com.qingyu.companion.local.db.LocalLorebookEntity(
                id = "lb1",
                name = "城市设定",
                canonicalJson = """{"entries":[{"id":"e1"}]}""",
                createdAt = 0,
                updatedAt = 0,
            ),
        )
        store.putPreset(
            com.qingyu.companion.local.db.LocalPresetEntity(
                id = "ps1",
                name = "默认预设",
                createdAt = 0,
                updatedAt = 0,
            ),
        )

        assertEquals(listOf("城市设定"), h.repository.listLorebooks().map { it.name })
        assertEquals(listOf("默认预设"), h.repository.listPresets().map { it.name })

        h.repository.setSessionLorebooks("s1", listOf("lb1"))
        h.repository.setSessionPreset("s1", "ps1")
        assertEquals(listOf("lb1"), h.repository.getSessionLorebooks("s1"))
        assertEquals("ps1", h.repository.getSessionPreset("s1"))

        // 记忆开关与策略也落在会话行（面板可开关记忆）
        h.repository.patchSessionMemory("s1", memoryEnabled = true, memoryMode = "auto", autoMemoryInterval = 5, characterId = "c1")
        val memory = h.repository.getSessionMemory("s1", "c1")
        assertEquals(true, memory.memoryEnabled)
        assertEquals("auto", memory.memoryMode)
        assertEquals(5, memory.autoMemoryInterval)
    }
}
