package com.qingyu.companion.chatcore

import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.testing.FakeLocalStore
import com.qingyu.companion.network.models.ChatMessageDto
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
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-02 的另一半：**本地阻断**。
 *
 * `ChatContextOverflowDetectionTest` 覆盖「检测」，这里覆盖「不把超限请求发出去」——
 * 方案原话是「不能只依赖供应商报错」。若这里失效，用户在大预设/大世界书下会看到
 * 供应商的原始报错（甚至被静默截断），而不是可行动的本地提示。
 *
 * 反向同样重要：**正常输入绝不能被误阻断**，因此两个方向都断言。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class LocalGenerationOverflowGuardTest {

    private class CountingGateway(private val reply: String = "助手回复。") : ModelGateway {
        var calls = 0
            private set

        override fun stream(
            provider: ModelProvider,
            profile: ConnectionProfilePublic,
            request: ModelChatRequest,
            apiKey: String?,
        ): Pair<Flow<ModelStreamEvent>, ModelRequestHandle> {
            calls++
            val handle = object : ModelRequestHandle {
                override fun cancel() = Unit
                override val isCancelled: Boolean = false
            }
            return flow {
                emit(ModelStreamEvent.Chunk(ModelChunk(deltaText = reply)))
                emit(ModelStreamEvent.Completed("stop", null))
            } to handle
        }
    }

    /**
     * 播种一个「非历史部分本身就超限」的会话。
     *
     * 触发源用**会话预设**：预设正文此前完全没有接线（装配器收不到），
     * 本轮已接通，因此它也是唯一能让「非历史部分」超出输入池的现实输入
     * （角色描述/世界书都受各自预算约束）。
     */
    private fun storeWith(presetBodyJson: String?, maxContext: Int): FakeLocalStore = runBlocking {
        val store = FakeLocalStore("overflow-guard")
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "苏晚", createdAt = 0, updatedAt = 0))
        store.putSession(
            LocalSessionEntity(id = "s1", characterId = "c1", presetId = "p1", createdAt = 0, updatedAt = 0),
        )
        store.putPreset(
            com.qingyu.companion.local.db.LocalPresetEntity(
                id = "p1",
                name = "预设",
                bodyJson = presetBodyJson ?: "{}",
                createdAt = 0,
                updatedAt = 0,
            ),
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
        store
    }

    private fun useCase(store: FakeLocalStore, gateway: CountingGateway) = LocalChatGenerationUseCase(
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

    private fun deltas(useCase: LocalChatGenerationUseCase, userText: String = "夜安。") = runBlocking {
        useCase.generate(sessionId = "s1", userText = userText).toList()
    }

    @Test
    fun oversizedContextIsBlockedLocallyWithoutCallingTheModel() {
        // 预设远超上下文：必须本地阻断，且**一次模型调用都不能发**
        val gateway = CountingGateway()
        val store = storeWith(
            presetBodyJson = org.json.JSONObject()
                .put("systemPrompt", "很长的预设。".repeat(4000))
                // 预设自带上下文上限（PC 预设同样可配）——这正是「非历史部分撑爆输入池」的现实场景
                .put("maxContext", 2048)
                .toString(),
            maxContext = 2048,
        )
        val events = deltas(useCase(store, gateway))

        assertEquals("超限必须本地阻断，绝不能把请求发给供应商", 0, gateway.calls)
        val finished = events.filterIsInstance<LocalChatGenerationUseCase.Delta.Finished>().lastOrNull()
        assertTrue("必须给出明确的本轮结束事件", finished != null)
        val outcome = finished!!.outcome
        assertEquals("必须是失败终态而不是静默成功", "failed", outcome.status)
        assertEquals("必须带上可识别的失败码", "CONTEXT_OVERFLOW", outcome.failureCode)
        assertTrue(
            "错误提示必须是可行动的本地文案（含上下文超限语义），实际：${outcome.noticeText}",
            outcome.noticeText.orEmpty().contains("上下文") && outcome.noticeText.orEmpty().contains("超出"),
        )
    }

    @Test
    fun normalContextStillCallsTheModel() {
        // 反向断言：正常输入绝不能被误阻断（误阻断比漏报更糟）
        val gateway = CountingGateway()
        val store = storeWith(presetBodyJson = """{"systemPrompt":"你是助手。"}""", maxContext = 8192)
        val events = deltas(useCase(store, gateway))

        assertTrue("正常输入必须照常调用模型", gateway.calls >= 1)
        assertTrue(
            "正常轮次不得出现失败结果",
            events.filterIsInstance<LocalChatGenerationUseCase.Delta.Finished>()
                .none { it.outcome.status == "failed" },
        )
    }
}
