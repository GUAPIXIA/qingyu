package com.qingyu.companion.ui.usage

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.local.db.LocalUsageRecordEntity
import com.qingyu.companion.local.db.UsageAggregateRow
import com.qingyu.companion.local.domain.UsageClearResult
import com.qingyu.companion.local.domain.UsageStats
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.QyEmptyState
import com.qingyu.companion.ui.components.QyErrorBanner
import com.qingyu.companion.ui.content.EditorNote
import java.util.Locale

/**
 * 阶段 5 S5-07：用量分析（本地库聚合 + 因果清理）。
 *
 * 这是**新增的第二屏**，没有改写只读的 [UsageScreen]：那一屏的数据来自
 * `ChatRepository`（PC/Relay 通道），这一屏直接读本地 `local_usage_records`。
 * 合并会让「同一个数字有两个来源」变成常态，而清理动作只对本地库成立。
 *
 * 维度切换全部在 SQL 里完成（`store.usageAggregate` 按维度分支固定查询），
 * 页面只负责把 `group_key` 翻成人能读的名字。
 */
@Composable
fun UsageInsightsScreen(onBack: () -> Unit) {
    // 容器必须在组合期取出：viewModelFactory 的 initializer 运行在组合之外，读不到 CompositionLocal
    val appContainer = LocalAppContainer.current
    val vm: UsageInsightsViewModel = viewModel(factory = viewModelFactory {
        initializer { UsageInsightsViewModel(appContainer.localSyncRepository) }
    })
    val ui by vm.ui.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            AppTopBar(
                title = "用量分析",
                subtitle = "本机 ${formatCount(ui.totalRecords.toLong())} 条记录",
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            ui.error?.let { QyErrorBanner(message = it, onRetry = vm::refresh) }
            ui.clearResult?.let { result -> ClearResultNote(result) }
            LazyColumn(
                contentPadding = PaddingValues(top = 8.dp, bottom = 32.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                item {
                    Column(Modifier.padding(horizontal = 16.dp)) {
                        ChipRow(
                            label = "区间",
                            options = UsageInsightsViewModel.RANGES.map { range -> range to vm.rangeLabel(range) },
                            selected = { token -> ui.range == token },
                            onSelect = vm::selectRange,
                        )
                        ChipRow(
                            label = "任务类型",
                            options = UsageInsightsViewModel.TASK_TYPES,
                            selected = { token -> ui.taskType == token },
                            onSelect = vm::selectTaskType,
                        )
                        ChipRow(
                            label = "统计维度",
                            options = UsageInsightsViewModel.DIMENSIONS,
                            selected = { token -> ui.dimension == token },
                            onSelect = vm::selectDimension,
                        )
                    }
                }
                item { ui.totals?.let { totals -> SummaryBlock(totals) } }
                item {
                    Text(
                        "按维度分组（按输出字符倒序）",
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
                if (ui.aggregate.isEmpty() && !ui.loading) {
                    item {
                        QyEmptyState(
                            title = "这个区间没有用量",
                            description = "换一个区间或任务类型；只有真正发起过生成的调用才会入库",
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                // 两段共用一个 LazyColumn，键加前缀避免维度键与记录 id 撞在同一个命名空间里
                items(ui.aggregate, key = { row -> "agg-${row.group_key}" }) { row ->
                    AggregateRow(label = vm.labelOf(row), row = row, share = vm.shareOf(row))
                }
                item {
                    HorizontalDivider(Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
                    Text(
                        "区间内最近 ${ui.records.size} 条记录",
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.padding(horizontal = 16.dp),
                    )
                }
                items(ui.records, key = { record -> "rec-${record.id}" }) { record ->
                    RecordLine(record)
                }
                item {
                    ClearSection(
                        markerText = vm.markerText(ui.marker),
                        totalRecords = ui.totalRecords,
                        busy = ui.busy || ui.loading,
                        onClear = vm::inspectClear,
                    )
                }
            }
        }
    }

    ui.clearPreview?.let { preview ->
        AlertDialog(
            onDismissRequest = vm::cancelClear,
            title = { Text("清空用量记录？") },
            text = {
                Column {
                    Text(
                        "本次枚举了 ${preview.enumerated} 条记录的版本头，将清除 ${preview.willClear} 条" +
                            "（全库 ${ui.totalRecords} 条），保留 ${preview.willRetain} 条。",
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "保留的是清理游标没有覆盖的记录：并发期间新写入的、" +
                            "以及读不到版本头、无法证明被支配的（本次 ${preview.unreadableHeads} 条）。" +
                            "「按时间整段删除」会把别人刚产生的事件一起抹掉，而对端日志里那些事件还在——" +
                            "这正是已清理记录又被带回的成因。",
                    )
                    if (preview.truncated) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "注意：记录数超过本次枚举上限 ${UsageInsightsViewModel.ENUMERATE_CAP} 条，" +
                                "未枚举的部分不会进游标；实际清除数以执行后的回执为准。",
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "确认后会写一条 usage_clear_marker（${preview.clearedThrough.size} 个设备分量）" +
                            "并把被它支配的记录逐条记为删除。",
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = vm::confirmClear) { Text("清除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = vm::cancelClear) { Text("取消") } },
        )
    }
}

/** 通用一维选择行；`selected` 是纯比较，不参与重组决策。 */
@Composable
private fun <T> ChipRow(
    label: String,
    options: List<Pair<T, String>>,
    selected: (T) -> Boolean,
    onSelect: (T) -> Unit,
) {
    Column(Modifier.padding(vertical = 4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            options.forEach { (token, text) ->
                FilterChip(selected = selected(token), onClick = { onSelect(token) }, label = { Text(text) })
            }
        }
    }
}

@Composable
private fun SummaryBlock(totals: UsageStats) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(
                formatCount(totals.totalChars),
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                "输入 ${formatCount(totals.totalInput)} · 输出 ${formatCount(totals.totalOutput)} · " +
                    "${totals.count} 条记录（可见字符，与 PC getSummary 同口径）",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            EditorNote(UsageInsightsViewModel.STATS_SCOPE_NOTE)
        }
    }
}

@Composable
private fun AggregateRow(label: String, row: UsageAggregateRow, share: Float) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                label,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(
                "${row.records} 条 · ↑${formatCount(row.input_chars)} ↓${formatCount(row.output_chars)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.height(4.dp))
        // 占比条用普通盒子：进度条组件带「任务完成度」语义，这里是组间份额
        Box(
            Modifier
                .fillMaxWidth()
                .height(6.dp)
                .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(3.dp)),
        ) {
            Box(
                Modifier
                    .fillMaxWidth(share.coerceIn(0f, 1f))
                    .fillMaxHeight()
                    .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(3.dp)),
            )
        }
        Text(
            "token：提示 ${formatCount(row.prompt_tokens)} · 补全 ${formatCount(row.completion_tokens)}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun RecordLine(record: LocalUsageRecordEntity) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                "${record.model.ifBlank { "(未知模型)" }} · ${record.taskType}",
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "${record.dateKey.ifBlank { "-" }} · ${record.provider.ifBlank { "-" }} · ${record.status}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            "↑${formatCount(record.inputChars.toLong())} ↓${formatCount(record.outputChars.toLong())}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.primary,
        )
    }
}

@Composable
private fun ClearSection(markerText: String, totalRecords: Int, busy: Boolean, onClear: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text("清理与同步语义", style = MaterialTheme.typography.titleSmall)
        EditorNote("当前清理游标：$markerText")
        EditorNote(
            "用量记录以事件 id 去重；清空不是「删表」，而是产生 usage_clear_marker，" +
                "并把已被该游标因果支配的记录逐条记为删除，旧设备因此不会把已清理事件重新带回。",
        )
        EditorNote("本机共 $totalRecords 条记录；删除标记与批量 tombstone 在仓储的同一事务里完成。")
        Spacer(Modifier.height(6.dp))
        Button(onClick = onClear, enabled = !busy && totalRecords > 0, modifier = Modifier.fillMaxWidth()) {
            Text("查看清理影响范围")
        }
    }
}

@Composable
private fun ClearResultNote(result: UsageClearResult) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.secondaryContainer,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "已清除 ${result.clearedIds.size} 条，保留 ${result.retainedIds.size} 条。",
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f),
            )
            if (result.retainedIds.isNotEmpty()) {
                Text(
                    "保留项为并发或游标未覆盖的事件",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

private fun formatCount(value: Long): String = String.format(Locale.getDefault(), "%,d", value)
