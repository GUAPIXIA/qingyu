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
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.R
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.data.userMessage
import com.qingyu.companion.model.UsageSummary
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.LoadState
import com.qingyu.companion.ui.components.QyEmptyState
import com.qingyu.companion.ui.components.QyErrorBanner
import com.qingyu.companion.ui.components.QyOfflineBanner
import com.qingyu.companion.ui.components.QySkeletonList
import com.qingyu.companion.ui.components.rememberSkeletonVisible
import com.qingyu.companion.ui.theme.qyColors
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 用量统计页（阶段三只读：今日/累计汇总 + 最近记录）。
 * E-02：页面状态统一由 [UsageViewModel.loadState]（LoadState 五态）驱动，
 * 渲染走 ui/components/AsyncStates.kt 的 Qy 组件（骨架/空态/离线/错误）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UsageScreen(onBack: () -> Unit) {
    val qy = qyColors()
    val container = LocalAppContainer.current
    val vm: UsageViewModel = viewModel(factory = viewModelFactory {
        initializer { UsageViewModel(container.repository) }
    })
    val loadState by vm.loadState.collectAsStateWithLifecycle()
    val skeletonVisible = rememberSkeletonVisible(loadState is LoadState.Loading)

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            AppTopBar(
                title = stringResource(R.string.usage_title),
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.cd_back))
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
                when (val st = loadState) {
                    is LoadState.Loading -> {
                        if (skeletonVisible) {
                            QySkeletonList(
                                modifier = Modifier
                                    .fillMaxSize()
                                    .padding(12.dp),
                                rows = 2,
                                rowHeight = 96.dp,
                            )
                        }
                    }

                    is LoadState.Empty -> {
                        QyEmptyState(
                            title = stringResource(R.string.usage_empty),
                            actionLabel = stringResource(R.string.action_retry),
                            onAction = vm::refresh,
                            modifier = Modifier.fillMaxSize(),
                        )
                    }

                    is LoadState.Error -> {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            QyErrorBanner(
                                message = st.error.userMessage(),
                                retryable = st.retryable,
                                onRetry = vm::refresh,
                                modifier = Modifier.padding(horizontal = 16.dp),
                            )
                        }
                    }

                    is LoadState.Offline -> {
                        Column(Modifier.fillMaxSize()) {
                            QyOfflineBanner(
                                onRetry = vm::refresh,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                            )
                            UsageList(st.cached, vm::format)
                        }
                    }

                    is LoadState.Content -> {
                        UsageList(st.data, vm::format)
                    }
                }
            }
        }
    }
}

/** 用量内容渲染（Content / Offline 共用）：汇总卡 + 最近记录 */
@Composable
private fun UsageList(data: UsageViewModel.UsageData, format: (Long) -> String) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        contentPadding = PaddingValues(12.dp),
    ) {
        item { SummaryCard(stringResource(R.string.usage_today), data.today) }
        item { SummaryCard(stringResource(R.string.usage_total), data.total) }
        item {
            Text(
                stringResource(R.string.usage_recent_records),
                style = MaterialTheme.typography.titleMedium,
                color = qyColors().text,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        if (data.records.isEmpty()) {
            item {
                Text(
                    stringResource(R.string.usage_no_records),
                    style = MaterialTheme.typography.bodySmall,
                    color = qyColors().muted,
                )
            }
        } else {
            items(data.records, key = { it.id }) { record ->
                RecordRow(record, format)
            }
        }
    }
}

@Composable
private fun SummaryCard(label: String, summary: UsageSummary?) {
    val qy = qyColors()
    if (summary == null) return
    Surface(
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
                stringResource(
                    R.string.usage_summary_desc,
                    String.format(Locale.getDefault(), "%,d", summary.totalChars),
                    String.format(Locale.getDefault(), "%,d", summary.totalInput),
                    String.format(Locale.getDefault(), "%,d", summary.totalOutput),
                    summary.count,
                ),
                style = MaterialTheme.typography.bodySmall,
                color = qy.soft,
            )
        }
    }
}

@Composable
private fun RecordRow(record: com.qingyu.companion.model.UsageRecordDto, format: (Long) -> String) {
    val qy = qyColors()
    Surface(
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
                    stringResource(R.string.usage_record_total, format(record.totalChars.toLong())),
                    style = MaterialTheme.typography.labelSmall,
                    color = qy.muted,
                )
            }
        }
    }
}

private fun formatTime(epochMs: Long): String =
    SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(epochMs))
