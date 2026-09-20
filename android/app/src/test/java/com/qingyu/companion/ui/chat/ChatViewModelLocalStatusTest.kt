package com.qingyu.companion.ui.chat

import com.qingyu.companion.chatcore.LocalChatGenerationUseCase
import com.qingyu.companion.chatcore.ModelGateway
import com.qingyu.companion.data.local.LocalChatRepository
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.testing.FakeLocalStore
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.ModelRequestHandle
import com.qingyu.companion.network.models.ModelStreamEvent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 阶段 4 S4-06：`ChatViewModel` 在**真实本地仓库**下的状态标签接线测试。
 *
 * 与 `ChatStatusLabelTest`（纯映射）分工：这里验证状态确实从本地档案流到 UI 状态，
 * 即「切到本地仓库后，顶栏显示的到底是本地直连还是 PC 远程」这件事。
 * 用 FakeLocalStore + 脚本化网关，不触碰网络。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatViewModelLocalStatusTest {

    private val dispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private class NoopGateway : ModelGateway {
        override fun stream(
            provider: ModelProvider,
            profile: ConnectionProfilePublic,
            request: ModelChatRequest,
            apiKey: String?,
        ): Pair<Flow<ModelStreamEvent>, ModelRequestHandle> {
            val handle = object : ModelRequestHandle {
                override fun cancel() = Unit
                override val isCancelled: Boolean = false
            }
            return flow<ModelStreamEvent> { } to handle
        }
    }

    private class Fixture(val store: FakeLocalStore, val repository: LocalChatRepository)

    private suspend fun fixture(profileModel: String? = "gpt-4o-mini", sessionTitle: String = ""): Fixture {
        val store = FakeLocalStore("android-test")
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "苏晚", createdAt = 0, updatedAt = 0))
        store.putSession(
            LocalSessionEntity(id = "s1", characterId = "c1", title = sessionTitle, createdAt = 0, updatedAt = 0),
        )
        if (profileModel != null) {
            store.upsertConnectionProfile(
                LocalConnectionProfileEntity(
                    id = "p1",
                    provider = "openai",
                    baseUrl = "https://api.example.com/v1",
                    model = profileModel,
                    createdAt = 0,
                    updatedAt = 0,
                ),
            )
        }
        var n = 0
        val generation = LocalChatGenerationUseCase(
            store = store,
            gateway = NoopGateway(),
            profileProvider = {
                store.listConnectionProfiles().firstOrNull()?.let { p ->
                    ConnectionProfilePublic(
                        id = p.id,
                        provider = ModelProvider.fromWire(p.provider) ?: ModelProvider.OpenAI,
                        baseUrl = p.baseUrl,
                        model = p.model,
                        allowHttp = p.allowHttp,
                    )
                }
            },
            idFactory = { "id-${++n}" },
        )
        return Fixture(store, LocalChatRepository(store, generation) { "id-${++n}" })
    }

    @Test
    fun topBarShowsLocalDirectModelLabelNotPcRemote() = runTest(dispatcher) {
        val f = fixture()

        val vm = ChatViewModel(f.repository, "s1", ttsPlayer = null)
        advanceUntilIdle()

        assertEquals("本地直连 · gpt-4o-mini", vm.ui.value.sourceLabel)
        assertEquals("本地直连 · gpt-4o-mini", vm.ui.value.secondaryLine)
        assertEquals("角色名必须参与顶栏", "苏晚", vm.ui.value.characterName)
    }

    @Test
    fun sessionTitleIsJoinedWithSourceLabel() = runTest(dispatcher) {
        val f = fixture(sessionTitle = "第一次相遇")

        val vm = ChatViewModel(f.repository, "s1", ttsPlayer = null)
        advanceUntilIdle()

        assertEquals("第一次相遇 · 本地直连 · gpt-4o-mini", vm.ui.value.secondaryLine)
    }

    @Test
    fun missingModelProfileProducesActionableHintInsteadOfSilentFailure() = runTest(dispatcher) {
        val f = fixture(profileModel = null)

        val vm = ChatViewModel(f.repository, "s1", ttsPlayer = null)
        advanceUntilIdle()

        assertEquals("本地直连 · 未配置模型", vm.ui.value.sourceLabel)
        assertNotNull("必须给出可行动作", vm.ui.value.actionHint)
        assertTrue(
            "副标题行应优先展示动作而非仅报状态",
            vm.ui.value.secondaryLine.contains("请到「连接」页"),
        )
    }

    @Test
    fun labelFollowsProfileChangesAfterRefresh() = runTest(dispatcher) {
        val f = fixture()
        val vm = ChatViewModel(f.repository, "s1", ttsPlayer = null)
        advanceUntilIdle()
        assertEquals("本地直连 · gpt-4o-mini", vm.ui.value.sourceLabel)

        // 用户换成另一个模型：刷新后标签必须跟着走，而不是停在旧值
        f.store.upsertConnectionProfile(
            LocalConnectionProfileEntity(
                id = "p1",
                provider = "anthropic",
                baseUrl = "https://api.anthropic.com",
                model = "claude-sonnet",
                createdAt = 0,
                updatedAt = 0,
            ),
        )
        f.repository.refreshDataSourceStatus()
        advanceUntilIdle()

        assertEquals("本地直连 · claude-sonnet", vm.ui.value.sourceLabel)
    }
}
