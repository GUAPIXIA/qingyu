package com.qingyu.companion.ui.sessions

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.AlertDialog
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
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.R
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.data.userMessage
import com.qingyu.companion.model.Character
import com.qingyu.companion.model.SessionPreview
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.AvatarBubble
import com.qingyu.companion.ui.components.LoadState
import com.qingyu.companion.ui.components.QyConnectionChip
import com.qingyu.companion.ui.components.QyEmptyState
import com.qingyu.companion.ui.components.QyErrorBanner
import com.qingyu.companion.ui.components.QyOfflineBanner
import com.qingyu.companion.ui.components.QySkeletonList
import com.qingyu.companion.ui.components.SessionCard
import com.qingyu.companion.ui.components.rememberSkeletonVisible
import com.qingyu.companion.ui.components.resolveImageUrl
import com.qingyu.companion.ui.theme.qyColors
import com.qingyu.companion.utils.SearchUtils


/**
 * 会话列表页（方案 B）：顶栏「轻语」+ 右上角设置，紧凑列表行 + 48dp 圆角 FAB。
 * E-02：页面状态统一由 [SessionsViewModel.loadState]（LoadState 五态）驱动，
 * 渲染走 ui/components/AsyncStates.kt 的 Qy 组件（骨架/空态/离线/错误）；
 * 搜索、排序、删除、重命名、新建对话等交互保持不变。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    onOpenChat: (sessionId: String, characterId: String) -> Unit,
    onOpenCharacters: () -> Unit,
    onOpenPairing: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenGroups: () -> Unit,
    showSectionShortcuts: Boolean = true,
) {
    val qy = qyColors()
    val container = LocalAppContainer.current
    val vm: SessionsViewModel = viewModel(factory = viewModelFactory {
        initializer { SessionsViewModel(container.repository) }
    })
    val ui by vm.ui.collectAsStateWithLifecycle()
    val loadState by vm.loadState.collectAsStateWithLifecycle()
    // E-02：连接胶囊消费阶段 B ConnectionState（含重连倒计时/需修复文案）
    val connectionState by container.connectionManager.connectionState.collectAsStateWithLifecycle()
    // E-02：骨架屏最短展示 300ms 防抖（快速加载不闪烁）
    val skeletonVisible = rememberSkeletonVisible(loadState is LoadState.Loading)
    var pendingDelete by remember { mutableStateOf<SessionPreview?>(null) }
    var renamingSession by remember { mutableStateOf<SessionPreview?>(null) }
    var searchQuery by remember { mutableStateOf("") }
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
    val connState by container.connectionManager.activeFlow.collectAsStateWithLifecycle()
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
            // 紧凑 FAB：48dp 仍满足主要触控目标，减轻列表上方的视觉重量。
            Surface(
                onClick = { showNewChat = true },
                shape = RoundedCornerShape(14.dp),
                color = qy.accent,
                contentColor = qy.onAccent,
                shadowElevation = 4.dp,
                modifier = Modifier.size(48.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        Icons.Filled.Add,
                        contentDescription = stringResource(R.string.cd_new_session),
                        modifier = Modifier.size(21.dp),
                    )
                }
            }
        },
        topBar = {
            if (showSectionShortcuts) {
                AppTopBar(
                    title = stringResource(R.string.shell_home_title),
                    navigationIcon = null,
                    compact = true,
                    actions = {
                        // 无底栏的旧回退导航仍保留栏目入口，避免角色/群聊不可达。
                        IconButton(onClick = onOpenGroups) {
                            Icon(
                                Icons.Outlined.Group,
                                contentDescription = stringResource(R.string.cd_group),
                                tint = qy.soft,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                        IconButton(onClick = onOpenCharacters) {
                            Icon(
                                Icons.Outlined.Person,
                                contentDescription = stringResource(R.string.cd_character),
                                tint = qy.soft,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                        IconButton(onClick = vm::refresh) {
                            Icon(
                                Icons.Filled.Refresh,
                                contentDescription = stringResource(R.string.cd_refresh),
                                tint = qy.soft,
                                modifier = Modifier.size(18.dp),
                            )
                        }
                        IconButton(onClick = onOpenSettings) {
                            Icon(
                                Icons.Filled.Settings,
                                contentDescription = stringResource(R.string.cd_settings),
                                tint = qy.soft,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    },
                )
            } else {
                // 主 Shell 已有角色/群聊底栏：标题、状态、排序和必要操作合并成单行。
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .statusBarsPadding()
                        .height(48.dp)
                        .padding(start = 12.dp, end = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        stringResource(R.string.shell_home_title),
                        style = MaterialTheme.typography.titleMedium,
                        color = qy.text,
                        maxLines = 1,
                        modifier = Modifier.weight(1f),
                    )
                    QyConnectionChip(state = connectionState, onTap = onOpenPairing)
                    SessionsSortChip(sortMode = ui.sortMode, onToggle = vm::toggleSort)
                    IconButton(onClick = vm::refresh) {
                        Icon(
                            Icons.Filled.Refresh,
                            contentDescription = stringResource(R.string.cd_refresh),
                            tint = qy.soft,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(
                            Icons.Filled.Settings,
                            contentDescription = stringResource(R.string.cd_settings),
                            tint = qy.soft,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }
        },
    ) { padding ->
        AppBackground {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
            ) {
                if (showSectionShortcuts) {
                    // 无底栏回退路径仍使用独立工具行，给四个顶部入口留足宽度。
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        QyConnectionChip(state = connectionState, onTap = onOpenPairing)
                        Spacer(Modifier.weight(1f))
                        SessionsSortChip(sortMode = ui.sortMode, onToggle = vm::toggleSort)
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
                            stringResource(R.string.sessions_token_invalid_banner),
                            style = MaterialTheme.typography.bodySmall,
                            color = qy.danger,
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                        )
                    }
                }

                // 搜索框（端侧会话搜索，不走网络）
                CompactSearchField(
                    value = searchQuery,
                    onValueChange = { searchQuery = it },
                )
                val filteredSessions = remember(ui.sessions, searchQuery) { SearchUtils.filterSessions(ui.sessions, searchQuery) }
                Box(Modifier.fillMaxSize()) {
                    // E-02：五态分发（Loading 骨架 / Empty 空态 / Offline 横幅+缓存 / Error 横幅+重试 / Content 列表）
                    when (val st = loadState) {
                        is LoadState.Loading -> {
                            if (skeletonVisible) {
                                QySkeletonList(
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .padding(horizontal = 16.dp, vertical = 12.dp),
                                    rows = 6,
                                )
                            }
                        }

                        is LoadState.Empty -> {
                            QyEmptyState(
                                title = stringResource(R.string.sessions_empty_title),
                                description = stringResource(
                                    if (ui.offline) R.string.sessions_empty_desc_offline
                                    else R.string.sessions_empty_desc_online
                                ),
                                leading = { SessionsEmptyBadge() },
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
                                SessionListArea(
                                    sessions = filteredSessions,
                                    searchActive = searchQuery.isNotBlank(),
                                    avatarMap = avatarMap,
                                    onOpenChat = onOpenChat,
                                    onRename = { session ->
                                        renamingSession = session
                                        renameText = session.title
                                    },
                                    onDelete = { session -> pendingDelete = session },
                                )
                            }
                        }

                        is LoadState.Content -> {
                            SessionListArea(
                                sessions = filteredSessions,
                                searchActive = searchQuery.isNotBlank(),
                                avatarMap = avatarMap,
                                onOpenChat = onOpenChat,
                                onRename = { session ->
                                    renamingSession = session
                                    renameText = session.title
                                },
                                onDelete = { session -> pendingDelete = session },
                            )
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
            title = { Text(stringResource(R.string.title_new_session), color = qy.text) },
            text = {
                if (newChatCharacters.isEmpty()) {
                    Text(
                        stringResource(R.string.sessions_new_chat_no_characters),
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
                    Text(stringResource(R.string.action_cancel), color = qy.soft)
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
            title = { Text(stringResource(R.string.title_first_message), color = qy.text) },
            text = {
                Column {
                    Text(
                        stringResource(R.string.sessions_greeting_pick_desc, character.name),
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
                ) {
                    Text(
                        if (selectedGreeting != null) {
                            stringResource(R.string.action_start_chat)
                        } else {
                            stringResource(R.string.sessions_greeting_skip)
                        },
                        color = qy.accent,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { if (!creatingSession) greetingPickCharacter = null }) {
                    Text(stringResource(R.string.action_cancel), color = qy.soft)
                }
            },
        )
    }

    pendingDelete?.let { session ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            containerColor = qy.card,
            title = { Text(stringResource(R.string.sessions_delete_title), color = qy.text) },
            text = {
                Text(
                    stringResource(
                        R.string.msg_delete_session_confirm,
                        session.title.ifBlank { stringResource(R.string.msg_unnamed_session) },
                    ),
                    color = qy.soft,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.delete(session)
                    pendingDelete = null
                }) { Text(stringResource(R.string.action_delete), color = qy.danger) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text(stringResource(R.string.action_cancel), color = qy.soft) }
            },
        )
    }

    renamingSession?.let { session ->
        AlertDialog(
            onDismissRequest = { renamingSession = null },
            containerColor = qy.card,
            title = { Text(stringResource(R.string.title_rename_session), color = qy.text) },
            text = {
                OutlinedTextField(
                    value = renameText,
                    onValueChange = { renameText = it },
                    label = { Text(stringResource(R.string.msg_rename_hint)) },
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
                }) { Text(stringResource(R.string.action_save), color = qy.accent) }
            },
            dismissButton = {
                TextButton(onClick = { renamingSession = null }) { Text(stringResource(R.string.action_cancel), color = qy.soft) }
            },
        )
    }
}

@Composable
private fun SessionsSortChip(
    sortMode: String,
    onToggle: () -> Unit,
) {
    val qy = qyColors()
    Surface(
        onClick = onToggle,
        shape = RoundedCornerShape(50),
        color = qy.accentSoft,
        modifier = Modifier.minimumInteractiveComponentSize(),
    ) {
        Row(
            Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                if (sortMode == "name") {
                    stringResource(R.string.sessions_sort_by_name)
                } else {
                    stringResource(R.string.sessions_sort_by_recent)
                },
                style = MaterialTheme.typography.labelSmall,
                color = qy.accent,
            )
            Icon(
                Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                modifier = Modifier.size(13.dp),
                tint = qy.accent.copy(alpha = 0.7f),
            )
        }
    }
}

/** 48dp 紧凑搜索框：避开 Material OutlinedTextField 的 56dp 内部最小高度与文字裁切。 */
@Composable
private fun CompactSearchField(
    value: String,
    onValueChange: (String) -> Unit,
) {
    val qy = qyColors()
    val searchHint = stringResource(R.string.sessions_search_hint)
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = qy.bg2,
        border = BorderStroke(1.dp, qy.line),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 2.dp)
            .height(48.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Filled.Search,
                contentDescription = null,
                tint = qy.muted,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(8.dp))
            Box(
                modifier = Modifier.weight(1f),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (value.isEmpty()) {
                    Text(
                        searchHint,
                        style = MaterialTheme.typography.bodyMedium,
                        color = qy.muted,
                    )
                }
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(color = qy.text),
                    cursorBrush = SolidColor(qy.accent),
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { contentDescription = searchHint },
                )
            }
        }
    }
}

/**
 * 会话列表渲染（Content / Offline 共用）：搜索无结果 → 空态；否则列表。
 * 长按重命名、删除、点击进入会话等交互保持不变。
 */
@Composable
private fun SessionListArea(
    sessions: List<SessionPreview>,
    searchActive: Boolean,
    avatarMap: Map<String, String>,
    onOpenChat: (sessionId: String, characterId: String) -> Unit,
    onRename: (SessionPreview) -> Unit,
    onDelete: (SessionPreview) -> Unit,
) {
    if (searchActive && sessions.isEmpty()) {
        QyEmptyState(
            title = stringResource(R.string.sessions_search_empty),
            modifier = Modifier.fillMaxSize(),
        )
        return
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        items(sessions, key = { "${it.characterId}:${it.id}" }) { session ->
            SessionCard(
                session = session,
                avatarUrl = avatarMap[session.characterId],
                onClick = { onOpenChat(session.id, session.characterId) },
                onLongClick = { onRename(session) },
                onDelete = { onDelete(session) },
            )
        }
    }
}
