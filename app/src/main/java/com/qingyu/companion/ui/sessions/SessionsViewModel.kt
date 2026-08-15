package com.qingyu.companion.ui.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.SessionPreview
import com.qingyu.companion.network.WsClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 会话列表 ViewModel：REST 拉取 + WS session:updated 增量刷新 + 离线只读回退。
 */
class SessionsViewModel(
    private val repository: ChatRepository,
    /** 可选：按角色过滤（角色历史会话列表用）；null = 全部会话 */
    private val characterId: String? = null,
) : ViewModel() {

    data class UiState(
        val sessions: List<SessionPreview> = emptyList(),
        val loading: Boolean = false,
        val offline: Boolean = false,
        val error: String? = null,
        val connection: WsClient.State = WsClient.State.DISCONNECTED,
        /** 排序模式：updated = 按时间（最近优先）｜name = 按角色名称 */
        val sortMode: String = "updated",
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    init {
        viewModelScope.launch {
            repository.connectionState.collect { state ->
                _ui.update { it.copy(connection = state) }
            }
        }
        viewModelScope.launch {
            repository.events.collect { event ->
                if (event is CompanionEvent.SessionUpdated) refresh()
            }
        }
        refresh()
    }

    /** 切换排序：时间 ↔ 角色名称（触发重排） */
    fun toggleSort() {
        val next = if (_ui.value.sortMode == "updated") "name" else "updated"
        _ui.update { it.copy(sortMode = next) }
        refresh()
    }

    /** 按当前排序模式对会话列表排序 */
    private fun applySort(list: List<SessionPreview>): List<SessionPreview> =
        when (_ui.value.sortMode) {
            "name" -> list.sortedWith(
                compareBy<SessionPreview, String>(String.CASE_INSENSITIVE_ORDER) { it.characterName.ifBlank { it.title } }
                    .thenByDescending { it.updatedAt },
            )
            else -> list.sortedByDescending { it.updatedAt }
        }

    fun refresh() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, error = null) }
            try {
                val sessions = repository.listSessions()
                    .let { all ->
                        if (characterId != null) all.filter { it.characterId == characterId } else all
                    }
                    .let { applySort(it) }
                _ui.update { it.copy(sessions = sessions, loading = false, offline = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val cached = applySort(repository.listCachedSessions())
                _ui.update {
                    it.copy(
                        sessions = cached,
                        loading = false,
                        offline = true,
                        error = e.message ?: "无法连接 PC，已显示本地缓存",
                    )
                }
            }
        }
    }

    fun delete(session: SessionPreview) {
        viewModelScope.launch {
            try {
                // 传 characterId 精确定位（历史遗留：多个角色共用 default sessionId）
                repository.deleteSession(session.id, session.characterId.takeIf { it.isNotBlank() })
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update { it.copy(error = e.message ?: "删除失败") }
            }
            refresh()
        }
    }

    /** 新建对话：创建会话后回调新会话 id；greeting 为选定的开场白（可空，不选则用 PC 默认） */
    fun createSession(characterId: String, greeting: String? = null, onCreated: (sessionId: String) -> Unit) {
        viewModelScope.launch {
            runCatching { repository.createSession(characterId, greeting = greeting) }
                .onSuccess { session ->
                    onCreated(session.id)
                    refresh()
                }
                .onFailure { e ->
                    _ui.update { it.copy(error = e.message ?: "新建对话失败") }
                }
        }
    }

    /** 重命名会话（协议假设 PATCH /api/v1/sessions/:id） */
    fun rename(sessionId: String, title: String) {
        val trimmed = title.trim()
        if (trimmed.isEmpty()) return
        viewModelScope.launch {
            try {
                repository.renameSession(sessionId, trimmed)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update { it.copy(error = e.message ?: "重命名失败") }
            }
            refresh()
        }
    }
}
