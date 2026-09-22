package com.qingyu.companion.ui.groups

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.data.userMessage
import com.qingyu.companion.model.GroupMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * 群聊消息页 ViewModel（阶段二：查看 + 发言落盘）。
 *
 * S6-01(f)：流式事件转发 + 停止 + 立即接话 + 续写 + 导出 + 群记忆反馈。
 * - [driver] 非空 = 驱动 `LocalGroupGenerationUseCase.generate` 的 Flow（Chunk 实时上屏、
 *   TurnFinished 落库可见、WaitingUser 交还用户、Stopped 保留已见正文并标已停止）；
 *   为 null 时回落旧的一次性 [ChatRepository.groupAiReply]（保持既有行为，测试不破）。
 * - **错误／提示只进提示字段，绝不进正文**（语义钉子，见 [GroupStreamingReducer]）。
 */
class GroupChatViewModel(
    private val repository: ChatRepository,
    private val groupId: String,
    private val sessionId: String,
    private val generationTracker: com.qingyu.companion.data.GenerationTracker? = null,
    /** 群生成流源（S6-01f）；null = 回落一次性 groupAiReply。 */
    private val driver: GroupGenerationDriver? = null,
    /** 群长记忆摘要触发（S6-01f 记忆面板）；null = 不触发。 */
    private val memorySummarizer: (suspend () -> GroupMemoryFeedback)? = null,
) : ViewModel() {

    data class UiState(
        val messages: List<GroupMessage> = emptyList(),
        val loading: Boolean = false,
        val sending: Boolean = false,
        val generating: Boolean = false,
        val translatingMessageIds: Set<String> = emptySet(),
        val error: String? = null,
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    private val _input = MutableStateFlow("")
    val input: StateFlow<String> = _input.asStateFlow()

    private val _memberNames = MutableStateFlow<Map<String, String>>(emptyMap())
    val memberNames: StateFlow<Map<String, String>> = _memberNames.asStateFlow()

    /** 流式显示状态（S6-01f 第 3 项）。 */
    private val _streaming = MutableStateFlow(GroupStreamingReducer.initial())
    val streaming: StateFlow<GroupStreamingUi> = _streaming.asStateFlow()

    /** 群记忆面板反馈（S6-01f 第 7 项）。 */
    private val _memoryFeedback = MutableStateFlow<GroupMemoryFeedback?>(null)
    val memoryFeedback: StateFlow<GroupMemoryFeedback?> = _memoryFeedback.asStateFlow()

    private var generationJob: Job? = null

    init {
        load()
        loadMemberNames()
    }

    private fun loadMemberNames() {
        viewModelScope.launch {
            runCatching {
                val chars = repository.listCharacters()
                chars.associate { it.id to it.name }
            }.onSuccess { map -> _memberNames.value = map }
            // 失败时保留空 Map，speakerName 会退化为 characterId.take(6)，不抛错
        }
    }

    fun onInputChange(v: String) {
        _input.value = v
    }

    fun load() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, error = null) }
            runCatching { repository.listGroupMessages(groupId, sessionId) }
                .onSuccess { messages ->
                    _ui.update { it.copy(messages = messages, loading = false) }
                }
                .onFailure { e ->
                    val msg = if (e is CompanionError) e.userMessage() else e.message ?: "加载失败"
                    _ui.update { it.copy(loading = false, error = msg) }
                }
        }
    }

    private suspend fun refreshMessagesPreserveError() {
        runCatching { repository.listGroupMessages(groupId, sessionId) }
            .onSuccess { messages ->
                _ui.update { it.copy(messages = messages, loading = false) }
            }
            .onFailure { e ->
                val msg = if (e is CompanionError) e.userMessage() else e.message ?: "加载失败"
                _ui.update { it.copy(loading = false, error = msg) }
            }
    }

    fun send() {
        if (driver != null) {
            sendStreaming()
            return
        }
        val content = _input.value.trim()
        if (content.isEmpty() || _ui.value.sending || _ui.value.generating) {
            return
        }
        _input.value = ""
        _ui.update { it.copy(sending = true, generating = false, error = null) }
        viewModelScope.launch {
            // sending 已在同步区置为 true，保证 UI 立即禁用
            val requestId = UUID.randomUUID().toString()
            var userSendOk = false
            var aiError: String? = null
            try {
                repository.sendGroupMessage(groupId, sessionId, requestId, content)
                userSendOk = true
                _ui.update { it.copy(sending = false, generating = true) }
                generationTracker?.onStarted(sessionId, groupId)
                try {
                    val aiOk = repository.groupAiReply(groupId, sessionId)
                    if (!aiOk) {
                        aiError = "AI 回复失败，可重试 AI 回复"
                        _ui.update { it.copy(generating = false, error = aiError) }
                        generationTracker?.onStopped(sessionId)
                    } else {
                        _ui.update { it.copy(generating = false, error = null) }
                        generationTracker?.onStopped(sessionId)
                    }
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    val msg = if (e is CompanionError) e.userMessage() else e.message ?: "AI 回复失败，可重试"
                    aiError = msg
                    _ui.update { it.copy(generating = false, error = msg) }
                    generationTracker?.onStopped(sessionId)
                }
            } catch (e: Exception) {
                val msg = if (e is CompanionError) e.userMessage() else e.message ?: "发送失败"
                if (!userSendOk) {
                    _ui.update { it.copy(sending = false, generating = false, error = msg) }
                } else {
                    aiError = msg
                    _ui.update { it.copy(generating = false, error = aiError) }
                }
            } finally {
                _ui.update { it.copy(sending = false) }
                // 保留 AI 失败错误，不被 load() 的 error=null 覆盖
                refreshMessagesPreserveError()
                if (aiError != null) {
                    _ui.update { it.copy(error = aiError) }
                }
            }
        }
    }

    fun retryAiReply() {
        if (driver != null) {
            runGeneration(forcedSpeakerId = null, chainEnabled = true)
            return
        }
        if (_ui.value.generating || _ui.value.sending) return
        viewModelScope.launch {
            _ui.update { it.copy(generating = true, error = null) }
            var retryError: String? = null
            try {
                val ok = repository.groupAiReply(groupId, sessionId)
                if (!ok) {
                    retryError = "AI 回复失败，可重试"
                    _ui.update { it.copy(error = retryError) }
                } else {
                    _ui.update { it.copy(error = null) }
                }
            } catch (e: Exception) {
                retryError = if (e is CompanionError) e.userMessage() else e.message ?: "AI 回复失败"
                _ui.update { it.copy(error = retryError) }
            } finally {
                _ui.update { it.copy(generating = false) }
                refreshMessagesPreserveError()
                if (retryError != null) {
                    _ui.update { it.copy(error = retryError) }
                }
            }
        }
    }

    // ---------- S6-01f 流式驱动（driver 非空时） ----------

    private fun sendStreaming() {
        val content = _input.value.trim()
        if (content.isEmpty() || _ui.value.sending || _ui.value.generating) return
        _input.value = ""
        _ui.update { it.copy(sending = true, generating = false, error = null) }
        viewModelScope.launch {
            val requestId = UUID.randomUUID().toString()
            try {
                repository.sendGroupMessage(groupId, sessionId, requestId, content)
                _ui.update { it.copy(sending = false) }
                refreshMessagesPreserveError()
                runGeneration(forcedSpeakerId = null, chainEnabled = true)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                val msg = if (e is CompanionError) e.userMessage() else e.message ?: "发送失败"
                _ui.update { it.copy(sending = false, generating = false, error = msg) }
            }
        }
    }

    /** 立即接话（S6-01f 第 4 项，forcedSpeakerId）：不经发言计划、开新轮、不接力。 */
    fun speakNow(memberId: String) {
        if (_ui.value.generating || _ui.value.sending) return
        runGeneration(forcedSpeakerId = memberId, chainEnabled = false)
    }

    /** 续写（S6-01f 第 4 项）：让最后一棒角色继续推进（开新轮、不接力）。 */
    fun continueWrite() {
        if (_ui.value.generating || _ui.value.sending) return
        val lastAi = _ui.value.messages.lastOrNull { !it.isUser && it.characterId.isNotBlank() }
        val speaker = lastAi?.characterId ?: return
        runGeneration(forcedSpeakerId = speaker, chainEnabled = false)
    }

    /** 停止生成（S6-01f 第 3 项）：取消收集 = 用户停止，保留已见正文并标「已停止生成」。 */
    fun stop() {
        val job = generationJob ?: return
        _streaming.update {
            it.copy(active = false, stopped = true, notice = GroupStreamingReducer.STOPPED_NOTICE)
        }
        generationTracker?.onStopped(sessionId)
        job.cancel()
    }

    private fun runGeneration(forcedSpeakerId: String?, chainEnabled: Boolean) {
        val driver = this.driver ?: return
        if (_ui.value.generating || _ui.value.sending) return
        generationJob?.cancel()
        val requestId = UUID.randomUUID().toString()
        _streaming.value = GroupStreamingReducer.initial().copy(active = true)
        _ui.update { it.copy(generating = true, error = null) }
        generationTracker?.onStarted(sessionId, groupId)
        generationJob = viewModelScope.launch {
            try {
                driver.generate(
                    groupId = groupId,
                    sessionId = sessionId,
                    requestId = requestId,
                    targetCharId = null,
                    forcedSpeakerId = forcedSpeakerId,
                    chainEnabled = chainEnabled,
                    turnRound = null,
                ).collect { delta ->
                    _streaming.update { GroupStreamingReducer.reduce(it, delta) }
                    when (delta) {
                        is com.qingyu.companion.chatcore.LocalGroupGenerationUseCase.Delta.TurnFinished ->
                            refreshMessagesPreserveError()
                        is com.qingyu.companion.chatcore.LocalGroupGenerationUseCase.Delta.Rejected ->
                            _ui.update { it.copy(error = delta.reason) }
                        is com.qingyu.companion.chatcore.LocalGroupGenerationUseCase.Delta.WaitingUser ->
                            _ui.update { it.copy(error = null) }
                        else -> Unit
                    }
                }
            } catch (e: CancellationException) {
                // 收集方取消 = 用户停止；正文已保留（stop() 已置已停止提示）
                throw e
            } catch (e: Throwable) {
                val msg = if (e is CompanionError) e.userMessage() else e.message ?: "生成失败"
                _streaming.update { it.copy(active = false, error = msg) }
                _ui.update { it.copy(error = msg) }
            } finally {
                generationTracker?.onStopped(sessionId)
                _ui.update { it.copy(generating = false) }
            }
        }
    }

    /** 群记忆总结（S6-01f 第 7 项）：触发并把 Outcome 投影为可见反馈。 */
    fun summarizeMemory() {
        val summarizer = this.memorySummarizer ?: return
        viewModelScope.launch {
            runCatching { summarizer() }
                .onSuccess { feedback -> _memoryFeedback.value = feedback }
                .onFailure { e ->
                    val msg = if (e is CompanionError) e.userMessage() else e.message ?: "群记忆总结失败"
                    _memoryFeedback.value = GroupMemoryFeedback(msg, isError = true, summarized = false)
                }
        }
    }

    /** 群导出（S6-01f 第 4 项，D-14 群口径 Markdown）：由当前消息构造，不复用单聊 sessionExport。 */
    fun exportMarkdown(groupName: String, sessionTitle: String, userName: String): String =
        GroupExport.build(
            groupName = groupName,
            sessionTitle = sessionTitle,
            memberNames = _memberNames.value,
            userName = userName,
            messages = _ui.value.messages,
            exportedAt = System.currentTimeMillis(),
        )

    // ---------- S6-01f 模式切换（第 2 项）：patchGroup 群级键 ----------

    /** 发言模式切换（mention | polling | free）。 */
    fun applyChatMode(mode: String) = patchGroup { GroupSessionPatch.chatModePatch(mode) }

    /** polling 自动接力开关。 */
    fun applyAutoMode(enabled: Boolean) = patchGroup { GroupSessionPatch.autoModePatch(enabled) }

    /** 每成员发言间隔（毫秒）。 */
    fun applySpeakerInterval(millis: Int) = patchGroup { GroupSessionPatch.speakerIntervalPatch(millis) }

    /** 自动接力最大轮数。 */
    fun applyMaxRounds(rounds: Int) = patchGroup { GroupSessionPatch.maxRoundsPatch(rounds) }

    /** 会话叙事模式（""／immersive／omniscient）。 */
    fun applyNarrativeMode(mode: String) = patchSession { GroupSessionPatch.narrativeModePatch(mode) }

    private fun patchGroup(build: () -> Map<String, Any?>) {
        val patch = runCatching(build).getOrElse { e ->
            _ui.update { it.copy(error = e.message ?: "参数无效") }
            return
        }
        viewModelScope.launch {
            runCatching { repository.patchGroup(groupId, patch) }
                .onFailure { e ->
                    val msg = if (e is CompanionError) e.userMessage() else e.message ?: "修改群设置失败"
                    _ui.update { it.copy(error = msg) }
                }
        }
    }

    private fun patchSession(build: () -> Map<String, Any?>) {
        val patch = runCatching(build).getOrElse { e ->
            _ui.update { it.copy(error = e.message ?: "参数无效") }
            return
        }
        viewModelScope.launch {
            runCatching { repository.patchGroupSession(groupId, sessionId, patch) }
                .onFailure { e ->
                    val msg = if (e is CompanionError) e.userMessage() else e.message ?: "修改会话设置失败"
                    _ui.update { it.copy(error = msg) }
                }
        }
    }

    /** 发言者显示名：用户 -> 你，角色 -> 角色名（缺省 id 前 6 位） */
    fun speakerName(characterId: String): String =
        if (characterId == "__user__") "你"
        else _memberNames.value[characterId] ?: characterId.take(6)

    /** 删除群聊消息 */
    fun deleteMessage(messageId: String) {
        viewModelScope.launch {
            runCatching { repository.deleteGroupMessage(groupId, sessionId, messageId) }
                .onSuccess { load() }
                .onFailure { e ->
                    val msg = if (e is CompanionError) e.userMessage() else e.message ?: "删除失败"
                    _ui.update { it.copy(error = msg) }
                }
        }
    }

    /** 编辑群聊消息 */
    fun editMessage(messageId: String, content: String) {
        val trimmed = content.trim()
        if (trimmed.isEmpty()) {
            return
        }
        viewModelScope.launch {
            runCatching { repository.editGroupMessage(groupId, sessionId, messageId, trimmed) }
                .onSuccess { load() }
                .onFailure { e ->
                    val msg = if (e is CompanionError) e.userMessage() else e.message ?: "编辑失败"
                    _ui.update { it.copy(error = msg) }
                }
        }
    }

    /** 翻译群聊消息（AI 翻译，成功后写入 translation 并刷新） */
    fun translate(messageId: String) {
        if (messageId in _ui.value.translatingMessageIds) return
        _ui.update { it.copy(translatingMessageIds = it.translatingMessageIds + messageId, error = null) }
        viewModelScope.launch {
            try {
                val translation = repository.groupTranslate(groupId, sessionId, messageId)
                if (translation.isNullOrBlank()) throw IllegalStateException("翻译结果为空，请重试")
                _ui.update { st ->
                    st.copy(
                        messages = st.messages.map { m ->
                            if (m.id == messageId) m.copy(translation = translation) else m
                        },
                    )
                }
            } catch (e: Throwable) {
                if (e is CancellationException) throw e
                val msg = if (e is CompanionError) e.userMessage() else e.message ?: "翻译失败"
                _ui.update { it.copy(error = msg) }
            } finally {
                _ui.update { it.copy(translatingMessageIds = it.translatingMessageIds - messageId) }
            }
        }
    }
}
