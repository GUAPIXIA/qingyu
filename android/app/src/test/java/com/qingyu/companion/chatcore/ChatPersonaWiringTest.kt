package com.qingyu.companion.chatcore

import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.db.LocalPersonaEntity
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
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-04：会话级**人设**与「会话覆盖 > 角色默认 > 全局默认」的解析链。
 *
 * 此前装配器从未收到人设（`personaInjection`/`userDescription`/`userPersona` 一律为空），
 * 用户人设完全不生效且不报错；角色卡自带的默认预设/人设/世界书也一律被忽略。
 * 本测试锁定解析链的每一层，避免「只接会话绑定、忘了角色默认」这种半接线。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatPersonaWiringTest {

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

    private fun run(
        character: LocalCharacterEntity,
        session: LocalSessionEntity,
        personas: List<LocalPersonaEntity>,
        presets: List<LocalPresetEntity> = emptyList(),
    ): CapturingGateway = runBlocking {
        val store = FakeLocalStore("persona-wiring")
        store.putCharacter(character)
        store.putSession(session)
        personas.forEach { store.putPersona(it) }
        presets.forEach { store.putPreset(it) }
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
        LocalChatGenerationUseCase(
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
        ).generate(sessionId = "s1", userText = "夜安。").toList()
        gateway
    }

    private fun requestText(gateway: CapturingGateway): String =
        gateway.lastRequest?.messages?.joinToString("\n") { it.content } ?: ""

    @Test
    fun sessionBoundPersonaReachesTheRequest() {
        val gateway = run(
            character = LocalCharacterEntity(id = "c1", name = "苏晚", createdAt = 0, updatedAt = 0),
            session = LocalSessionEntity(id = "s1", characterId = "c1", personaId = "u1", createdAt = 0, updatedAt = 0),
            personas = listOf(
                LocalPersonaEntity(
                    id = "u1",
                    name = "旅人",
                    description = "常年在外旅行。",
                    persona = "沉默寡言。",
                    createdAt = 0,
                    updatedAt = 0,
                ),
            ),
        )
        val text = requestText(gateway)
        assertTrue("会话绑定的人设描述必须出现在请求里：\n$text", text.contains("常年在外旅行"))
        assertTrue("会话绑定的人设性格必须出现在请求里：\n$text", text.contains("沉默寡言"))
    }

    @Test
    fun characterDefaultPersonaIsUsedWhenSessionHasNone() {
        // 半接线的典型反例：只读会话绑定、忽略角色卡默认值
        val gateway = run(
            character = LocalCharacterEntity(
                id = "c1",
                name = "苏晚",
                defaultPersonaId = "u9",
                createdAt = 0,
                updatedAt = 0,
            ),
            session = LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0),
            personas = listOf(
                LocalPersonaEntity(
                    id = "u9",
                    name = "角色默认人设",
                    description = "角色卡指定的人设。",
                    createdAt = 0,
                    updatedAt = 0,
                ),
                LocalPersonaEntity(
                    id = "u0",
                    name = "全局默认人设",
                    isDefault = true,
                    description = "全局默认。",
                    createdAt = 0,
                    updatedAt = 0,
                ),
            ),
        )
        val text = requestText(gateway)
        assertTrue("会话未绑定时必须回退到角色默认人设：\n$text", text.contains("角色卡指定的人设"))
        assertTrue("角色默认优先于全局默认：\n$text", !text.contains("全局默认。"))
    }

    @Test
    fun globalDefaultPersonaIsUsedWhenNothingIsBound() {
        val gateway = run(
            character = LocalCharacterEntity(id = "c1", name = "苏晚", createdAt = 0, updatedAt = 0),
            session = LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0),
            personas = listOf(
                LocalPersonaEntity(
                    id = "u0",
                    name = "全局默认人设",
                    isDefault = true,
                    description = "全局默认。",
                    createdAt = 0,
                    updatedAt = 0,
                ),
            ),
        )
        assertTrue("无任何绑定时必须回退到全局默认人设：\n${requestText(gateway)}", requestText(gateway).contains("全局默认。"))
    }

    @Test
    fun characterDefaultPresetIsUsedWhenSessionHasNone() {
        val gateway = run(
            character = LocalCharacterEntity(
                id = "c1",
                name = "苏晚",
                defaultPresetId = "p9",
                createdAt = 0,
                updatedAt = 0,
            ),
            session = LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0),
            personas = emptyList(),
            presets = listOf(
                LocalPresetEntity(
                    id = "p9",
                    name = "角色默认预设",
                    bodyJson = """{"systemPrompt":"角色默认预设的系统提示。"}""",
                    createdAt = 0,
                    updatedAt = 0,
                ),
            ),
        )
        assertTrue(
            "会话未绑预设时必须回退到角色默认预设：\n${requestText(gateway)}",
            requestText(gateway).contains("角色默认预设的系统提示"),
        )
    }

    @Test
    fun noPersonaStillGenerates() {
        val gateway = run(
            character = LocalCharacterEntity(id = "c1", name = "苏晚", createdAt = 0, updatedAt = 0),
            session = LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0),
            personas = emptyList(),
        )
        assertTrue("没有人设时仍必须能正常生成", gateway.lastRequest != null)
    }
}
