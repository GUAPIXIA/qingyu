package com.qingyu.companion.ui.groups

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
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
import com.qingyu.companion.model.GroupSession
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.AvatarBubble
import com.qingyu.companion.ui.components.LoadState
import com.qingyu.companion.ui.components.QyEmptyState
import com.qingyu.companion.ui.components.QyErrorBanner
import com.qingyu.companion.ui.components.QyOfflineBanner
import com.qingyu.companion.ui.components.QySkeletonList
import com.qingyu.companion.ui.components.rememberSkeletonVisible
import com.qingyu.companion.ui.theme.qyColors

/**
 * 群聊列表页（阶段二：群列表 → 群会话列表）。
 * E-02：页面状态统一由 [GroupsViewModel.loadState]（LoadState 五态）驱动，
 * 渲染走 ui/components/AsyncStates.kt 的 Qy 组件（骨架/空态/离线/错误）；
 * 群会话子列表加载用骨架屏，新建群聊等交互保持不变。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GroupsScreen(
    onOpenGroupChat: (groupId: String, groupName: String, sessionId: String) -> Unit,
    onBack: () -> Unit,
) {
    val qy = qyColors()
    val container = LocalAppContainer.current
    val vm: GroupsViewModel = viewModel(factory = viewModelFactory {
        initializer { GroupsViewModel(container.repository) }
    })
    val ui by vm.ui.collectAsStateWithLifecycle()
    val loadState by vm.loadState.collectAsStateWithLifecycle()
    val skeletonVisible = rememberSkeletonVisible(loadState is LoadState.Loading)
    val selectedGroup = remember(ui.selectedGroupId, ui.groups) {
        ui.groups.firstOrNull { it.id == ui.selectedGroupId }
    }
    // 新建群聊对话框：名称与选中成员（纯 UI 输入态）
    var showCreate by remember { mutableStateOf(false) }
    var newGroupName by remember { mutableStateOf("") }
    var selectedMemberIds by remember { mutableStateOf<Set<String>>(emptySet()) }

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            AppTopBar(
                title = selectedGroup?.name ?: stringResource(R.string.groups_title),
                navigationIcon = {
                    IconButton(onClick = { if (selectedGroup == null) onBack() else vm.backToGroups() }) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.cd_back),
                            tint = qy.soft,
                        )
                    }
                },
                actions = {
                    if (selectedGroup == null) {
                        TextButton(onClick = {
                            showCreate = true
                            newGroupName = ""
                            selectedMemberIds = emptySet()
                            vm.prepareCreateDialog()
                        }) {
                            Text(stringResource(R.string.groups_create_action), style = MaterialTheme.typography.labelLarge, color = qy.accent)
                        }
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
                    // E-02：群列表层五态分发（Loading 骨架 / Empty 空态 / Offline 横幅+缓存 / Error 横幅+重试 / Content 列表）
                    selectedGroup == null -> when (val st = loadState) {
                        is LoadState.Loading -> {
                            if (skeletonVisible) {
                                QySkeletonList(
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .padding(16.dp),
                                    rows = 4,
                                )
                            }
                        }

                        is LoadState.Empty -> {
                            QyEmptyState(
                                title = stringResource(R.string.groups_empty),
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
                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                                )
                                GroupList(st.cached, onOpenGroup = vm::openGroup)
                            }
                        }

                        is LoadState.Content -> {
                            GroupList(st.data, onOpenGroup = vm::openGroup)
                        }
                    }

                    // 群会话列表层
                    else -> {
                        if (ui.sessionsLoading) {
                            QySkeletonList(
                                modifier = Modifier
                                    .fillMaxSize()
                                    .padding(16.dp),
                                rows = 3,
                            )
                        } else if (ui.groupSessions.isEmpty()) {
                            QyEmptyState(
                                title = stringResource(R.string.groups_sessions_empty),
                                actionLabel = stringResource(R.string.action_retry),
                                onAction = { vm.openGroup(selectedGroup.id) },
                                modifier = Modifier.fillMaxSize(),
                            )
                        } else {
                            GroupSessionList(
                                sessions = ui.groupSessions,
                                onOpenSession = { session ->
                                    onOpenGroupChat(selectedGroup.id, selectedGroup.name, session.id)
                                },
                            )
                        }
                    }
                }
            }
        }
    }

    // 新建群聊对话框
    if (showCreate) {
        AlertDialog(
            onDismissRequest = {
                if (!ui.creating) {
                    showCreate = false
                    vm.clearActionError()
                }
            },
            containerColor = qy.card,
            title = { Text(stringResource(R.string.title_new_group), color = qy.text) },
            text = {
                Column {
                    OutlinedTextField(
                        value = newGroupName,
                        onValueChange = { newGroupName = it.take(30) },
                        label = { Text(stringResource(R.string.title_group_name_empty)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedTextColor = qy.text,
                            focusedBorderColor = qy.accent,
                            unfocusedBorderColor = qy.line,
                            focusedContainerColor = qy.bg2,
                            cursorColor = qy.accent,
                        ),
                    )
                    Spacer(Modifier.height(10.dp))
                    Text(
                        stringResource(R.string.groups_select_members),
                        style = MaterialTheme.typography.labelMedium,
                        color = qy.soft,
                    )
                    if (ui.allCharacters.isEmpty()) {
                        Text(
                            stringResource(R.string.characters_empty),
                            style = MaterialTheme.typography.bodySmall,
                            color = qy.soft,
                        )
                    } else {
                        LazyColumn(Modifier.heightIn(max = 240.dp)) {
                            items(ui.allCharacters, key = { it.id }) { c ->
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .clickable {
                                            selectedMemberIds = if (c.id in selectedMemberIds) {
                                                selectedMemberIds - c.id
                                            } else {
                                                selectedMemberIds + c.id
                                            }
                                        }
                                        .padding(vertical = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Checkbox(
                                        checked = c.id in selectedMemberIds,
                                        onCheckedChange = { chk ->
                                            selectedMemberIds = if (chk) selectedMemberIds + c.id else selectedMemberIds - c.id
                                        },
                                    )
                                    Text(
                                        c.name,
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = qy.text,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }
                    // 创建失败（动作级错误，不参与页面 LoadState 投影）
                    ui.actionError?.let { err ->
                        Spacer(Modifier.height(8.dp))
                        QyErrorBanner(
                            message = err.userMessage(),
                            onRetry = null,
                            retryable = false,
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        if (ui.creating || selectedMemberIds.isEmpty()) return@TextButton
                        vm.createGroup(newGroupName.ifBlank { null }, selectedMemberIds.toList()) {
                            showCreate = false
                        }
                    },
                    enabled = selectedMemberIds.isNotEmpty() && !ui.creating,
                ) {
                    if (ui.creating) {
                        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = qy.accent)
                    } else {
                        Text(stringResource(R.string.action_create), color = qy.accent)
                    }
                }
            },
            dismissButton = {
                TextButton(onClick = {
                    if (!ui.creating) {
                        showCreate = false
                        vm.clearActionError()
                    }
                }) { Text(stringResource(R.string.action_cancel), color = qy.soft) }
            },
        )
    }
}

/**
 * 群列表渲染（Content / Offline 共用）：方案 B bg2 圆角 14 行 + accentSoft 胶囊。
 */
@Composable
private fun GroupList(groups: List<com.qingyu.companion.model.GroupChat>, onOpenGroup: (String) -> Unit) {
    val qy = qyColors()
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(groups, key = { it.id }) { group ->
            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onOpenGroup(group.id) },
                shape = RoundedCornerShape(14.dp),
                color = qy.bg2,
            ) {
                Row(
                    modifier = Modifier.padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AvatarBubble(name = group.name, size = 44)
                    Column(
                        Modifier
                            .weight(1f)
                            .padding(start = 12.dp)
                    ) {
                        Text(
                            group.name,
                            style = MaterialTheme.typography.titleMedium,
                            color = qy.text,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Spacer(Modifier.height(6.dp))
                        Surface(
                            shape = RoundedCornerShape(50),
                            color = qy.accentSoft,
                        ) {
                            Text(
                                stringResource(R.string.groups_member_count, group.memberIds.size),
                                style = MaterialTheme.typography.labelSmall,
                                color = qy.accent,
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 3.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * 群会话列表渲染：点击进入群聊会话。
 */
@Composable
private fun GroupSessionList(
    sessions: List<GroupSession>,
    onOpenSession: (GroupSession) -> Unit,
) {
    val qy = qyColors()
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(sessions, key = { it.id }) { session ->
            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onOpenSession(session) },
                shape = RoundedCornerShape(14.dp),
                color = qy.bg2,
            ) {
                Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
                    Text(
                        session.title,
                        style = MaterialTheme.typography.titleMedium,
                        color = qy.text,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.height(6.dp))
                    Surface(
                        shape = RoundedCornerShape(50),
                        color = qy.accentSoft,
                    ) {
                        Text(
                            stringResource(R.string.groups_message_count, session.messageCount),
                            style = MaterialTheme.typography.labelSmall,
                            color = qy.accent,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 3.dp),
                        )
                    }
                }
            }
        }
    }
}
