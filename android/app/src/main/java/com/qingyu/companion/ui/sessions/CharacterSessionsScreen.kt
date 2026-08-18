package com.qingyu.companion.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.model.SessionPreview
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.AvatarBubble
import com.qingyu.companion.ui.components.SessionCard
import com.qingyu.companion.ui.components.resolveImageUrl
import com.qingyu.companion.ui.theme.qyColors

/**
 * 角色历史会话页：某角色的全部历史对话。
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
    val ui by vm.ui.collectAsState()
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
                            contentDescription = "返回",
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
                                "历史对话",
                                style = MaterialTheme.typography.titleMedium,
                            )
                            Text(
                                "${ui.sessions.size} 个会话",
                                style = MaterialTheme.typography.labelSmall,
                                color = qy.soft,
                            )
                        }
                    }
                }

                Box(Modifier.fillMaxSize()) {
                    when {
                        ui.loading && ui.sessions.isEmpty() -> {
                            CircularProgressIndicator(Modifier.align(Alignment.Center), color = qy.accent)
                        }

                        ui.sessions.isEmpty() -> {
                            Text(
                                "暂无与该角色的历史对话",
                                style = MaterialTheme.typography.bodyMedium,
                                color = qy.soft,
                                modifier = Modifier.align(Alignment.Center),
                            )
                        }

                        else -> {
                            LazyColumn(
                                modifier = Modifier.fillMaxSize(),
                                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                                verticalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                items(ui.sessions, key = { "${it.characterId}:${it.id}" }) { session ->
                                    SessionCard(
                                        session = session,
                                        avatarUrl = avatarUrl,
                                        showCharacterName = false,
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

    pendingDelete?.let { session ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            containerColor = qy.card,
            title = { Text("删除会话") },
            text = { Text("确定删除「${session.title.ifBlank { "未命名会话" }}」？此操作会同步删除 PC 端数据。") },
            confirmButton = {
                TextButton(onClick = {
                    vm.delete(session)
                    pendingDelete = null
                }) { Text("删除", color = qy.danger) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("取消") }
            },
        )
    }

    renamingSession?.let { session ->
        AlertDialog(
            onDismissRequest = { renamingSession = null },
            containerColor = qy.card,
            title = { Text("重命名会话") },
            text = {
                OutlinedTextField(
                    value = renameText,
                    onValueChange = { renameText = it },
                    label = { Text("标题") },
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
                }) { Text("保存") }
            },
            dismissButton = {
                TextButton(onClick = { renamingSession = null }) { Text("取消") }
            },
        )
    }
}
