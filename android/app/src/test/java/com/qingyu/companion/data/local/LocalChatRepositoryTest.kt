package com.qingyu.companion.data.local

import com.qingyu.companion.chatcore.LocalChatGenerationUseCase
import com.qingyu.companion.chatcore.ModelGateway
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.testing.FakeLocalStore
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelError
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.ModelRequestHandle
import com.qingyu.companion.network.models.ModelStreamEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 阶段 4 S4-06：本地优先 ChatRepository 的行为测试。
 *
 * 验证「关掉 PC 后 UI 仍能连续多轮聊天」的最小契约：
 * 会话/角色列表来自本地库、历史分页正确、发送走本地生成、
 * 流式增量经 `CompanionEvent` 推送、失败可被 UI 观察到。
 *
 * 事件收集用 `SharedFlow` 的 `extraBufferCapacity` 缓冲：`sendMessage` 结束后再 `toList()`
 * 取回缓冲事件，避免依赖线程时序（原实现用后台协程 + delay，属于不必要的不确定性）。
 */
class LocalChatRepositoryTest {

        /**
     * 按「每次生成一段脚本」的队列产出事件的网关。
     *
     * 早先的实现每次 `stream()` 都重放同一份脚本，导致第二次生成（swipe / 多轮）拿到的
     * 仍是第一段脚本；`secondTurn` 测试当初另建一个 gateway 就是对这一缺陷的临时绕行。
     */
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

    private class Seq {
        private var n = 0
        fun next(): String = "id-${++n}"
    }

    private fun chunk(text: String) = ModelStreamEvent.Chunk(
        com.qingyu.companion.network.models.ModelChunk(deltaText = text),
    )

    private fun finish(reason: String = "stop") = ModelStreamEvent.Chunk(
        com.qingyu.companion.network.models.ModelChunk(deltaText = "", finished = true, finishReason = reason),
    )

    private fun profile() = ConnectionProfilePublic(
        id = "p1",
        provider = ModelProvider.OpenAI,
        baseUrl = "https://api.example.com/v1",
        model = "gpt-4o-mini",
        allowHttp = false,
    )

    private class Fixture(
        val store: FakeLocalStore,
        val repository: LocalChatRepository,
        val gateway: ScriptedGateway,
        /** 整个用例共享的 ID 序列：多轮生成必须持续递增，否则新消息会覆盖旧消息 */
        val seq: Seq,
    )

    private fun seedStore(): FakeLocalStore = runBlocking {
        val store = FakeLocalStore("android-test")
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
        store
    }

    private fun fixture(
        scripts: List<List<ModelStreamEvent>>,
        store: FakeLocalStore = seedStore(),
        /**
         * 生成任务作用域。用 `UnconfinedTestDispatcher` 让生成在 `sendMessage` 内尽早跑完，
         * 使断言保持确定性；生产实现用独立的 IO 作用域（生成不依赖 UI 生命周期）。
         */
        scope: CoroutineScope = CoroutineScope(UnconfinedTestDispatcher()),
    ): Fixture {
        val gateway = ScriptedGateway(scripts)
        val seq = Seq()
        val generation = LocalChatGenerationUseCase(
            store = store,
            gateway = gateway,
            profileProvider = { profile() },
            apiKeyProvider = { "sk-test" },
            idFactory = { seq.next() },
            now = { 1_000L },
        )
        return Fixture(store, LocalChatRepository(store, generation, scope) { seq.next() }, gateway, seq)
    }

    /**
     * 启动事件收集，并**确定性等待订阅建立**后再返回。
     *
     * 两个必须点：
     * 1. `MutableSharedFlow` 无 replay，订阅者出现之前 emit 的事件会被直接丢弃，
     *    因此不能用「启动协程 + yield 若干次」抢时序（间歇失败正是其症状）；
     * 2. 收集协程用 [Dispatchers.Unconfined]，使 `tryEmit` 在发送线程上同步投递，
     *    事件按序进入列表，既不跨线程也没有可见性问题。
     */
    private suspend fun CoroutineScope.collectEvents(
        repository: LocalChatRepository,
    ): Pair<MutableList<CompanionEvent>, suspend () -> Unit> {
        val events = mutableListOf<CompanionEvent>()
        val job: Job = launch(Dispatchers.Unconfined) { repository.events.collect { events += it } }
        repository.eventSubscriberCount.first { it > 0 }
        return events to { job.cancel() }
    }

    // ---------------------------------------------------------------- 列表与分页

    @Test
    fun sessionsAndCharactersComeFromLocalLibrary() = runBlocking {
        val f = fixture(listOf(listOf(chunk("你好"), finish())))
        val sessions = f.repository.listSessions()
        assertEquals(1, sessions.size)
        assertEquals("s1", sessions[0].id)
        assertEquals("c1", sessions[0].characterId)

        val characters = f.repository.listCharacters()
        assertEquals(1, characters.size)
        assertEquals("苏晚", characters[0].name)
    }

    @Test
    fun createSessionPersistsLocallyAndOptionallySeedsGreeting() = runBlocking {
        val f = fixture(listOf(listOf(chunk("x"), finish())))
        val created = f.repository.createSession("c1", title = "第一次相遇", greeting = "夜安。")
        assertEquals("第一次相遇", created.title)
        assertEquals("c1", created.characterId)

        val messages = f.repository.listMessages(created.id).messages
        assertEquals(1, messages.size)
        assertEquals("夜安。", messages[0].content)
        assertEquals(com.qingyu.companion.model.Role.assistant, messages[0].role)

        assertTrue(f.repository.listSessions().any { it.id == created.id })
    }

    @Test
    fun renameAndDeleteSessionWriteToLocalLibrary() = runBlocking {
        val f = fixture(listOf(listOf(chunk("x"), finish())))
        f.repository.renameSession("s1", "改名后")
        assertEquals("改名后", f.store.getSession("s1")!!.title)

        f.repository.deleteSession("s1")
        assertNull(f.store.getSession("s1"))
        assertTrue("删除必须写 tombstone", f.store.isTombstoned("session", "s1"))
    }

    @Test
    fun messagePagingUsesCursorWithoutGapOrOverlap() = runBlocking {
        // 发送 5 次 = 5 段脚本（网关队列按调用顺序消费）
        val f = fixture(List(5) { listOf(chunk("ok"), finish()) })
        repeat(5) { index ->
            f.repository.sendMessage("s1", "r$index", "第${index + 1}句")
        }
        assertEquals(5, f.gateway.callCount)
        val all = f.store.listMessages("s1")
        assertEquals(10, all.size) // 5 user + 5 assistant

        val page = f.repository.listMessages("s1")
        assertTrue("默认页不超过 PAGE_SIZE", page.messages.size <= LocalChatRepository.PAGE_SIZE)
        assertEquals(all.last().id, page.messages.last().id)

        // 以第一页首条为游标取更早一页：不得重叠
        val older = f.repository.listMessages("s1", beforeId = page.messages.first().id)
        assertTrue(older.messages.none { it.id in page.messages.map { m -> m.id } })
    }

    // ---------------------------------------------------------------- 发送与流式

    @Test
    fun sendMessagePersistsUserAndEmitsChunkThenDone() = runBlocking {
        val f = fixture(listOf(listOf(chunk("你"), chunk("好"), finish())))
        val (events, stop) = collectEvents(f.repository)

        val returned = f.repository.sendMessage("s1", "req-1", "在吗")
        stop()

        // 返回值是用户消息（与在线实现同语义）
        assertEquals("在吗", returned.content)
        assertEquals("sendMessage 返回用户消息（与在线实现同语义）", com.qingyu.companion.model.Role.user, returned.role)

        val chunks = events.filterIsInstance<CompanionEvent.Chunk>()
        assertEquals("增量必须逐块推送", listOf("你", "好"), chunks.map { it.delta })
        val done = events.filterIsInstance<CompanionEvent.Done>().single()
        assertEquals("req-1", done.requestId)
        assertEquals("你好", done.message.content)

        val messages = f.store.listMessages("s1")
        assertEquals(2, messages.size)
        assertEquals("在吗", messages[0].content)
        assertEquals("你好", messages[1].content)
    }

    @Test
    fun sendMessageReturnsUserMessageImmediatelyAndReportsFailureViaEvent() = runBlocking {
        val f = fixture(
            listOf(
                listOf(
                    chunk("半截"),
                    ModelStreamEvent.Failure(ModelError("IO_ERROR", "connection reset", retryable = true)),
                ),
            ),
        )
        val (events, stop) = collectEvents(f.repository)

        // 契约：sendMessage 只负责用户消息落地，生成失败**不从这里抛出**（与在线实现一致），
        // 否则 ChatViewModel 会把它当成「发送失败」而走 pending 重发路径。
        val returned = f.repository.sendMessage("s1", "req-2", "问")
        stop()

        assertEquals("user", returned.role.name)
        assertEquals("问", returned.content)

        val errors = events.filterIsInstance<CompanionEvent.Error>()
        assertEquals("生成失败必须以 Error 事件上报", 1, errors.size)
        assertTrue("错误文案必须可行动", errors[0].message.contains("connection reset"))

        // 失败时用户消息保留、不产生 assistant 消息
        val messages = f.store.listMessages("s1")
        assertEquals(1, messages.size)
        assertEquals("user", messages[0].role)
    }

    @Test
    fun secondTurnSeesPreviousTurnInRequestHistory() = runBlocking {
        // 同一个 gateway 依次服务两轮：第一轮脚本 → 第二轮脚本。
        // 这样断言的就是「同一仓库连续两轮」的真实路径，而不是靠另建对象绕开缺陷。
        val f = fixture(
            listOf(
                listOf(chunk("第一次回复"), finish()),
                listOf(chunk("第二次回复"), finish()),
            ),
        )
        f.repository.sendMessage("s1", "r1", "第一问")
        // 请求现在由共享装配器产出：首条是 system 提示，其后才是对话历史
        assertEquals("system", f.gateway.lastRequest!!.messages.first().role)
        assertEquals(1, f.gateway.lastRequest!!.messages.count { it.role != "system" })

        f.repository.sendMessage("s1", "r2", "第二问")
        assertEquals(2, f.gateway.callCount)

        val request = f.gateway.lastRequest!!
        val conversation = request.messages.filter { it.role != "system" }
        assertEquals(3, conversation.size)
        assertEquals("第一问", conversation[0].content)
        assertEquals("第一次回复", conversation[1].content)
        assertEquals("第二问", conversation[2].content)
    }

    @Test
    fun editAndDeleteMessageWriteLocally() = runBlocking {
        val f = fixture(listOf(listOf(chunk("原文"), finish())))
        f.repository.sendMessage("s1", "r1", "问")
        val assistant = f.store.listMessages("s1").first { it.role == "assistant" }

        val edited = f.repository.editMessage("s1", assistant.id, "改后正文")
        assertEquals("改后正文", edited.content)
        assertEquals("改后正文", f.store.listMessages("s1").first { it.id == assistant.id }.content)

        f.repository.deleteMessage("s1", assistant.id)
        assertNull(f.store.listMessages("s1").firstOrNull { it.id == assistant.id })
        assertTrue("删除消息必须写 tombstone", f.store.isTombstoned("message", assistant.id))
    }

    @Test
    fun clearChatRemovesMessagesButKeepsSession() = runBlocking {
        val f = fixture(listOf(listOf(chunk("x"), finish())))
        f.repository.sendMessage("s1", "r1", "问")
        assertEquals(2, f.store.listMessages("s1").size)

        f.repository.clearChat("s1")
        assertEquals(0, f.store.listMessages("s1").size)
        assertNotNull("清空消息不得删除会话本身", f.store.getSession("s1"))
    }

    @Test
    fun branchSessionCopiesHistoryUpToMessage() = runBlocking {
        val f = fixture(listOf(listOf(chunk("回复"), finish())))
        f.repository.sendMessage("s1", "r1", "问")
        val target = f.store.listMessages("s1")[0]

        val branch = f.repository.branchSession("s1", target.id)
        assertTrue(branch.id != "s1")
        val branchMessages = f.store.listMessages(branch.id)
        assertEquals(1, branchMessages.size)
        assertEquals("问", branchMessages[0].content)
        assertTrue("分支消息必须换新 id", branchMessages[0].id != target.id)
    }

    @Test
    fun swipeRegeneratesAndPersistsNewAssistantMessage() = runBlocking {
        val f = fixture(
            listOf(
                listOf(chunk("第一版"), finish()),
                listOf(chunk("第二版"), finish()),
            ),
        )
        f.repository.sendMessage("s1", "r1", "问")
        val firstAssistant = f.store.listMessages("s1").first { it.role == "assistant" }

        // direction=0 = 重新生成：**候选追加到同一条消息**（与 PC 一致），
        // 不新建消息——消息数量会进入导出、分页与上下文预算
        val regenerated = f.repository.swipe("s1", firstAssistant.id, direction = 0)
        assertEquals("第二版", regenerated.content)
        assertEquals("不得新建消息", 2, f.store.listMessages("s1").size)
        val stored = f.store.listMessages("s1").first { it.id == firstAssistant.id }
        assertEquals("候选必须落盘", """["第一版","第二版"]""", stored.swipesJson)
        assertEquals("当前索引必须指向新候选", 1, stored.swipeIndex)
        assertEquals(2, f.gateway.callCount)

        // direction!=0 = 切换候选：纯本地，不再调用模型
        val switched = f.repository.swipe("s1", firstAssistant.id, direction = -1)
        assertEquals("第一版", switched.content)
        assertEquals("切换候选不得调用模型", 2, f.gateway.callCount)
        assertEquals(0, f.store.listMessages("s1").first { it.id == firstAssistant.id }.swipeIndex)
    }

    @Test
    fun unsupportedCapabilitiesReturnActionableEmptyResults() = runBlocking {
        val f = fixture(listOf(listOf(chunk("x"), finish())))

        assertTrue(f.repository.listLorebooks().isEmpty())
        assertTrue(f.repository.listPresets().isEmpty())
        assertTrue(f.repository.usageRecords(10).isEmpty())
        assertNull(f.repository.fetchVersionInfo())

        // AI 辅助已实现（S4-04）：未配置连接时必须给出可行动错误，而不是静默返回空串
        val assistError = runCatching { f.repository.aiAssist("s1", "continue", null) }.exceptionOrNull()
        assertTrue("未配置连接必须抛错，实际 $assistError", assistError is IllegalStateException)
        assertTrue(assistError!!.message!!.contains("未配置"))

        assertNotNull("仍属未迁移的能力必须留下提示", f.repository.unsupportedNotice.value)
        assertTrue(f.repository.unsupportedNotice.value!!.contains("尚未在本地模式提供"))
    }

    @Test
    fun modelsListComesFromLocalConnectionProfiles() = runBlocking {
        val f = fixture(listOf(listOf(chunk("x"), finish())))
        assertEquals(listOf("gpt-4o-mini"), f.repository.listModels())
    }

    @Test
    fun contextUsageUsesLocalHeuristicEstimate() = runBlocking {
        val f = fixture(listOf(listOf(chunk("回复"), finish())))
        f.repository.sendMessage("s1", "r1", "问")
        val usage = f.repository.getContextUsage("s1")
        assertTrue("必须有已用量", usage.used > 0)
        assertEquals(LocalChatRepository.CONTEXT_LIMIT_TOKENS.toLong(), usage.max)
        assertTrue(usage.ratio > 0.0)
    }

    @Test
    fun memoryReadsFromLocalStore() = runBlocking {
        val f = fixture(listOf(listOf(chunk("x"), finish())))
        val empty = f.repository.getSessionMemory("s1")
        assertTrue("无记忆状态时应表示未启用", !empty.memoryEnabled)
        assertEquals("", empty.memory)
    }

    @Test
    fun connectionStateIsReadyWithoutPc() = runBlocking {
        val f = fixture(listOf(listOf(chunk("x"), finish())))
        // 本地模式不依赖 PC 连接，状态必须表达「可用」而不是「未连接」
        assertEquals(com.qingyu.companion.network.WsClient.State.CONNECTED, f.repository.connectionState.value)
    }

    @Test
    fun activateCharacterReusesExistingSessionOrCreatesOne() = runBlocking {
        val f = fixture(listOf(listOf(chunk("x"), finish())))
        val existing = f.repository.activateCharacter("c1")
        assertTrue(existing.ok)
        assertEquals("s1", existing.sessionId)

        val fresh = f.repository.activateCharacter("c1")
        assertEquals("s1", fresh.sessionId)
    }
}
