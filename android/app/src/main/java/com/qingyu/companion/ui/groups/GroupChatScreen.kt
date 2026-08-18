package com.qingyu.companion.ui.groups

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Translate
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
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
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.MarkdownText
import com.qingyu.companion.ui.components.extractThought
import com.qingyu.companion.ui.components.stripThought
import com.qingyu.companion.ui.theme.qyColors
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale


/**
 * 群聊消息页（方案 B · 情感极简）：成员消息列表（角色名 + 内容）+ 发言输入框。
 * 气泡对齐单聊规范：AI ai-bg（16/左上6、无边框）、用户 me-bg + 描边（18/右上6）；
 * 输入栏 bg2 圆角 22 + 细描边 + 圆形暖金发送键。
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
    val qy = qyColors()
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
            AppTopBar(
                title = groupName,
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "返回",
                            tint = qy.soft,
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
                Box(Modifier.weight(1f)) {
                    when {
                        ui.loading && ui.messages.isEmpty() ->
                            CircularProgressIndicator(Modifier.align(Alignment.Center), color = qy.accent)

                        ui.messages.isEmpty() -> Text(
                            "暂无消息，说点什么吧",
                            modifier = Modifier.align(Alignment.Center),
                            color = qy.soft,
                        )

                        else -> LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            items(ui.messages, key = { it.id }) { message ->
                                GroupMessageRow(
                                    message = message,
                                    speakerName = vm::speakerName,
                                    mentionNames = memberNames.values.toList(),
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
                        color = qy.danger,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(horizontal = 16.dp),
                    )
                }

                // 输入栏（方案 B）：bg2 圆角 22 + 细描边 + 40dp 圆形暖金发送键（收窄 2/5，居中）
                Surface(
                    color = qy.bg2,
                    shape = RoundedCornerShape(22.dp),
                    border = BorderStroke(1.dp, qy.line),
                    modifier = Modifier
                        .fillMaxWidth(0.6f)
                        .padding(vertical = 8.dp)
                        .align(Alignment.CenterHorizontally),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 14.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        BasicTextField(
                            value = input,
                            onValueChange = vm::onInputChange,
                            modifier = Modifier
                                .weight(1f)
                                .heightIn(min = 40.dp, max = 132.dp),
                            textStyle = MaterialTheme.typography.bodyLarge.copy(color = qy.text),
                            cursorBrush = SolidColor(qy.accent),
                            maxLines = 4,
                            decorationBox = { innerTextField ->
                                Box {
                                    if (input.isEmpty()) {
                                        Text(
                                            "发言…（AI 群聊回复待二期）",
                                            style = MaterialTheme.typography.bodyLarge,
                                            color = qy.muted,
                                        )
                                    }
                                    innerTextField()
                                }
                            },
                        )
                        Spacer(Modifier.width(10.dp))
                        Surface(
                            onClick = vm::send,
                            enabled = input.isNotBlank() && !ui.sending,
                            shape = CircleShape,
                            color = qy.accent,
                            contentColor = qy.onAccent,
                        ) {
                            Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                                if (ui.sending) {
                                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = qy.onAccent)
                                } else {
                                    Icon(
                                        Icons.AutoMirrored.Filled.Send,
                                        contentDescription = "发送",
                                        modifier = Modifier.size(16.dp),
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 消息长按操作面板（方案 B 底部面板：card 底、顶部圆角 24、44dp 动作行）
    menuMessage?.let { message ->
        GroupMessageActionSheet(
            message = message,
            speaker = vm.speakerName(message.characterId),
            onDismiss = { menuMessage = null },
            onEdit = {
                menuMessage = null
                editingMessage = message
                editText = message.content
            },
            onTranslate = {
                menuMessage = null
                vm.translate(message.id)
            },
            onDelete = {
                menuMessage = null
                deleteTarget = message
            },
        )
    }

    // 编辑对话框
    editingMessage?.let { message ->
        AlertDialog(
            onDismissRequest = { editingMessage = null },
            containerColor = qy.card,
            title = { Text("编辑消息", color = qy.text) },
            text = {
                OutlinedTextField(
                    value = editText,
                    onValueChange = { editText = it },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 5,
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
                TextButton(
                    onClick = {
                        vm.editMessage(message.id, editText)
                        editingMessage = null
                    },
                    enabled = editText.isNotBlank(),
                ) { Text("保存", color = qy.accent) }
            },
            dismissButton = {
                TextButton(onClick = { editingMessage = null }) { Text("取消", color = qy.soft) }
            },
        )
    }

    // 删除确认
    deleteTarget?.let { message ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            containerColor = qy.card,
            title = { Text("删除消息", color = qy.text) },
            text = { Text("确定删除这条消息？此操作会同步删除 PC 端数据。", color = qy.soft) },
            confirmButton = {
                TextButton(onClick = {
                    vm.deleteMessage(message.id)
                    deleteTarget = null
                }) { Text("删除", color = qy.danger) }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) { Text("取消", color = qy.soft) }
            },
        )
    }
}

/** 群消息操作面板（方案 B 底部弹出）：grip + 消息预览 + 44dp 动作行 + 红色删除 */
