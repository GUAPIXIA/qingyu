package com.qingyu.companion.ui.chat

import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.model.Character
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.Message
import com.qingyu.companion.model.MessagePage
import com.qingyu.companion.model.SessionPreview
import com.qingyu.companion.network.WsClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatViewModelErrorTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var fakeRepo: FakeRepo
    private lateinit var vm: ChatViewModel

    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
        fakeRepo = FakeRepo()
    }
    @After fun tearDown() { Dispatchers.resetMain() }

    @Test fun `Unauthorized shows re-pair message`() = runTest(dispatcher) {
        fakeRepo.quickReplyError = CompanionError.Unauthorized()
        vm = ChatViewModel(fakeRepo, "s1")
        advanceUntilIdle()
        vm.onQuickReplyClick(com.qingyu.companion.model.QuickReply(id="qr1", label="t", content="hi", action = com.qingyu.companion.model.QuickReplyAction.text, sendWithAI=false, order=0, enabled=true))
        advanceUntilIdle()
        assertTrue(vm.ui.value.error?.contains("重新配对") == true)
    }

    @Test fun `Offline shows offline message`() = runTest(dispatcher) {
        fakeRepo.listMessagesError = CompanionError.Offline()
        vm = ChatViewModel(fakeRepo, "s1")
        advanceUntilIdle()
        vm.loadLatest()
        advanceUntilIdle()
        val err = vm.ui.value.error ?: ""
        assertTrue(err.contains("离线") || err.contains("缓存") || err.contains("无法连接"))
    }

    @Test fun `IncompatibleVersion shows upgrade message`() = runTest(dispatcher) {
        fakeRepo.quickReplyError = CompanionError.IncompatibleVersion()
        vm = ChatViewModel(fakeRepo, "s1")
        advanceUntilIdle()
        vm.onQuickReplyClick(com.qingyu.companion.model.QuickReply(id="qr1", label="t", content="hi", action = com.qingyu.companion.model.QuickReplyAction.text, sendWithAI=false, order=0, enabled=true))
        advanceUntilIdle()
        assertTrue(vm.ui.value.error?.contains("升级") == true)
    }

    private class FakeRepo : ChatRepository {
        var quickReplyError: Throwable? = null
        var listMessagesError: Throwable? = null
        override val events = MutableSharedFlow<CompanionEvent>()
        override val connectionState = MutableStateFlow(WsClient.State.CONNECTED)
        override suspend fun listSessions() = emptyList<SessionPreview>()
        override suspend fun createSession(characterId: String, title: String?, greeting: String?) = throw NotImplementedError()
        override suspend fun deleteSession(sessionId: String, characterId: String?) {}
        override suspend fun renameSession(sessionId: String, title: String) {}
        override suspend fun getSettings() = throw NotImplementedError()
        override suspend fun updateSettings(patch: Map<String, Any?>) {}
        override suspend fun listLorebooks() = emptyList<com.qingyu.companion.model.LorebookDto>()
        override suspend fun listPresets() = emptyList<com.qingyu.companion.model.PresetDto>()
        override suspend fun getSessionLorebooks(sessionId: String) = emptyList<String>()
        override suspend fun setSessionLorebooks(sessionId: String, lorebookIds: List<String>) {}
        override suspend fun getSessionPreset(sessionId: String) = null
        override suspend fun setSessionPreset(sessionId: String, presetId: String?) {}
        override suspend fun listModels() = emptyList<String>()
        override suspend fun clearChat(sessionId: String) {}
        override suspend fun aiAssist(sessionId: String, type: String, content: String?) = ""
        override suspend fun updatePreset(presetId: String, temperature: Double?, topP: Double?, maxTokens: Int?) = null
        override suspend fun getSessionMemory(sessionId: String, characterId: String?) = throw NotImplementedError()
        override suspend fun patchSessionMemory(sessionId: String, memoryEnabled: Boolean?, memoryMode: String?, autoMemoryInterval: Int?, characterId: String?) {}
        override suspend fun summarizeMemory(sessionId: String, characterId: String?) = "" to emptyList<com.qingyu.companion.model.MemoryFactDto>()
        override suspend fun getContextUsage(sessionId: String, characterId: String?) = com.qingyu.companion.model.ContextUsageDto(0, 100)
        override suspend fun listMessages(sessionId: String, beforeId: String?): MessagePage {
            listMessagesError?.let { throw it }
            return MessagePage(emptyList(), null)
        }
        override suspend fun branchSession(sessionId: String, messageId: String) = throw NotImplementedError()
        override suspend fun sendMessage(sessionId: String, requestId: String, content: String, replyToId: String?, images: List<String>) = throw NotImplementedError()
        override suspend fun editMessage(sessionId: String, messageId: String, content: String) = throw NotImplementedError()
        override suspend fun deleteMessage(sessionId: String, messageId: String) {}
        override suspend fun stopGeneration(requestId: String) {}
        override suspend fun swipe(sessionId: String, messageId: String, direction: Int) = throw NotImplementedError()
        override suspend fun translate(sessionId: String, messageId: String) = throw NotImplementedError()
        override suspend fun listCharacters() = emptyList<Character>()
        override suspend fun activateCharacter(characterId: String) = throw NotImplementedError()
        override suspend fun listQuickReplies(characterId: String?) = com.qingyu.companion.model.QuickReplyListResponse(emptyList(), emptyMap())
        override suspend fun executeQuickReply(id: String): Boolean {
            quickReplyError?.let { throw it }
            return true
        }
        override suspend fun usageSummary() = throw NotImplementedError()
        override suspend fun usageRecords(limit: Int) = emptyList<com.qingyu.companion.model.UsageRecordDto>()
        override suspend fun listAnnouncements() = throw NotImplementedError()
        override suspend fun fetchVersionInfo() = null
        override suspend fun listGroups() = emptyList<com.qingyu.companion.model.GroupChat>()
        override suspend fun listGroupSessions(groupId: String) = emptyList<com.qingyu.companion.model.GroupSession>()
        override suspend fun listGroupMessages(groupId: String, sessionId: String) = emptyList<com.qingyu.companion.model.GroupMessage>()
        override suspend fun sendGroupMessage(groupId: String, sessionId: String, requestId: String, content: String) = false
        override suspend fun createGroupSession(groupId: String) = throw NotImplementedError()
        override suspend fun renameGroupSession(groupId: String, sessionId: String, title: String) {}
        override suspend fun editGroupMessage(groupId: String, sessionId: String, messageId: String, content: String) {}
        override suspend fun deleteGroupMessage(groupId: String, sessionId: String, messageId: String) {}
        override suspend fun groupAiReply(groupId: String, sessionId: String, speakerId: String?) = false
        override suspend fun createGroup(name: String?, memberIds: List<String>) = false
        override suspend fun patchGroup(groupId: String, patch: Map<String, Any?>) {}
        override suspend fun addGroupMembers(groupId: String, characterIds: List<String>) {}
        override suspend fun removeGroupMember(groupId: String, characterId: String) {}
        override suspend fun groupTranslate(groupId: String, sessionId: String, messageId: String) = null
        override suspend fun listCachedSessions() = emptyList<SessionPreview>()
        override suspend fun listCachedMessages(sessionId: String) = emptyList<Message>()
        override suspend fun clearLocalCache() {}
        override suspend fun wipeLocalData() {}
    }
}
