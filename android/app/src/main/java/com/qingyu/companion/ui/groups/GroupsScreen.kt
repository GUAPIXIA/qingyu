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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.data.userMessage
import com.qingyu.companion.model.Character
import com.qingyu.companion.model.GroupChat
import com.qingyu.companion.model.GroupSession
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.AvatarBubble
import com.qingyu.companion.data.userMessage
import com.qingyu.companion.ui.theme.qyColors
import kotlinx.coroutines.launch

/**
 * 群聊列表页（阶段二：群列表 → 群会话列表）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GroupsScreen(
    onOpenGroupChat: (groupId: String, groupName: String, sessionId: String) -> Unit,
    onBack: () -> Unit,
) {
    val qy = qyColors()
    val container = LocalAppContainer.current
    val repository = container.repository
    val scope = rememberCoroutineScope()
    var groups by remember { mutableStateOf<List<GroupChat>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var selectedGroup by remember { mutableStateOf<GroupChat?>(null) }
    var groupSessions by remember { mutableStateOf<List<GroupSession>>(emptyList()) }
    var sessionsLoading by remember { mutableStateOf(false) }
    var memberNames by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    // 新建群聊状态
    var showCreate by remember { mutableStateOf(false) }
    var newGroupName by remember { mutableStateOf("") }
    var allCharacters by remember { mutableStateOf<List<Character>>(emptyList()) }
    var selectedMemberIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var creating by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        runCatching { repository.listGroups() }
            .onSuccess { groups = it; loading = false }
            .onFailure { e ->
                val msg = if (e is CompanionError) e.userMessage() else e.message ?: "加载群聊失败"
                error = msg; loading = false
            }
    }

    // 选中群后加载会话与成员名
    LaunchedEffect(selectedGroup?.id) {
        val g = selectedGroup ?: return@LaunchedEffect
        sessionsLoading = true
        runCatching { repository.listGroupSessions(g.id) }
            .onSuccess { groupSessions = it }
        runCatching { repository.listCharacters() }
            .onSuccess { chars -> memberNames = chars.associate { c -> c.id to c.name } }
        sessionsLoading = false
    }

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            AppTopBar(
                title = if (selectedGroup == null) "群聊" else selectedGroup!!.name,
                navigationIcon = {
                    IconButton(onClick = { if (selectedGroup == null) onBack() else selectedGroup = null }) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "返回",
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
                            scope.launch {
                                runCatching { repository.listCharacters() }
                                    .onSuccess { allCharacters = it }
                            }
                        }) {
                            Text("新建", style = MaterialTheme.typography.labelLarge, color = qy.accent)
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
                    loading -> CircularProgressIndicator(Modifier.align(Alignment.Center), color = qy.accent)

                    selectedGroup != null -> {
                        // 群会话列表
                        if (sessionsLoading) {
                            CircularProgressIndicator(Modifier.align(Alignment.Center), color = qy.accent)
                        } else if (groupSessions.isEmpty()) {
                            Text(
                                "暂无群聊会话",
                                modifier = Modifier.align(Alignment.Center),
                                color = qy.soft,
                            )
                        } else {
                            LazyColumn(
                                modifier = Modifier.fillMaxSize(),
                                contentPadding = PaddingValues(16.dp),
                                verticalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                items(groupSessions, key = { it.id }) { session ->
                                    // 方案 B：bg2 圆角 14 行 + accentSoft 胶囊
                                    Surface(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clickable {
                                                onOpenGroupChat(
                                                    selectedGroup!!.id,
                                                    selectedGroup!!.name,
                                                    session.id,
                                                )
                                            },
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
                                                    "${session.messageCount} 条消息",
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

                    error != null -> Text(
                        error!!,
                        modifier = Modifier.align(Alignment.Center),
                        color = qy.danger,
                    )

                    groups.isEmpty() -> Text(
                        "暂无群聊，请在 PC 端创建",
                        modifier = Modifier.align(Alignment.Center),
                        color = qy.soft,
                    )

                    else -> {
                        LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(16.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            items(groups, key = { it.id }) { group ->
                                // 方案 B：bg2 圆角 14 行 + accentSoft 胶囊
                                Surface(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable {
                                            selectedGroup = group
                                        },
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
                                                    "${group.memberIds.size} 位成员",
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
                }
            }
        }
    }

    // 新建群聊对话框
    if (showCreate) {
        AlertDialog(
            onDismissRequest = { if (!creating) showCreate = false },
            containerColor = qy.card,
            title = { Text("新建群聊", color = qy.text) },
            text = {
                Column {
                    OutlinedTextField(
                        value = newGroupName,
                        onValueChange = { newGroupName = it.take(30) },
                        label = { Text("群聊名称（可空）") },
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
                        "选择成员（至少 1 个）",
                        style = MaterialTheme.typography.labelMedium,
                        color = qy.soft,
                    )
                    if (allCharacters.isEmpty()) {
                        Text(
                            "暂无角色",
                            style = MaterialTheme.typography.bodySmall,
                            color = qy.soft,
                        )
                    } else {
                        LazyColumn(Modifier.heightIn(max = 240.dp)) {
                            items(allCharacters, key = { it.id }) { c ->
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
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        if (creating || selectedMemberIds.isEmpty()) return@TextButton
                        creating = true
                        scope.launch {
                            runCatching { repository.createGroup(newGroupName.ifBlank { null }, selectedMemberIds.toList()) }
                                .onSuccess {
                                    showCreate = false
                                    creating = false
                                    runCatching { repository.listGroups() }.onSuccess { groups = it }
                                }
                                .onFailure { e ->
                                    creating = false
                                    val msg = if (e is CompanionError) e.userMessage() else e.message ?: "创建失败"
                                    error = msg
                                }
                        }
                    },
                    enabled = selectedMemberIds.isNotEmpty() && !creating,
                ) {
                    if (creating) {
                        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = qy.accent)
                    } else {
                        Text("创建", color = qy.accent)
                    }
                }
            },
            dismissButton = {
                TextButton(onClick = { if (!creating) showCreate = false }) { Text("取消", color = qy.soft) }
            },
        )
    }
}
