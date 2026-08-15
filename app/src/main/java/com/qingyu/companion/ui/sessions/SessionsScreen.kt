package com.qingyu.companion.ui.sessions

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
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
import com.qingyu.companion.ui.theme.Accent
import com.qingyu.companion.ui.theme.Lantern
import com.qingyu.companion.ui.theme.NightSky
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 会话列表页：玻璃卡片列表（角色渐变头像）、离线只读回退、删除/重命名。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    onOpenChat: (sessionId: String) -> Unit,
    onOpenCharacters: () -> Unit,
    onOpenPairing: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenGroups: () -> Unit,
) {
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
        containerColor = Color.Transparent,
        floatingActionButton = {
            FloatingActionButton(
                onClick = { showNewChat = true },
                containerColor = Accent,
                contentColor = Color(0xFF3B2410),
            ) {
                Icon(Icons.Filled.Add, contentDescription = "新建对话")
            }
        },
        topBar = {
            AppTopBar(
                title = "会话",
                navigationIcon = null,
                compact = true,
                actions = {
                    // 主要导航：群聊 / 角色（文字，清晰可点；紧凑：小号文字 + 收紧 padding）
                    TextButton(
                        onClick = onOpenGroups,
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                    ) {
                        Text(
                            "群聊",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    TextButton(
                        onClick = onOpenCharacters,
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                    ) {
                        Text(
                            "角色",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    // 次要操作：图标
                    IconButton(onClick = vm::refresh) {
                        Icon(
                            Icons.Filled.Refresh,
                            contentDescription = "刷新",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(
                            Icons.Filled.Settings,
                            contentDescription = "设置",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(18.dp),
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
                // 顶部工具条：连接状态（左）+ 排序（右，chip 样式；紧凑：收紧 padding）
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ConnectionStatusBar(state = ui.connection, onTap = onOpenPairing)
                    Spacer(Modifier.weight(1f))
                    Surface(
                        onClick = vm::toggleSort,
                        shape = RoundedCornerShape(50),
                        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.75f),
                        border = androidx.compose.foundation.BorderStroke(
                            1.dp,
                            MaterialTheme.colorScheme.outline.copy(alpha = 0.3f),
                        ),
                    ) {
                        Row(
                            Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                if (ui.sortMode == "name") "按角色名" else "按最近",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Icon(
                                Icons.Filled.KeyboardArrowDown,
                                contentDescription = null,
                                modifier = Modifier.size(14.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
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
                        color = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.7f),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 6.dp)
                            .clickable(onClick = onOpenPairing),
                    ) {
                        Text(
                            "连接令牌已失效（PC 端可能已吊销此设备），点击重新配对",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                        )
                    }
                }

                Box(Modifier.fillMaxSize()) {
                    when {
                        ui.loading && ui.sessions.isEmpty() -> {
                            CircularProgressIndicator(
                                Modifier.align(Alignment.Center),
                                color = Lantern,
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
                                        color = MaterialTheme.colorScheme.error,
                                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 2.dp),
                                    )
                                }
                                LazyColumn(
                                    modifier = Modifier.fillMaxSize(),
                                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                                    verticalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    items(ui.sessions, key = { "${it.characterId}:${it.id}" }) { session ->
                                        SessionCard(
                                            session = session,
                                            avatarUrl = avatarMap[session.characterId],
                                            onClick = { onOpenChat(session.id) },
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
            containerColor = MaterialTheme.colorScheme.surface,
            title = { Text("新建对话") },
            text = {
                if (newChatCharacters.isEmpty()) {
                    Text(
                        "暂无角色，请先在 PC 端创建角色",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
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
                                                onOpenChat(sessionId)
                                            }
                                        }
                                    }
                                },
                                shape = RoundedCornerShape(12.dp),
                                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
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
                                        modifier = Modifier.padding(start = 10.dp),
                                    )
                                }
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { if (!creatingSession) showNewChat = false }) { Text("取消") }
            },
        )
    }

    // 首条消息选择（角色有开场白时弹出）
    greetingPickCharacter?.let { character ->
        val options = buildGreetingOptions(character)
        AlertDialog(
            onDismissRequest = { if (!creatingSession) greetingPickCharacter = null },
            containerColor = MaterialTheme.colorScheme.surface,
            title = { Text("首条消息") },
            text = {
                Column {
                    Text(
                        "为「${character.name}」选择一个开场白开始对话",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
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
                                color = if (selectedGreeting == greeting) {
                                    MaterialTheme.colorScheme.primaryContainer
                                } else {
                                    MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)
                                },
                            ) {
                                Text(
                                    greeting,
                                    style = MaterialTheme.typography.bodySmall,
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
                                onOpenChat(sessionId)
                            }
                        }
                    },
                ) { Text(if (selectedGreeting != null) "开始对话" else "跳过") }
            },
            dismissButton = {
                TextButton(onClick = { if (!creatingSession) greetingPickCharacter = null }) { Text("取消") }
            },
        )
    }

    pendingDelete?.let { session ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            containerColor = MaterialTheme.colorScheme.surface,
            title = { Text("删除会话") },
            text = { Text("确定删除「${session.title.ifBlank { "未命名会话" }}」？此操作会同步删除 PC 端数据。") },
            confirmButton = {
                TextButton(onClick = {
                    vm.delete(session)
                    pendingDelete = null
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("取消") }
            },
        )
    }

    renamingSession?.let { session ->
        AlertDialog(
            onDismissRequest = { renamingSession = null },
            containerColor = MaterialTheme.colorScheme.surface,
            title = { Text("重命名会话") },
            text = {
                OutlinedTextField(
                    value = renameText,
                    onValueChange = { renameText = it },
                    label = { Text("标题") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = Lantern,
                        focusedContainerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.6f),
                    ),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.rename(session.id, renameText)
                    renamingSession = null
                }) { Text("保存") }
            },
            dismissButton = {
                TextButton(onClick = { renamingSession = null }) { Text("取消") }
            },
        )
    }
}

/** 空状态：品牌化插画（字标 + 引导文案） */
@Composable
private fun EmptyState(offline: Boolean) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        // 灯火印章
        Box(
            modifier = Modifier
                .size(84.dp)
                .shadow(20.dp, CircleShape, ambientColor = Lantern.copy(alpha = 0.3f))
                .clip(CircleShape)
                .background(
                    Brush.radialGradient(
                        colors = listOf(Lantern.copy(alpha = 0.28f), Color.Transparent),
                    )
                ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "轻",
                style = MaterialTheme.typography.headlineLarge,
                color = Lantern.copy(alpha = 0.9f),
                fontWeight = FontWeight.Bold,
            )
        }
        Spacer(Modifier.height(20.dp))
        Text("暂无会话", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(8.dp))
        Text(
            if (offline) "未连接 PC，且无本地缓存" else "在 PC 端开始对话，或检查连接状态",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** 构建可选开场白列表：主首条消息 + 备选开场白（译文优先），过滤空串与重复项 */
private fun buildGreetingOptions(character: Character): List<String> {
    val main = character.translatedContent?.firstMessage ?: character.firstMessage
    val alternates = character.alternateGreetings.mapIndexed { i, g ->
        character.translatedContent?.alternateGreetings?.getOrNull(i) ?: g
    }
    return (listOfNotNull(main.takeIf { it.isNotBlank() }) + alternates)
        .filter { it.isNotBlank() }
        .distinct()
}

