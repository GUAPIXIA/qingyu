package com.qingyu.companion.ui.groups

import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.GroupMessage
import com.qingyu.companion.network.WsClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import com.qingyu.companion.data.CompanionError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class GroupChatViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var repo: FakeGroupRepository
    private lateinit var vm: GroupChatViewModel

    private fun groupMsg(
        id: String,
        content: String = id,
        characterId: String = "__user__",
    ) = GroupMessage(
        id = id,
        groupId = "g1",
        characterId = characterId,
        content = content,
        timestamp = 1000L,
        round = 1,
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repo = FakeGroupRepository()
        repo.groupCharacters = listOf(
            com.qingyu.companion.model.Character(id="c1", name="爱丽丝", description=""),
            com.qingyu.companion.model.Character(id="c2", name="鲍勃", description="")
        )
        // init 会触发 load()
        vm = GroupChatViewModel(repo, "g1", "s1")
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `连续两轮发送成功 sending 正确复位`() = runTest(dispatcher) {
        repo.messages = mutableListOf()
        // 首次 load
        advanceUntilIdle()
        assertFalse(vm.ui.value.sending)
        assertFalse(vm.ui.value.generating)

        // 第一轮
        vm.onInputChange("hello1")
        vm.send()
        advanceUntilIdle()
        assertFalse(vm.ui.value.sending)
        assertFalse(vm.ui.value.generating)
        assertEquals(null, vm.ui.value.error)
        assertEquals(2, vm.ui.value.messages.size) // user + ai
        assertEquals("hello1", vm.ui.value.messages[0].content)

        // 第二轮 - 验证未永久卡死
        vm.onInputChange("hello2")
        vm.send()
        advanceUntilIdle()
        assertFalse(vm.ui.value.sending)
        assertFalse(vm.ui.value.generating)
        assertEquals(4, vm.ui.value.messages.size)
        assertEquals("hello2", vm.ui.value.messages[2].content)
    }

    @Test
    fun `AI 失败时用户消息保留且可单独重试`() = runTest(dispatcher) {
        repo.messages = mutableListOf()
        repo.failAi = true
        advanceUntilIdle()

        vm.onInputChange("hi")
        vm.send()
        advanceUntilIdle()

        // 发送中应已复位，生成结束但报错
        assertFalse(vm.ui.value.sending)
        assertFalse(vm.ui.value.generating)
        assertTrue(vm.ui.value.error != null)
        // 用户消息已落盘，AI 未产生
        assertEquals(1, vm.ui.value.messages.size)
        assertEquals("hi", vm.ui.value.messages[0].content)

        // 重试 AI - 不重发用户消息
        val beforeCount = repo.sendGroupMessageCalls
        repo.failAi = false
        vm.retryAiReply()
        advanceUntilIdle()

        assertFalse(vm.ui.value.generating)
        // 重试后错误应清除
        assertEquals(2, vm.ui.value.messages.size) // 补上 AI 回复
        assertEquals(beforeCount, repo.sendGroupMessageCalls) // 未重发用户消息
    }

    @Test
    fun `用户消息发送失败时 sending 复位并提示`() = runTest(dispatcher) {
        repo.messages = mutableListOf()
        repo.failSend = true
        advanceUntilIdle()

        vm.onInputChange("bad")
        vm.send()
        advanceUntilIdle()

        assertFalse(vm.ui.value.sending)
        assertFalse(vm.ui.value.generating)
        assertTrue(vm.ui.value.error != null)
        // 未落盘
        assertEquals(0, vm.ui.value.messages.size)

        // 再次发送应可成功（验证未永久卡死）
        repo.failSend = false
        vm.onInputChange("good")
        vm.send()
        advanceUntilIdle()
        assertFalse(vm.ui.value.sending)
        assertEquals(2, vm.ui.value.messages.size)
    }

    @Test
    fun `Group AI 401 Unauthorized 显示重新配对`() = runTest(dispatcher) {
        repo.messages = mutableListOf()
        repo.aiError = CompanionError.Unauthorized()
        advanceUntilIdle()
        vm.onInputChange("hi")
        vm.send()
        advanceUntilIdle()
        assertFalse(vm.ui.value.generating)
        assertTrue(vm.ui.value.error?.contains("重新配对") == true)
        // 用户消息已落盘，AI 未产生
        assertEquals(1, vm.ui.value.messages.size)
    }

    @Test
    fun `Group AI Offline 显示离线提示`() = runTest(dispatcher) {
        repo.messages = mutableListOf()
        repo.aiError = CompanionError.Offline()
        advanceUntilIdle()
        vm.onInputChange("hi")
        vm.send()
        advanceUntilIdle()
        assertTrue(vm.ui.value.error?.contains("离线") == true || vm.ui.value.error?.contains("无法连接") == true)
    }

    @Test
    fun `发送期间不接受重复点击`() = runTest(dispatcher) {
        repo.messages = mutableListOf()
        // 延迟 send 以保持 sending true 窗口
        repo.delaySend = 1000L
        advanceUntilIdle()

        vm.onInputChange("first")
        vm.send()
        // 讓协程调度 sending 置位（viewModelScope.launch 需调度）
        advanceTimeBy(10)
        assertTrue(vm.ui.value.sending)
        vm.onInputChange("second")
        vm.send() // 应被忽略
        advanceUntilIdle() // 此时第一个完成
        // 只应有 first 的用户消息 + AI，不应有 second
        assertTrue(vm.ui.value.messages.none { it.content == "second" })
        assertFalse(vm.ui.value.sending)
    }
}

private class FakeGroupRepository : ChatRepository {
    override val events = MutableSharedFlow<CompanionEvent>(extraBufferCapacity = 64)
    override val connectionState = MutableStateFlow(WsClient.State.CONNECTED)

    var messages: MutableList<GroupMessage> = mutableListOf()
    var groupCharacters: List<com.qingyu.companion.model.Character> = emptyList()
    var failSend = false
    var failAi = false
    var aiError: Throwable? = null
    var delaySend: Long = 0
    var sendGroupMessageCalls = 0

    override suspend fun listCharacters(): List<com.qingyu.companion.model.Character> = groupCharacters

    override suspend fun listGroupMessages(groupId: String, sessionId: String): List<GroupMessage> {
        return messages.toList()
    }

    override suspend fun sendGroupMessage(groupId: String, sessionId: String, requestId: String, content: String): Boolean {
        sendGroupMessageCalls++
        if (delaySend > 0) kotlinx.coroutines.delay(delaySend)
        if (failSend) throw RuntimeException("发送失败")
        messages.add(GroupMessage(id = requestId, groupId = groupId, characterId = "__user__", content = content, timestamp = System.currentTimeMillis(), round = messages.size + 1))
        return true
    }

    override suspend fun groupAiReply(groupId: String, sessionId: String, speakerId: String?): Boolean {
        aiError?.let { throw it }
        if (failAi) return false
        // 模拟 AI 回复
        messages.add(GroupMessage(id = "ai-${System.nanoTime()}", groupId = groupId, characterId = "c1", content = "ai reply", timestamp = System.currentTimeMillis(), round = messages.size + 1))
        return true
    }

    // 其他方法未用到，抛异常或空实现
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
    override suspend fun getContextUsage(sessionId: String, characterId: String?) = com.qingyu.companion.model.ContextUsageDto(0,0,0.0,0)
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
    override suspend fun createGroupSession(groupId: String) = throw UnsupportedOperationException()
    override suspend fun renameGroupSession(groupId: String, sessionId: String, title: String) = throw UnsupportedOperationException()
    override suspend fun editGroupMessage(groupId: String, sessionId: String, messageId: String, content: String) = throw UnsupportedOperationException()
    override suspend fun deleteGroupMessage(groupId: String, sessionId: String, messageId: String) = throw UnsupportedOperationException()
    override suspend fun createGroup(name: String?, memberIds: List<String>) = throw UnsupportedOperationException()
    override suspend fun patchGroup(groupId: String, patch: Map<String, Any?>) = throw UnsupportedOperationException()
    override suspend fun addGroupMembers(groupId: String, characterIds: List<String>) = throw UnsupportedOperationException()
    override suspend fun removeGroupMember(groupId: String, characterId: String) = throw UnsupportedOperationException()
    override suspend fun groupTranslate(groupId: String, sessionId: String, messageId: String) = throw UnsupportedOperationException()
    override suspend fun listCachedSessions() = throw UnsupportedOperationException()
    override suspend fun listCachedMessages(sessionId: String) = throw UnsupportedOperationException()
    override suspend fun clearLocalCache() = throw UnsupportedOperationException()
    override suspend fun wipeLocalData() = throw UnsupportedOperationException()
}
