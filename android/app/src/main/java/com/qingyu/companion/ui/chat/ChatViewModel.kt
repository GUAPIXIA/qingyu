package com.qingyu.companion.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.data.send.CancelQueuedMessageUseCase
import com.qingyu.companion.data.send.ObserveOutboxUseCase
import com.qingyu.companion.data.send.RetryGenerationUseCase
import com.qingyu.companion.data.send.RetrySendUseCase
import com.qingyu.companion.data.send.SendMessageUseCase
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.Message
import com.qingyu.companion.model.MessageOps
import com.qingyu.companion.model.MessageUsage
import com.qingyu.companion.model.PendingMessage
import com.qingyu.companion.model.QuickReply
import com.qingyu.companion.model.QuickReplyAction
import com.qingyu.companion.model.Role
import com.qingyu.companion.network.WsClient
import com.qingyu.companion.ui.tts.TtsPlayer
import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.data.userMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * 单聊页 ViewModel。
 * - 消息列表按时间**降序**存储（最新在前），配合 LazyColumn(reverseLayout=true) 展示；
 * - 流式 token 经 WS chunk 增量累积，不落盘；done 到达后替换为完整消息；
 * - 历史分页：beforeId 游标，拉取更早消息后追加；
 * - **chunk 节流**（方案 §8 弱网对策，复用 PC 侧 chunkAccumulator 思路）：
 *   增量先进缓冲，每 ~[FLUSH_INTERVAL_MS] 批量刷入 state，避免高频重组；
 * - 重新生成（regen）：约定 swipe 端点 direction=0 = 追加新候选（对齐 PC 侧 regenerateChatMessage）。
 */
class ChatViewModel(
    private val repository: ChatRepository,
    private val sessionId: String,
    /** 从会话列表带入的角色 ID；用于消除不同角色共用 default sessionId 的歧义。 */
    private val expectedCharacterId: String? = null,
    private val ttsPlayer: TtsPlayer? = null,
    private val generationTracker: com.qingyu.companion.data.GenerationTracker? = null,
    private val draftStore: com.qingyu.companion.data.DraftStore? = null,
    // F-06：发送/重试/取消统一走 UseCase（默认由 repository 构造；ViewModel 只投影状态）
    private val sendMessageUseCase: SendMessageUseCase = SendMessageUseCase(repository),
    private val retrySendUseCase: RetrySendUseCase = RetrySendUseCase(repository),
    private val retryGenerationUseCase: RetryGenerationUseCase = RetryGenerationUseCase(repository),
    private val cancelQueuedMessageUseCase: CancelQueuedMessageUseCase = CancelQueuedMessageUseCase(repository),
) : ViewModel() {

    /** 所属角色 id（loadSessionInfo 时缓存，删除会话时精确定位） */
    private var resolvedCharacterId: String? = null

    sealed interface Streaming {
        data object Idle : Streaming
        data class Generating(val requestId: String, val text: String) : Streaming
    }

    data class UiState(
        val messages: List<Message> = emptyList(),
        /** 本地未落盘消息（发送中/失败，可重试，幂等键复用） */
        val pending: List<PendingMessage> = emptyList(),
        val streaming: Streaming = Streaming.Idle,
        val nextCursor: String? = null,
        val loading: Boolean = false,
        val loadingOlder: Boolean = false,
        val connection: WsClient.State = WsClient.State.DISCONNECTED,
        val error: String? = null,
        /** AI 续写/润色处理中 */
        val aiProcessing: Boolean = false,
        /** 正在翻译的消息；按消息粒度反馈，避免重复请求。 */
        val translatingMessageIds: Set<String> = emptySet(),
        /** 上下文用量（≥0.85 预警） */
        val contextUsage: com.qingyu.companion.model.ContextUsageDto? = null,
        /** 文本型快捷回复（已启用），按 order 排序 */
        val quickReplies: List<QuickReply> = emptyList(),
        /** 会话标题与所属角色信息（顶栏显示） */
        val sessionTitle: String = "",
        val characterName: String = "",
        val characterAvatarUrl: String? = null,
        /** 角色封面（对话背景用；无封面时回退头像） */
        val characterCoverUrl: String? = null,
        /** 会话是否开启“下一步方向”；旧响应缺省 false。 */
        val dialogueDirectionsEnabled: Boolean = false,
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    private val _input = MutableStateFlow("")
    val input: StateFlow<String> = _input.asStateFlow()

    /** 引用回复目标（输入框上方引用条展示，发送后清除） */
    private val _replyTo = MutableStateFlow<Message?>(null)
    val replyTo: StateFlow<Message?> = _replyTo.asStateFlow()

    /** chunk 节流缓冲：requestId -> 本批增量（每 FLUSH_INTERVAL_MS 清空） */
    private val chunkBuffer = LinkedHashMap<String, StringBuilder>()
    /** 流式累积缓冲：requestId -> 完整累积文本（跨 flush 保留，done/error/stop 时清理） */
    private val streamingAccumulated = HashMap<String, StringBuilder>()
    private var flushJob: Job? = null

    /** ai:usage 事件缓冲：requestId -> 用量（Done 到达时附加到消息） */
    private val usageBuffer = HashMap<String, MessageUsage>()

    // 每会话草稿自动保存（5.2），发送后清除，切换恢复
    private var draftJob: Job? = null

    init {
        // 恢复草稿
        draftStore?.let { ds ->
            viewModelScope.launch {
                runCatching { ds.getDraft(sessionId) }.onSuccess { saved ->
                    if (saved.isNotEmpty()) _input.value = saved
                }
            }
        }
        viewModelScope.launch {
            // StateFlow 天然去重，仅状态变化时触发
            repository.connectionState.collect { state ->
                _ui.update { it.copy(connection = state) }
                // 断线队列：连接恢复后自动重发失败消息（方案 §8 弱网对策）
                if (state == WsClient.State.CONNECTED) retryAllFailed()
            }
        }
        viewModelScope.launch {
            repository.events.collect(::handleEvent)
        }
        // P1-4.1 B1-2：观察持久化发件箱，App 重启后可恢复（替代纯内存 pending）
        // F-06：经 ObserveOutboxUseCase 观察（仅当前活跃 PC 的未完成行）
        viewModelScope.launch {
            ObserveOutboxUseCase(repository)(sessionId).collect { outboxPending ->
                _ui.update { it.copy(pending = outboxPending) }
            }
        }
        viewModelScope.launch {
            // 恢复未完成发件箱（queued/failed -> queued 等待重发）
            runCatching { repository.restoreOutbox() }
        }
        loadLatest()
        loadQuickReplies()
        loadSessionInfo()
        loadContextUsage()
    }

    /** 加载上下文用量（对齐 PC 端 P1-3 预警） */
    private fun loadContextUsage() {
        viewModelScope.launch {
            runCatching { repository.getContextUsage(sessionId, expectedCharacterId?.takeIf { it.isNotBlank() }) }
                .onSuccess { usage -> _ui.update { it.copy(contextUsage = usage) } }
        }
    }

    /** 加载会话标题与角色信息（顶栏「角色名 + 对话名」+ 头像） */
    private fun loadSessionInfo() {
        viewModelScope.launch {
            runCatching {
                val session = repository.listSessions().firstOrNull { candidate ->
                    candidate.id == sessionId &&
                        (expectedCharacterId.isNullOrBlank() || candidate.characterId == expectedCharacterId)
                }
                if (session != null) {
                    resolvedCharacterId = session.characterId.takeIf { it.isNotBlank() }
                    val character = repository.listCharacters()
                        .firstOrNull { it.id == session.characterId }
                    Triple(session.title, character, session.dialogueDirectionsEnabled)
                } else {
                    null
                }
            }.onSuccess { pair ->
                if (pair != null) {
                    _ui.update {
                        it.copy(
                            sessionTitle = pair.first,
                            characterName = pair.second?.name ?: "",
                            characterAvatarUrl = pair.second?.avatarUrl,
                            characterCoverUrl = pair.second?.coverUrl ?: pair.second?.avatarUrl,
                            dialogueDirectionsEnabled = pair.third,
                        )
                    }
                }
            }
        }
    }

    fun onInputChange(value: String) {
        _input.value = value
        draftJob?.cancel()
        draftJob = viewModelScope.launch {
            // 300ms 防抖，避免每字符都写 DataStore
            delay(300)
            runCatching { draftStore?.saveDraft(sessionId, value) }
        }
    }

    /** 消息内搜索 query（端侧过滤，不走网络） */
    private val _searchQuery = MutableStateFlow("")
    val searchQuery: StateFlow<String> = _searchQuery.asStateFlow()
    fun onSearchQueryChange(q: String) { _searchQuery.value = q }
    fun clearSearch() { _searchQuery.value = "" }

    /** 设置/清除引用回复目标（长按消息「引用回复」；发送成功后自动清除） */
    fun setReplyTo(message: Message?) {
        _replyTo.value = message
    }

    fun loadLatest() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, error = null) }
            try {
                val page = repository.listMessages(sessionId)
                _ui.update {
                    it.copy(
                        messages = MessageOps.merge(emptyList(), page.messages),
                        nextCursor = page.nextCursor,
                        loading = false,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val cached = repository.listCachedMessages(sessionId)
                val msg = if (e is com.qingyu.companion.data.CompanionError) e.userMessage() else e.message ?: "无法连接 PC，已显示本地缓存"
                _ui.update {
                    it.copy(
                        messages = MessageOps.merge(emptyList(), cached),
                        loading = false,
                        error = msg,
                    )
                }
            }
        }
    }

    fun loadOlder() {
        val cursor = _ui.value.nextCursor ?: return
        if (_ui.value.loadingOlder) return
        viewModelScope.launch {
            _ui.update { it.copy(loadingOlder = true) }
            try {
                val page = repository.listMessages(sessionId, beforeId = cursor)
                _ui.update { st ->
                    st.copy(
                        messages = MessageOps.merge(st.messages, page.messages),
                        nextCursor = page.nextCursor,
                        loadingOlder = false,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update { it.copy(loadingOlder = false, error = e.message) }
            }
        }
    }

    fun send() = doSend(_input.value, _images.value)

    /** 清空对话并删除会话（用户要求：清空后不留空会话，直接删掉） */
    fun clearChat(onCleared: () -> Unit) {
        viewModelScope.launch {
            runCatching { repository.clearChat(sessionId) }
                .onSuccess {
                    // 清空成功后删除会话（删除会话同时清空消息文件），完成后返回会话列表
                    runCatching { repository.deleteSession(sessionId, resolvedCharacterId) }
                    _ui.update { st -> st.copy(messages = emptyList(), nextCursor = null, error = null) }
                    onCleared()
                }
                .onFailure { e -> report(e, "清空对话失败") }
        }
    }

    /** AI 续写：无输入时生成用户回复，有输入时续写未完成消息 */
    fun aiContinue() {
        if (_ui.value.aiProcessing) return
        val original = _input.value
        viewModelScope.launch {
            _ui.update { it.copy(aiProcessing = true) }
            runCatching { repository.aiAssist(sessionId, "continue", original) }
                .onSuccess { text ->
                    _input.value = if (original.isNotBlank()) original + text else text
                }
                .onFailure { e -> report(e, "续写失败") }
            _ui.update { it.copy(aiProcessing = false) }
        }
    }

    /** AI 润色：改写输入文本（失败时保留原文） */
    fun aiPolish() {
        if (_ui.value.aiProcessing) return
        val original = _input.value
        if (original.isBlank()) return
        viewModelScope.launch {
            _ui.update { it.copy(aiProcessing = true) }
            runCatching { repository.aiAssist(sessionId, "polish", original) }
                .onSuccess { text -> _input.value = text }
                .onFailure { e -> report(e, "润色失败") }
            _ui.update { it.copy(aiProcessing = false) }
        }
    }

    /** 快捷回复点击：优先走 execute 端点，统一错误模型（P1-4.4） */
    fun onQuickReplyClick(qr: QuickReply) {
        viewModelScope.launch {
            try {
                val executed = repository.executeQuickReply(qr.id)
                if (executed) return@launch
                if (qr.action == QuickReplyAction.text) {
                    doSend(qr.content)
                } else {
                    report(Exception("快捷回复执行失败"), "该快捷回复需 PC 端执行（预设/命令），请确认桥接层已支持")
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                // 501 未实现时 text 类型可降级直发，其余按错误类型提示
                val ce = (e as? CompanionError)
                if (qr.action == QuickReplyAction.text && ce is CompanionError.ServerRejected && ce.code == 501) {
                    doSend(qr.content)
                } else {
                    report(e)
                }
            }
        }
    }

    /** 待发送图片（本地选中，发送时上传） */
    private val _images = MutableStateFlow<List<String>>(emptyList())
    val images: StateFlow<List<String>> = _images.asStateFlow()

    /** 添加/移除待发送图片 */
    fun onImagesChange(value: List<String>) {
        _images.value = value
    }

    private fun doSend(raw: String, images: List<String> = emptyList()) {
        val content = raw.trim()
        if (content.isEmpty() && images.isEmpty()) return
        val replyTarget = _replyTo.value
        // 发送后清除引用、待发送图片与草稿
        _replyTo.value = null
        _images.value = emptyList()
        _input.value = ""
        viewModelScope.launch { runCatching { draftStore?.clearDraft(sessionId) } }
        val requestId = UUID.randomUUID().toString()
        val submitted = PendingMessage(
            requestId = requestId,
            content = content,
            timestamp = System.currentTimeMillis(),
            failed = false,
            images = images,
            replyToId = replyTarget?.id,
        )
        // 先本地入列（发送中），成功后替换为落盘消息；失败保留以便重试
        _ui.update {
            it.copy(
                error = null,
                pending = it.pending + submitted,
            )
        }
        viewModelScope.launch {
            try {
                // F-06：网络/状态机逻辑下沉 SendMessageUseCase（Repository 状态机在事务内推进）
                val result = sendMessageUseCase(sessionId, content, replyTarget?.id, images, requestId)
                onSendResult(requestId, submitted, result)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                markPendingFailed(requestId, e)
            }
        }
    }

    /**
     * 处理双发送链路返回值：
     * - v1 立即返回用户消息，pending 转落盘消息并进入流式占位；
     * - v2 task 完成后返回助手消息，此时立即重拉权威列表，避免 pending 清除后用户消息消失。
     */
    private suspend fun onSendResult(requestId: String, submitted: PendingMessage, result: Message) {
        if (result.role != Role.user) {
            reconcileCompletedTask(requestId, submitted, result)
            return
        }
        _ui.update { st ->
            st.copy(
                messages = MessageOps.upsert(st.messages, result),
                pending = st.pending.filterNot { it.requestId == requestId },
                streaming = Streaming.Generating(requestId, ""),
            )
        }
        generationTracker?.onStarted(sessionId, _ui.value.characterName)
    }

    /** v2 完成态对账：优先使用服务端权威列表，网络补拉失败时保留本地用户消息快照。 */
    private suspend fun reconcileCompletedTask(
        requestId: String,
        submitted: PendingMessage,
        assistantMessage: Message,
    ) {
        val page = runCatching { repository.listMessages(sessionId) }.getOrNull()
        val authoritativePage = page?.takeIf { candidate ->
            val hasAssistant = candidate.messages.any { it.id == assistantMessage.id }
            val hasUser = candidate.messages.any { message ->
                message.role == Role.user &&
                    message.content == submitted.content &&
                    message.replyToId == submitted.replyToId
            }
            hasAssistant && hasUser
        }
        chunkBuffer.remove(requestId)
        streamingAccumulated.remove(requestId)
        usageBuffer.remove(requestId)
        _ui.update { st ->
            val reconciled = if (authoritativePage != null) {
                // 仅用服务端最新页更新当前列表，保留用户已经向上加载的更早消息。
                MessageOps.merge(st.messages, authoritativePage.messages)
            } else {
                val alreadyHasUser = st.messages.any { message ->
                    message.role == Role.user &&
                        message.content == submitted.content &&
                        message.replyToId == submitted.replyToId &&
                        kotlin.math.abs(message.timestamp - submitted.timestamp) <= USER_MATCH_WINDOW_MS
                }
                val withUser = if (alreadyHasUser) {
                    st.messages
                } else {
                    MessageOps.upsert(
                        st.messages,
                        Message(
                            id = requestId,
                            sessionId = sessionId,
                            characterId = expectedCharacterId?.takeIf { it.isNotBlank() }
                                ?: resolvedCharacterId
                                ?: assistantMessage.characterId,
                            role = Role.user,
                            content = submitted.content,
                            images = submitted.images,
                            timestamp = submitted.timestamp,
                            replyToId = submitted.replyToId,
                        ),
                    )
                }
                MessageOps.upsert(withUser, assistantMessage)
            }
            val nextStreaming = if (streamingAccumulated.isEmpty()) Streaming.Idle else {
                val (otherId, otherSb) = streamingAccumulated.entries.first()
                Streaming.Generating(otherId, otherSb.toString())
            }
            st.copy(
                messages = reconciled,
                pending = st.pending.filterNot { it.requestId == requestId },
                streaming = nextStreaming,
                nextCursor = authoritativePage?.nextCursor ?: st.nextCursor,
            )
        }
        if (streamingAccumulated.isEmpty()) generationTracker?.onStopped(sessionId)
    }

    private fun markPendingFailed(requestId: String, e: Exception) {
        _ui.update { st ->
            st.copy(
                pending = st.pending.map {
                    if (it.requestId == requestId) it.copy(failed = true) else it
                },
                error = e.message ?: "发送失败",
            )
        }
    }

    /** 重试失败消息：复用原幂等键（PC 侧已落盘则去重；引用/图片/requestId 由 UseCase 原样保持） */
    fun retryPending(requestId: String) {
        val pending = _ui.value.pending.firstOrNull { it.requestId == requestId } ?: return
        if (!pending.failed) return
        _ui.update {
            it.copy(
                pending = it.pending.map { p -> if (p.requestId == requestId) p.copy(failed = false) else p },
                error = null,
            )
        }
        viewModelScope.launch {
            try {
                // F-06：RetrySendUseCase——发送失败行重发；已落盘用户消息的行自动转生成重试
                val result = retrySendUseCase(sessionId, requestId)
                onSendResult(requestId, pending, result)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                markPendingFailed(requestId, e)
            }
        }
    }

    /** F-06：仅重试 AI 生成（不重发用户消息；v2 有 taskId 走 /tasks/:id/retry）。 */
    fun retryGeneration(requestId: String) {
        _ui.update { it.copy(error = null) }
        viewModelScope.launch {
            try {
                val message = retryGenerationUseCase(requestId)
                _ui.update { st ->
                    st.copy(
                        messages = MessageOps.upsert(st.messages, message),
                        pending = st.pending.filterNot { it.requestId == requestId },
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                markPendingFailed(requestId, e)
            }
        }
    }

    /** F-06：取消排队/生成中的消息（queued/sending 本地取消；v2 任务同时请求 PC 取消）。 */
    fun cancelPending(requestId: String) {
        viewModelScope.launch {
            runCatching { cancelQueuedMessageUseCase(requestId) }
                .onSuccess { cancelled ->
                    if (cancelled) {
                        _ui.update { st ->
                            st.copy(pending = st.pending.filterNot { it.requestId == requestId })
                        }
                    }
                }
                .onFailure { e -> report(e, "取消失败") }
        }
    }

    fun stop() {
        val current = _ui.value.streaming
        if (current is Streaming.Generating) {
            viewModelScope.launch { repository.stopGeneration(current.requestId) }
            // 清理对应 requestId 的两级缓冲
            chunkBuffer.remove(current.requestId)
            streamingAccumulated.remove(current.requestId)
            _ui.update {
                val nextStreaming = if (streamingAccumulated.isEmpty()) Streaming.Idle else {
                    val (otherId, otherSb) = streamingAccumulated.entries.first()
                    Streaming.Generating(otherId, otherSb.toString())
                }
                it.copy(streaming = nextStreaming)
            }
            if (streamingAccumulated.isEmpty()) generationTracker?.onStopped(sessionId)
        }
    }

    /** 方向生成失败的可见反馈（按消息 ID；仅本地）。 */
    private val DIRECTIONS_FAILED = "方向生成失败，请稍后重试"

    private val _directionsError = MutableStateFlow<Map<String, String>>(emptyMap())
    val directionsError: StateFlow<Map<String, String>> = _directionsError.asStateFlow()

    /** “换一批”：重新生成指定消息的方向；失败时在该消息下给出提示。 */
    fun regenerateDirections(messageId: String) {
        viewModelScope.launch {
            _directionsError.update { it - messageId }
            runCatching { repository.regenerateDirections(sessionId, messageId) }
                .onSuccess { directions ->
                    if (directions.isEmpty()) {
                        _directionsError.update { it + (messageId to DIRECTIONS_FAILED) }
                    } else {
                        _ui.update { st ->
                            st.copy(
                                messages = st.messages.map { message ->
                                    if (message.id == messageId) message.copy(dialogueDirections = directions) else message
                                },
                            )
                        }
                    }
                }
                .onFailure { _directionsError.update { it + (messageId to DIRECTIONS_FAILED) } }
        }
    }

    /** 重新生成：追加新候选（协议假设：swipe direction=0，PC 侧对齐 regenerateChatMessage） */
    fun regenerate(messageId: String) {
        viewModelScope.launch {
            runCatching { repository.swipe(sessionId, messageId, DIRECTION_REGENERATE) }
                .onSuccess { m ->
                    _ui.update { st -> st.copy(messages = MessageOps.upsert(st.messages, m)) }
                }
                .onFailure { e -> report(e, "重新生成失败") }
        }
    }

    fun branch(messageId: String, onCreated: (String, String) -> Unit) {
        viewModelScope.launch {
            runCatching { repository.branchSession(sessionId, messageId) }
                .onSuccess { branch -> onCreated(branch.id, branch.characterId) }
                .onFailure { e -> report(e, "创建分支失败") }
        }
    }

    /** 朗读指定消息：PC 合成中转音频流，ExoPlayer 播放（方案 §3.3） */
    fun playTts(messageId: String) {
        val player = ttsPlayer ?: return
        viewModelScope.launch {
            runCatching { player.play(sessionId, messageId) }
                .onFailure { e -> report(e, "朗读失败") }
        }
    }

    /** 连接恢复后自动重发全部失败消息（断线队列，方案 §8） */
    private fun retryAllFailed() {
        val failed = _ui.value.pending.filter { it.failed }.map { it.requestId }
        if (failed.isEmpty()) return
        failed.forEach { retryPending(it) }
    }

    fun clearError() = _ui.update { it.copy(error = null) }

    fun loadQuickReplies() {
        viewModelScope.launch {
            runCatching { repository.listQuickReplies(characterId = null) }
                .onSuccess { resp ->
                    _ui.update { state ->
                        state.copy(
                            // 全部已启用类型（text/preset/command），点击时经 execute 端点分发；byCharacter 为 Map 值平铺
                            quickReplies = (resp.global + resp.byCharacter.values.flatten())
                                .filter { q -> q.enabled }
                                .sortedBy { q -> q.order }
                        )
                    }
                }
                .onFailure { e -> report(e) }
        }
    }

    fun editMessage(messageId: String, content: String) {
        val trimmed = content.trim()
        if (trimmed.isEmpty()) {
            return
        }
        viewModelScope.launch {
            runCatching { repository.editMessage(sessionId, messageId, trimmed) }
                .onSuccess { m ->
                    _ui.update { st -> st.copy(messages = MessageOps.upsert(st.messages, m), error = null) }
                }
                .onFailure { e -> report(e, "编辑失败") }
        }
    }

    fun deleteMessage(messageId: String) {
        viewModelScope.launch {
            runCatching { repository.deleteMessage(sessionId, messageId) }
                .onSuccess {
                    _ui.update { st -> st.copy(messages = MessageOps.remove(st.messages, messageId)) }
                }
                .onFailure { e -> report(e, "删除失败") }
        }
    }

    fun swipe(messageId: String, direction: Int) {
        viewModelScope.launch {
            runCatching { repository.swipe(sessionId, messageId, direction) }
                .onSuccess { m ->
                    _ui.update { st -> st.copy(messages = MessageOps.upsert(st.messages, m)) }
                }
                .onFailure { e -> report(e, "切换失败") }
        }
    }

    fun translate(messageId: String) {
        if (messageId in _ui.value.translatingMessageIds) return
        _ui.update { it.copy(translatingMessageIds = it.translatingMessageIds + messageId, error = null) }
        viewModelScope.launch {
            try {
                val resp = repository.translate(sessionId, messageId)
                if (resp.translation.isBlank()) throw IllegalStateException("翻译结果为空，请重试")
                _ui.update { st ->
                    st.copy(
                        messages = st.messages.map { m ->
                            if (m.id == resp.messageId) m.copy(translation = resp.translation) else m
                        }
                    )
                }
            } catch (e: Exception) {
                report(e, "翻译失败")
            } finally {
                _ui.update { it.copy(translatingMessageIds = it.translatingMessageIds - messageId) }
            }
        }
    }

    /** 将异常转为 UI 错误提示（跳过协程取消，P1-4.4 统一错误模型） */
    private fun report(e: Throwable, fallback: String? = null) {
        if (e is CancellationException) throw e
        val msg = when (e) {
            is CompanionError -> e.userMessage()
            else -> e.message ?: fallback
        }
        _ui.update { it.copy(error = msg) }
    }

    private fun handleEvent(event: CompanionEvent) {
        when (event) {
            is CompanionEvent.Chunk -> if (event.sessionId == sessionId) {
                // 节流：累积增量，定时批量 flush（弱网下高频 chunk 不逐帧重组）
                chunkBuffer.getOrPut(event.requestId) { StringBuilder() }
                    .append(event.delta)
                scheduleFlush()
            }

            is CompanionEvent.Done -> if (event.sessionId == sessionId) {
                // 同一 requestId 的流式缓冲作废，直接替换为落盘完整消息
                chunkBuffer.remove(event.requestId)
                streamingAccumulated.remove(event.requestId)
                val usage = usageBuffer.remove(event.requestId)
                val message = if (usage != null) event.message.copy(usage = usage) else event.message
                _ui.update { st ->
                    st.copy(
                        messages = MessageOps.upsert(st.messages, message),
                        streaming = if (streamingAccumulated.isEmpty()) Streaming.Idle else {
                            // 仍有其他进行中流式，展示其中一个（避免 Idle 覆盖其他请求）
                            val (otherId, otherSb) = streamingAccumulated.entries.first()
                            Streaming.Generating(otherId, otherSb.toString())
                        },
                    )
                }
                if (streamingAccumulated.isEmpty()) generationTracker?.onStopped(sessionId)
                // P1-4.1 B1-2：发件箱完成清理（幂等）
                viewModelScope.launch { runCatching { repository.clearCompletedOutbox(sessionId) } }
            }

            is CompanionEvent.Error -> if (event.sessionId == sessionId) {
                chunkBuffer.remove(event.requestId)
                streamingAccumulated.remove(event.requestId)
                usageBuffer.remove(event.requestId)
                _ui.update {
                    val nextStreaming = if (streamingAccumulated.isEmpty()) Streaming.Idle else {
                        val (otherId, otherSb) = streamingAccumulated.entries.first()
                        Streaming.Generating(otherId, otherSb.toString())
                    }
                    it.copy(streaming = nextStreaming, error = event.message)
                }
                if (streamingAccumulated.isEmpty()) generationTracker?.onStopped(sessionId)
            }

            is CompanionEvent.Usage ->
                // 用量先缓存，Done 时附加到完整消息（与 PC 侧 ai:usage 事件对齐）
                usageBuffer[event.requestId] = MessageUsage(
                    promptTokens = event.promptTokens,
                    completionTokens = event.completionTokens,
                    totalTokens = event.totalTokens,
                )

            // PC 侧新增消息 -> 刷新；标题/删除等变更由会话列表页处理
            // （revision 预留字段当前恒 null；PC 补充后可在此做跳变检测触发补拉，见 model/WsEvent.kt TODO）
            is CompanionEvent.SessionUpdated ->
                if (event.sessionId == sessionId && event.change == "message") loadLatest()

            // 设置同步 v2 事件（方案 §7 C-04）由设置页仓库消费，聊天页无关
            is CompanionEvent.SettingsUpdated -> Unit
            is CompanionEvent.RelayCommandCompleted -> Unit
            is CompanionEvent.RelayCommandExpired -> Unit

            // F-01：task:* 帧事件——本设备 v2 任务由 Repository 轮询链路消费（cursor 去重后
            // 转为同构 Chunk 事件流）；此分支面向 PC 端发起的任务推送，聊天页当前不消费
            is CompanionEvent.TaskEvent -> Unit
        }
    }

    /** 首次 chunk 到达时启动周期 flush；缓冲清空后自动退出 */
    private fun scheduleFlush() {
        if (flushJob?.isActive == true) return
        flushJob = viewModelScope.launch {
            while (isActive) {
                delay(FLUSH_INTERVAL_MS)
                if (chunkBuffer.isEmpty()) break
                val snapshot = chunkBuffer.entries.associate { (reqId, sb) -> reqId to sb.toString() }
                chunkBuffer.clear()
                _ui.update { st ->
                    var updated = st
                    for ((reqId, delta) in snapshot) {
                        val acc = streamingAccumulated.getOrPut(reqId) { StringBuilder() }
                        acc.append(delta)
                        updated = updated.copy(
                            streaming = Streaming.Generating(reqId, acc.toString())
                        )
                    }
                    updated
                }
            }
        }
    }

    private companion object {
        /** 流式渲染刷新间隔（毫秒）：与 PC 侧 chunkAccumulator 节流量级一致 */
        const val FLUSH_INTERVAL_MS = 100L

        /** swipe 端点的"重新生成"约定方向（0 = 追加新候选，非循环切换） */
        const val DIRECTION_REGENERATE = 0

        /** v2 补拉失败时识别已存在用户消息的时间窗口，避免本地兜底重复插入。 */
        const val USER_MATCH_WINDOW_MS = 5 * 60 * 1000L
    }
}
