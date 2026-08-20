package com.qingyu.companion.ui.characters

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.data.userMessage
import com.qingyu.companion.model.Character
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 角色浏览 ViewModel：只读浏览 + 切换当前角色（方案 §3.1）。
 * 「切换当前角色」走 `POST /api/v1/characters/{id}/activate`（协议假设，
 * PC 桥接层落地前先留入口，失败降级为提示）。
 */
class CharactersViewModel(
    private val repository: ChatRepository,
) : ViewModel() {

    data class UiState(
        val characters: List<Character> = emptyList(),
        val loading: Boolean = false,
        /** 正在切换的角色 id（按钮 loading 反馈） */
        val activatingId: String? = null,
        /** 正在为角色创建会话的 id */
        val creatingId: String? = null,
        val error: String? = null,
        val info: String? = null,
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, error = null) }
            try {
                val characters = repository.listCharacters()
                _ui.update { it.copy(characters = characters, loading = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val msg = if (e is CompanionError) e.userMessage() else e.message ?: "加载角色失败"
                _ui.update { it.copy(loading = false, error = msg) }
            }
        }
    }

    /** 切换当前角色：PC 侧创建新会话并激活该角色（协议假设，失败仅提示） */
    fun activate(characterId: String, characterName: String) {
        if (_ui.value.activatingId != null) return
        viewModelScope.launch {
            _ui.update { it.copy(activatingId = characterId, error = null, info = null) }
            try {
                repository.activateCharacter(characterId)
                _ui.update {
                    it.copy(
                        activatingId = null,
                        info = "已切换到「$characterName」，返回会话列表开始对话",
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val msg = if (e is CompanionError) e.userMessage() else e.message ?: "切换失败（PC 桥接层可能未实现该端点）"
                _ui.update {
                    it.copy(
                        activatingId = null,
                        error = msg,
                    )
                }
            }
        }
    }

    /** 从角色详情直接创建会话，避免必须先切换角色再返回会话页。 */
    fun startChat(characterId: String, onCreated: (sessionId: String) -> Unit) {
        if (_ui.value.creatingId != null) return
        viewModelScope.launch {
            _ui.update { it.copy(creatingId = characterId, error = null, info = null) }
            try {
                val session = repository.createSession(characterId)
                _ui.update { it.copy(creatingId = null) }
                onCreated(session.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val msg = if (e is CompanionError) e.userMessage() else e.message ?: "新建对话失败"
                _ui.update {
                    it.copy(
                        creatingId = null,
                        error = msg,
                    )
                }
            }
        }
    }

    fun clearInfo() = _ui.update { it.copy(info = null) }
}
