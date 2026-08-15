package com.qingyu.companion.ui.groups

import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
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
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.model.GroupMessage
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.MarkdownText
import com.qingyu.companion.ui.components.stripThought
import com.qingyu.companion.ui.theme.Accent
import com.qingyu.companion.ui.theme.AssistantBubble
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 群聊消息页：成员消息列表（角色名 + 内容）+ 发言输入框。
 * AI 群聊回复待二期（当前仅查看 + 用户发言落盘，PC 端可见）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GroupChatScreen(
    groupId: String,
    groupName: String,
    sessionId: String,
    memberNames: Map<String, String>,
    onBack: () -> Unit,
) {
    val container = LocalAppContainer.current
    val vm: GroupChatViewModel = viewModel(
        key = "group-chat-$groupId-$sessionId",
        factory = viewModelFactory {
            initializer { GroupChatViewModel(container.repository, groupId, sessionId, memberNames) }
        },
    )
    val ui by vm.ui.collectAsState()
    val input by vm.input.collectAsState()
    // 消息操作状态
    var menuMessage by remember { mutableStateOf<GroupMessage?>(null) }
    var editingMessage by remember { mutableStateOf<GroupMessage?>(null) }
    var editText by remember { mutableStateOf("") }
    var deleteTarget by remember { mutableStateOf<GroupMessage?>(null) }
    val clipboard = LocalClipboardManager.current

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        groupName,
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onBackground,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "返回",
                            tint = MaterialTheme.colorScheme.onBackground,
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
            )
        },
    ) { padding ->
        AppBackground {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
            ) {
                Box(Modifier.weight(1f)) {
                    when {
                        ui.loading && ui.messages.isEmpty() ->
                            CircularProgressIndicator(Modifier.align(Alignment.Center), color = Accent)

                        ui.messages.isEmpty() -> Text(
                            "暂无消息，说点什么吧",
                            modifier = Modifier.align(Alignment.Center),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )

                        else -> LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            items(ui.messages, key = { it.id }) { message ->
                                GroupMessageRow(
                                    message = message,
                                    speakerName = vm::speakerName,
                                    onLongPress = { menuMessage = message },
                                    onCopy = {
                                        clipboard.setText(AnnotatedString(message.content))
                                    },
                                    onEdit = {
                                        editingMessage = message
                                        editText = message.content
                                    },
                                    onTranslate = { vm.translate(message.id) },
                                    onDelete = { deleteTarget = message },
                                )
                            }
                        }
                    }
                }

                ui.error?.let {
                    Text(
                        it,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(horizontal = 16.dp),
                    )
                }

                // 输入栏
                Surface(
                    color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
                    shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp),
                    modifier = Modifier.fillMaxWidth(),
                    border = androidx.compose.foundation.BorderStroke(
                        1.dp,
                        MaterialTheme.colorScheme.outline.copy(alpha = 0.25f),
                    ),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.Bottom,
                    ) {
                        OutlinedTextField(
                            value = input,
                            onValueChange = vm::onInputChange,
                            modifier = Modifier.weight(1f),
                            placeholder = { Text("发言…（AI 群聊回复待二期）") },
                            maxLines = 4,
                            shape = RoundedCornerShape(18.dp),
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
                                unfocusedContainerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                                focusedBorderColor = Accent.copy(alpha = 0.7f),
                                unfocusedBorderColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f),
                            ),
                        )
                        Spacer(Modifier.width(8.dp))
                        Surface(
                            onClick = vm::send,
                            enabled = input.isNotBlank() && !ui.sending,
                            shape = CircleShape,
                            color = Accent,
                            modifier = Modifier.shadow(10.dp, CircleShape, ambientColor = Accent.copy(alpha = 0.5f)),
                        ) {
                            Box(Modifier.size(46.dp), contentAlignment = Alignment.Center) {
                                if (ui.sending) {
                                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Color(0xFF3B2410))
                                } else {
                                    Icon(
                                        Icons.AutoMirrored.Filled.Send,
                                        contentDescription = "发送",
                                        tint = Color(0xFF3B2410),
                                        modifier = Modifier.size(20.dp),
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 消息长按操作菜单
    menuMessage?.let { message ->
        AlertDialog(
            onDismissRequest = { menuMessage = null },
            containerColor = MaterialTheme.colorScheme.surface,
            title = { Text("消息操作") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    TextButton(onClick = {
                        menuMessage = null
                        editingMessage = message
                        editText = message.content
                    }) { Text("编辑") }
                    TextButton(onClick = {
                        menuMessage = null
                        vm.translate(message.id)
                    }) { Text("翻译") }
                    TextButton(onClick = {
                        menuMessage = null
                        deleteTarget = message
                    }) {
                        Text("删除", color = MaterialTheme.colorScheme.error)
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { menuMessage = null }) { Text("取消") }
            },
        )
    }

    // 编辑对话框
    editingMessage?.let { message ->
        AlertDialog(
            onDismissRequest = { editingMessage = null },
            containerColor = MaterialTheme.colorScheme.surface,
            title = { Text("编辑消息") },
            text = {
                OutlinedTextField(
                    value = editText,
                    onValueChange = { editText = it },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 5,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.editMessage(message.id, editText)
                        editingMessage = null
                    },
                    enabled = editText.isNotBlank(),
                ) { Text("保存") }
            },
            dismissButton = {
                TextButton(onClick = { editingMessage = null }) { Text("取消") }
            },
        )
    }

    // 删除确认
    deleteTarget?.let { message ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            containerColor = MaterialTheme.colorScheme.surface,
            title = { Text("删除消息") },
            text = { Text("确定删除这条消息？此操作会同步删除 PC 端数据。") },
            confirmButton = {
                TextButton(onClick = {
                    vm.deleteMessage(message.id)
                    deleteTarget = null
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) { Text("取消") }
            },
        )
    }
}

/** 群聊消息行：角色名 + 内容气泡（用户右侧暖金，角色左侧紫罗兰） */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun GroupMessageRow(
    message: GroupMessage,
    speakerName: (String) -> String,
    onLongPress: () -> Unit = {},
    onCopy: (() -> Unit)? = null,
    onEdit: (() -> Unit)? = null,
    onTranslate: (() -> Unit)? = null,
    onDelete: (() -> Unit)? = null,
) {
    val isUser = message.isUser
    val name = speakerName(message.characterId)
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
    ) {
        if (!isUser) {
            Text(
                name,
                style = MaterialTheme.typography.labelSmall,
                color = AssistantBubble,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.padding(start = 4.dp, bottom = 2.dp),
            )
        }
        Surface(
            color = if (isUser) {
                Accent
            } else {
                MaterialTheme.colorScheme.surface.copy(alpha = 0.92f)
            },
            shape = if (isUser) {
                RoundedCornerShape(topStart = 16.dp, topEnd = 6.dp, bottomStart = 16.dp, bottomEnd = 16.dp)
            } else {
                RoundedCornerShape(topStart = 6.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 16.dp)
            },
            border = if (!isUser) {
                androidx.compose.foundation.BorderStroke(1.dp, AssistantBubble.copy(alpha = 0.4f))
            } else {
                null
            },
            modifier = Modifier
                .widthIn(max = 300.dp)
                .then(
                    if (isUser) Modifier.shadow(6.dp, RoundedCornerShape(16.dp), ambientColor = Accent.copy(alpha = 0.3f))
                    else Modifier
                )
                .combinedClickable(onClick = {}, onLongClick = onLongPress),
        ) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                if (message.content.isNotBlank()) {
                    if (isUser) {
                        Text(message.content, style = MaterialTheme.typography.bodyMedium, color = Color(0xFF3B2410))
                    } else {
                        MarkdownText(message.content, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                // 翻译译文（斜体灰显）
                message.translation?.let { raw ->
                    val translation = stripThought(raw)
                    if (translation.isNotEmpty()) {
                        androidx.compose.foundation.layout.Spacer(
                            Modifier
                                .fillMaxWidth()
                                .height(1.dp)
                                .background(MaterialTheme.colorScheme.outlineVariant),
                        )
                        androidx.compose.foundation.layout.Spacer(Modifier.height(4.dp))
                        Text(
                            text = translation,
                            style = MaterialTheme.typography.bodyMedium.copy(
                                color = if (isUser) Color(0xFF3B2410).copy(alpha = 0.75f)
                                else MaterialTheme.colorScheme.onSurfaceVariant,
                                fontStyle = FontStyle.Italic,
                            ),
                        )
                    }
                }
                Text(
                    formatTime(message.timestamp),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (isUser) Color(0xFF3B2410).copy(alpha = 0.6f) else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 2.dp),
                )
                // 气泡操作排（翻译/复制/编辑/删除）
                Row(
                    modifier = Modifier.padding(start = 2.dp, top = 1.dp),
                    horizontalArrangement = Arrangement.spacedBy(0.dp),
                ) {
                    GroupActionChip("翻译", onTranslate)
                    GroupActionChip("复制", onCopy)
                    GroupActionChip("编辑", onEdit)
                    GroupActionChip("删除", onDelete)
                }
            }
        }
    }
}

@Composable
private fun GroupActionChip(label: String, onClick: (() -> Unit)?) {
    Text(
        text = label,
        style = MaterialTheme.typography.labelSmall,
        color = if (onClick != null) {
            MaterialTheme.colorScheme.onSurfaceVariant
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
        },
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(enabled = onClick != null) { onClick?.invoke() }
            .padding(horizontal = 6.dp, vertical = 4.dp),
    )
}

private fun formatTime(epochMs: Long): String {
    if (epochMs <= 0) return ""
    return SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(epochMs))
}
