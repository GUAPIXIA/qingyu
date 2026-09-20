package com.qingyu.companion.ui.usage

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.local.db.LocalUsageClearMarkerEntity
import com.qingyu.companion.local.db.LocalUsageRecordEntity
import com.qingyu.companion.local.db.UsageAggregateRow
import com.qingyu.companion.local.domain.CounterVectors
import com.qingyu.companion.local.domain.EntityTypes
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.local.domain.UsageClearResult
import com.qingyu.companion.local.domain.UsageDimension
import com.qingyu.companion.local.domain.UsageStats
import com.qingyu.companion.local.domain.VersionVectorJson
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 阶段 5 S5-07：用量分析与清理（本地库口径）。
 *
 * 与既存的 [UsageViewModel]（只读、走 `ChatRepository` 的 PC/Relay 通道）**并存**：
 * 那条路径服务伴侣模式，这里服务「Android 自己的用量记录」。两者数据源不同，
 * 合并成一个页面就会出现「同一个数字有两个来源、两个口径」，反而看不清。
 *
 * 清理不能写成「按时间删全部」（方案 §S5-07、总方案 §6.3）：
 * `store.clearUsage` 只清除被 [ClearPreview.clearedThrough] **因果支配**的记录，
 * 所以游标必须来自这些记录自己的版本头。这里逐条读 `entity_heads` 构造游标，
 * 读不到头的记录一律按保留处理——宁可少删，也不能把别人刚产生的事件抹掉。
 */
class UsageInsightsViewModel(
    private val store: LocalStore,
) : ViewModel() {

    /** 区间预设（UI token，不是 SQL）。 */
    enum class Range { ALL, TODAY, WEEK, MONTH }

    data class ClearPreview(
        /** 交给 `clearUsage` 的因果游标：本次枚举到的记录逐设备取最大值 */
        val clearedThrough: Map<String, String>,
        val willClear: Int,
        /** 预计保留：含游标未覆盖的并发记录、以及未枚举到的更老记录 */
        val willRetain: Int,
        /** 读不到版本头 / counter 非法：无法证明被支配，按保留处理 */
        val unreadableHeads: Int,
        /** 本次实际枚举了多少条（受 [ENUMERATE_CAP] 限制） */
        val enumerated: Int,
        /** 记录数超过枚举上限：实际清除数可能比预览更多（执行后以回执为准） */
        val truncated: Boolean,
    )

    data class UiState(
        val loading: Boolean = false,
        val busy: Boolean = false,
        val error: String? = null,
        val range: Range = Range.MONTH,
        val taskType: String = "",
        val dimension: UsageDimension = UsageDimension.MODEL,
        val totals: UsageStats? = null,
        val aggregate: List<UsageAggregateRow> = emptyList(),
        val records: List<LocalUsageRecordEntity> = emptyList(),
        val characterNames: Map<String, String> = emptyMap(),
        /** 全库用量条数（`localCounts` 口径，不受区间影响） */
        val totalRecords: Int = 0,
        val marker: LocalUsageClearMarkerEntity? = null,
        val clearPreview: ClearPreview? = null,
        val clearResult: UsageClearResult? = null,
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, error = null) }
            val (since, until) = rangeOf(_ui.value.range)
            val dimension = _ui.value.dimension
            val taskType = _ui.value.taskType
            runCatching {
                Snapshot(
                    totals = store.usageStats(since, until),
                    aggregate = store.usageAggregate(dimension, since, until, taskType),
                    records = store.listUsageInRange(since, until, RECENT_RECORDS),
                    marker = store.usageClearMarker(store.deviceId()),
                    totalRecords = store.localCounts().usageRecords,
                    characterNames = store.listCharacters().associate { row -> row.id to row.name.ifBlank { row.id } },
                )
            }.fold(
                onSuccess = { snap ->
                    _ui.update {
                        it.copy(
                            loading = false,
                            totals = snap.totals,
                            aggregate = snap.aggregate,
                            records = snap.records,
                            marker = snap.marker,
                            totalRecords = snap.totalRecords,
                            characterNames = snap.characterNames,
                        )
                    }
                },
                onFailure = { error -> _ui.update { it.copy(loading = false, error = error.message ?: "用量读取失败") } },
            )
        }
    }

    fun selectRange(range: Range) {
        if (_ui.value.range == range) return
        _ui.update { it.copy(range = range, clearPreview = null, clearResult = null) }
        refresh()
    }

    fun selectTaskType(taskType: String) {
        if (_ui.value.taskType == taskType) return
        _ui.update { it.copy(taskType = taskType, clearPreview = null, clearResult = null) }
        refresh()
    }

    fun selectDimension(dimension: UsageDimension) {
        if (_ui.value.dimension == dimension) return
        _ui.update { it.copy(dimension = dimension) }
        refresh()
    }

    /** 分组键的界面名：角色维度要翻成角色名，状态维度翻成中文，其余原样。 */
    fun labelOf(row: UsageAggregateRow): String {
        val key = row.group_key
        return when (_ui.value.dimension) {
            UsageDimension.CHARACTER -> when {
                key == null -> "（无角色归属）"
                else -> _ui.value.characterNames[key] ?: key
            }

            UsageDimension.STATUS -> when (key) {
                "success" -> "成功"
                "error" -> "失败"
                null -> "（未记录状态）"
                else -> key
            }

            UsageDimension.DATE -> key ?: "（缺少日期键）"
            UsageDimension.MODEL -> key?.ifBlank { "（空模型名）" } ?: "（无模型）"
            UsageDimension.PROVIDER -> key?.ifBlank { "（空提供方）" } ?: "（无提供方）"
        }
    }

    /** 分组占比（按输出字符）：用于条状图。总数为 0 时返回 0，不画出一条满格假数据。 */
    fun shareOf(row: UsageAggregateRow): Float {
        val total = _ui.value.aggregate.sumOf { it.output_chars }
        if (total <= 0L) return 0f
        return row.output_chars.toFloat() / total.toFloat()
    }

    // ------------------------------------------------------------ 清空用量

    /**
     * 先算游标再问用户：`clearUsage` 的语义是「删掉被这个向量支配的记录」，
     * 所以「将清除多少条」只能由同一套谓词算出来，不能拿区间条数糊过去。
     */
    fun inspectClear() {
        viewModelScope.launch {
            _ui.update { it.copy(busy = true, error = null, clearResult = null, clearPreview = null) }
            runCatching { buildClearPreview() }.fold(
                onSuccess = { preview -> _ui.update { it.copy(busy = false, clearPreview = preview) } },
                onFailure = { error -> _ui.update { it.copy(busy = false, error = error.message ?: "无法计算清理范围") } },
            )
        }
    }

    fun cancelClear() {
        _ui.update { it.copy(clearPreview = null) }
    }

    fun confirmClear() {
        val preview = _ui.value.clearPreview ?: return
        viewModelScope.launch {
            _ui.update { it.copy(busy = true, error = null) }
            runCatching { store.clearUsage(preview.clearedThrough) }.fold(
                onSuccess = { result ->
                    _ui.update { it.copy(busy = false, clearPreview = null, clearResult = result) }
                    refresh()
                },
                onFailure = { error ->
                    _ui.update {
                        it.copy(
                            busy = false,
                            clearPreview = null,
                            error = error.message ?: "清理失败（counter 非法时仓储会整段拒绝，不会半删）",
                        )
                    }
                },
            )
        }
    }

    private suspend fun buildClearPreview(): ClearPreview {
        val total = store.localCounts().usageRecords
        val scanned = store.listUsage(total.coerceAtMost(ENUMERATE_CAP))
        var clearedThrough: Map<String, String> = emptyMap()
        val versions = LinkedHashMap<String, Map<String, String>>()
        var unreadable = 0
        scanned.forEach { row ->
            val head = store.getHead(EntityTypes.USAGE_RECORD, row.id)
            val version = head?.let { runCatching { VersionVectorJson.decode(it.versionJson) }.getOrNull() }
            // 非法 counter 会让 merge 直接抛错：判给保留而不是让整次清理预览失败
            val usable = version?.takeIf { candidate ->
                candidate.isNotEmpty() && candidate.values.all { CounterVectors.isCanonical(it) }
            }
            if (usable == null) {
                unreadable += 1
            } else {
                versions[row.id] = usable
                clearedThrough = CounterVectors.merge(clearedThrough, usable)
            }
        }
        val willClear = versions.count { (_, version) -> CounterVectors.dominates(version, clearedThrough) }
        return ClearPreview(
            clearedThrough = clearedThrough,
            willClear = willClear,
            willRetain = (total - willClear).coerceAtLeast(0),
            unreadableHeads = unreadable,
            enumerated = scanned.size,
            truncated = total > scanned.size,
        )
    }

    /** 游标行的可读化展示（每设备一个 counter，十进制无符号串）。 */
    fun markerText(marker: LocalUsageClearMarkerEntity?): String {
        val json = marker?.clearedThroughJson ?: return "尚无清理记录"
        val vector = runCatching { VersionVectorJson.decode(json) }.getOrNull() ?: return "游标无法解析（保留原样）"
        if (vector.isEmpty()) return "尚无清理记录"
        return vector.entries.joinToString("、") { (device, counter) -> "${device.take(8)}… = $counter" }
    }

    fun rangeLabel(range: Range): String = when (range) {
        Range.ALL -> "全部"
        Range.TODAY -> "今天"
        Range.WEEK -> "近 7 天"
        Range.MONTH -> "近 30 天"
    }

    /** 区间端点：`usageStats` / `usageAggregate` 都是闭区间，全部用 0..Long.MAX_VALUE。 */
    private fun rangeOf(range: Range): Pair<Long, Long> {
        val now = System.currentTimeMillis()
        if (range == Range.ALL) return 0L to Long.MAX_VALUE
        val calendar = java.util.Calendar.getInstance().apply {
            timeInMillis = now
            set(java.util.Calendar.HOUR_OF_DAY, 0)
            set(java.util.Calendar.MINUTE, 0)
            set(java.util.Calendar.SECOND, 0)
            set(java.util.Calendar.MILLISECOND, 0)
        }
        val startOfDay = calendar.timeInMillis
        val since = when (range) {
            Range.TODAY -> startOfDay
            Range.WEEK -> startOfDay - 6L * DAY_MS
            Range.MONTH -> startOfDay - 29L * DAY_MS
            Range.ALL -> 0L
        }
        return since to now
    }

    private class Snapshot(
        val totals: UsageStats,
        val aggregate: List<UsageAggregateRow>,
        val records: List<LocalUsageRecordEntity>,
        val marker: LocalUsageClearMarkerEntity?,
        val totalRecords: Int,
        val characterNames: Map<String, String>,
    )

    companion object {
        /** 汇总只统计 `main`：仓储的 `usageStats` SQL 带 `task_type = 'main'`，界面必须说清。 */
        const val STATS_SCOPE_NOTE = "汇总卡只统计聊天任务（task_type=main）；记忆总结与翻译不计入。"

        const val DAY_MS = 86_400_000L

        /** 区间内最近记录条数（详情页级，不做分页：区间过滤已在 SQL 里）。 */
        const val RECENT_RECORDS = 60

        /**
         * 清理游标的枚举上限。
         *
         * 用量记录没有条数上限，而每条都要回读一次版本头（一次 IO 跳转 + 一次点查），
         * 所以枚举必须有界。超出上限的部分**不进游标**，因而不会被判定为被支配——
         * 少删是安全方向，把并发数据删掉才是事故；界面如实说明这是有界枚举。
         */
        const val ENUMERATE_CAP = 1_000

        val RANGES = Range.entries.toList()
        val DIMENSIONS = listOf(
            UsageDimension.MODEL to "模型",
            UsageDimension.PROVIDER to "提供方",
            UsageDimension.CHARACTER to "角色",
            UsageDimension.DATE to "日期",
            UsageDimension.STATUS to "成功/失败",
        )

        /** 任务类型候选：与仓库里真实写入了哪些 `task_type` 的值一致（空串 = 不限）。 */
        val TASK_TYPES = listOf(
            "" to "不限",
            "main" to "聊天",
            "memory" to "记忆总结",
            "translation" to "翻译",
        )
    }
}
