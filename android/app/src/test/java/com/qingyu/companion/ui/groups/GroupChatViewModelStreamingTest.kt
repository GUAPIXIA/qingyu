package com.qingyu.companion.ui.groups

import com.qingyu.companion.chatcore.ChatGroupTurnMachine
import com.qingyu.companion.chatcore.LocalGroupGenerationUseCase
import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.DialogueDirection
import com.qingyu.companion.model.GroupMessage
import com.qingyu.companion.network.WsClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 群生成流式转发 + 停止 + 立即接话 + 续写（S6-01f 第 3／4 项）ViewModel JVM 单测。
 * 用脚本化 [GroupGenerationDriver] 驱动 Flow，断言流式/停止语义（错误绝不进正文）。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class GroupChatViewModelStreamingTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var repo: StreamingGroupRepository
    private lateinit var driver: ScriptedDriver

    private fun turn(speakerId: String?) = ChatGroupTurnMachine.Turn("assistant", speakerId, 1L)

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repo = StreamingGroupRepository()
        driver = ScriptedDriver()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun vm() = GroupChatViewModel(repo, "g1", "s1", null, driver, null)

    @Test
    fun `Chunk 实时上屏 TurnFinished 落库并清缓冲`() = runTest(dispatcher) {
        // 模拟 LocalGroupGenerationUseCase 在 TurnFinished 前把本轮正文落盘
        driver.script = flow {
            emit(LocalGroupGenerationUseCase.Delta.TurnStarted(turn("c1"), "r#t0"))
            emit(LocalGroupGenerationUseCase.Delta.Chunk("r#t0", "你好"))
            repo.messages += GroupMessage(id = "ai1", groupId = "g1", characterId = "c1", content = "你好", timestamp = 2000L, round = 1)
            emit(LocalGroupGenerationUseCase.Delta.TurnFinished(turn("c1"), listOf("ai1"), emptyMap(), "complete"))
        }
        val vm = vm()
        advanceUntilIdle()
        vm.onInputChange("hi")
        vm.send()
        advanceUntilIdle()

        assertEquals("TurnFinished 后流式缓冲清零", "", vm.streaming.value.streamingText)
        assertEquals("完成一轮", 1, vm.streaming.value.finishedTurns)
        // 落库消息（fake 在 TurnFinished 后由 refresh 拉回 ai1）
        assertTrue("落库 AI 回复可见", vm.ui.value.messages.any { it.id == "ai1" })
        assertFalse("结束后不再生成中", vm.ui.value.generating)
    }

    @Test
    fun `generationError 只进提示字段绝不进正文`() = runTest(dispatcher) {
        driver.script = flowOf(
            LocalGroupGenerationUseCase.Delta.TurnStarted(turn("c1"), "r#t0"),
            LocalGroupGenerationUseCase.Delta.Chunk("r#t0", "正文"),
            LocalGroupGenerationUseCase.Delta.TurnFinished(turn("c1"), emptyList(), mapOf("generationError" to "网络中断"), "failed"),
        )
        val vm = vm()
        advanceUntilIdle()
        vm.onInputChange("hi")
        vm.send()
        advanceUntilIdle()

        assertEquals("失败原因进提示字段", "网络中断", vm.streaming.value.error)
        assertFalse("错误绝不进正文", vm.streaming.value.streamingText.contains("网络中断"))
    }

    @Test
    fun `Stopped 保留已见正文并标已停止生成`() = runTest(dispatcher) {
        driver.script = flowOf(
            LocalGroupGenerationUseCase.Delta.TurnStarted(turn("c1"), "r#t0"),
            LocalGroupGenerationUseCase.Delta.Chunk("r#t0", "半截正文"),
            LocalGroupGenerationUseCase.Delta.Stopped("stopped"),
        )
        val vm = vm()
        advanceUntilIdle()
        vm.onInputChange("hi")
        vm.send()
        advanceUntilIdle()

        assertTrue("已见正文保留", vm.streaming.value.streamingText.contains("半截正文"))
        assertTrue("标记已停止", vm.streaming.value.stopped)
        assertEquals("已停止提示可见", GroupStreamingReducer.STOPPED_NOTICE, vm.streaming.value.notice)
    }

    @Test
    fun `停止按钮取消收集并保留已见正文`() = runTest(dispatcher) {
        // 无限 Chunk，需手动停止
        driver.script = flow {
            emit(LocalGroupGenerationUseCase.Delta.TurnStarted(turn("c1"), "r#t0"))
            while (true) {
                emit(LocalGroupGenerationUseCase.Delta.Chunk("r#t0", "字"))
                delay(10)
            }
        }
        val vm = vm()
        advanceUntilIdle()
        vm.onInputChange("hi")
        vm.send()
        advanceTimeBy(50)
        assertTrue("生成中可停", vm.streaming.value.showStop)

        vm.stop()
        advanceUntilIdle()

        assertTrue("停止后标记已停止", vm.streaming.value.stopped)
        assertEquals("停止提示为已停止生成", GroupStreamingReducer.STOPPED_NOTICE, vm.streaming.value.notice)
        assertTrue("已见正文保留", vm.streaming.value.streamingText.isNotEmpty())
        assertFalse("停止后不再生成中", vm.ui.value.generating)
    }

    @Test
    fun `立即接话用 forcedSpeakerId 开新轮不接力`() = runTest(dispatcher) {
        driver.script = flowOf(LocalGroupGenerationUseCase.Delta.TurnStarted(turn("c2"), "r#t0"))
        val vm = vm()
        advanceUntilIdle()
        vm.speakNow("c2")
        advanceUntilIdle()

        assertEquals("立即接话锁定发言者", "c2", driver.lastForced)
        assertFalse("立即接话不接力", driver.lastChainEnabled)
    }

    @Test
    fun `续写让最后一棒角色继续推进`() = runTest(dispatcher) {
        repo.messages += GroupMessage(id = "m1", groupId = "g1", characterId = "c1", content = "前面", timestamp = 1000L, round = 1)
        driver.script = flowOf(LocalGroupGenerationUseCase.Delta.TurnStarted(turn("c1"), "r#t0"))
        val vm = vm()
        advanceUntilIdle()
        vm.continueWrite()
        advanceUntilIdle()

        assertEquals("续写锁定最后一棒", "c1", driver.lastForced)
        assertFalse("续写不接力", driver.lastChainEnabled)
    }
}

/** S6-01f 第 1／2 项：模式切换 + 群编辑/成员增删排序 驱动群接口（白名单键）。 */
@OptIn(ExperimentalCoroutinesApi::class)
class GroupManagementActionsTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var repo: StreamingGroupRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repo = StreamingGroupRepository()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `模式切换下发 patchGroup chatMode 白名单键`() = runTest(dispatcher) {
        val vm = GroupChatViewModel(repo, "g1", "s1", null, null, null)
        advanceUntilIdle()
        vm.applyChatMode("free")
        advanceUntilIdle()
        assertEquals("chatMode 走群级补丁", mapOf("chatMode" to "free"), repo.patchGroupCalls.single())
        assertNull("合法模式无错误", vm.ui.value.error)
    }

    @Test
    fun `发言间隔与自动接力走群级补丁`() = runTest(dispatcher) {
        val vm = GroupChatViewModel(repo, "g1", "s1", null, null, null)
        advanceUntilIdle()
        vm.applyAutoMode(true)
        vm.applySpeakerInterval(1500)
        advanceUntilIdle()
        assertTrue("自动接力进群补丁", repo.patchGroupCalls.any { it["autoMode"] == true })
        assertTrue("发言间隔进群补丁", repo.patchGroupCalls.any { it["speakerInterval"] == 1500 })
    }

    @Test
    fun `叙事模式走会话补丁白名单键`() = runTest(dispatcher) {
        val vm = GroupChatViewModel(repo, "g1", "s1", null, null, null)
        advanceUntilIdle()
        vm.applyNarrativeMode("omniscient")
        advanceUntilIdle()
        assertEquals("narrativeMode 走会话补丁", mapOf("narrativeMode" to "omniscient"), repo.patchSessionCalls.single())
    }

    @Test
    fun `非法模式被拦截不下发`() = runTest(dispatcher) {
        val vm = GroupChatViewModel(repo, "g1", "s1", null, null, null)
        advanceUntilIdle()
        vm.applyChatMode("natural")
        advanceUntilIdle()
        assertTrue("非法模式不进仓库", repo.patchGroupCalls.isEmpty())
        assertNotNull("越界报错进提示", vm.ui.value.error)
    }

    @Test
    fun `成员增删排序驱动群接口`() = runTest(dispatcher) {
        val vm = GroupsViewModel(repo)
        advanceUntilIdle()
        vm.addMembers("g1", listOf("c9"))
        vm.removeMember("g1", "c1")
        vm.reorderMembers("g1", listOf("c2", "c1"))
        advanceUntilIdle()
        assertEquals("新增成员走 addGroupMembers", listOf("c9"), repo.addedMembers)
        assertEquals("删除成员走 removeGroupMember", listOf("c1"), repo.removedMembers)
        assertEquals("排序走 memberIds 整表覆盖", mapOf("memberIds" to listOf("c2", "c1")), repo.patchGroupCalls.single())
    }

    @Test
    fun `删除群驱动 deleteGroup`() = runTest(dispatcher) {
        val vm = GroupsViewModel(repo)
        advanceUntilIdle()
        vm.deleteGroup("g1")
        advanceUntilIdle()
        assertEquals("删除群调用 deleteGroup", "g1", repo.deletedGroup)
    }
}

private class ScriptedDriver : GroupGenerationDriver {
    var script: Flow<LocalGroupGenerationUseCase.Delta> = flowOf()
    var lastForced: String? = "unset"
    var lastChainEnabled: Boolean = true

    override fun generate(
        groupId: String,
        sessionId: String,
        requestId: String,
        targetCharId: String?,
        forcedSpeakerId: String?,
        chainEnabled: Boolean,
        turnRound: Long?,
    ): Flow<LocalGroupGenerationUseCase.Delta> {
        lastForced = forcedSpeakerId
        lastChainEnabled = chainEnabled
        return script
    }
}

private class StreamingGroupRepository : ChatRepository {
    override val events = MutableSharedFlow<CompanionEvent>(extraBufferCapacity = 64)
    override val connectionState = MutableStateFlow(WsClient.State.CONNECTED)
    val messages: MutableList<GroupMessage> = mutableListOf()
    val patchGroupCalls = mutableListOf<Map<String, Any?>>()
    val patchSessionCalls = mutableListOf<Map<String, Any?>>()
    val addedMembers = mutableListOf<String>()
    val removedMembers = mutableListOf<String>()
    var deletedGroup: String? = null

    override suspend fun listCharacters(): List<com.qingyu.companion.model.Character> =
        listOf(com.qingyu.companion.model.Character(id = "c1", name = "爱丽丝", description = ""))

    override suspend fun listGroupMessages(groupId: String, sessionId: String): List<GroupMessage> = messages.toList()

    override suspend fun sendGroupMessage(groupId: String, sessionId: String, requestId: String, content: String): Boolean {
        messages += GroupMessage(id = requestId, groupId = groupId, characterId = "__user__", content = content, timestamp = System.currentTimeMillis(), round = 1)
        return true
    }

    override suspend fun regenerateDirections(sessionId: String, messageId: String): List<DialogueDirection> = emptyList()
    override suspend fun getContextUsage(sessionId: String, characterId: String?) = com.qingyu.companion.model.ContextUsageDto(0, 0, 0.0, 0)

    override suspend fun listSessions() = throw UnsupportedOperationException()
    override suspend fun createSession(characterId: String, title: String?, greeting: String?) = throw UnsupportedOperationException()
    override suspend fun renameSession(sessionId: String, title: String) = throw UnsupportedOperationException()
    override suspend fun deleteSession(sessionId: String, characterId: String?) = throw UnsupportedOperationException()
    override suspend fun getSettings() = throw UnsupportedOperationException()
    override suspend fun updateSettings(patch: Map<String, Any?>) = throw UnsupportedOperationException()
    override suspend fun listLorebooks() = throw UnsupportedOperationException()
    override suspend fun listPresets() = throw UnsupportedOperationException()
    override suspend fun getSessionLorebooks(sessionId: String) = throw UnsupportedOperationException()
    override suspend fun setSessionLorebooks(sessionId: String, lorebookIds: List<String>) = throw UnsupportedOperationException()
    override suspend fun getSessionPreset(sessionId: String) = throw UnsupportedOperationException()
    override suspend fun setSessionPreset(sessionId: String, presetId: String?) = throw UnsupportedOperationException()
    override suspend fun listModels() = throw UnsupportedOperationException()
    override suspend fun clearChat(sessionId: String) = throw UnsupportedOperationException()
    override suspend fun aiAssist(sessionId: String, type: String, content: String?) = throw UnsupportedOperationException()
    override suspend fun updatePreset(presetId: String, temperature: Double?, topP: Double?, maxTokens: Int?) = throw UnsupportedOperationException()
    override suspend fun getSessionMemory(sessionId: String, characterId: String?) = throw UnsupportedOperationException()
    override suspend fun patchSessionMemory(sessionId: String, memoryEnabled: Boolean?, memoryMode: String?, autoMemoryInterval: Int?, characterId: String?) = throw UnsupportedOperationException()
    override suspend fun summarizeMemory(sessionId: String, characterId: String?) = throw UnsupportedOperationException()
    override suspend fun listMessages(sessionId: String, beforeId: String?) = throw UnsupportedOperationException()
    override suspend fun branchSession(sessionId: String, messageId: String) = throw UnsupportedOperationException()
    override suspend fun sendMessage(sessionId: String, requestId: String, content: String, replyToId: String?, images: List<String>) = throw UnsupportedOperationException()
    override suspend fun editMessage(sessionId: String, messageId: String, content: String) = throw UnsupportedOperationException()
    override suspend fun deleteMessage(sessionId: String, messageId: String) = throw UnsupportedOperationException()
    override suspend fun translate(sessionId: String, messageId: String) = throw UnsupportedOperationException()
    override suspend fun swipe(sessionId: String, messageId: String, direction: Int) = throw UnsupportedOperationException()
    override suspend fun stopGeneration(requestId: String) = throw UnsupportedOperationException()
    override suspend fun activateCharacter(characterId: String) = throw UnsupportedOperationException()
    override suspend fun listQuickReplies(characterId: String?) = throw UnsupportedOperationException()
    override suspend fun executeQuickReply(id: String) = throw UnsupportedOperationException()
    override suspend fun usageSummary() = throw UnsupportedOperationException()
    override suspend fun usageRecords(limit: Int) = throw UnsupportedOperationException()
    override suspend fun listAnnouncements() = throw UnsupportedOperationException()
    override suspend fun fetchVersionInfo() = throw UnsupportedOperationException()
    override suspend fun listGroups() = throw UnsupportedOperationException()
    override suspend fun listGroupSessions(groupId: String) = throw UnsupportedOperationException()
    override suspend fun editGroupMessage(groupId: String, sessionId: String, messageId: String, content: String) = throw UnsupportedOperationException()
    override suspend fun deleteGroupMessage(groupId: String, sessionId: String, messageId: String) = throw UnsupportedOperationException()
    override suspend fun createGroup(name: String?, memberIds: List<String>) = throw UnsupportedOperationException()
    override suspend fun patchGroup(groupId: String, patch: Map<String, Any?>) { patchGroupCalls += patch }
    override suspend fun patchGroupSession(groupId: String, sessionId: String, patch: Map<String, Any?>) { patchSessionCalls += patch }
    override suspend fun addGroupMembers(groupId: String, characterIds: List<String>) { addedMembers += characterIds }
    override suspend fun removeGroupMember(groupId: String, characterId: String) { removedMembers += characterId }
    override suspend fun deleteGroup(groupId: String) { deletedGroup = groupId }
    override suspend fun groupAiReply(groupId: String, sessionId: String, speakerId: String?): Boolean = true
    override suspend fun groupTranslate(groupId: String, sessionId: String, messageId: String): String? = null
    override suspend fun listCachedSessions() = throw UnsupportedOperationException()
    override suspend fun listCachedMessages(sessionId: String) = throw UnsupportedOperationException()
    override suspend fun clearLocalCache() = throw UnsupportedOperationException()
    override suspend fun wipeLocalData() = throw UnsupportedOperationException()
}
