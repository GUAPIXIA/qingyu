package com.qingyu.companion.ui.announcements

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.data.toCompanionError
import com.qingyu.companion.model.Announcement
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
 * 公告 ViewModel（阶段三：公告同步，走 PC 侧公告服务器 + 缓存回退）。
 *
 * E-02：页面渲染统一消费 [loadState]（LoadState 投影，纯函数 [projectAnnouncementsLoadState]）。
 * 公告页无本地缓存（repository 无公告缓存回退），失败且无上次数据 → Error；
 * 已有上次列表再遇网络类失败 → Offline（展示上次列表 + 离线横幅）。
 */
class AnnouncementsViewModel(
    private val repository: ChatRepository,
) : ViewModel() {

    data class UiState(
        val items: List<Announcement> = emptyList(),
        /** 初始即 true：投影起点为 LoadState.Loading，避免首帧误判 Empty（E-02） */
        val loading: Boolean = true,
        /** 页面级加载错误：参与 [loadState] 投影（E-02）；刷新开始时清空 */
        val pageError: CompanionError? = null,
        /** 展开详情的公告 id（其余折叠） */
        val expandedId: Int? = null,
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    /**
     * E-02 统一异步页面状态：loading/pageError/items → LoadState 五态投影。
     * Screen 只需 `when (loadState)` 分发到 Qy 组件，不再手写状态 if/else。
     */
    val loadState: StateFlow<LoadState<List<Announcement>>> = _ui
        .map { state -> projectAnnouncementsLoadState(state.loading, state.pageError, state.items) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, LoadState.Loading)

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, pageError = null) }
            try {
                val page = repository.listAnnouncements()
                _ui.update { it.copy(items = page.items, loading = false, pageError = null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update { it.copy(loading = false, pageError = e.toCompanionError()) }
            }
        }
    }

    fun toggle(id: Int) {
        _ui.update { it.copy(expandedId = if (it.expandedId == id) null else id) }
    }
}

/**
 * 公告页 LoadState 投影（纯函数，JVM 单测覆盖）：非空列表即「有内容」。
 */
internal fun projectAnnouncementsLoadState(
    loading: Boolean,
    error: CompanionError?,
    items: List<Announcement>,
): LoadState<List<Announcement>> = projectLoadState(
    loading = loading,
    error = error,
    data = items,
    hasContent = { it.isNotEmpty() },
)
