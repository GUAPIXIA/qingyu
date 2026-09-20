package com.qingyu.companion.ui.announcements

import com.qingyu.companion.chatcore.LocalChatGenerationUseCase
import com.qingyu.companion.chatcore.ModelGateway
import com.qingyu.companion.data.local.LocalChatRepository
import com.qingyu.companion.local.testing.FakeLocalStore
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.ModelRequestHandle
import com.qingyu.companion.network.models.ModelStreamEvent
import com.qingyu.companion.ui.components.LoadState
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 阶段 5 §2.28 的「可见性未闭环」收口：**本地模式的未迁移提示要真的出现在公告页**。
 *
 * 背景：公告在本地模式是未迁移能力，仓库会经 `notMigrated` 写一句可行动提示，
 * 但此前只有 `ChatViewModel` 消费 `unsupportedNotice`——公告页仍然显示「暂无公告」，
 * 用户分不清「真的没有公告」与「这一端还没提供」。**提示写了却没人显示，等于没写。**
 *
 * 用真实 `LocalChatRepository` + `FakeLocalStore`（不碰网络），断言：
 * ① 提示进入 `UiState.notice`（界面把它作为空态说明渲染）；
 * ② 空列表**仍然**投影为 `Empty`——提示是空态的补充说明，不改五态语义；
 * ③ 不伪造公告条数。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AnnouncementsNoticeTest {

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

    @Test
    fun `本地模式的未迁移提示进入公告页状态而不是只说暂无公告`() = runTest(dispatcher) {
        val store = FakeLocalStore("android-device")
        var n = 0
        val generation = LocalChatGenerationUseCase(
            store = store,
            gateway = NoopGateway(),
            profileProvider = { null },
            idFactory = { "id-${++n}" },
        )
        val repository = LocalChatRepository(store, generation) { "id-${++n}" }

        val vm = AnnouncementsViewModel(repository, repository.unsupportedNotice)
        advanceUntilIdle()

        val notice = vm.ui.value.notice
        assertNotNull("本地模式下公告是未迁移能力，提示必须接到界面状态里（不能只写进仓库没人看）", notice)
        assertTrue(
            "提示要说明是本地模式尚未提供，实际：$notice",
            notice!!.contains("尚未在本地模式提供"),
        )
        assertTrue(
            "空列表仍应投影为 Empty（提示是空态的补充说明，不改五态语义），实际 ${vm.loadState.value}",
            vm.loadState.value is LoadState.Empty,
        )
        assertTrue("不得伪造公告条数", vm.ui.value.items.isEmpty())
    }
}
