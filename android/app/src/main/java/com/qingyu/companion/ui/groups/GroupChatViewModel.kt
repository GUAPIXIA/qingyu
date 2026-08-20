package com.qingyu.companion.ui.groups

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.data.userMessage
import com.qingyu.companion.model.GroupMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * 群聊消息页 ViewModel（阶段二：查看 + 发言落盘；AI 群聊回复待二期）。
 */
class GroupChatViewModel(
    private val repository: ChatRepository,
    private val groupId: String,
    private val sessionId: String,
    private val generationTracker: com.qingyu.companion.data.GenerationTracker? = null,
) : ViewModel() {

    data class UiState(
        val messages: List<GroupMessage> = emptyList(),
        val loading: Boolean = false,
        val sending: Boolean = false,
        val generating: Boolean = false,
        val error: String? = null,
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    private val _input = MutableStateFlow("")
    val input: StateFlow<String> = _input.asStateFlow()

    private val _memberNames = MutableStateFlow<Map<String, String>>(emptyMap())
    val memberNames: StateFlow<Map<String, String>> = _memberNames.asStateFlow()

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
                    if (e is kotlinx.coroutines.CancellationException) throw e
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
        viewModelScope.launch {
            _ui.update { it.copy(error = null) }
            runCatching { repository.groupTranslate(groupId, sessionId, messageId) }
                .onSuccess { translation ->
                    if (translation.isNullOrBlank()) {
                        _ui.update { it.copy(error = "翻译结果为空，请重试") }
                    } else {
                        _ui.update { st ->
                            st.copy(
                                messages = st.messages.map { m ->
                                    if (m.id == messageId) m.copy(translation = translation) else m
                                },
                            )
                        }
                    }
                }
                .onFailure { e ->
                    val msg = if (e is CompanionError) e.userMessage() else e.message ?: "翻译失败"
                    _ui.update { it.copy(error = msg) }
                }
        }
    }
}
