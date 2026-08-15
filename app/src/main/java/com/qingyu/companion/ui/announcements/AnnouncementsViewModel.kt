package com.qingyu.companion.ui.announcements

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.model.Announcement
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 公告 ViewModel（阶段三：公告同步，走 PC 侧公告服务器 + 缓存回退）。
 */
class AnnouncementsViewModel(
    private val repository: ChatRepository,
) : ViewModel() {

    data class UiState(
        val items: List<Announcement> = emptyList(),
        val loading: Boolean = false,
        val error: String? = null,
        /** 展开详情的公告 id（其余折叠） */
        val expandedId: Int? = null,
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, error = null) }
            runCatching { repository.listAnnouncements() }
                .onSuccess { page ->
                    _ui.update { it.copy(items = page.items, loading = false) }
                }
                .onFailure { e ->
                    _ui.update { it.copy(loading = false, error = e.message ?: "加载公告失败") }
                }
        }
    }

    fun toggle(id: Int) {
        _ui.update { it.copy(expandedId = if (it.expandedId == id) null else id) }
    }
}
