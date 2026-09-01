package com.qingyu.companion.ui.usage

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.data.toCompanionError
import com.qingyu.companion.model.UsageRecordDto
import com.qingyu.companion.model.UsageSummary
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
 * 用量统计 ViewModel（阶段三：安卓端只读查看，方案 §7）。
 * PC 为唯一数据源（usage.json），安卓端仅拉取汇总与最近记录。
 *
 * E-02：页面渲染统一消费 [loadState]（LoadState 投影，纯函数 [projectUsageLoadState]）。
 * 用量页无本地缓存（repository 无 usage 缓存回退），失败且无上次数据 → Error；
 * 已有上次数据再遇网络类失败 → Offline（展示上次数据 + 离线横幅）。
 */
class UsageViewModel(
    private val repository: ChatRepository,
) : ViewModel() {

    /** 页面内容聚合：汇总（今日/累计）+ 最近记录 */
    data class UsageData(
        val today: UsageSummary? = null,
        val total: UsageSummary? = null,
        val records: List<UsageRecordDto> = emptyList(),
    )

    data class UiState(
        val data: UsageData = UsageData(),
        /** 初始即 true：投影起点为 LoadState.Loading，避免首帧误判 Empty（E-02） */
        val loading: Boolean = true,
        /** 页面级加载错误：参与 [loadState] 投影（E-02）；刷新开始时清空 */
        val pageError: CompanionError? = null,
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    /**
     * E-02 统一异步页面状态：loading/pageError/usage 数据 → LoadState 五态投影。
     * Screen 只需 `when (loadState)` 分发到 Qy 组件，不再手写状态 if/else。
     */
    val loadState: StateFlow<LoadState<UsageData>> = _ui
        .map { state -> projectUsageLoadState(state.loading, state.pageError, state.data) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, LoadState.Loading)

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, pageError = null) }
            try {
                val summary = repository.usageSummary()
                val records = repository.usageRecords(limit = 20)
                _ui.update {
                    it.copy(
                        data = UsageData(today = summary.today, total = summary.total, records = records),
                        loading = false,
                        pageError = null,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update { it.copy(loading = false, pageError = e.toCompanionError()) }
            }
        }
    }

    /** 千分位格式化 */
    fun format(n: Long): String = String.format(java.util.Locale.getDefault(), "%,d", n)
}

/**
 * 用量页 LoadState 投影（纯函数，JVM 单测覆盖）：
 * 「有内容」的判定 = 累计汇总存在（PC 侧开启用量统计的标志），records 可为空。
 */
internal fun projectUsageLoadState(
    loading: Boolean,
    error: CompanionError?,
    data: UsageViewModel.UsageData,
): LoadState<UsageViewModel.UsageData> = projectLoadState(
    loading = loading,
    error = error,
    data = data,
    hasContent = { it.total != null },
)
