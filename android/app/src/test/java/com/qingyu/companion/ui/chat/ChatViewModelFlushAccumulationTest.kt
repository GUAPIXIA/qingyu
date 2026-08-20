package com.qingyu.companion.ui.chat

import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.Message
import com.qingyu.companion.model.Role
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatViewModelFlushAccumulationTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var repo: FakeFlushRepository
    private lateinit var vm: ChatViewModel

    private fun msg(id: String, content: String = id) = Message(
        id = id, sessionId = "s1", characterId = "c1", role = Role.assistant, content = content, timestamp = 1000L
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repo = FakeFlushRepository()
        vm = ChatViewModel(repo, "s1", ttsPlayer = null)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `3次 flush 累加而非覆盖`() = runTest(dispatcher) {
        // 触发 3 次间隔 >100ms 的 chunk，最终流式文本应为完整累积
        repo.emit(CompanionEvent.Chunk("req-acc", "s1", "A"))
        advanceTimeBy(110)
        advanceUntilIdle()
        var streaming = vm.ui.value.streaming as ChatViewModel.Streaming.Generating
        assertEquals("A", streaming.text)

        repo.emit(CompanionEvent.Chunk("req-acc", "s1", "B"))
        advanceTimeBy(110)
        advanceUntilIdle()
        streaming = vm.ui.value.streaming as ChatViewModel.Streaming.Generating
        assertEquals("AB", streaming.text)

        repo.emit(CompanionEvent.Chunk("req-acc", "s1", "C"))
        advanceTimeBy(110)
        advanceUntilIdle()
        streaming = vm.ui.value.streaming as ChatViewModel.Streaming.Generating
        assertEquals("ABC", streaming.text)

        // done 应清理缓冲并落盘完整消息，内容与累积一致
        repo.emit(CompanionEvent.Done("req-acc", "s1", msg("ai-1", "ABC")))
        advanceUntilIdle()
        assertTrue(vm.ui.value.streaming is ChatViewModel.Streaming.Idle)
        assertEquals("ABC", vm.ui.value.messages.first { it.id == "ai-1" }.content)

        // 再次发送同 requestId 不应受前次缓冲影响（已清理）
        repo.emit(CompanionEvent.Chunk("req-acc", "s1", "X"))
        advanceTimeBy(110)
        advanceUntilIdle()
        streaming = vm.ui.value.streaming as ChatViewModel.Streaming.Generating
        assertEquals("X", streaming.text)
    }

    @Test
    fun `多请求并发互不覆盖且 done 只清理对应缓冲`() = runTest(dispatcher) {
        repo.emit(CompanionEvent.Chunk("req-1", "s1", "hello "))
        repo.emit(CompanionEvent.Chunk("req-2", "s1", "world "))
        advanceTimeBy(110)
        advanceUntilIdle()
        // 最后一次 flush 的生成态为 req-2，但 req-1 的累积应保留
        // 先 done req-1，不应影响 req-2 的后续累积
        repo.emit(CompanionEvent.Done("req-1", "s1", msg("ai-1", "hello ")))
        advanceUntilIdle()
        // req-2 仍在流式（因 done 时若有其他累积会切到其他请求），此时再追加
        repo.emit(CompanionEvent.Chunk("req-2", "s1", "again"))
        advanceTimeBy(110)
        advanceUntilIdle()
        val streaming = vm.ui.value.streaming as ChatViewModel.Streaming.Generating
        // 应为 req-2 的累积 world + again
        assertEquals("req-2", streaming.requestId)
        assertEquals("world again", streaming.text)
    }
}

/** 极简 Fake，仅需 events/connectionState 与基础桩 */
private class FakeFlushRepository : ChatRepository {
    override val events = MutableSharedFlow<CompanionEvent>(extraBufferCapacity = 64)
    override val connectionState = MutableStateFlow(WsClient.State.DISCONNECTED)
    fun emit(e: CompanionEvent) { events.tryEmit(e) }
    override suspend fun listMessages(sessionId: String, beforeId: String?) = com.qingyu.companion.model.MessagePage(emptyList(), null)
    override suspend fun branchSession(sessionId: String, messageId: String) = com.qingyu.companion.model.SessionPreview(id="b", characterId="c", title="t", createdAt=0, updatedAt=0, messageCount=0, lastMessage="")
    override suspend fun listCachedMessages(sessionId: String) = emptyList<Message>()
    override suspend fun sendMessage(sessionId: String, requestId: String, content: String, replyToId: String?, images: List<String>) = Message(requestId, sessionId, "c1", Role.user, content, timestamp = System.currentTimeMillis())
    override suspend fun editMessage(sessionId: String, messageId: String, content: String) = Message(messageId, sessionId, "c1", Role.assistant, content, timestamp = 0)
    override suspend fun deleteMessage(sessionId: String, messageId: String) = Unit
    override suspend fun translate(sessionId: String, messageId: String) = com.qingyu.companion.model.TranslateResponse(messageId, "")
    override suspend fun swipe(sessionId: String, messageId: String, direction: Int) = Message(messageId, sessionId, "c1", Role.assistant, "swipe", timestamp = 0)
    override suspend fun listSessions() = emptyList<com.qingyu.companion.model.SessionPreview>()
    override suspend fun listCharacters() = emptyList<com.qingyu.companion.model.Character>()
    override suspend fun listQuickReplies(characterId: String?) = com.qingyu.companion.model.QuickReplyListResponse(emptyList(), emptyMap())
    override suspend fun executeQuickReply(id: String) = false
    override suspend fun stopGeneration(requestId: String) = Unit
    override suspend fun clearChat(sessionId: String) = Unit
    override suspend fun getContextUsage(sessionId: String, characterId: String?) = com.qingyu.companion.model.ContextUsageDto(0,0,0.0,0)
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
    override suspend fun aiAssist(sessionId: String, type: String, content: String?) = throw UnsupportedOperationException()
    override suspend fun updatePreset(presetId: String, temperature: Double?, topP: Double?, maxTokens: Int?) = throw UnsupportedOperationException()
    override suspend fun getSessionMemory(sessionId: String, characterId: String?) = throw UnsupportedOperationException()
    override suspend fun patchSessionMemory(sessionId: String, memoryEnabled: Boolean?, memoryMode: String?, autoMemoryInterval: Int?, characterId: String?) = throw UnsupportedOperationException()
    override suspend fun summarizeMemory(sessionId: String, characterId: String?) = throw UnsupportedOperationException()
    override suspend fun activateCharacter(characterId: String) = throw UnsupportedOperationException()
    override suspend fun usageSummary() = throw UnsupportedOperationException()
    override suspend fun usageRecords(limit: Int) = throw UnsupportedOperationException()
    override suspend fun listAnnouncements() = throw UnsupportedOperationException()
    override suspend fun fetchVersionInfo() = throw UnsupportedOperationException()
    override suspend fun listGroups() = throw UnsupportedOperationException()
    override suspend fun listGroupSessions(groupId: String) = throw UnsupportedOperationException()
    override suspend fun listGroupMessages(groupId: String, sessionId: String) = throw UnsupportedOperationException()
    override suspend fun sendGroupMessage(groupId: String, sessionId: String, requestId: String, content: String) = throw UnsupportedOperationException()
    override suspend fun createGroupSession(groupId: String) = throw UnsupportedOperationException()
    override suspend fun renameGroupSession(groupId: String, sessionId: String, title: String) = throw UnsupportedOperationException()
    override suspend fun editGroupMessage(groupId: String, sessionId: String, messageId: String, content: String) = throw UnsupportedOperationException()
    override suspend fun deleteGroupMessage(groupId: String, sessionId: String, messageId: String) = throw UnsupportedOperationException()
    override suspend fun groupAiReply(groupId: String, sessionId: String, speakerId: String?) = throw UnsupportedOperationException()
    override suspend fun createGroup(name: String?, memberIds: List<String>) = throw UnsupportedOperationException()
    override suspend fun patchGroup(groupId: String, patch: Map<String, Any?>) = throw UnsupportedOperationException()
    override suspend fun addGroupMembers(groupId: String, characterIds: List<String>) = throw UnsupportedOperationException()
    override suspend fun removeGroupMember(groupId: String, characterId: String) = throw UnsupportedOperationException()
    override suspend fun groupTranslate(groupId: String, sessionId: String, messageId: String) = throw UnsupportedOperationException()
    override suspend fun listCachedSessions() = throw UnsupportedOperationException()
    override suspend fun clearLocalCache() = throw UnsupportedOperationException()
    override suspend fun wipeLocalData() = throw UnsupportedOperationException()
}
