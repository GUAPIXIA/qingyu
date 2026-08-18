package com.qingyu.companion.ui.usage

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.model.UsageRecordDto
import com.qingyu.companion.model.UsageSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 用量统计 ViewModel（阶段三：安卓端只读查看，方案 §7）。
 * PC 为唯一数据源（usage.json），安卓端仅拉取汇总与最近记录。
 */
class UsageViewModel(
    private val repository: ChatRepository,
) : ViewModel() {

    data class UiState(
        val today: UsageSummary? = null,
        val total: UsageSummary? = null,
        val records: List<UsageRecordDto> = emptyList(),
        val loading: Boolean = false,
        val error: String? = null,
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, error = null) }
            runCatching {
                val summary = repository.usageSummary()
                val records = repository.usageRecords(limit = 20)
                summary to records
            }.onSuccess { (summary, records) ->
                _ui.update {
                    it.copy(today = summary.today, total = summary.total, records = records, loading = false)
                }
            }.onFailure { e ->
                _ui.update { it.copy(loading = false, error = e.message ?: "加载用量失败") }
            }
        }
    }

    /** 千分位格式化 */
    fun format(n: Long): String = String.format("%,d", n)
}
