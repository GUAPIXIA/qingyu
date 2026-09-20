package com.qingyu.companion.chatcore

import com.qingyu.companion.data.local.LocalChatRepository
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.testing.FakeLocalStore
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelChunk
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.ModelRequestHandle
import com.qingyu.companion.network.models.ModelStreamEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
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
 * 阶段 4 S4-04：会话级叙事模式的**写入方与闭环**。
 *
 * v3 迁移加出了 `local_sessions.narrative_mode` 列，但「有列」只是必要条件：
 * 没有写入方，列永远是默认值，用户也就无法切换「代入式 / 全局叙事」。
 * 本测试锁定三件事：
 * 1. 仓库写入能往返（写进去、读出来、确实落库）；
 * 2. 非法取值被拒绝（不把脏值写进库、再被装配器当成有效模式）；
 * 3. 写进去的值**真的改变发往模型的请求**（叙事模式进入系统提示）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class SessionNarrativeModeWriteTest {

    private class CapturingGateway : ModelGateway {
        var lastRequest: ModelChatRequest? = null

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

    private fun seedStore(): FakeLocalStore = runBlocking {
        val store = FakeLocalStore("narrative-mode-write")
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
        store
    }

    private fun repository(store: FakeLocalStore, gateway: ModelGateway = CapturingGateway()) = LocalChatRepository(
        store = store,
        generation = LocalChatGenerationUseCase(
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
        ),
        scope = CoroutineScope(Dispatchers.Unconfined),
        requestIdFactory = { "r1" },
    )

    @Test
    fun narrativeModeRoundTripsThroughTheSessionRow() = runBlocking {
        val store = seedStore()
        val repository = repository(store)

        assertEquals("初始应为未设置", "", repository.getSessionNarrativeMode("s1"))
        repository.patchSessionRuntimeState("s1", narrativeMode = "omniscient")
        assertEquals("写入后必须能读回", "omniscient", repository.getSessionNarrativeMode("s1"))
        assertEquals("必须真的落库（而不是只改内存）", "omniscient", store.getSession("s1")!!.narrativeMode)
    }

    @Test
    fun patchOnlyTouchesProvidedFields() = runBlocking {
        val store = seedStore()
        val repository = repository(store)
        repository.patchSessionRuntimeState("s1", narrativeMode = "omniscient")
        repository.patchSessionRuntimeState("s1", responseLengthMode = "detailed")
        val session = store.getSession("s1")!!
        assertEquals("只改篇幅时不得清掉叙事模式", "omniscient", session.narrativeMode)
        assertEquals("detailed", session.responseLengthMode)
    }

    @Test
    fun invalidValuesAreRejectedBeforePersisting() = runBlocking {
        val store = seedStore()
        val repository = repository(store)
        val bad = runCatching { repository.patchSessionRuntimeState("s1", narrativeMode = "乱写的模式") }
        assertTrue("非法叙事模式必须被拒绝", bad.isFailure)
        assertEquals("被拒绝的值不得落库", "", store.getSession("s1")!!.narrativeMode)

        val badLength = runCatching { repository.patchSessionRuntimeState("s1", responseLengthMode = "huge") }
        assertTrue("非法篇幅模式必须被拒绝", badLength.isFailure)
        assertEquals("", store.getSession("s1")!!.responseLengthMode)
    }

    @Test
    fun narrativeModeChangesTheModelRequest() = runBlocking {
        val store = seedStore()
        val gateway = CapturingGateway()
        val repository = repository(store, gateway)

        repository.sendMessage("s1", "r1", "夜安。")
        val beforeText = gateway.lastRequest!!.messages.joinToString("\n") { it.content }

        gateway.lastRequest = null
        repository.patchSessionRuntimeState("s1", narrativeMode = "omniscient")
        repository.sendMessage("s1", "r2", "继续。")
        val afterText = gateway.lastRequest!!.messages.joinToString("\n") { it.content }

        assertTrue(
            "切换叙事模式必须改变发往模型的提示（否则切换是空转）：\n$afterText",
            beforeText != afterText,
        )
    }
}
