package com.qingyu.companion.ui.chat

import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.model.Character
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.Message
import com.qingyu.companion.model.MessagePage
import com.qingyu.companion.model.QuickReply
import com.qingyu.companion.model.QuickReplyAction
import com.qingyu.companion.model.QuickReplyListResponse
import com.qingyu.companion.model.Role
import com.qingyu.companion.model.SessionPreview
import com.qingyu.companion.model.TranslateResponse
import com.qingyu.companion.network.WsClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * ChatViewModel 核心逻辑单测（Fake 仓库 + 主调度器替换）。
 * 覆盖：发送成功/失败、编辑/删除/翻译/swipe、流式 chunk 节流、done 替换、错误处理、
 * 快捷回复分发、连接恢复重发。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var repo: FakeChatRepository
    private lateinit var vm: ChatViewModel

    private fun msg(
        id: String,
        sessionId: String = "s1",
        ts: Long = 1000L,
        content: String = id,
    ) = Message(
        id = id,
        sessionId = sessionId,
        characterId = "c1",
        role = Role.assistant,
        content = content,
        timestamp = ts,
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repo = FakeChatRepository()
        vm = ChatViewModel(repo, "s1", ttsPlayer = null)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    // ---------- 发送 ----------

    @Test
    fun `发送成功后消息入列表并清空输入`() = runTest(dispatcher) {
        repo.onSend = { _, requestId, content, _, _ ->
            msg(id = requestId, content = content)
        }
        vm.onInputChange("你好")
        vm.send()
        advanceUntilIdle()

        assertEquals("你好", vm.ui.value.messages.single().content)
        assertEquals("", vm.input.value)
        assertTrue(vm.ui.value.pending.isEmpty())
    }

    @Test
    fun `发送失败保留为失败 pending 并提示错误`() = runTest(dispatcher) {
        repo.onSend = { _, _, _, _, _ -> throw RuntimeException("网络中断") }
        vm.onInputChange("你好")
        vm.send()
        advanceUntilIdle()

        assertTrue(vm.ui.value.messages.isEmpty())
        assertEquals(1, vm.ui.value.pending.size)
        assertTrue(vm.ui.value.pending.single().failed)
        assertEquals("网络中断", vm.ui.value.error)
    }

    @Test
    fun `空白输入不发送`() = runTest(dispatcher) {
        var sendCount = 0
        repo.onSend = { _, _, _, _, _ -> sendCount++; msg("m") }
        vm.onInputChange("   ")
        vm.send()
        advanceUntilIdle()
        assertEquals(0, sendCount)
        assertTrue(vm.ui.value.pending.isEmpty())
    }

    @Test
    fun `重试失败消息复用幂等键`() = runTest(dispatcher) {
        // 第一次发送失败 -> pending 标记 failed（requestId 由 vm 内部 UUID 生成）
        repo.onSend = { _, _, _, _, _ -> throw RuntimeException("网络中断") }
        vm.onInputChange("内容")
        vm.send()
        advanceUntilIdle()
        val requestId = vm.ui.value.pending.single().requestId
        assertTrue(vm.ui.value.pending.single().failed)

        // 重试：复用原幂等键
        repo.onSend = { _, rid, content, _, _ ->
            msg(id = if (rid == requestId) "final-id" else rid, content = content)
        }
        vm.retryPending(requestId)
        advanceUntilIdle()

        assertTrue(vm.ui.value.pending.isEmpty())
        // 重试复用原幂等键：请求到达仓库（id 命中 final-id），内容为原消息
        assertEquals("final-id", vm.ui.value.messages.single().id)
        assertEquals("内容", vm.ui.value.messages.single().content)
    }

    // ---------- 流式 ----------

    @Test
    fun `chunk 累积后进入 streaming 状态`() = runTest(dispatcher) {
        // 发送一条消息触发流式
        repo.onSend = { _, requestId, content, _, _ -> msg(id = requestId, content = content) }
        vm.onInputChange("问")
        vm.send()
        advanceUntilIdle()

        // 注入 chunk（同 session）
        repo.emit(CompanionEvent.Chunk("req-x", "s1", "你好"))
        repo.emit(CompanionEvent.Chunk("req-x", "s1", "世界"))
        advanceUntilIdle()

        val streaming = vm.ui.value.streaming as ChatViewModel.Streaming.Generating
        assertEquals("req-x", streaming.requestId)
        assertEquals("你好世界", streaming.text)
    }

    @Test
    fun `其他会话 chunk 不干扰当前会话`() = runTest(dispatcher) {
        repo.emit(CompanionEvent.Chunk("req-x", "other-session", "无关"))
        advanceUntilIdle()
        assertTrue(vm.ui.value.streaming is ChatViewModel.Streaming.Idle)
    }

    @Test
    fun `done 到达替换流式缓冲为完整消息`() = runTest(dispatcher) {
        repo.onSend = { _, requestId, content, _, _ -> msg(id = requestId, content = content) }
        vm.onInputChange("问")
        vm.send()
        advanceUntilIdle()

        repo.emit(CompanionEvent.Chunk("req-x", "s1", "增量"))
        advanceUntilIdle()
        // done：完整消息 + 用量（用量先到缓存，Done 时附加）
        repo.emit(CompanionEvent.Usage("req-x", 10, 20, 30))
        repo.emit(
            CompanionEvent.Done(
                requestId = "req-x",
                sessionId = "s1",
                message = msg(id = "ai-1", content = "完整回复"),
            )
        )
        advanceUntilIdle()

        assertTrue(vm.ui.value.streaming is ChatViewModel.Streaming.Idle)
        val done = vm.ui.value.messages.first { it.id == "ai-1" }
        assertEquals("完整回复", done.content)
        assertEquals(30, done.usage?.totalTokens)
    }

    @Test
    fun `error 事件清空流式并提示`() = runTest(dispatcher) {
        repo.emit(CompanionEvent.Chunk("req-x", "s1", "部分"))
        advanceUntilIdle()
        repo.emit(CompanionEvent.Error("req-x", "s1", "生成失败"))
        advanceUntilIdle()

        assertTrue(vm.ui.value.streaming is ChatViewModel.Streaming.Idle)
        assertEquals("生成失败", vm.ui.value.error)
    }

    // ---------- 消息操作 ----------

    @Test
    fun `编辑消息更新内容`() = runTest(dispatcher) {
        repo.messages = listOf(msg("m1", content = "原文"))
        repo.onEdit = { _, _, content -> msg("m1", content = content) }
        vm.loadLatest()
        advanceUntilIdle()

        vm.editMessage("m1", "新内容")
        advanceUntilIdle()
        assertEquals("新内容", vm.ui.value.messages.single().content)
    }

    @Test
    fun `空白编辑被忽略`() = runTest(dispatcher) {
        repo.messages = listOf(msg("m1", content = "原文"))
        vm.loadLatest()
        advanceUntilIdle()
        vm.editMessage("m1", "   ")
        advanceUntilIdle()
        assertEquals("原文", vm.ui.value.messages.single().content)
    }

    @Test
    fun `删除消息从列表移除`() = runTest(dispatcher) {
        repo.messages = listOf(msg("m1"), msg("m2"))
        vm.loadLatest()
        advanceUntilIdle()

        vm.deleteMessage("m1")
        advanceUntilIdle()
        assertEquals(listOf("m2"), vm.ui.value.messages.map { it.id })
    }

    @Test
    fun `翻译回写译文`() = runTest(dispatcher) {
        repo.messages = listOf(msg("m1", content = "hello"))
        repo.onTranslate = { _, messageId -> TranslateResponse(messageId, "你好") }
        vm.loadLatest()
        advanceUntilIdle()

        vm.translate("m1")
        advanceUntilIdle()
        assertEquals("你好", vm.ui.value.messages.single().translation)
    }

    @Test
    fun `swipe 切换候选`() = runTest(dispatcher) {
        repo.messages = listOf(msg("m1", content = "第一版"))
        repo.onSwipe = { _, messageId, _ -> msg(messageId, content = "第二版") }
        vm.loadLatest()
        advanceUntilIdle()

        vm.swipe("m1", 1)
        advanceUntilIdle()
        assertEquals("第二版", vm.ui.value.messages.single().content)
    }

    // ---------- 快捷回复 ----------

    @Test
    fun `text 型快捷回复直接发送`() = runTest(dispatcher) {
        var sent = ""
        repo.onSend = { _, _, content, _, _ -> sent = content; msg(id = "m") }
        repo.quickReplyList = QuickReplyListResponse(
            global = listOf(QuickReply(id = "qr1", label = "早安", content = "早上好", action = QuickReplyAction.text, sendWithAI = false, order = 1, enabled = true)),
            byCharacter = emptyMap(),
        )
        vm.loadQuickReplies()
        advanceUntilIdle()

        vm.onQuickReplyClick(repo.quickReplyList!!.global.first())
        advanceUntilIdle()
        assertEquals("早上好", sent)
    }

    @Test
    fun `execute 成功则不直发`() = runTest(dispatcher) {
        var sent = false
        repo.onSend = { _, _, _, _, _ -> sent = true; msg(id = "m") }
        repo.onExecute = { true }
        vm.onQuickReplyClick(
            QuickReply(id = "qr1", label = "L", content = "", action = QuickReplyAction.command, sendWithAI = false, order = 1, enabled = true)
        )
        advanceUntilIdle()
        assertTrue(!sent)
    }

    // ---------- 连接恢复重发 ----------

    @Test
    fun `连接恢复自动重发失败消息`() = runTest(dispatcher) {
        repo.onSend = { _, rid, content, _, _ -> msg(id = rid, content = content) }
        // 制造失败 pending
        repo.failNextSend = true
        vm.onInputChange("断线内容")
        vm.send()
        advanceUntilIdle()
        assertTrue(vm.ui.value.pending.single().failed)

        // 模拟连接恢复
        repo.failNextSend = false
        repo.setConnected(true)
        advanceUntilIdle()

        assertTrue(vm.ui.value.pending.isEmpty())
        assertEquals("断线内容", vm.ui.value.messages.single().content)
    }

    // ---------- 加载回退 ----------

    @Test
    fun `加载失败回退本地缓存`() = runTest(dispatcher) {
        repo.failListMessages = true
        repo.cachedMessages = listOf(msg("cached-1", content = "缓存消息"))
        vm.loadLatest()
        advanceUntilIdle()

        assertEquals("缓存消息", vm.ui.value.messages.single().content)
        assertTrue(vm.ui.value.error != null)
    }

    // ---------- 引用回复 ----------

    @Test
    fun `引用回复随发送传递 replyToId 并清除`() = runTest(dispatcher) {
        var replyId: String? = "not-set"
        repo.onSend = { _, _, _, replyToId, _ -> replyId = replyToId; msg(id = "m") }
        vm.onInputChange("回复你")
        vm.setReplyTo(msg("target-1", content = "原消息"))
        vm.send()
        advanceUntilIdle()

        assertEquals("target-1", replyId)
        assertNull(vm.replyTo.value)
    }

    @Test
    fun `引用回复失败 pending 保留 replyToId`() = runTest(dispatcher) {
        repo.onSend = { _, _, _, _, _ -> throw RuntimeException("网络中断") }
        vm.onInputChange("引用内容")
        vm.setReplyTo(msg("origin-msg", content = "被引用"))
        vm.send()
        advanceUntilIdle()

        val pending = vm.ui.value.pending.single()
        assertEquals("origin-msg", pending.replyToId)
        assertEquals("引用内容", pending.content)
        assertTrue(pending.failed)
    }

    @Test
    fun `重试保留 replyToId`() = runTest(dispatcher) {
        // 首次失败，pending 带 replyToId
        repo.onSend = { _, _, _, _, _ -> throw RuntimeException("断网") }
        vm.onInputChange("重试内容")
        vm.setReplyTo(msg("target-42", content = "原消息"))
        vm.send()
        advanceUntilIdle()
        val reqId = vm.ui.value.pending.single().requestId
        assertEquals("target-42", vm.ui.value.pending.single().replyToId)

        // 重试应以同一 replyToId 重发
        var retriedReplyId: String? = "not-set"
        var retriedImages: List<String> = emptyList()
        repo.onSend = { _, _, _, replyToId, images ->
            retriedReplyId = replyToId
            retriedImages = images
            msg(id = reqId, content = "重试内容")
        }
        vm.retryPending(reqId)
        advanceUntilIdle()

        assertEquals("target-42", retriedReplyId)
        assertTrue(vm.ui.value.pending.isEmpty())
        assertEquals("重试内容", vm.ui.value.messages.single().content)
    }

    @Test
    fun `断网重连自动重发保留 replyToId 与图片`() = runTest(dispatcher) {
        // 首次失败，带图片与引用
        repo.onSend = { _, _, _, _, _ -> throw RuntimeException("断网") }
        vm.onInputChange("带图引用")
        vm.setReplyTo(msg("img-target", content = "原图消息"))
        // 模拟待发送图片（base64）
        vm.onImagesChange(listOf("base64img"))
        vm.send()
        advanceUntilIdle()
        val pending = vm.ui.value.pending.single()
        assertEquals("img-target", pending.replyToId)
        assertEquals(listOf("base64img"), pending.images)
        assertTrue(pending.failed)

        // 连接恢复自动重发（retryAllFailed 内部调用 retryPending）
        var autoReplyId: String? = null
        var autoImages: List<String> = emptyList()
        repo.onSend = { _, _, _, replyToId, images ->
            autoReplyId = replyToId
            autoImages = images
            msg(id = pending.requestId, content = "带图引用")
        }
        repo.setConnected(true)
        advanceUntilIdle()

        assertEquals("img-target", autoReplyId)
        assertEquals(listOf("base64img"), autoImages)
        assertTrue(vm.ui.value.pending.isEmpty())
    }

    @Test
    fun `重试无引用时 replyToId 为空`() = runTest(dispatcher) {
        repo.onSend = { _, _, _, _, _ -> throw RuntimeException("断网") }
        vm.onInputChange("普通消息")
        // 未设置 replyTo
        vm.send()
        advanceUntilIdle()
        val reqId = vm.ui.value.pending.single().requestId
        assertNull(vm.ui.value.pending.single().replyToId)

        var retriedReplyId: String? = "not-set"
        repo.onSend = { _, _, _, replyToId, _ ->
            retriedReplyId = replyToId
            msg(id = reqId, content = "普通消息")
        }
        vm.retryPending(reqId)
        advanceUntilIdle()
        assertNull(retriedReplyId)
    }

    // ---------- 会话信息 ----------

    @Test
    fun `加载会话标题与角色名`() = runTest(dispatcher) {
        // 数据在 vm 创建前注入（init 中 loadSessionInfo 立即执行）
        repo.sessions = listOf(SessionPreview(id = "s1", characterId = "c1", title = "对话标题", createdAt = 0, updatedAt = 0, messageCount = 0, lastMessage = ""))
        repo.characters = listOf(Character(id = "c1", name = "爱丽丝", description = ""))
        vm = ChatViewModel(repo, "s1", ttsPlayer = null)
        advanceUntilIdle()

        assertEquals("对话标题", vm.ui.value.sessionTitle)
        assertEquals("爱丽丝", vm.ui.value.characterName)
    }
}

/** 可配置的 Fake 仓库：核心行为可注入，其余抛 UnsupportedOperationException */
@OptIn(ExperimentalCoroutinesApi::class)
private class FakeChatRepository : ChatRepository {

    override val events = MutableSharedFlow<CompanionEvent>(extraBufferCapacity = 64)
    override val connectionState = MutableStateFlow(WsClient.State.DISCONNECTED)

    // 可注入行为
    var messages: List<Message> = emptyList()
    var cachedMessages: List<Message> = emptyList()
    var sessions: List<SessionPreview> = emptyList()
    var characters: List<Character> = emptyList()
    var quickReplyList: QuickReplyListResponse? = null
    var failNextSend = false
    var failListMessages = false
    var onSend: ((String, String, String, String?, List<String>) -> Message)? = null
    var onEdit: ((String, String, String) -> Message)? = null
    var onTranslate: ((String, String) -> TranslateResponse)? = null
    var onSwipe: ((String, String, Int) -> Message)? = null
    var onExecute: (() -> Boolean)? = null

    fun emit(event: CompanionEvent) {
        events.tryEmit(event)
    }

    fun setConnected(connected: Boolean) {
        connectionState.value = if (connected) WsClient.State.CONNECTED else WsClient.State.DISCONNECTED
    }

    override suspend fun listMessages(sessionId: String, beforeId: String?): MessagePage {
        if (failListMessages) throw RuntimeException("无法连接")
        return MessagePage(messages = messages, nextCursor = null)
    }

    override suspend fun branchSession(sessionId: String, messageId: String) =
        com.qingyu.companion.model.SessionPreview(
            id = "branch-session", characterId = "char-1", title = "分支",
            createdAt = 1, updatedAt = 1, messageCount = 1, lastMessage = "消息",
        )

    override suspend fun listCachedMessages(sessionId: String): List<Message> = cachedMessages

    override suspend fun sendMessage(
        sessionId: String,
        requestId: String,
        content: String,
        replyToId: String?,
        images: List<String>,
    ): Message {
        if (failNextSend) throw RuntimeException("网络中断")
        return onSend?.invoke(sessionId, requestId, content, replyToId, images)
            ?: Message(requestId, sessionId, "c1", Role.user, content, timestamp = System.currentTimeMillis())
    }

    override suspend fun editMessage(sessionId: String, messageId: String, content: String): Message =
        onEdit?.invoke(sessionId, messageId, content) ?: throw UnsupportedOperationException()

    override suspend fun deleteMessage(sessionId: String, messageId: String) {
        messages = messages.filterNot { it.id == messageId }
    }

    override suspend fun translate(sessionId: String, messageId: String): TranslateResponse =
        onTranslate?.invoke(sessionId, messageId) ?: TranslateResponse(messageId, "")

    override suspend fun swipe(sessionId: String, messageId: String, direction: Int): Message =
        onSwipe?.invoke(sessionId, messageId, direction) ?: throw UnsupportedOperationException()

    override suspend fun listSessions(): List<SessionPreview> = sessions

    override suspend fun listCharacters(): List<Character> = characters

    override suspend fun listQuickReplies(characterId: String?): QuickReplyListResponse =
        quickReplyList ?: QuickReplyListResponse(emptyList(), emptyMap())

    override suspend fun executeQuickReply(id: String): Boolean = onExecute?.invoke() ?: false

    override suspend fun stopGeneration(requestId: String) = Unit

    override suspend fun clearChat(sessionId: String) = Unit

    override suspend fun getContextUsage(sessionId: String, characterId: String?) = com.qingyu.companion.model.ContextUsageDto(
        used = 0, max = 0, ratio = 0.0, pct = 0,
    )

    // ---------- 未用到的方法 ----------
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
