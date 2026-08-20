package com.qingyu.companion.ui.usage

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.model.UsageSummary
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.theme.qyColors
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 用量统计页（阶段三只读：今日/累计汇总 + 最近记录）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UsageScreen(onBack: () -> Unit) {
    val qy = qyColors()
    val container = LocalAppContainer.current
    val vm: UsageViewModel = viewModel(factory = viewModelFactory {
        initializer { UsageViewModel(container.repository) }
    })
    val ui by vm.ui.collectAsStateWithLifecycle()

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            AppTopBar(
                title = "用量统计",
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        AppBackground {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            when {
                ui.loading && ui.total == null ->
                    CircularProgressIndicator(Modifier.align(Alignment.Center), color = qy.accent)

                ui.total == null -> Text(
                    ui.error ?: "暂无用量数据（PC 侧未开启用量统计或未连接）",
                    modifier = Modifier.align(Alignment.Center),
                    color = qy.soft,
                )

                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
                ) {
                    item { SummaryCard("今日", ui.today) }
                    item { SummaryCard("累计", ui.total) }
                    item {
                        Text(
                            "最近记录",
                            style = MaterialTheme.typography.titleMedium,
                            color = qy.text,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                    if (ui.records.isEmpty()) {
                        item {
                            Text(
                                "暂无记录",
                                style = MaterialTheme.typography.bodySmall,
                                color = qy.muted,
                            )
                        }
                    } else {
                        items(ui.records, key = { it.id }) { record ->
                            RecordRow(record, vm::format)
                        }
                    }
                }
            }
        }
        }
    }
}

@Composable
private fun SummaryCard(label: String, summary: UsageSummary?) {
    val qy = qyColors()
    if (summary == null) return
    androidx.compose.material3.Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        color = qy.card,
        border = androidx.compose.foundation.BorderStroke(1.dp, qy.line),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(label, style = MaterialTheme.typography.labelLarge, color = qy.muted)
            Text(
                String.format(Locale.getDefault(), "%,d", summary.totalChars),
                style = MaterialTheme.typography.headlineMedium,
                color = qy.accent,
            )
            Text(
                "总字符 · 输入 ${String.format(Locale.getDefault(), "%,d", summary.totalInput)} · 输出 ${String.format(Locale.getDefault(), "%,d", summary.totalOutput)} · 共 ${summary.count} 次对话",
                style = MaterialTheme.typography.bodySmall,
                color = qy.soft,
            )
        }
    }
}

@Composable
private fun RecordRow(record: com.qingyu.companion.model.UsageRecordDto, format: (Long) -> String) {
    val qy = qyColors()
    androidx.compose.material3.Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        color = qy.bg2,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    record.model,
                    style = MaterialTheme.typography.bodyMedium,
                    color = qy.text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${formatTime(record.timestamp)} · ${record.characterId.take(8)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = qy.muted,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    "↑${format(record.inputChars.toLong())} ↓${format(record.outputChars.toLong())}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = qy.accent,
                )
                Text(
                    "共 ${format(record.totalChars.toLong())} 字符",
                    style = MaterialTheme.typography.labelSmall,
                    color = qy.muted,
                )
            }
        }
    }
}

private fun formatTime(epochMs: Long): String =
    SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(epochMs))
