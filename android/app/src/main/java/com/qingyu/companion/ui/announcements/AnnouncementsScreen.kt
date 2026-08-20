package com.qingyu.companion.ui.announcements

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.model.Announcement
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.MarkdownText
import com.qingyu.companion.ui.theme.qyColors

/**
 * 公告页（阶段三：列表 + 点击展开详情，内容 Markdown 渲染）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AnnouncementsScreen(onBack: () -> Unit) {
    val qy = qyColors()
    val container = LocalAppContainer.current
    val vm: AnnouncementsViewModel = viewModel(factory = viewModelFactory {
        initializer { AnnouncementsViewModel(container.repository) }
    })
    val ui by vm.ui.collectAsStateWithLifecycle()

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            AppTopBar(
                title = "公告",
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
                ui.loading && ui.items.isEmpty() ->
                    CircularProgressIndicator(Modifier.align(Alignment.Center), color = qy.accent)

                ui.items.isEmpty() -> Text(
                    ui.error ?: "暂无公告",
                    modifier = Modifier.align(Alignment.Center),
                    color = qy.soft,
                )

                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
                ) {
                    items(ui.items, key = { it.id }) { announcement ->
                        AnnouncementRow(
                            announcement = announcement,
                            expanded = ui.expandedId == announcement.id,
                            onClick = { vm.toggle(announcement.id) },
                        )
                    }
                }
            }
        }
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
    androidx.compose.material3.Surface(
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
