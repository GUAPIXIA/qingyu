package com.qingyu.companion.ui.announcements

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.R
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.data.userMessage
import com.qingyu.companion.model.Announcement
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.LoadState
import com.qingyu.companion.ui.components.MarkdownText
import com.qingyu.companion.ui.components.QyEmptyState
import com.qingyu.companion.ui.components.QyErrorBanner
import com.qingyu.companion.ui.components.QyOfflineBanner
import com.qingyu.companion.ui.components.QySkeletonList
import com.qingyu.companion.ui.components.rememberSkeletonVisible
import com.qingyu.companion.ui.theme.qyColors

/**
 * 公告页（阶段三：列表 + 点击展开详情，内容 Markdown 渲染）。
 * E-02：页面状态统一由 [AnnouncementsViewModel.loadState]（LoadState 五态）驱动，
 * 渲染走 ui/components/AsyncStates.kt 的 Qy 组件（骨架/空态/离线/错误）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AnnouncementsScreen(onBack: () -> Unit) {
    val qy = qyColors()
    val container = LocalAppContainer.current
    val vm: AnnouncementsViewModel = viewModel(factory = viewModelFactory {
        initializer { AnnouncementsViewModel(container.repository) }
    })
    val loadState by vm.loadState.collectAsStateWithLifecycle()
    val ui by vm.ui.collectAsStateWithLifecycle()
    val skeletonVisible = rememberSkeletonVisible(loadState is LoadState.Loading)

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            AppTopBar(
                title = stringResource(R.string.announcements_title),
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
                                rows = 4,
                            )
                        }
                    }

                    is LoadState.Empty -> {
                        QyEmptyState(
                            title = stringResource(R.string.announcements_empty),
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
                            AnnouncementList(st.cached, ui.expandedId, vm::toggle)
                        }
                    }

                    is LoadState.Content -> {
                        AnnouncementList(st.data, ui.expandedId, vm::toggle)
                    }
                }
            }
        }
    }
}

/** 公告列表渲染（Content / Offline 共用）：点击行展开/收起详情 */
@Composable
private fun AnnouncementList(
    items: List<Announcement>,
    expandedId: Int?,
    onToggle: (Int) -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        contentPadding = PaddingValues(12.dp),
    ) {
        items(items, key = { it.id }) { announcement ->
            AnnouncementRow(
                announcement = announcement,
                expanded = expandedId == announcement.id,
                onClick = { onToggle(announcement.id) },
            )
        }
    }
}

@Composable
private fun AnnouncementRow(
    announcement: Announcement,
    expanded: Boolean,
    onClick: () -> Unit,
) {
    val qy = qyColors()
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(14.dp),
        color = qy.bg2,
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(qy.accent)
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    announcement.title,
                    style = MaterialTheme.typography.titleMedium,
                    color = qy.text,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    announcement.createdAt,
                    style = MaterialTheme.typography.labelSmall,
                    color = qy.muted,
                )
            }
            if (expanded) {
                MarkdownText(
                    announcement.content,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        }
    }
}
