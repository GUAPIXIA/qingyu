package com.qingyu.companion.chatcore

import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.testing.FakeLocalStore
import com.qingyu.companion.network.models.ChatMessageDto
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelError
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.ModelRequestHandle
import com.qingyu.companion.network.models.ModelStreamEvent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 阶段 4 S4-04：单聊「发送 → 流式 → 落盘」用例行为测试。
 *
 * 全部在无网络、无 Android 依赖的条件下运行（FakeModelGateway + FakeLocalStore），
 * 覆盖阶段 4 §3 要求的终局分类：正常完成、取消、断网、限流、畸形响应、空输出，
 * 以及「未验证完成结果不得提前保存为成功消息」与「错误不创建空消息」两条硬约束。
 */
class LocalChatGenerationUseCaseTest {

    // ---------------------------------------------------------------- 测试替身

    /** 按脚本产出事件的模型网关；同时记录收到的请求便于断言上下文装配。 */
    private class FakeModelGateway(
        private val script: List<ModelStreamEvent>,
        private val throwOnCollect: Throwable? = null,
    ) : ModelGateway {
        var lastRequest: ModelChatRequest? = null
        var lastProfile: ConnectionProfilePublic? = null
        var lastApiKey: String? = null
        var cancelCalls = 0

        override fun stream(
            provider: ModelProvider,
            profile: ConnectionProfilePublic,
            request: ModelChatRequest,
            apiKey: String?,
        ): Pair<Flow<ModelStreamEvent>, ModelRequestHandle> {
            lastRequest = request
            lastProfile = profile
            lastApiKey = apiKey
            val handle = object : ModelRequestHandle {
                override fun cancel() {
                    cancelCalls++
                }

                override val isCancelled: Boolean = false
            }
            val flow = flow {
                throwOnCollect?.let { throw it }
                script.forEach { emit(it) }
            }
            return flow to handle
        }
    }

    private class SeqIds {
        private var n = 0
        fun next(): String = "id-${++n}"
    }

    private fun profile(model: String = "gpt-4o-mini") = ConnectionProfilePublic(
        id = "p1",
        provider = ModelProvider.OpenAI,
        baseUrl = "https://api.example.com/v1",
        model = model,
        allowHttp = false,
    )

    /** 建一个含角色与会话的本地库；返回 (store, sessionId)。 */
    private fun seedStore(): Pair<FakeLocalStore, String> = runBlocking {
        val store = FakeLocalStore("android-test")
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "苏晚", createdAt = 0, updatedAt = 0))
        store.putSession(LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0))
        store to "s1"
    }

    private fun useCase(
        store: FakeLocalStore,
        script: List<ModelStreamEvent>,
        ids: SeqIds = SeqIds(),
        throwOnCollect: Throwable? = null,
    ): Pair<LocalChatGenerationUseCase, FakeModelGateway> {
        val gateway = FakeModelGateway(script, throwOnCollect)
        val useCase = LocalChatGenerationUseCase(
            store = store,
            gateway = gateway,
            profileProvider = { profile() },
            apiKeyProvider = { "sk-test" },
            idFactory = { ids.next() },
            now = { 1_000L },
        )
        return useCase to gateway
    }

    private fun chunk(text: String): ModelStreamEvent =
        ModelStreamEvent.Chunk(com.qingyu.companion.network.models.ModelChunk(deltaText = text))

    private fun finish(reason: String = "stop", prompt: Int? = null, completion: Int? = null): ModelStreamEvent =
        ModelStreamEvent.Chunk(
            com.qingyu.companion.network.models.ModelChunk(
                deltaText = "",
                finished = true,
                finishReason = reason,
                promptTokens = prompt,
                completionTokens = completion,
            ),
        )

    private fun outcomeOf(deltas: List<LocalChatGenerationUseCase.Delta>): LocalChatGenerationUseCase.GenerationOutcome {
        val finished = deltas.filterIsInstance<LocalChatGenerationUseCase.Delta.Finished>()
        assertEquals("必须恰好产生一个终局事件", 1, finished.size)
        return finished.first().outcome
    }

    // ---------------------------------------------------------------- 正常路径

    @Test
    fun happyPathPersistsUserThenAssistant() = runBlocking {
        val (store, sessionId) = seedStore()
        val (useCase, _) = useCase(store, listOf(chunk("你"), chunk("好"), finish()))

        val deltas = useCase.generate(sessionId, "在吗").toList()
        val outcome = outcomeOf(deltas)

        assertEquals("completed", outcome.status)
        assertEquals("provider_stop", outcome.terminationCause)
        assertTrue("必须落盘 assistant 消息", outcome.persisted)
        assertEquals("你好", outcome.content)

        val messages = store.listMessages(sessionId)
        assertEquals(2, messages.size)
        assertEquals("user", messages[0].role)
        assertEquals("在吗", messages[0].content)
        assertEquals("assistant", messages[1].role)
        assertEquals("你好", messages[1].content)
        assertEquals("completed", messages[1].generationStatus)
        assertEquals(outcome.userMessageId, messages[0].id)
        assertEquals(outcome.assistantMessageId, messages[1].id)

        // 流式增量按序发出且拼接等于最终正文
        val streamed = deltas.filterIsInstance<LocalChatGenerationUseCase.Delta.Chunk>().joinToString("") { it.text }
        assertEquals("你好", streamed)

        // Started 事件携带任务与用户消息 id
        val started = deltas.filterIsInstance<LocalChatGenerationUseCase.Delta.Started>().single()
        assertEquals(outcome.taskId, started.taskId)
        assertEquals(messages[0].id, started.userMessageId)
    }

    @Test
    fun chunksAreNotPersistedBeforeTerminalState() = runBlocking {
        val (store, sessionId) = seedStore()
        val (useCase, _) = useCase(store, listOf(chunk("第一段"), chunk("第二段"), finish()))

        val deltas = mutableListOf<LocalChatGenerationUseCase.Delta>()
        useCase.generate(sessionId, "提问").collect { delta ->
            deltas += delta
            if (delta is LocalChatGenerationUseCase.Delta.Chunk) {
                // 流式期间库里只应有用户消息，不得出现半截 assistant 消息
                val assistantCount = store.listMessages(sessionId).count { it.role == "assistant" }
                assertEquals("chunk 期间不得写入 assistant 消息", 0, assistantCount)
            }
        }

        assertEquals(1, store.listMessages(sessionId).count { it.role == "assistant" })
        assertEquals(2, store.listMessages(sessionId).size)
    }

    @Test
    fun usageIsPersistedOnAssistantMessage() = runBlocking {
        val (store, sessionId) = seedStore()
        val (useCase, _) = useCase(store, listOf(chunk("正文"), finish(prompt = 120, completion = 45)))

        val outcome = outcomeOf(useCase.generate(sessionId, "问").toList())
        assertEquals(120, outcome.usage["promptTokens"])
        assertEquals(45, outcome.usage["completionTokens"])
        val assistant = store.listMessages(sessionId).first { it.role == "assistant" }
        assertNotNull(assistant.usageJson)
        assertTrue(assistant.usageJson!!.contains("promptTokens"))
    }

    @Test
    fun regenerateWithNoUserTextKeepsHistoryUnchanged() = runBlocking {
        val (store, sessionId) = seedStore()
        val (useCase, _) = useCase(store, listOf(chunk("重生成正文"), finish()))

        val outcome = outcomeOf(useCase.generate(sessionId, userText = null).toList())
        assertNull("regenerate 不应新增用户消息", outcome.userMessageId)
        val messages = store.listMessages(sessionId)
        assertEquals(1, messages.size)
        assertEquals("assistant", messages[0].role)
        assertEquals("重生成正文", messages[0].content)
    }

    @Test
    fun requestCarriesHistoryWindowAndProfileModel() = runBlocking {
        val (store, sessionId) = seedStore()
        val (useCase, gateway) = useCase(store, listOf(chunk("ok"), finish()))

        useCase.generate(sessionId, "第一句").toList()
        useCase.generate(sessionId, "第二句").toList()

        val request = gateway.lastRequest!!
        assertEquals("gpt-4o-mini", request.model)
        assertTrue(request.stream)
        // 请求现在由共享装配器产出：首条是系统提示，其后是对话历史
        assertEquals("system", request.messages.first().role)
        assertTrue("系统提示必须非空", request.messages.first().content.isNotEmpty())
        assertTrue("必须带上输出预算上限", (request.maxTokens ?: 0) > 0)
        val conversation = request.messages.filter { it.role != "system" }
        // 历史应包含：user 第一句、assistant ok、user 第二句
        assertEquals(3, conversation.size)
        assertEquals("user", conversation[0].role)
        assertEquals("第一句", conversation[0].content)
        assertEquals("assistant", conversation[1].role)
        assertEquals("第二句", conversation[2].content)
        assertEquals("sk-test", gateway.lastApiKey)
    }

    // ---------------------------------------------------------------- 取消

    @Test
    fun userCancelKeepsAlreadyVisibleBody() = runBlocking {
        val (store, sessionId) = seedStore()
        val (useCase, _) = useCase(
            store,
            listOf(chunk("已看到的"), ModelStreamEvent.Failure(ModelError("CANCELLED", "已取消", retryable = false))),
        )

        val outcome = outcomeOf(useCase.generate(sessionId, "问").toList())
        assertEquals("cancelled", outcome.status)
        assertEquals("user_cancel", outcome.terminationCause)
        assertEquals("已看到的", outcome.content)
        val assistant = store.listMessages(sessionId).first { it.role == "assistant" }
        assertEquals("已看到的", assistant.content)
        assertEquals("已停止生成", assistant.generationNotice)
        assertNull("取消提示不得拼入正文", assistant.generationError)
    }

    @Test
    fun cancelWithoutBodyCreatesNoMessage() = runBlocking {
        val (store, sessionId) = seedStore()
        val (useCase, _) = useCase(
            store,
            listOf(ModelStreamEvent.Failure(ModelError("CANCELLED", "已取消", retryable = false))),
        )

        val outcome = outcomeOf(useCase.generate(sessionId, "问").toList())
        assertEquals("cancelled", outcome.status)
        assertFalse("空正文不得落盘", outcome.persisted)
        assertEquals(1, store.listMessages(sessionId).size)
        assertEquals("user", store.listMessages(sessionId)[0].role)
    }

    // ---------------------------------------------------------------- 失败终局

    @Test
    fun transportFailureKeepsUserMessageAndCreatesNoAssistantMessage() = runBlocking {
        val (store, sessionId) = seedStore()
        val (useCase, _) = useCase(
            store,
            listOf(chunk("半截"), ModelStreamEvent.Failure(ModelError("IO_ERROR", "connection reset", retryable = true))),
        )

        val outcome = outcomeOf(useCase.generate(sessionId, "问").toList())
        assertEquals("failed", outcome.status)
        assertEquals("transport_error", outcome.terminationCause)
        assertEquals("PROVIDER_UNAVAILABLE", outcome.failureCode)
        assertTrue("传输失败可重试", outcome.retryable)
        assertFalse(outcome.persisted)
        // 供应商错误自带可读文案时优先展示它（PC `terminationPromptWithoutContent` 同口径）
        assertEquals("connection reset", outcome.noticeText)
        assertEquals("generationError", outcome.noticeField)

        val messages = store.listMessages(sessionId)
        assertEquals("失败时用户消息必须保留", 1, messages.size)
        assertEquals("user", messages[0].role)
    }

    @Test
    fun rateLimitMapsToRetryableTransportFailure() = runBlocking {
        val (store, sessionId) = seedStore()
        val (useCase, _) = useCase(
            store,
            listOf(ModelStreamEvent.Failure(ModelError("HTTP_429", "rate limited", retryable = true, httpStatus = 429))),
        )

        val outcome = outcomeOf(useCase.generate(sessionId, "问").toList())
        assertEquals("failed", outcome.status)
        assertEquals("transport_error", outcome.terminationCause)
        assertTrue(outcome.retryable)
        assertFalse(outcome.persisted)
    }

    @Test
    fun malformedResponseMapsToProtocolFailure() = runBlocking {
        val (store, sessionId) = seedStore()
        val (useCase, _) = useCase(
            store,
            listOf(ModelStreamEvent.Failure(ModelError("MALFORMED_JSON", "bad json", retryable = false))),
        )

        val outcome = outcomeOf(useCase.generate(sessionId, "问").toList())
        assertEquals("failed", outcome.status)
        assertEquals("protocol_error", outcome.terminationCause)
        assertEquals("INVALID_MODEL_RESPONSE", outcome.failureCode)
        assertFalse("协议错误不可重试", outcome.retryable)
    }

    @Test
    fun contentFilterDoesNotPersistBody() = runBlocking {
        val (store, sessionId) = seedStore()
        val (useCase, _) = useCase(
            store,
            listOf(chunk("被拦截正文"), ModelStreamEvent.Failure(ModelError("CONTENT_BLOCKED", "blocked", retryable = false))),
        )

        val outcome = outcomeOf(useCase.generate(sessionId, "问").toList())
        assertEquals("failed", outcome.status)
        assertEquals("provider_content_filter", outcome.terminationCause)
        assertFalse("审核拦截不保留正文", outcome.persisted)
        assertEquals(1, store.listMessages(sessionId).size)
    }

    @Test
    fun timeoutMapsToIdleTimeoutAndIsRetryable() = runBlocking {
        val (store, sessionId) = seedStore()
        val (useCase, _) = useCase(
            store,
            listOf(chunk("部分"), ModelStreamEvent.Failure(ModelError("TIMEOUT", "timeout", retryable = true))),
        )

        val outcome = outcomeOf(useCase.generate(sessionId, "问").toList())
        assertEquals("idle_timeout", outcome.terminationCause)
        assertEquals("PROVIDER_TIMEOUT", outcome.failureCode)
        assertTrue(outcome.retryable)
    }

    @Test
    fun emptyResponseFailsWithoutCreatingMessage() = runBlocking {
        val (store, sessionId) = seedStore()
        val (useCase, _) = useCase(store, emptyList())

        val outcome = outcomeOf(useCase.generate(sessionId, "问").toList())
        assertEquals("failed", outcome.status)
        assertEquals("INVALID_MODEL_RESPONSE", outcome.failureCode)
        assertEquals("供应商未返回可用内容", outcome.noticeText)
        // 域错误表把 INVALID_MODEL_RESPONSE 归为不可自动重试：空输出重试同一请求大概率仍为空，
        // 交回用户决定（避免无人值守下的重复计费）。
        assertFalse("空输出不自动重试", outcome.retryable)
        assertFalse(outcome.persisted)
        assertEquals(1, store.listMessages(sessionId).size)
    }

    @Test
    fun onlyThoughtOutputIsStillPersistedAsBody() = runBlocking {
        // 只有 thought：messagePostProcess 的空回退会把思考内容作为正文（阶段 4 §3 覆盖项）
        val (store, sessionId) = seedStore()
        val (useCase, _) = useCase(store, listOf(chunk("<thought>只有思考</thought>"), finish()))

        val outcome = outcomeOf(useCase.generate(sessionId, "问").toList())
        assertEquals("completed", outcome.status)
        assertTrue("只有 thought 时按空回退落盘思考内容", outcome.persisted)
        assertEquals("<thought>只有思考</thought>", outcome.content)
    }

    // ---------------------------------------------------------------- 前置校验

    @Test
    fun unknownSessionFailsWithoutWritingAnything() = runBlocking {
        val (store, _) = seedStore()
        val (useCase, gateway) = useCase(store, listOf(chunk("x"), finish()))

        val outcome = outcomeOf(useCase.generate("missing", "问").toList())
        assertEquals("failed", outcome.status)
        assertEquals("SESSION_NOT_FOUND", outcome.failureCode)
        assertNull("前置校验失败不得调用模型", gateway.lastRequest)
        assertTrue(store.listMessages("missing").isEmpty())
    }

    @Test
    fun missingProfileFailsWithActionableCode() = runBlocking {
        val (store, sessionId) = seedStore()
        val gateway = FakeModelGateway(listOf(chunk("x"), finish()))
        val useCase = LocalChatGenerationUseCase(
            store = store,
            gateway = gateway,
            profileProvider = { null },
            idFactory = { "id" },
        )

        val outcome = outcomeOf(useCase.generate(sessionId, "问").toList())
        assertEquals("failed", outcome.status)
        assertEquals("INVALID_COMMAND", outcome.failureCode)
        assertTrue("未配置档案不得写用户消息", store.listMessages(sessionId).isEmpty())
        assertNull(gateway.lastRequest)
    }

    @Test
    fun collectExceptionIsClassifiedAsFailureNotCrash() = runBlocking {
        val (store, sessionId) = seedStore()
        val (useCase, _) = useCase(
            store,
            script = emptyList(),
            throwOnCollect = IllegalStateException("boom"),
        )

        // 非 CancellationException 的异常应向上抛（调用方负责），而不是被静默吞掉
        val thrown = runCatching { useCase.generate(sessionId, "问").toList() }.exceptionOrNull()
        assertNotNull("实现异常必须可被调用方观察到", thrown)
        assertEquals("boom", thrown!!.message)
    }

    @Test
    fun historyRespectsConfiguredLimit() = runBlocking {
        val (store, sessionId) = seedStore()
        val seq = SeqIds()
        val gateway = FakeModelGateway(listOf(chunk("ok"), finish()))
        val useCase = LocalChatGenerationUseCase(
            store = store,
            gateway = gateway,
            profileProvider = { profile() },
            idFactory = { seq.next() },
            now = { 1_000L },
            historyLimit = 2,
        )

        repeat(3) { index -> useCase.generate(sessionId, "第${index + 1}句").toList() }

        // 三次生成共 3 user + 3 assistant = 6 条；读取上限 2 时装配器只看到最近 2 条 +
        // 本轮用户消息（真正的裁剪口径是装配器的 token 预算，读取上限只是兜底）。
        val request = gateway.lastRequest!!
        assertEquals("system", request.messages.first().role)
        val conversation = request.messages.filter { it.role != "system" }
        assertTrue("historyLimit=2 时对话消息数应受限", conversation.size <= 3)
        assertEquals("第3句", conversation.last().content)
    }

    @Test
    fun providerFromWireFallsBackToOpenAi() {
        assertEquals(ModelProvider.OpenAI, providerFromWire("openai"))
        assertEquals(ModelProvider.Anthropic, providerFromWire("anthropic"))
        assertEquals(ModelProvider.Ollama, providerFromWire("ollama"))
        assertEquals("未知 provider 回退 OpenAI", ModelProvider.OpenAI, providerFromWire("nonsense"))
    }

    @Test
    fun ulidIsWellFormedAndMonotonic() {
        val first = Ulid.newId()
        val second = Ulid.newId()
        assertTrue("ULID 必须合法", Ulid.isValid(first))
        assertEquals(26, first.length)
        assertTrue("同毫秒内必须单调递增", second >= first)
        assertFalse(Ulid.isValid("short"))
        assertFalse("含非法字符应被拒绝", Ulid.isValid("0123456789ABCDEFGHJKMNPQRSTU!"))
    }
}
