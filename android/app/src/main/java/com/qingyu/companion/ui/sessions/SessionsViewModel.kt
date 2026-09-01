package com.qingyu.companion.ui.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.data.toCompanionError
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.SessionPreview
import com.qingyu.companion.network.WsClient
import com.qingyu.companion.ui.components.LoadState
import com.qingyu.companion.ui.components.projectLoadState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 会话列表 ViewModel：REST 拉取 + WS session:updated 增量刷新 + 离线只读回退。
 *
 * E-02：页面渲染统一消费 [loadState]（LoadState 投影，纯函数 [projectLoadState]）；
 * [UiState] 保留原始字段供迁移中的旧读法（如角色历史会话页）过渡。
 */
class SessionsViewModel(
    private val repository: ChatRepository,
    /** 可选：按角色过滤（角色历史会话列表用）；null = 全部会话 */
    private val characterId: String? = null,
) : ViewModel() {

    data class UiState(
        val sessions: List<SessionPreview> = emptyList(),
        /** 初始即 true：投影起点为 LoadState.Loading，避免首帧误判 Empty（E-02） */
        val loading: Boolean = true,
        val offline: Boolean = false,
        /** 页面级加载错误：参与 [loadState] 投影（E-02）；刷新开始时清空 */
        val pageError: CompanionError? = null,
        /** 动作级错误（删除/重命名/新建失败）：不参与页面 LoadState 投影 */
        val error: CompanionError? = null,
        val connection: WsClient.State = WsClient.State.DISCONNECTED,
        /** 排序模式：updated = 按时间（最近优先）｜name = 按角色名称 */
        val sortMode: String = "updated",
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    /**
     * E-02 统一异步页面状态：loading/pageError/sessions → LoadState 五态投影
     * （纯函数 [projectSessionsLoadState]，全局会话页与角色历史会话页共用）。
     * Screen 只需 `when (loadState)` 分发到 Qy 组件，不再手写状态 if/else。
     */
    val loadState: StateFlow<LoadState<List<SessionPreview>>> = _ui
        .map { state -> projectSessionsLoadState(state) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, LoadState.Loading)

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
            _ui.update { it.copy(loading = true, pageError = null) }
            try {
                val sessions = repository.listSessions()
                    .let { all ->
                        if (characterId != null) all.filter { it.characterId == characterId } else all
                    }
                    .filter { it.messageCount > 0 } // 无消息空会话不显示（PC 端历史遗留空壳）
                    .let { applySort(it) }
                _ui.update { it.copy(sessions = sessions, loading = false, offline = false, pageError = null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val err = e.toCompanionError()
                val cached = applySort(
                    repository.listCachedSessions().filter { it.messageCount > 0 } // 缓存同样过滤空会话
                )
                _ui.update {
                    it.copy(
                        sessions = cached,
                        loading = false,
                        offline = true,
                        pageError = err,
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
                _ui.update { it.copy(error = e.toCompanionError()) }
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
                    _ui.update { it.copy(error = e.toCompanionError()) }
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
                _ui.update { it.copy(error = e.toCompanionError()) }
            }
            refresh()
        }
    }
}

/**
 * 会话列表 LoadState 投影（纯函数，JVM 单测覆盖）：非空会话列表即「有内容」。
 * 网络类错误 + 缓存列表 → Offline（只读）；其他错误即使有缓存也走 Error。
 * 供 [SessionsViewModel.loadState] 使用（全局会话页与角色历史会话页共用）。
 */
internal fun projectSessionsLoadState(state: SessionsViewModel.UiState): LoadState<List<SessionPreview>> =
    projectLoadState(
        loading = state.loading,
        error = state.pageError,
        data = state.sessions,
        hasContent = { it.isNotEmpty() },
    )
