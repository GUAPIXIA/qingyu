package com.qingyu.companion.chatcore

import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.testing.FakeLocalStore
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelChunk
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.ModelRequestHandle
import com.qingyu.companion.network.models.ModelStreamEvent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-04：「会话级预设」必须在生成时**生效**。
 *
 * 此前 `LocalChatGenerationUseCase` **从未把会话预设传给装配器**——
 * 用户设置了预设却毫无效果，且不报任何错（又一例「功能在、接线不在」）。
 * 本测试锁定两段：
 * 1. 解析：`body_json` → 装配器输入（缺字段取默认、未知字段忽略、坏 JSON 不致失败）；
 * 2. 端到端：会话绑定的预设正文**确实出现在发给模型的请求里**。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatPresetWiringTest {

    private class CapturingGateway : ModelGateway {
        var lastRequest: ModelChatRequest? = null
            private set

        override fun stream(
            provider: ModelProvider,
            profile: ConnectionProfilePublic,
            request: ModelChatRequest,
            apiKey: String?,
        ): Pair<Flow<ModelStreamEvent>, ModelRequestHandle> {
            lastRequest = request
            val handle = object : ModelRequestHandle {
                override fun cancel() = Unit
                override val isCancelled: Boolean = false
            }
            return flow {
                emit(ModelStreamEvent.Chunk(ModelChunk(deltaText = "回复。")))
                emit(ModelStreamEvent.Completed("stop", null))
            } to handle
        }
    }

    // ---------- 解析 ----------

    @Test
    fun parsesCamelCaseAndSnakeCaseKeys() {
        val camel = ChatPresetCompile.parse(
            """{"systemPrompt":"你是助手。","jailbreak":"越狱段","maxContext":4096,"maxTokens":512,"enableThoughtFormat":true}""",
            "p1",
        )
        assertEquals("p1", camel.id)
        assertEquals("你是助手。", camel.systemPrompt)
        assertEquals("越狱段", camel.jailbreak)
        assertEquals(4096, camel.maxContext)
        assertEquals(512, camel.maxTokens)
        assertEquals(true, camel.enableThoughtFormat)

        val snake = ChatPresetCompile.parse(
            """{"system_prompt":"主线提示","post_history_instructions":"后历史","max_context":2048,"max_tokens":256}""",
            "p2",
        )
        assertEquals("主线提示", snake.systemPrompt)
        assertEquals("后历史", snake.jailbreak)
        assertEquals(2048, snake.maxContext)
        assertEquals(256, snake.maxTokens)
    }

    @Test
    fun missingOrMalformedBodyFallsBackToDefaultsInsteadOfFailing() {
        val empty = ChatPresetCompile.parse(null, "p1")
        assertEquals("", empty.systemPrompt)
        assertEquals(0, empty.maxContext)
        assertNull(empty.enableThoughtFormat)

        val blank = ChatPresetCompile.parse("   ", "p1")
        assertEquals("", blank.systemPrompt)

        // 坏 JSON 不得让整轮生成失败：退化为「没有预设」
        val broken = ChatPresetCompile.parse("{不是 JSON", "p1")
        assertEquals("", broken.systemPrompt)
        assertEquals("p1", broken.id)
    }

    @Test
    fun unknownFieldsAreIgnoredNotRejected() {
        // S5-03 之前 body 里可能有任何东西：未知字段必须被忽略而不是报错
        val parsed = ChatPresetCompile.parse(
            """{"systemPrompt":"甲","完全未知的字段":{"a":[1,2,3]},"temperature":0.8,"topP":0.9}""",
            "p1",
        )
        assertEquals("甲", parsed.systemPrompt)
    }

    // ---------- 端到端 ----------

    private fun seedAndRun(bodyJson: String): CapturingGateway = runBlocking {
        val store = FakeLocalStore("preset-wiring")
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "苏晚", createdAt = 0, updatedAt = 0))
        store.putSession(
            LocalSessionEntity(id = "s1", characterId = "c1", presetId = "p1", createdAt = 0, updatedAt = 0),
        )
        store.putPreset(
            LocalPresetEntity(id = "p1", name = "预设", bodyJson = bodyJson, createdAt = 0, updatedAt = 0),
        )
        store.upsertConnectionProfile(
            LocalConnectionProfileEntity(
                id = "profile-1",
                provider = "openai",
                baseUrl = "https://example.invalid/v1",
                model = "gpt-4o-mini",
                createdAt = 0,
                updatedAt = 0,
            ),
        )
        val gateway = CapturingGateway()
        val useCase = LocalChatGenerationUseCase(
            store = store,
            gateway = gateway,
            profileProvider = {
                ConnectionProfilePublic(
                    id = "profile-1",
                    provider = ModelProvider.OpenAI,
                    baseUrl = "https://example.invalid/v1",
                    model = "gpt-4o-mini",
                )
            },
            apiKeyProvider = { "sk-test" },
        )
        useCase.generate(sessionId = "s1", userText = "夜安。").toList()
        gateway
    }

    @Test
    fun sessionPresetSystemPromptReachesTheModelRequest() {
        val gateway = seedAndRun("""{"systemPrompt":"预设里的系统提示：务必保持旧书香气。"}""")
        val request = gateway.lastRequest
        assertTrue("必须真的调用了模型", request != null)
        val joined = request!!.messages.joinToString("\n") { it.content }
        assertTrue(
            "会话绑定的预设正文必须出现在请求里（否则就是「设了预设却没效果」）：\n$joined",
            joined.contains("务必保持旧书香气"),
        )
    }

    @Test
    fun sessionWithoutPresetStillWorks() {
        val gateway = runBlocking {
            val store = FakeLocalStore("preset-none")
            store.putCharacter(LocalCharacterEntity(id = "c1", name = "苏晚", createdAt = 0, updatedAt = 0))
            store.putSession(LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0))
            store.upsertConnectionProfile(
                LocalConnectionProfileEntity(
                    id = "profile-1",
                    provider = "openai",
                    baseUrl = "https://example.invalid/v1",
                    model = "gpt-4o-mini",
                    createdAt = 0,
                    updatedAt = 0,
                ),
            )
            val gateway = CapturingGateway()
            val useCase = LocalChatGenerationUseCase(
                store = store,
                gateway = gateway,
                profileProvider = {
                    ConnectionProfilePublic(
                        id = "profile-1",
                        provider = ModelProvider.OpenAI,
                        baseUrl = "https://example.invalid/v1",
                        model = "gpt-4o-mini",
                    )
                },
                apiKeyProvider = { "sk-test" },
            )
            useCase.generate(sessionId = "s1", userText = "夜安。").toList()
            gateway
        }
        assertTrue("没有绑定预设时仍必须能正常生成", gateway.lastRequest != null)
    }
}
