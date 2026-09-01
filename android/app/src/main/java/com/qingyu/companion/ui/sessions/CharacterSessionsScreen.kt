package com.qingyu.companion.ui.sessions

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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.R
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.data.userMessage
import com.qingyu.companion.model.SessionPreview
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.AvatarBubble
import com.qingyu.companion.ui.components.LoadState
import com.qingyu.companion.ui.components.QyEmptyState
import com.qingyu.companion.ui.components.QyErrorBanner
import com.qingyu.companion.ui.components.QyOfflineBanner
import com.qingyu.companion.ui.components.QySkeletonList
import com.qingyu.companion.ui.components.SessionCard
import com.qingyu.companion.ui.components.rememberSkeletonVisible
import com.qingyu.companion.ui.components.resolveImageUrl
import com.qingyu.companion.ui.theme.qyColors

/**
 * 角色历史会话页：某角色的全部历史对话。
 * E-02：复用 [SessionsViewModel.loadState]（LoadState 五态），
 * 渲染走 ui/components/AsyncStates.kt 的 Qy 组件（骨架/空态/离线/错误）；
 * 删除、重命名等交互保持不变。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CharacterSessionsScreen(
    characterId: String,
    characterName: String,
    onOpenChat: (sessionId: String, characterId: String) -> Unit,
    onBack: () -> Unit,
) {
    val qy = qyColors()
    val container = LocalAppContainer.current
    val vm: SessionsViewModel = viewModel(
        key = "char-sessions-$characterId",
        factory = viewModelFactory {
            initializer { SessionsViewModel(container.repository, characterId) }
        },
    )
    val ui by vm.ui.collectAsStateWithLifecycle()
    val loadState by vm.loadState.collectAsStateWithLifecycle()
    val skeletonVisible = rememberSkeletonVisible(loadState is LoadState.Loading)
    var pendingDelete by remember { mutableStateOf<SessionPreview?>(null) }
    var renamingSession by remember { mutableStateOf<SessionPreview?>(null) }
    var renameText by remember { mutableStateOf("") }
    // 角色头像（PC 端同步）
    var avatarUrl by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(characterId) {
        runCatching { container.repository.listCharacters() }
            .onSuccess { characters ->
                val character = characters.firstOrNull { it.id == characterId }
                avatarUrl = resolveImageUrl(character?.avatarUrl, container.connectionManager.activeConnection)
            }
    }

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            AppTopBar(
                title = characterName,
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.cd_back),
                            tint = qy.text,
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
                // 头部：角色头像 + 历史对话数
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 4.dp),
                    shape = RoundedCornerShape(16.dp),
                    color = qy.card,
                ) {
                    Row(
                        modifier = Modifier.padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AvatarBubble(name = characterName, avatarUrl = avatarUrl, size = 40)
                        Column(Modifier.padding(start = 12.dp)) {
                            Text(
                                stringResource(R.string.sessions_history_title),
                                style = MaterialTheme.typography.titleMedium,
                            )
                            Text(
                                stringResource(R.string.sessions_history_count, ui.sessions.size),
                                style = MaterialTheme.typography.labelSmall,
                                color = qy.soft,
                            )
                        }
                    }
                }

                Box(Modifier.fillMaxSize()) {
                    // E-02：五态分发（Loading 骨架 / Empty 空态 / Offline 横幅+缓存 / Error 横幅+重试 / Content 列表）
                    when (val st = loadState) {
                        is LoadState.Loading -> {
                            if (skeletonVisible) {
                                QySkeletonList(
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .padding(horizontal = 16.dp, vertical = 8.dp),
                                    rows = 4,
                                )
                            }
                        }

                        is LoadState.Empty -> {
                            QyEmptyState(
                                title = stringResource(R.string.sessions_character_empty),
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
                                    sessions = st.cached,
                                    avatarUrl = avatarUrl,
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
                                sessions = st.data,
                                avatarUrl = avatarUrl,
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

    pendingDelete?.let { session ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            containerColor = qy.card,
            title = { Text(stringResource(R.string.sessions_delete_title)) },
            text = {
                Text(
                    stringResource(
                        R.string.msg_delete_session_confirm,
                        session.title.ifBlank { stringResource(R.string.msg_unnamed_session) },
                    ),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.delete(session)
                    pendingDelete = null
                }) { Text(stringResource(R.string.action_delete), color = qy.danger) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text(stringResource(R.string.action_cancel)) }
            },
        )
    }

    renamingSession?.let { session ->
        AlertDialog(
            onDismissRequest = { renamingSession = null },
            containerColor = qy.card,
            title = { Text(stringResource(R.string.title_rename_session)) },
            text = {
                OutlinedTextField(
                    value = renameText,
                    onValueChange = { renameText = it },
                    label = { Text(stringResource(R.string.msg_rename_hint)) },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = qy.accent,
                    ),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.rename(session.id, renameText)
                    renamingSession = null
                }) { Text(stringResource(R.string.action_save)) }
            },
            dismissButton = {
                TextButton(onClick = { renamingSession = null }) { Text(stringResource(R.string.action_cancel)) }
            },
        )
    }
}

/**
 * 角色历史会话列表渲染（Content / Offline 共用）。
 */
@Composable
private fun SessionListArea(
    sessions: List<SessionPreview>,
    avatarUrl: String?,
    onOpenChat: (sessionId: String, characterId: String) -> Unit,
    onRename: (SessionPreview) -> Unit,
    onDelete: (SessionPreview) -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(sessions, key = { "${it.characterId}:${it.id}" }) { session ->
            SessionCard(
                session = session,
                avatarUrl = avatarUrl,
                showCharacterName = false,
                onClick = { onOpenChat(session.id, session.characterId) },
                onLongClick = { onRename(session) },
                onDelete = { onDelete(session) },
            )
        }
    }
}
