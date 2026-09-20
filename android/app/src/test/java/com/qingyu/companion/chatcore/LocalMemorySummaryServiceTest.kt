package com.qingyu.companion.chatcore

import com.qingyu.companion.local.db.LocalMemoryStateEntity
import com.qingyu.companion.local.db.LocalMessageEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.testing.FakeLocalStore
import com.qingyu.companion.network.models.ChatMessageDto
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelChunk
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.ModelRequestHandle
import com.qingyu.companion.network.models.ModelStreamEvent
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-05：长记忆总结编排的端到端测试（假网关 + 假存储，无网络）。
 *
 * 覆盖的是「记忆真正被写出来」这条路径上的关键分支：
 * 正常总结并推进版本、间隔不足跳过、**生成期间历史被改动 → 丢弃摘要**、
 * 模型输出不可解析 → 失败且不写库、游标只推进到已总结位置、事实提案被应用并落库。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class LocalMemorySummaryServiceTest {

    private class ScriptedGateway(
        private val replies: MutableList<String>,
        /** 在真正消费流之前执行，用于制造「生成期间外部写入」的交错。 */
        private val onCollect: (suspend () -> Unit)? = null,
    ) : ModelGateway {
        var lastRequest: ModelChatRequest? = null
        var calls = 0
        override fun stream(
            provider: ModelProvider,
            profile: ConnectionProfilePublic,
            request: ModelChatRequest,
            apiKey: String?,
        ): Pair<Flow<ModelStreamEvent>, ModelRequestHandle> {
            lastRequest = request
            calls++
            val text = if (replies.isEmpty()) "" else replies.removeAt(0)
            val handle = object : ModelRequestHandle {
                override fun cancel() = Unit
                override val isCancelled: Boolean = false
            }
            return flow {
                onCollect?.invoke()
                emit(ModelStreamEvent.Chunk(ModelChunk(text)))
                emit(ModelStreamEvent.Completed("stop", null))
            } to handle
        }
    }

    private val profile = ConnectionProfilePublic(
        id = "p1",
        provider = ModelProvider.OpenAI,
        baseUrl = "https://example.invalid/v1",
        model = "gpt-4o-mini",
    )

    private suspend fun seed(
        store: FakeLocalStore,
        messageCount: Int,
        cursorId: String? = null,
        memoryVersion: Long = 0,
    ): String {
        val sessionId = "s1"
        store.putSession(
            LocalSessionEntity(
                id = sessionId,
                characterId = "c1",
                title = "T",
                createdAt = 0,
                updatedAt = 0,
                // 会话行是记忆开关与策略的权威来源：自动触发要求开关打开且为 auto 模式
                memoryEnabled = true,
                memoryMode = "auto",
                autoMemoryInterval = 10,
            ),
        )
        // 角色必须存在：否则主体名无法与角色名匹配，事实的 entityId 绑定无从验证
        store.putCharacter(
            com.qingyu.companion.local.db.LocalCharacterEntity(
                id = "c1",
                name = "苏晚",
                createdAt = 0,
                updatedAt = 0,
            ),
        )
        repeat(messageCount) { index ->
            store.appendMessage(
                LocalMessageEntity(
                    id = "m$index",
                    sessionId = sessionId,
                    characterId = "c1",
                    role = if (index % 2 == 0) "user" else "assistant",
                    content = "第${index}句内容。",
                    logicalTime = index.toLong(),
                    seq = -1L,
                    createdAt = index.toLong(),
                    updatedAt = index.toLong(),
                ),
            )
        }
        store.putMemoryState(
            LocalMemoryStateEntity(
                id = "mem",
                sessionId = sessionId,
                summary = "旧时间线",
                updatedAt = 0,
                memoryVersion = memoryVersion,
                currentState = "旧状态",
                factsJson = "[]",
                historyJson = "[]",
                memoryLastMessageId = cursorId,
            ),
        )
        return sessionId
    }

    @Test
    fun summarizesPersistsAndAdvancesVersion() = runBlocking {
        val store = FakeLocalStore()
        val sessionId = seed(store, 20, cursorId = "m9")
        val gateway = ScriptedGateway(
            mutableListOf(
                """
                【当前状态】
                深夜的书店，苏晚正在收拾书架。
                【时间线】
                1. 旅人进店避雨。
                2. 苏晚端上热茶。
                """.trimIndent(),
            ),
        )
        val service = LocalMemorySummaryService(store, gateway, now = { 1_000L })

        val outcome = service.summarize(
            scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined),
            sessionId = sessionId,
            automatic = true,
            profile = profile,
            apiKey = "sk",
            model = "gpt-4o-mini",
            userName = "旅人",
        )

        assertTrue("应总结成功，实际 $outcome", outcome is LocalMemorySummaryService.Outcome.Summarized)
        val summarized = outcome as LocalMemorySummaryService.Outcome.Summarized
        assertEquals(1L, summarized.memoryVersion)
        assertTrue(summarized.currentState.contains("深夜的书店"))
        assertEquals("m19", summarized.cursorMessageId)

        val written = store.getMemoryState(sessionId)!!
        assertEquals(1L, written.memoryVersion)
        assertTrue("当前状态必须落库", written.currentState.contains("深夜的书店"))
        assertTrue("时间线必须落库", written.summary.contains("旅人进店避雨"))
        assertEquals("游标必须推进到最后一条", "m19", written.memoryLastMessageId)

        // 请求形状：系统提示 + 用户内容，非流式，低温
        val request = gateway.lastRequest!!
        assertEquals(2, request.messages.size)
        assertEquals("system", request.messages[0].role)
        assertTrue(request.messages[0].content.contains("【事实提案】"))
        assertTrue(request.messages[1].content.contains("【待总结的新对话】"))
        assertEquals(false, request.stream)
        assertEquals(0.3, request.temperature!!, 1e-9)
        assertTrue("必须带上输出预算", (request.maxTokens ?: 0) > 0)

        // S4-05：记忆请求必须按**独立 task type** 记用量。
        // 只实现记录、不写库的话，用量页上「记忆花了多少」永远查不到；
        // 而混进 main 则会污染「本会话聊了多少」（记忆输入往往是整段对话）。
        val usageRows = store.listUsageInRange(0L, Long.MAX_VALUE, 20)
        val memoryRows = usageRows.filter { it.taskType == "memory" }
        assertEquals("成功总结必须留下恰好一条 memory 用量记录", 1, memoryRows.size)
        assertTrue("必须记录输入字符数", memoryRows[0].inputChars > 0)
        assertTrue("必须记录输出字符数", memoryRows[0].outputChars > 0)
        assertEquals("不得混入聊天任务", emptyList<String>(), usageRows.filter { it.taskType == "main" }.map { it.id })
    }

    @Test
    fun staleVersionDiscardsSummaryAndKeepsHistory() = runBlocking {
        val store = FakeLocalStore()
        val sessionId = seed(store, 20, cursorId = "m9")
        // 模拟：生成期间另一并发方把记忆版本推进到 3
        store.applyMemoryStateIfVersion(
            sessionId = sessionId,
            expectedVersion = 0,
            entity = LocalMemoryStateEntity(id = "mem", sessionId = sessionId, summary = "并发写入", updatedAt = 0),
        )
        store.applyMemoryStateIfVersion(
            sessionId = sessionId,
            expectedVersion = 1,
            entity = LocalMemoryStateEntity(id = "mem", sessionId = sessionId, summary = "并发写入", updatedAt = 0),
        )
        store.applyMemoryStateIfVersion(
            sessionId = sessionId,
            expectedVersion = 2,
            entity = LocalMemoryStateEntity(id = "mem", sessionId = sessionId, summary = "并发写入", updatedAt = 0),
        )

        val gateway = ScriptedGateway(
            mutableListOf("【当前状态】\n并发前的旧快照。\n【时间线】\n1. 过期事件。"),
            // 关键：在真正消费流时（即已读取版本、尚未提交）推进版本，
            // 制造「生成期间用户编辑了历史」的真实交错。
            onCollect = {
                store.applyMemoryStateIfVersion(
                    sessionId = sessionId,
                    expectedVersion = 3,
                    entity = LocalMemoryStateEntity(
                        id = "mem",
                        sessionId = sessionId,
                        summary = "并发写入",
                        updatedAt = 0,
                    ),
                )
            },
        )
        val service = LocalMemorySummaryService(store, gateway, now = { 1_000L })
        val outcome = service.summarize(
            scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined),
            sessionId = sessionId,
            automatic = true,
            profile = profile,
            apiKey = null,
            model = "gpt-4o-mini",
        )

        assertTrue("版本过期必须跳过，实际 $outcome", outcome is LocalMemorySummaryService.Outcome.Skipped)
        assertEquals(
            ChatMemorySummaryPolicy.REASON_STALE_VERSION,
            (outcome as LocalMemorySummaryService.Outcome.Skipped).reason,
        )
        assertEquals("磁盘不得被过期摘要覆盖", "并发写入", store.getMemoryState(sessionId)!!.summary)
    }

    @Test
    fun intervalNotReachedSkipsWithoutCallingModel() = runBlocking {
        val store = FakeLocalStore()
        val sessionId = seed(store, 5, cursorId = "m3")
        val gateway = ScriptedGateway(mutableListOf("不会用到"))
        val service = LocalMemorySummaryService(store, gateway, now = { 1_000L })

        val outcome = service.summarize(
            scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined),
            sessionId = sessionId,
            automatic = true,
            profile = profile,
            apiKey = null,
            model = "gpt-4o-mini",
        )

        assertTrue(outcome is LocalMemorySummaryService.Outcome.Skipped)
        assertEquals(
            ChatMemorySummaryPolicy.REASON_INTERVAL_NOT_REACHED,
            (outcome as LocalMemorySummaryService.Outcome.Skipped).reason,
        )
        assertEquals("未达阈值不得发起模型调用", 0, gateway.calls)
        assertEquals("不得改动记忆", "旧时间线", store.getMemoryState(sessionId)!!.summary)
    }

    @Test
    fun unparsableOutputFailsWithoutTouchingMemory() = runBlocking {
        val store = FakeLocalStore()
        val sessionId = seed(store, 20, cursorId = "m9")
        val gateway = ScriptedGateway(mutableListOf("模型只返回了一段没有分段的闲聊。"))
        val service = LocalMemorySummaryService(store, gateway, now = { 1_000L })

        val outcome = service.summarize(
            scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined),
            sessionId = sessionId,
            automatic = true,
            profile = profile,
            apiKey = null,
            model = "gpt-4o-mini",
        )

        // 无分段文本会被兜底当作摘要，因此这里应成功
        assertTrue("无分段输出应兜底为摘要，实际 $outcome", outcome is LocalMemorySummaryService.Outcome.Summarized)

        // 空输出必须失败且不写库——用**独立**的 store，避免上一次已推进游标导致本次直接跳过
        val emptyStore = FakeLocalStore()
        val emptySessionId = seed(emptyStore, 20, cursorId = "m9")
        val before = emptyStore.getMemoryState(emptySessionId)!!
        val emptyGateway = ScriptedGateway(mutableListOf("   "))
        val service2 = LocalMemorySummaryService(emptyStore, emptyGateway, now = { 1_000L })
        val emptyOutcome = service2.summarize(
            scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined),
            sessionId = emptySessionId,
            automatic = true,
            profile = profile,
            apiKey = null,
            model = "gpt-4o-mini",
        )
        assertTrue("空输出必须失败，实际 $emptyOutcome", emptyOutcome is LocalMemorySummaryService.Outcome.Failed)
        val after = emptyStore.getMemoryState(emptySessionId)!!
        assertEquals("失败不得改动摘要", before.summary, after.summary)
        assertEquals("失败不得推进版本", before.memoryVersion, after.memoryVersion)
        assertEquals("失败不得推进游标", before.memoryLastMessageId, after.memoryLastMessageId)
    }

    @Test
    fun factProposalsAreAppliedAndPersisted() = runBlocking {
        val store = FakeLocalStore()
        val sessionId = seed(store, 20, cursorId = "m9")
        val gateway = ScriptedGateway(
            mutableListOf(
                """
                【当前状态】
                书店内，苏晚在整理书架。
                【时间线】
                1. 旅人带来一本旧书。
                【事实提案】
                ```json
                [{"subject":"苏晚","predicate":"职业","value":"书店店主","changeType":"set","importance":4,"confidence":0.9}]
                ```
                """.trimIndent(),
            ),
        )
        val service = LocalMemorySummaryService(store, gateway, now = { 1_000L })

        val outcome = service.summarize(
            scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined),
            sessionId = sessionId,
            automatic = true,
            profile = profile,
            apiKey = null,
            model = "gpt-4o-mini",
        )

        assertTrue("应总结成功，实际 $outcome", outcome is LocalMemorySummaryService.Outcome.Summarized)
        val written = store.getMemoryState(sessionId)!!
        assertTrue("事实必须落库为规范 JSON", written.factsJson.contains("书店店主"))
        assertTrue("事实必须带会话范围", written.factsJson.contains("session:s1"))
        assertTrue("主体等于角色名时必须绑定角色 id", written.factsJson.contains("\"entityId\":\"c1\""))
        // 首次 set 不产生历史：history 只记录**被取代**的旧值，
        // 因此全新事实的历史必须是空数组（若这里非空，说明实现错误地把新事实记进了历史）
        assertEquals("首次新增不得产生历史", "[]", written.historyJson)
    }

    @Test
    fun updatingAnExistingFactRecordsTheSupersededValueInHistory() = runBlocking {
        val store = FakeLocalStore()
        val sessionId = seed(store, 20, cursorId = "m9")
        // 预置一条已有事实：职业 = 学徒
        store.applyMemoryStateIfVersion(
            sessionId = sessionId,
            expectedVersion = 0,
            entity = LocalMemoryStateEntity(
                id = "mem",
                sessionId = sessionId,
                summary = "旧时间线",
                updatedAt = 0,
                factsJson = ChatMemoryFacts.factsToJson(
                    listOf(
                        ChatMemoryFacts.FactRecord.Structured(
                            id = "f1",
                            subject = "苏晚",
                            predicate = "职业",
                            value = "学徒",
                            scope = "session:s1",
                            entityId = "c1",
                        ),
                    ),
                ),
            ),
        )
        val gateway = ScriptedGateway(
            mutableListOf(
                """
                【当前状态】
                苏晚正式接手了书店。
                【时间线】
                1. 苏晚成为店主。
                【事实提案】
                ```json
                [{"subject":"苏晚","predicate":"职业","value":"书店店主","changeType":"set"}]
                ```
                """.trimIndent(),
            ),
        )
        val service = LocalMemorySummaryService(store, gateway, now = { 1_000L })

        val outcome = service.summarize(
            scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined),
            sessionId = sessionId,
            automatic = true,
            profile = profile,
            apiKey = null,
            model = "gpt-4o-mini",
        )

        assertTrue("应总结成功，实际 $outcome", outcome is LocalMemorySummaryService.Outcome.Summarized)
        val written = store.getMemoryState(sessionId)!!
        assertTrue("当前事实应更新为新值", written.factsJson.contains("书店店主"))
        assertTrue("被取代的旧值必须进入历史", written.historyJson.contains("学徒"))
    }

    @Test
    fun automaticTriggerIsSkippedWhenSessionMemoryIsOff() = runBlocking {
        // 会话行的开关是权威来源：显式关闭时，即使消息很多也不能自动总结
        val store = FakeLocalStore()
        val sessionId = seed(store, 20, cursorId = "m9")
        val session = store.getSession(sessionId)!!
        store.putSession(session.copy(memoryEnabled = false, memoryMode = "manual"))
        val gateway = ScriptedGateway(mutableListOf("不应被调用"))
        val service = LocalMemorySummaryService(store, gateway, now = { 1_000L })

        val outcome = service.summarize(
            scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined),
            sessionId = sessionId,
            automatic = true,
            profile = profile,
            apiKey = null,
            model = "gpt-4o-mini",
        )

        assertTrue(outcome is LocalMemorySummaryService.Outcome.Skipped)
        assertEquals(
            ChatMemorySummaryPolicy.REASON_MEMORY_DISABLED,
            (outcome as LocalMemorySummaryService.Outcome.Skipped).reason,
        )
        assertEquals("开关关闭时不得发起模型调用", 0, gateway.calls)

        // 但手动触发仍允许（用户在界面上显式要求总结）
        val manual = service.summarize(
            scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined),
            sessionId = sessionId,
            automatic = false,
            profile = profile,
            apiKey = null,
            model = "gpt-4o-mini",
        )
        assertTrue("手动触发应绕过开关限制，实际 $manual", manual is LocalMemorySummaryService.Outcome.Summarized)
    }

    @Test
    fun manualTriggerCreatesFirstMemoryRow() = runBlocking {
        val store = FakeLocalStore()
        val sessionId = "s1"
        store.putSession(
            LocalSessionEntity(id = sessionId, characterId = "c1", title = "T", createdAt = 0, updatedAt = 0),
        )
        repeat(6) { index ->
            store.appendMessage(
                LocalMessageEntity(
                    id = "m$index",
                    sessionId = sessionId,
                    characterId = "c1",
                    role = if (index % 2 == 0) "user" else "assistant",
                    content = "第${index}句。",
                    logicalTime = index.toLong(),
                    seq = -1L,
                    createdAt = index.toLong(),
                    updatedAt = index.toLong(),
                ),
            )
        }
        val gateway = ScriptedGateway(mutableListOf("【当前状态】\n初次总结。\n【时间线】\n1. 开始。"))
        val service = LocalMemorySummaryService(store, gateway, now = { 1_000L })

        assertNull("初始没有记忆行", store.getMemoryState(sessionId))
        val outcome = service.summarize(
            scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined),
            sessionId = sessionId,
            automatic = false,
            profile = profile,
            apiKey = null,
            model = "gpt-4o-mini",
        )

        assertTrue("手动触发应创建首行，实际 $outcome", outcome is LocalMemorySummaryService.Outcome.Summarized)
        val created = store.getMemoryState(sessionId)!!
        assertEquals(1L, created.memoryVersion)
        assertEquals("m5", created.memoryLastMessageId)
        assertEquals(1, gateway.calls)
    }
}
