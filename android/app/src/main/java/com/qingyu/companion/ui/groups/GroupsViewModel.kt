package com.qingyu.companion.ui.groups

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.data.toCompanionError
import com.qingyu.companion.model.Character
import com.qingyu.companion.model.GroupChat
import com.qingyu.companion.model.GroupSession
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
 * 群聊列表 ViewModel（阶段二：群列表 → 群会话列表）。
 *
 * E-02：页面渲染统一消费 [loadState]（LoadState 投影，纯函数 [projectGroupsLoadState]）；
 * [UiState.actionError] 为动作级错误（新建群聊失败等），不参与页面 LoadState 投影。
 * 群列表无本地缓存（repository 无群聊缓存回退），失败且无数据 → Error。
 */
class GroupsViewModel(
    private val repository: ChatRepository,
) : ViewModel() {

    data class UiState(
        val groups: List<GroupChat> = emptyList(),
        /** 初始即 true：投影起点为 LoadState.Loading，避免首帧误判 Empty（E-02） */
        val loading: Boolean = true,
        /** 页面级加载错误：参与 [loadState] 投影（E-02）；刷新开始时清空 */
        val pageError: CompanionError? = null,
        /** 当前选中的群（null = 群列表层） */
        val selectedGroupId: String? = null,
        /** 选中群的会话列表 */
        val groupSessions: List<GroupSession> = emptyList(),
        /** 群会话列表加载中 */
        val sessionsLoading: Boolean = false,
        /** 群成员名称映射（characterId -> name） */
        val memberNames: Map<String, String> = emptyMap(),
        /** 新建群聊对话框可选择的成员（全部角色） */
        val allCharacters: List<Character> = emptyList(),
        /** 正在创建群聊 */
        val creating: Boolean = false,
        /** 动作级错误（新建群聊失败等）：不参与页面 LoadState 投影 */
        val actionError: CompanionError? = null,
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    /**
     * E-02 统一异步页面状态：loading/pageError/groups → LoadState 五态投影。
     * Screen 只需 `when (loadState)` 分发到 Qy 组件，不再手写状态 if/else。
     */
    val loadState: StateFlow<LoadState<List<GroupChat>>> = _ui
        .map { state -> projectGroupsLoadState(state.loading, state.pageError, state.groups) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, LoadState.Loading)

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, pageError = null) }
            try {
                val groups = repository.listGroups()
                _ui.update { it.copy(groups = groups, loading = false, pageError = null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update { it.copy(loading = false, pageError = e.toCompanionError()) }
            }
        }
    }

    /** 选中群：加载该群会话与成员名（成员名供群会话页/后续展示使用） */
    fun openGroup(groupId: String) {
        _ui.update { it.copy(selectedGroupId = groupId, sessionsLoading = true, groupSessions = emptyList()) }
        viewModelScope.launch {
            try {
                val sessions = repository.listGroupSessions(groupId)
                _ui.update { it.copy(groupSessions = sessions) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // 会话列表加载失败：保持空列表（页面空态可重试），不打回群列表错误态
                _ui.update { it.copy(groupSessions = emptyList()) }
            }
            runCatching { repository.listCharacters() }
                .onSuccess { chars -> _ui.update { it.copy(memberNames = chars.associate { c -> c.id to c.name }) } }
            _ui.update { it.copy(sessionsLoading = false) }
        }
    }

    /** 返回群列表层（保留已加载群数据） */
    fun backToGroups() {
        _ui.update { it.copy(selectedGroupId = null) }
    }

    /** 打开新建群聊对话框时预加载可选择的成员（全部角色） */
    fun prepareCreateDialog() {
        viewModelScope.launch {
            runCatching { repository.listCharacters() }
                .onSuccess { chars -> _ui.update { it.copy(allCharacters = chars, actionError = null) } }
        }
    }

    /** 新建群聊；成功后刷新群列表并回调（UI 关闭对话框） */
    fun createGroup(name: String?, memberIds: List<String>, onSuccess: () -> Unit = {}) {
        if (_ui.value.creating) return
        viewModelScope.launch {
            _ui.update { it.copy(creating = true, actionError = null) }
            try {
                repository.createGroup(name, memberIds)
                _ui.update { it.copy(creating = false) }
                refresh()
                onSuccess()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update { it.copy(creating = false, actionError = e.toCompanionError()) }
            }
        }
    }

    fun clearActionError() = _ui.update { it.copy(actionError = null) }
}

/**
 * 群聊页 LoadState 投影（纯函数，JVM 单测覆盖）：非空群列表即「有内容」。
 */
internal fun projectGroupsLoadState(
    loading: Boolean,
    error: CompanionError?,
    groups: List<GroupChat>,
): LoadState<List<GroupChat>> = projectLoadState(
    loading = loading,
    error = error,
    data = groups,
    hasContent = { it.isNotEmpty() },
)
