package com.qingyu.companion.ui.groups

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.ChatRepository
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
    /** 成员 id -> 名称（群消息只存 characterId，需映射角色名显示） */
    private val memberNames: Map<String, String>,
) : ViewModel() {

    data class UiState(
        val messages: List<GroupMessage> = emptyList(),
        val loading: Boolean = false,
        val sending: Boolean = false,
        val error: String? = null,
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    private val _input = MutableStateFlow("")
    val input: StateFlow<String> = _input.asStateFlow()

    init {
        load()
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
                    _ui.update { it.copy(loading = false, error = e.message ?: "加载失败") }
                }
        }
    }

    fun send() {
        val content = _input.value.trim()
        if (content.isEmpty() || _ui.value.sending) return
        _input.value = ""
        viewModelScope.launch {
            _ui.update { it.copy(sending = true, error = null) }
            val requestId = UUID.randomUUID().toString()
            runCatching { repository.sendGroupMessage(groupId, sessionId, requestId, content) }
                .onSuccess {
                    // 用户消息落盘后触发群聊 AI 回复（轮转发言人），完成后刷新
                    runCatching { repository.groupAiReply(groupId, sessionId) }
                    load()
                }
                .onFailure { e ->
                    _ui.update { it.copy(sending = false, error = e.message ?: "发送失败") }
                }
        }
    }

    /** 发言者显示名：用户 -> 你，角色 -> 角色名（缺省 id 前 6 位） */
    fun speakerName(characterId: String): String =
        if (characterId == "__user__") "你"
        else memberNames[characterId] ?: characterId.take(6)

    /** 删除群聊消息 */
    fun deleteMessage(messageId: String) {
        viewModelScope.launch {
            runCatching { repository.deleteGroupMessage(groupId, sessionId, messageId) }
                .onSuccess { load() }
                .onFailure { e -> _ui.update { it.copy(error = e.message ?: "删除失败") } }
        }
    }

    /** 编辑群聊消息 */
    fun editMessage(messageId: String, content: String) {
        val trimmed = content.trim()
        if (trimmed.isEmpty()) return
        viewModelScope.launch {
            runCatching { repository.editGroupMessage(groupId, sessionId, messageId, trimmed) }
                .onSuccess { load() }
                .onFailure { e -> _ui.update { it.copy(error = e.message ?: "编辑失败") } }
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
                .onFailure { e -> _ui.update { it.copy(error = e.message ?: "翻译失败") } }
        }
    }
}
