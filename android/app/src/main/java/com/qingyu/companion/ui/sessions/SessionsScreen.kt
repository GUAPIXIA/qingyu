package com.qingyu.companion.ui.sessions

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.model.Character
import com.qingyu.companion.model.SessionPreview
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.AvatarBubble
import com.qingyu.companion.ui.components.ConnectionStatusBar
import com.qingyu.companion.ui.components.SessionCard
import com.qingyu.companion.ui.components.resolveImageUrl
import com.qingyu.companion.ui.theme.qyColors


/**
 * 会话列表页（方案 B）：顶栏「轻语」+ 右上角设置，列表行 + 50dp 圆角 FAB。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    onOpenChat: (sessionId: String, characterId: String) -> Unit,
    onOpenCharacters: () -> Unit,
    onOpenPairing: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenGroups: () -> Unit,
) {
    val qy = qyColors()
    val container = LocalAppContainer.current
    val vm: SessionsViewModel = viewModel(factory = viewModelFactory {
        initializer { SessionsViewModel(container.repository) }
    })
    val ui by vm.ui.collectAsState()
    var pendingDelete by remember { mutableStateOf<SessionPreview?>(null) }
    var renamingSession by remember { mutableStateOf<SessionPreview?>(null) }
    var renameText by remember { mutableStateOf("") }
    var tokenInvalid by remember { mutableStateOf(false) }
    // 角色头像 map：characterId -> 完整头像 URL（PC 端同步）
    var avatarMap by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    // 新建对话：角色选择
    var showNewChat by remember { mutableStateOf(false) }
    var newChatCharacters by remember { mutableStateOf<List<Character>>(emptyList()) }
    var creatingSession by remember { mutableStateOf(false) }
    // 首条消息选择（角色有开场白时弹出）
    var greetingPickCharacter by remember { mutableStateOf<Character?>(null) }
    var selectedGreeting by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        container.connectionManager.tokenInvalidated.collect { tokenInvalid = true }
    }
    // 连接恢复/切换时重新拉取角色列表（含头像 URL）
    val connState by container.connectionManager.activeFlow.collectAsState()
    LaunchedEffect(connState) {
        if (connState != null) {
            runCatching { container.repository.listCharacters() }
                .onSuccess { characters ->
                    val conn = container.connectionManager.activeConnection
                    avatarMap = characters.mapNotNull { c ->
                        resolveImageUrl(c.avatarUrl, conn)?.let { c.id to it }
                    }.toMap()
                    newChatCharacters = characters
                }
        }
    }

    Scaffold(
        containerColor = androidx.compose.ui.graphics.Color.Transparent,
        floatingActionButton = {
            // 方案 B FAB：50dp · 圆角 16 · 暖金底
            Surface(
                onClick = { showNewChat = true },
                shape = RoundedCornerShape(16.dp),
                color = qy.accent,
                contentColor = qy.onAccent,
                shadowElevation = 6.dp,
                modifier = Modifier.size(50.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        Icons.Filled.Add,
                        contentDescription = "新建对话",
                        modifier = Modifier.size(22.dp),
                    )
                }
            }
        },
        topBar = {
            AppTopBar(
                title = "轻语",
                navigationIcon = null,
                compact = true,
                actions = {
                    // 次级入口：群聊 / 角色 / 刷新，设置贴最右（方案 B：右上角＝设置）
                    IconButton(onClick = onOpenGroups) {
                        Icon(
                            Icons.Outlined.Group,
                            contentDescription = "群聊",
                            tint = qy.soft,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                    IconButton(onClick = onOpenCharacters) {
                        Icon(
                            Icons.Outlined.Person,
                            contentDescription = "角色",
                            tint = qy.soft,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                    IconButton(onClick = vm::refresh) {
                        Icon(
                            Icons.Filled.Refresh,
                            contentDescription = "刷新",
                            tint = qy.soft,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(
                            Icons.Filled.Settings,
                            contentDescription = "设置",
                            tint = qy.soft,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                },
            )
        },
    ) { padding ->
        AppBackground {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
            ) {
                // 顶部工具条：连接状态（左）+ 排序（右，胶囊样式）
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ConnectionStatusBar(state = ui.connection, onTap = onOpenPairing)
                    Spacer(Modifier.weight(1f))
                    Surface(
                        onClick = vm::toggleSort,
                        shape = RoundedCornerShape(50),
                        color = qy.accentSoft,
                    ) {
                        Row(
                            Modifier.padding(horizontal = 10.dp, vertical = 3.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                if (ui.sortMode == "name") "按角色名" else "按最近",
                                style = MaterialTheme.typography.labelMedium,
                                color = qy.accent,
                            )
                            Icon(
                                Icons.Filled.KeyboardArrowDown,
                                contentDescription = null,
                                modifier = Modifier.size(14.dp),
                                tint = qy.accent.copy(alpha = 0.7f),
                            )
                        }
                    }
                }

                // 令牌失效横幅
                AnimatedVisibility(
                    visible = tokenInvalid,
                    enter = fadeIn(),
                    exit = fadeOut(),
                ) {
                    Surface(
                        color = qy.danger.copy(alpha = 0.12f),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 6.dp)
                            .clickable(onClick = onOpenPairing),
                    ) {
                        Text(
                            "连接令牌已失效（PC 端可能已吊销此设备），点击重新配对",
                            style = MaterialTheme.typography.bodySmall,
                            color = qy.danger,
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                        )
                    }
                }

                Box(Modifier.fillMaxSize()) {
                    when {
                        ui.loading && ui.sessions.isEmpty() -> {
                            CircularProgressIndicator(
                                Modifier.align(Alignment.Center),
                                color = qy.accent,
                            )
                        }

                        ui.sessions.isEmpty() -> {
                            EmptyState(offline = ui.offline)
                        }

                        else -> {
                            Column(Modifier.fillMaxSize()) {
                                if (ui.offline) {
                                    Text(
                                        "离线模式：显示本地缓存（只读）",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = qy.warn,
                                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 2.dp),
                                    )
                                }
                                LazyColumn(
                                    modifier = Modifier.fillMaxSize(),
                                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                                    verticalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    items(ui.sessions, key = { "${it.characterId}:${it.id}" }) { session ->
                                        SessionCard(
                                            session = session,
                                            avatarUrl = avatarMap[session.characterId],
                                            onClick = { onOpenChat(session.id, session.characterId) },
                                            onLongClick = {
                                                renamingSession = session
                                                renameText = session.title
                                            },
                                            onDelete = { pendingDelete = session },
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

    // 新建对话：角色选择
    if (showNewChat) {
        AlertDialog(
            onDismissRequest = { if (!creatingSession) showNewChat = false },
            containerColor = qy.card,
            title = { Text("新建对话", color = qy.text) },
            text = {
                if (newChatCharacters.isEmpty()) {
                    Text(
                        "暂无角色，请先在 PC 端创建角色",
                        style = MaterialTheme.typography.bodyMedium,
                        color = qy.soft,
                    )
                } else {
                    LazyColumn(
                        modifier = Modifier.heightIn(max = 320.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        items(newChatCharacters, key = { it.id }) { character ->
                            Surface(
                                onClick = {
                                    if (!creatingSession) {
                                        if (buildGreetingOptions(character).isNotEmpty()) {
                                            selectedGreeting = null
                                            greetingPickCharacter = character
                                        } else {
                                            creatingSession = true
                                            vm.createSession(character.id, null) { sessionId ->
                                                creatingSession = false
                                                showNewChat = false
                                                onOpenChat(sessionId, character.id)
                                            }
                                        }
                                    }
                                },
                                shape = RoundedCornerShape(12.dp),
                                color = qy.bg2,
                            ) {
                                Row(
                                    modifier = Modifier.padding(10.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    AvatarBubble(
                                        name = character.name,
                                        avatarUrl = resolveImageUrl(character.avatarUrl, container.connectionManager.activeConnection),
                                        size = 36,
                                    )
                                    Text(
                                        character.name,
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = qy.text,
                                        modifier = Modifier.padding(start = 10.dp),
                                    )
                                }
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { if (!creatingSession) showNewChat = false }) {
                    Text("取消", color = qy.soft)
                }
            },
        )
    }

    // 首条消息选择（角色有开场白时弹出）
    greetingPickCharacter?.let { character ->
        val options = buildGreetingOptions(character)
        AlertDialog(
            onDismissRequest = { if (!creatingSession) greetingPickCharacter = null },
            containerColor = qy.card,
            title = { Text("首条消息", color = qy.text) },
            text = {
                Column {
                    Text(
                        "为「${character.name}」选择一个开场白开始对话",
                        style = MaterialTheme.typography.bodyMedium,
                        color = qy.soft,
                    )
                    Spacer(Modifier.height(10.dp))
                    LazyColumn(
                        modifier = Modifier.heightIn(max = 280.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        items(options) { greeting ->
                            Surface(
                                onClick = { selectedGreeting = greeting },
                                shape = RoundedCornerShape(12.dp),
                                color = if (selectedGreeting == greeting) qy.accentSoft else qy.bg2,
                            ) {
                                Text(
                                    greeting,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = if (selectedGreeting == greeting) qy.accent else qy.text,
                                    maxLines = 3,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.padding(12.dp),
                                )
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        if (!creatingSession) {
                            creatingSession = true
                            vm.createSession(character.id, selectedGreeting) { sessionId ->
                                creatingSession = false
                                greetingPickCharacter = null
                                showNewChat = false
                                onOpenChat(sessionId, character.id)
                            }
                        }
                    },
                ) { Text(if (selectedGreeting != null) "开始对话" else "跳过", color = qy.accent) }
            },
            dismissButton = {
                TextButton(onClick = { if (!creatingSession) greetingPickCharacter = null }) {
                    Text("取消", color = qy.soft)
                }
            },
        )
    }

    pendingDelete?.let { session ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            containerColor = qy.card,
            title = { Text("删除会话", color = qy.text) },
            text = {
                Text(
                    "确定删除「${session.title.ifBlank { "未命名会话" }}」？此操作会同步删除 PC 端数据。",
                    color = qy.soft,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.delete(session)
                    pendingDelete = null
                }) { Text("删除", color = qy.danger) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("取消", color = qy.soft) }
            },
        )
    }

    renamingSession?.let { session ->
        AlertDialog(
            onDismissRequest = { renamingSession = null },
            containerColor = qy.card,
            title = { Text("重命名会话", color = qy.text) },
            text = {
                OutlinedTextField(
                    value = renameText,
                    onValueChange = { renameText = it },
                    label = { Text("标题") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = qy.text,
                        focusedBorderColor = qy.accent,
                        unfocusedBorderColor = qy.line,
                        focusedContainerColor = qy.bg2,
                        cursorColor = qy.accent,
                    ),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.rename(session.id, renameText)
                    renamingSession = null
                }) { Text("保存", color = qy.accent) }
            },
            dismissButton = {
                TextButton(onClick = { renamingSession = null }) { Text("取消", color = qy.soft) }
            },
        )
    }
}

/** 空状态：极简字标 + 引导文案（方案 B：仅保留必要元素） */
