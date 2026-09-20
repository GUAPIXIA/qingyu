package com.qingyu.companion.data.local

import com.qingyu.companion.chatcore.ChatTranslationPrompt
import com.qingyu.companion.chatcore.LocalChatGenerationUseCase
import com.qingyu.companion.chatcore.ModelGateway
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.db.LocalMessageEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.testing.FakeLocalStore
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelChunk
import com.qingyu.companion.network.models.ModelError
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.ModelRequestHandle
import com.qingyu.companion.network.models.ModelStreamEvent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-04：消息翻译的本地实现测试。
 *
 * 此前 `translate` 走 `notMigrated` → 「翻译」按钮点了没反应、返回空译文。
 * 本文件锁定修复后的契约：
 * - 系统提示词与采样参数与 PC 一致（提示词由 fixture 锁定）；
 * - 译文以「同 id 覆盖」写回消息，不产生新消息；
 * - 模型失败/空输出必须抛错，而不是静默写一条空译文。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class LocalTranslationTest {

    private class ScriptedGateway(private val scripts: MutableList<List<ModelStreamEvent>>) : ModelGateway {
        var lastRequest: ModelChatRequest? = null
        override fun stream(
            provider: ModelProvider,
            profile: ConnectionProfilePublic,
            request: ModelChatRequest,
            apiKey: String?,
        ): Pair<Flow<ModelStreamEvent>, ModelRequestHandle> {
            lastRequest = request
            val script = if (scripts.isEmpty()) emptyList() else scripts.removeAt(0)
            val handle = object : ModelRequestHandle {
                override fun cancel() = Unit
                override val isCancelled: Boolean = false
            }
            return flow { script.forEach { emit(it) } } to handle
        }
    }

    private suspend fun seedStore(): FakeLocalStore {
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
        store.appendMessage(
            LocalMessageEntity(
                id = "m1",
                sessionId = "s1",
                characterId = "c1",
                role = "assistant",
                content = "Good evening.",
                logicalTime = 1,
                seq = -1L,
                createdAt = 1,
                updatedAt = 1,
            ),
        )
        return store
    }

    private fun build(
        store: FakeLocalStore,
        gateway: ScriptedGateway,
    ): LocalChatRepository = LocalChatRepository(
        store = store,
        generation = LocalChatGenerationUseCase(
            store = store,
            gateway = gateway,
            profileProvider = { null },
        ),
        activeProfileAndKey = {
            ConnectionProfilePublic(
                id = "p1",
                provider = ModelProvider.OpenAI,
                baseUrl = "https://api.example.com/v1",
                model = "gpt-4o-mini",
            ) to "sk-test"
        },
        auxGateway = gateway,
        requestIdFactory = { "r1" },
    )

    private fun chunk(text: String) = ModelStreamEvent.Chunk(ModelChunk(text))

    @Test
    fun translationCallsModelWithPcPromptAndPersistsInPlace() = runBlocking {
        val store = seedStore()
        val gateway = ScriptedGateway(mutableListOf(listOf(chunk("晚上好。"))))
        val repository = build(store, gateway)

        val response = repository.translate("s1", "m1")

        assertEquals("m1", response.messageId)
        assertEquals("晚上好。", response.translation)

        val request = gateway.lastRequest!!
        assertEquals(2, request.messages.size)
        assertEquals("system", request.messages[0].role)
        assertEquals(
            ChatTranslationPrompt.buildMessageTranslationSystemPrompt(ChatTranslationPrompt.DEFAULT_TARGET_LANG),
            request.messages[0].content,
        )
        // 原文原样作为 user 内容（不做任何包裹）
        assertEquals("Good evening.", request.messages[1].content)
        assertEquals(0.3, request.temperature!!, 1e-9)
        assertEquals(false, request.stream)
        assertTrue("必须带上翻译任务预算", (request.maxTokens ?: 0) > 0)

        // 同 id 覆盖：消息数不变，且只有这一条带译文
        val messages = store.listMessages("s1")
        assertEquals("翻译不得产生新消息", 1, messages.size)
        assertEquals("晚上好。", messages[0].translation)
        assertEquals("原文不得被改写", "Good evening.", messages[0].content)
    }

    @Test
    fun translationStripsOuterCodeFence() = runBlocking {
        val store = seedStore()
        val gateway = ScriptedGateway(mutableListOf(listOf(chunk("```markdown\n晚上好。\n```"))))
        val repository = build(store, gateway)

        val response = repository.translate("s1", "m1")
        assertEquals("晚上好。", response.translation)
        assertEquals("晚上好。", store.listMessages("s1")[0].translation)
    }

    @Test
    fun emptyTranslationFailsInsteadOfWritingBlank() = runBlocking {
        val store = seedStore()
        val gateway = ScriptedGateway(mutableListOf(listOf(chunk("   "))))
        val repository = build(store, gateway)

        val error = runCatching { repository.translate("s1", "m1") }.exceptionOrNull()
        assertTrue("空译文必须抛错，实际 $error", error is IllegalStateException)
        assertEquals("不得写入空译文", null, store.listMessages("s1")[0].translation)
    }

    @Test
    fun modelFailureSurfacesAsErrorWithoutPersisting() = runBlocking {
        val store = seedStore()
        val gateway = ScriptedGateway(
            mutableListOf(listOf(ModelStreamEvent.Failure(ModelError(code = "HTTP_500", message = "boom", retryable = false)))),
        )
        val repository = build(store, gateway)

        val error = runCatching { repository.translate("s1", "m1") }.exceptionOrNull()
        assertTrue("模型失败必须抛错，实际 $error", error is IllegalStateException)
        assertEquals(null, store.listMessages("s1")[0].translation)
    }

    @Test
    fun missingMessageFails() = runBlocking {
        val store = seedStore()
        val gateway = ScriptedGateway(mutableListOf(listOf(chunk("x"))))
        val repository = build(store, gateway)
        val error = runCatching { repository.translate("s1", "missing") }.exceptionOrNull()
        assertTrue("目标消息不存在必须抛错，实际 $error", error is IllegalArgumentException)
    }

    @Test
    fun missingProfileFailsWithActionableMessage() = runBlocking {
        val store = seedStore()
        val gateway = ScriptedGateway(mutableListOf(listOf(chunk("x"))))
        val repository = LocalChatRepository(
            store = store,
            generation = LocalChatGenerationUseCase(
                store = store,
                gateway = gateway,
                profileProvider = { null },
            ),
            activeProfileAndKey = { null to null },
            auxGateway = gateway,
            requestIdFactory = { "r1" },
        )
        val error = runCatching { repository.translate("s1", "m1") }.exceptionOrNull()
        assertTrue("未配置连接必须给出可行动错误，实际 $error", error is IllegalStateException)
        assertTrue(error!!.message!!.contains("未配置"))
    }
}
