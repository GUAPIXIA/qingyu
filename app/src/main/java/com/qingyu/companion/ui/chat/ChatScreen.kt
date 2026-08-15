package com.qingyu.companion.ui.chat

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.activity.result.PickVisualMediaRequest
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.SuggestionChipDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import coil.compose.AsyncImage
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.model.Message
import com.qingyu.companion.model.PendingMessage
import com.qingyu.companion.model.QuickReply
import com.qingyu.companion.model.Role
import com.qingyu.companion.model.TimelineItem
import com.qingyu.companion.model.buildTimeline
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AvatarBubble
import com.qingyu.companion.ui.components.ConnectionStatusBar
import com.qingyu.companion.ui.components.ImageViewerDialog
import com.qingyu.companion.ui.components.MarkdownText
import com.qingyu.companion.ui.components.MessageImages
import com.qingyu.companion.ui.components.QuickSettingsPanel
import com.qingyu.companion.ui.components.extractThought
import com.qingyu.companion.ui.components.resolveImageUrl
import com.qingyu.companion.ui.components.stripThought
import com.qingyu.companion.ui.theme.Accent
import com.qingyu.companion.ui.theme.AssistantBubble
import com.qingyu.companion.ui.theme.TavernBorder
import com.qingyu.companion.ui.theme.UserBubble
import com.qingyu.companion.ui.tts.TtsPlayer
import com.qingyu.companion.utils.uriToCompressedBase64

/**
 * 单聊对话页（「深夜墨水与灯火」视觉）：
 * 时间线 + 渐变气泡 + 胶囊输入栏 + 流式光标 + 消息操作。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(sessionId: String, onBack: () -> Unit) {
    val container = LocalAppContainer.current
    val vm: ChatViewModel = viewModel(factory = viewModelFactory {
        initializer { ChatViewModel(container.repository, sessionId, container.ttsPlayer) }
    })
    val ui by vm.ui.collectAsState()
    val input by vm.input.collectAsState()
    val replyTo by vm.replyTo.collectAsState()
    val pendingImages by vm.images.collectAsState()
    val clipboard = LocalClipboardManager.current
    val context = androidx.compose.ui.platform.LocalContext.current

    var menuMessage by remember { mutableStateOf<Message?>(null) }
    var editingMessage by remember { mutableStateOf<Message?>(null) }
    var editText by remember { mutableStateOf("") }
    var viewer by remember { mutableStateOf<Pair<List<String>, Int>?>(null) }
    // 快捷设置面板（世界书/预设）
    var showQuickSettings by remember { mutableStateOf(false) }
    // 清空对话确认
    var showClearConfirm by remember { mutableStateOf(false) }

    // 选图（PhotoPicker，无需权限）
    val imagePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri: Uri? ->
        uri?.let {
            val base64 = uriToCompressedBase64(context, it)
            if (base64 != null) {
                vm.onImagesChange(pendingImages + base64)
            }
        }
    }

    val ttsState by container.ttsPlayer.state.collectAsState()

    DisposableEffect(Unit) {
        onDispose { container.ttsPlayer.release() }
    }

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            // 顶栏：角色头像 + 角色名 + 会话标题（头像从 PC 端同步）
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        // 角色头像（PC 端同步，相对路径拼 baseUrl）
                        val avatarUrl = resolveImageUrl(
                            ui.characterAvatarUrl,
                            container.connectionManager.activeConnection,
                        )
                        if (avatarUrl != null) {
                            var avatarFailed by remember(avatarUrl) { mutableStateOf(false) }
                            if (avatarFailed) {
                                AvatarBubble(
                                    name = ui.characterName,
                                    avatarUrl = null,
                                    size = 34,
                                )
                                Spacer(Modifier.width(10.dp))
                            } else {
                                AsyncImage(
                                    model = avatarUrl,
                                    contentDescription = ui.characterName,
                                    contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                                    modifier = Modifier
                                        .size(34.dp)
                                        .clip(CircleShape)
                                        .border(1.dp, Accent.copy(alpha = 0.4f), CircleShape),
                                    onError = { avatarFailed = true },
                                )
                                Spacer(Modifier.width(10.dp))
                            }
                        }
                        Column {
                            Text(
                                ui.characterName.ifBlank { "对话" },
                                style = MaterialTheme.typography.titleMedium,
                                color = MaterialTheme.colorScheme.onBackground,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (ui.sessionTitle.isNotBlank()) {
                                Text(
                                    ui.sessionTitle,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
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
                actions = {
                    IconButton(onClick = { showQuickSettings = true }) {
                        Icon(
                            Icons.Filled.Settings,
                            contentDescription = "对话设置",
                            tint = MaterialTheme.colorScheme.onBackground,
                        )
                    }
                    IconButton(onClick = { showClearConfirm = true }) {
                        Icon(
                            Icons.Filled.Delete,
                            contentDescription = "清空对话",
                            tint = MaterialTheme.colorScheme.onBackground,
                        )
                    }
                    ConnectionStatusBar(state = ui.connection, onTap = onBack)
                    Spacer(Modifier.width(12.dp))
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent,
                ),
            )
        },
    ) { padding ->
        AppBackground {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
            ) {
                // 时间线
                val timeline = remember(ui.messages, ui.pending) {
                    buildTimeline(ui.messages, ui.pending)
                }
                LazyColumn(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                    reverseLayout = true,
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                ) {
                    val streaming = ui.streaming as? ChatViewModel.Streaming.Generating
                    if (streaming != null && streaming.text.isNotEmpty()) {
                        item(key = "streaming") {
                            StreamingBubble(streaming.text)
                        }
                    }

                    items(timeline, key = { item ->
                        when (item) {
                            is TimelineItem.DateHeader -> "date:${item.label}"
                            is TimelineItem.Entry -> "${item.message.sessionId}:${item.message.id}"
                            is TimelineItem.PendingEntry -> "pending:${item.pending.requestId}"
                        }
                    }) { item ->
                        when (item) {
                            is TimelineItem.DateHeader -> DateHeaderRow(item.label)

                            is TimelineItem.Entry -> {
                                val referenced = ui.messages.firstOrNull { it.id == item.message.replyToId }
                                // 消息图片为相对路径（/static/messages/...），拼接当前连接的 baseUrl
                                val imageUrls = item.message.images.map {
                                    resolveImageUrl(it, container.connectionManager.activeConnection) ?: it
                                }
                                MessageBubble(
                                    message = item.message,
                                    referencedMessage = referenced,
                                    onLongPress = { menuMessage = item.message },
                                    onSwipe = { direction -> vm.swipe(item.message.id, direction) },
                                    onImageClick = { index -> viewer = imageUrls to index },
                                    imageUrls = imageUrls,
                                    onCopy = {
                                        clipboard.setText(AnnotatedString(item.message.content))
                                    },
                                    onEdit = {
                                        editingMessage = item.message
                                        editText = item.message.content
                                    },
                                    onRegenerate = { vm.regenerate(item.message.id) },
                                    onSpeak = {
                                        container.ttsPlayer.stop()
                                        vm.playTts(item.message.id)
                                    },
                                    onTranslate = { vm.translate(item.message.id) },
                                    onDelete = { vm.deleteMessage(item.message.id) },
                                )
                            }

                            is TimelineItem.PendingEntry -> PendingBubble(
                                pending = item.pending,
                                onRetry = { vm.retryPending(item.pending.requestId) },
                            )
                        }
                    }

                    ui.nextCursor?.let {
                        item(key = "load-older") {
                            Box(
                                Modifier
                                    .fillMaxWidth()
                                    .padding(8.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                TextButton(onClick = vm::loadOlder, enabled = !ui.loadingOlder) {
                                    if (ui.loadingOlder) {
                                        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                                        Spacer(Modifier.width(8.dp))
                                    }
                                    Text("加载更早消息", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                }

                // 上下文上限预警（对齐 PC 端：≥85% 黄，≥100% 红）
                ui.contextUsage?.let { usage ->
                    if (usage.max > 0 && usage.ratio >= 0.85) {
                        val danger = usage.ratio >= 1.0
                        Surface(
                            color = if (danger) {
                                MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.7f)
                            } else {
                                MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.7f)
                            },
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 12.dp, vertical = 4.dp),
                        ) {
                            Text(
                                "上下文已使用 ${usage.pct}%（${usage.used}/${usage.max} token）${if (danger) "，将裁剪早期历史" else "，接近上限"}",
                                style = MaterialTheme.typography.labelMedium,
                                color = if (danger) {
                                    MaterialTheme.colorScheme.onErrorContainer
                                } else {
                                    MaterialTheme.colorScheme.onTertiaryContainer
                                },
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                            )
                        }
                    }
                }

                ui.error?.let {
                    Text(
                        text = it,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(horizontal = 20.dp),
                    )
                }

                // TTS 状态条
                when (ttsState) {
                    TtsPlayer.State.SYNTHESIZING ->
                        StatusPill("正在合成语音…（点击停止）", isError = false) { container.ttsPlayer.stop() }

                    TtsPlayer.State.PLAYING ->
                        StatusPill("正在朗读…（点击停止）", isError = false) { container.ttsPlayer.stop() }

                    TtsPlayer.State.ERROR ->
                        StatusPill("朗读失败（PC 侧未实现 TTS 或消息不可合成）", isError = true) {}

                    TtsPlayer.State.IDLE -> Unit
                }

                // 引用条
                AnimatedVisibility(visible = replyTo != null, enter = fadeIn(), exit = fadeOut()) {
                    replyTo?.let { target ->
                        Surface(
                            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.9f),
                            shape = RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp),
                            modifier = Modifier
                                .fillMaxWidth()
                                .border(
                                    androidx.compose.foundation.BorderStroke(
                                        1.dp,
                                        Accent.copy(alpha = 0.4f),
                                    ),
                                    RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp),
                                ),
                        ) {
                            Row(
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Box(
                                    Modifier
                                        .width(3.dp)
                                        .height(28.dp)
                                        .clip(RoundedCornerShape(2.dp))
                                        .background(Accent)
                                )
                                Spacer(Modifier.width(10.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        "引用 ${if (target.role == Role.user) "你" else "对方"}",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = Accent,
                                    )
                                    Text(
                                        target.content.take(60),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                TextButton(onClick = { vm.setReplyTo(null) }) { Text("取消") }
                            }
                        }
                    }
                }

                QuickReplyBar(replies = ui.quickReplies, onSend = vm::onQuickReplyClick)

                // 待发送图片预览
                if (pendingImages.isNotEmpty()) {
                    LazyRow(
                        contentPadding = PaddingValues(horizontal = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(pendingImages.size) { index ->
                            Box {
                                MessageImages(
                                    images = listOf(pendingImages[index]),
                                    onImageClick = {},
                                )
                                // 移除按钮
                                Surface(
                                    onClick = { vm.onImagesChange(pendingImages.filterIndexed { i, _ -> i != index }) },
                                    shape = CircleShape,
                                    color = Color.Black.copy(alpha = 0.6f),
                                    modifier = Modifier.align(Alignment.TopEnd),
                                ) {
                                    Text(
                                        "×",
                                        color = Color.White,
                                        style = MaterialTheme.typography.labelMedium,
                                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                                    )
                                }
                            }
                        }
                    }
                }

                // AI 输入辅助（续写/润色，chip 样式）
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 2.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (ui.aiProcessing) {
                        Text(
                            "AI 处理中…",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(start = 8.dp, top = 8.dp),
                        )
                    } else {
                        Surface(
                            onClick = vm::aiContinue,
                            shape = RoundedCornerShape(50),
                            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.75f),
                            border = androidx.compose.foundation.BorderStroke(
                                1.dp,
                                MaterialTheme.colorScheme.outline.copy(alpha = 0.3f),
                            ),
                        ) {
                            Row(
                                Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Icon(
                                    Icons.Filled.Edit,
                                    contentDescription = null,
                                    modifier = Modifier.size(14.dp),
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Spacer(Modifier.width(4.dp))
                                Text(
                                    "AI 续写",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        Surface(
                            onClick = vm::aiPolish,
                            enabled = input.isNotBlank(),
                            shape = RoundedCornerShape(50),
                            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.75f),
                            border = androidx.compose.foundation.BorderStroke(
                                1.dp,
                                MaterialTheme.colorScheme.outline.copy(alpha = 0.3f),
                            ),
                        ) {
                            Text(
                                "润色",
                                style = MaterialTheme.typography.labelMedium,
                                color = if (input.isNotBlank()) {
                                    MaterialTheme.colorScheme.onSurfaceVariant
                                } else {
                                    MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
                                },
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                            )
                        }
                    }
                }

                InputBar(
                    value = input,
                    onValueChange = vm::onInputChange,
                    streaming = ui.streaming !is ChatViewModel.Streaming.Idle,
                    onSend = vm::send,
                    onStop = vm::stop,
                    onPickImage = {
                        imagePicker.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                        )
                    },
                    hasImage = pendingImages.isNotEmpty(),
                )
            }
        }
    }

    menuMessage?.let { message ->
        MessageActionDialog(
            message = message,
            onDismiss = { menuMessage = null },
            onReply = {
                menuMessage = null
                vm.setReplyTo(message)
            },
            onCopy = {
                clipboard.setText(AnnotatedString(message.content))
                menuMessage = null
            },
            onEdit = {
                menuMessage = null
                editingMessage = message
                editText = message.content
            },
            onTranslate = {
                menuMessage = null
                vm.translate(message.id)
            },
            onRegenerate = {
                menuMessage = null
                vm.regenerate(message.id)
            },
            onSpeak = {
                menuMessage = null
                container.ttsPlayer.stop()
                vm.playTts(message.id)
            },
            onDelete = {
                menuMessage = null
                vm.deleteMessage(message.id)
            },
        )
    }

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
                    maxLines = 6,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = Accent,
                        focusedContainerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.6f),
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
                ) { Text("保存") }
            },
            dismissButton = {
                TextButton(onClick = { editingMessage = null }) { Text("取消") }
            },
        )
    }

    viewer?.let { (images, index) ->
        ImageViewerDialog(
            images = images,
            initialIndex = index,
            onDismiss = { viewer = null },
        )
    }

    // 对话快捷设置面板
    if (showQuickSettings) {
        QuickSettingsPanel(
            sessionId = sessionId,
            onDismiss = { showQuickSettings = false },
        )
    }

    // 清空对话确认
    if (showClearConfirm) {
        AlertDialog(
            onDismissRequest = { showClearConfirm = false },
            containerColor = MaterialTheme.colorScheme.surface,
            title = { Text("清空并删除会话") },
            text = { Text("清空此会话的所有消息并删除会话，此操作会同步删除 PC 端数据，且不可恢复。") },
            confirmButton = {
                TextButton(onClick = {
                    showClearConfirm = false
                    vm.clearChat { onBack() }
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { showClearConfirm = false }) { Text("取消") }
            },
        )
    }
}

/** 状态胶囊（TTS 等轻提示） */
@Composable
private fun StatusPill(text: String, isError: Boolean, onClick: () -> Unit) {
    Surface(
        color = if (isError) {
            MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.7f)
        } else {
            MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.7f)
        },
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier
            .padding(horizontal = 16.dp, vertical = 2.dp)
            .clickable(onClick = onClick),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelMedium,
            color = if (isError) {
                MaterialTheme.colorScheme.onErrorContainer
            } else {
                MaterialTheme.colorScheme.onPrimaryContainer
            },
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
}

@Composable
private fun QuickReplyBar(replies: List<QuickReply>, onSend: (QuickReply) -> Unit) {
    if (replies.isEmpty()) return
    LazyRow(
        contentPadding = PaddingValues(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        items(replies, key = { it.id }) { reply ->
            SuggestionChip(
                onClick = { onSend(reply) },
                label = { Text(reply.label, maxLines = 1) },
                colors = SuggestionChipDefaults.suggestionChipColors(
                    containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.85f),
                    labelColor = MaterialTheme.colorScheme.onSurfaceVariant,
                ),
                border = SuggestionChipDefaults.suggestionChipBorder(
                    enabled = true,
                    borderColor = Accent.copy(alpha = 0.35f),
                ),
            )
        }
    }
}

@Composable
private fun MessageActionDialog(
    message: Message,
    onDismiss: () -> Unit,
    onReply: () -> Unit,
    onCopy: () -> Unit,
    onEdit: () -> Unit,
    onTranslate: () -> Unit,
    onRegenerate: () -> Unit,
    onSpeak: () -> Unit,
    onDelete: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = MaterialTheme.colorScheme.surface,
        title = { Text("消息操作", style = MaterialTheme.typography.titleMedium) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                TextButton(onClick = onReply) { Text("引用回复") }
                TextButton(onClick = onCopy) { Text("复制文本") }
                if (message.role == Role.user) {
                    TextButton(onClick = onEdit) {
                        Icon(Icons.Filled.Edit, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("编辑")
                    }
                }
                if (message.role == Role.assistant) {
                    TextButton(onClick = onRegenerate) {
                        Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("重新生成")
                    }
                }
                TextButton(onClick = onTranslate) { Text("翻译") }
                TextButton(onClick = onSpeak) { Text("朗读") }
                TextButton(onClick = onDelete) {
                    Icon(Icons.Filled.Delete, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("删除", color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
    )
}

/** 输入栏：胶囊玻璃 + 图片按钮 + 琥珀圆形发送按钮 */
@Composable
private fun InputBar(
    value: String,
    onValueChange: (String) -> Unit,
    streaming: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onPickImage: () -> Unit,
    hasImage: Boolean = false,
) {
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
            // 图片按钮
            IconButton(onClick = onPickImage) {
                Icon(
                    Icons.Filled.Add,
                    contentDescription = "添加图片",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            OutlinedTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier.weight(1f),
                placeholder = { Text("输入消息…") },
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
            if (streaming) {
                Surface(
                    onClick = onStop,
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.8f),
                ) {
                    Text(
                        "停止",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 14.dp),
                    )
                }
            } else {
                // 琥珀发光发送按钮
                Surface(
                    onClick = onSend,
                    enabled = value.isNotBlank() || hasImage,
                    shape = CircleShape,
                    color = Accent,
                    modifier = Modifier.shadow(10.dp, CircleShape, ambientColor = Accent.copy(alpha = 0.5f)),
                ) {
                    Box(
                        modifier = Modifier.size(48.dp),
                        contentAlignment = Alignment.Center,
                    ) {
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

@Composable
private fun DateHeaderRow(label: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .width(24.dp)
                    .height(1.dp)
                    .background(MaterialTheme.colorScheme.outline.copy(alpha = 0.4f))
            )
            Spacer(Modifier.width(10.dp))
            Text(
                label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.width(10.dp))
            Box(
                Modifier
                    .width(24.dp)
                    .height(1.dp)
                    .background(MaterialTheme.colorScheme.outline.copy(alpha = 0.4f))
            )
        }
    }
}

/** 本地待发送/失败消息气泡：发送中进度，失败重试 */
@Composable
private fun PendingBubble(pending: PendingMessage, onRetry: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.End,
    ) {
        Surface(
            color = Accent.copy(alpha = 0.25f),
            shape = BubbleShape(isUser = true),
            modifier = Modifier.widthIn(max = 300.dp),
        ) {
            Column(Modifier.padding(12.dp)) {
                Text(pending.content, style = MaterialTheme.typography.bodyMedium)
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    modifier = Modifier.padding(top = 6.dp),
                ) {
                    if (pending.failed) {
                        Text(
                            "发送失败",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                        TextButton(onClick = onRetry) { Text("重试") }
                    } else {
                        CircularProgressIndicator(
                            modifier = Modifier.size(12.dp),
                            strokeWidth = 2.dp,
                            color = Accent,
                        )
                        Text(
                            "发送中…",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

/** 流式气泡：玻璃底 + 呼吸光标 */
@Composable
private fun StreamingBubble(text: String) {
    val transition = rememberInfiniteTransition(label = "cursor")
    val blink by transition.animateFloat(
        initialValue = 1f,
        targetValue = 0.2f,
        animationSpec = infiniteRepeatable(tween(600), RepeatMode.Reverse),
        label = "cursorBlink",
    )
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.Start,
    ) {
        Surface(
            color = AssistantBubble.copy(alpha = 0.20f),
            shape = BubbleShape(isUser = false),
            border = androidx.compose.foundation.BorderStroke(
                1.dp,
                AssistantBubble.copy(alpha = 0.45f),
            ),
            modifier = Modifier.widthIn(max = 300.dp),
        ) {
            Column(Modifier.padding(12.dp)) {
                MarkdownText(extractThought(text).content)
                Text(
                    "▍",
                    color = Accent,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.alpha(blink),
                )
            }
        }
    }
}

/** 聊天气泡形状：用户=右上大圆角，AI=左上大圆角 */
private fun BubbleShape(isUser: Boolean): RoundedCornerShape =
    if (isUser) {
        RoundedCornerShape(topStart = 18.dp, topEnd = 6.dp, bottomStart = 18.dp, bottomEnd = 18.dp)
    } else {
        RoundedCornerShape(topStart = 6.dp, topEnd = 18.dp, bottomStart = 18.dp, bottomEnd = 18.dp)
    }

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageBubble(
    message: Message,
    referencedMessage: Message? = null,
    onLongPress: () -> Unit,
    onSwipe: (direction: Int) -> Unit,
    onImageClick: (index: Int) -> Unit = {},
    /** 已拼接完整 URL 的图片列表（相对路径经 resolveImageUrl 处理） */
    imageUrls: List<String> = emptyList(),
    onCopy: (() -> Unit)? = null,
    onEdit: (() -> Unit)? = null,
    onRegenerate: (() -> Unit)? = null,
    onSpeak: (() -> Unit)? = null,
    onTranslate: (() -> Unit)? = null,
    onDelete: (() -> Unit)? = null,
) {
    val isUser = message.role == Role.user
    val isSystem = message.role == Role.system
    val extraction = remember(message.content) { extractThought(message.content) }
    var thoughtExpanded by remember(message.content) { mutableStateOf(false) }

    // 气泡入场动画（消息新增时缩放 + 淡入）
    var appeared by remember(message.id) { mutableStateOf(false) }
    val scale by animateFloatAsState(
        targetValue = if (appeared) 1f else 0.92f,
        animationSpec = tween(220),
        label = "bubbleScale",
    )
    val bubbleAlpha by animateFloatAsState(
        targetValue = if (appeared) 1f else 0f,
        animationSpec = tween(260),
        label = "bubbleAlpha",
    )
    LaunchedEffect(message.id) { appeared = true }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .alpha(bubbleAlpha)
            .padding(vertical = 4.dp),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        if (!isUser) {
            // AI 灯火标记
            Box(
                Modifier
                    .padding(end = 6.dp, top = 2.dp)
                    .size(26.dp)
                    .clip(CircleShape)
                    .background(
                        Brush.linearGradient(listOf(Accent.copy(alpha = 0.85f), AssistantBubble.copy(alpha = 0.7f)))
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "✦",
                    style = MaterialTheme.typography.labelMedium,
                    color = Color.White,
                )
            }
        }

        Column(
            horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
            modifier = Modifier.widthIn(max = 312.dp),
        ) {
            Surface(
                color = if (isUser) {
                    Brush.linearGradient(listOf(Accent, Accent.copy(alpha = 0.9f)))
                        .let { Color.Transparent }
                } else {
                    AssistantBubble.copy(alpha = 0.20f)
                },
                shape = BubbleShape(isUser),
                border = if (!isUser) {
                    androidx.compose.foundation.BorderStroke(
                        1.dp,
                        AssistantBubble.copy(alpha = 0.45f),
                    )
                } else {
                    null
                },
                modifier = Modifier
                    .then(
                        if (isUser) {
                            Modifier
                                .shadow(8.dp, BubbleShape(true), ambientColor = Accent.copy(alpha = 0.35f))
                                .background(
                                    Brush.linearGradient(listOf(Accent, Accent.copy(alpha = 0.88f))),
                                    BubbleShape(true),
                                )
                        } else {
                            Modifier
                                .shadow(4.dp, BubbleShape(false), ambientColor = Color.Black.copy(alpha = 0.25f))
                        }
                    )
                    .combinedClickable(onClick = {}, onLongClick = onLongPress),
            ) {
                Column(Modifier.padding(12.dp)) {
                    // 引用块
                    referencedMessage?.let { ref ->
                        Surface(
                            color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                text = buildString {
                                    append(if (ref.role == Role.user) "你" else "对方")
                                    append("：")
                                    append(ref.content.take(40))
                                    if (ref.content.length > 40) append("…")
                                },
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.padding(6.dp),
                            )
                        }
                        Spacer(Modifier.height(6.dp))
                    }

                    // 心理描写折叠（灯火标签）
                    if (extraction.thought != null && !isSystem) {
                        Surface(
                            onClick = { thoughtExpanded = !thoughtExpanded },
                            shape = RoundedCornerShape(8.dp),
                            color = Accent.copy(alpha = 0.14f),
                            border = androidx.compose.foundation.BorderStroke(
                                1.dp,
                                Accent.copy(alpha = 0.35f),
                            ),
                        ) {
                            Text(
                                if (thoughtExpanded) "收起心理描写 ▲" else "展开心理描写 ▼",
                                style = MaterialTheme.typography.labelMedium,
                                color = Accent,
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                            )
                        }
                        if (thoughtExpanded) {
                            Spacer(Modifier.height(6.dp))
                            MarkdownText(
                                extraction.thought,
                                style = MaterialTheme.typography.bodyMedium.copy(
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    fontStyle = FontStyle.Italic,
                                ),
                            )
                        }
                    }

                    if (isUser) {
                        // 用户消息也走 Markdown 渲染（对齐 PC 端 ReactMarkdown），保留用户气泡深棕文字色
                        MarkdownText(
                            extraction.content,
                            style = MaterialTheme.typography.bodyMedium.copy(color = Color(0xFF3B2410)),
                        )
                    } else {
                        MarkdownText(extraction.content)
                    }

                    // 图片（imageUrls 已拼接完整 URL）
                    if (imageUrls.isNotEmpty()) {
                        Spacer(Modifier.height(6.dp))
                        MessageImages(
                            images = imageUrls,
                            onImageClick = onImageClick,
                        )
                    }

                    // 翻译
                    message.translation?.let { rawTranslation ->
                        val translation = stripThought(rawTranslation)
                        if (translation.isNotEmpty()) {
                            Spacer(
                                Modifier
                                    .fillMaxWidth()
                                    .height(1.dp)
                                    .background(MaterialTheme.colorScheme.outlineVariant)
                            )
                            Text(
                                text = translation,
                                style = MaterialTheme.typography.bodyMedium.copy(
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    fontStyle = FontStyle.Italic,
                                ),
                                modifier = Modifier.padding(top = 6.dp),
                            )
                        }
                    }

                    // token 用量
                    message.usage?.let { u ->
                        Text(
                            text = "↑${u.promptTokens} · ↓${u.completionTokens} · 共 ${u.totalTokens} tokens",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                            modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                }
            }

            // 时间戳
            Text(
                text = formatTime(message.timestamp),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                modifier = Modifier.padding(start = 4.dp, end = 4.dp, top = 2.dp),
            )

            // 气泡操作排（对齐 PC 端 MessageActionBar）
            Row(
                modifier = Modifier.padding(start = 2.dp, top = 1.dp),
                horizontalArrangement = Arrangement.spacedBy(0.dp),
            ) {
                if (isUser) {
                    ActionChip("复制", onCopy)
                    ActionChip("编辑", onEdit)
                    ActionChip("删除", onDelete)
                } else {
                    ActionChip("翻译", onTranslate)
                    ActionChip("朗读", onSpeak)
                    ActionChip("复制", onCopy)
                    ActionChip("编辑", onEdit)
                    ActionChip("重新生成", onRegenerate)
                    ActionChip("删除", onDelete)
                }
            }

            if (!isUser) {
                SwipeControl(message = message, onSwipe = onSwipe)
            }
        }
    }
}

@Composable
private fun ActionChip(label: String, onClick: (() -> Unit)?) {
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

@Composable
private fun SwipeControl(message: Message, onSwipe: (direction: Int) -> Unit) {
    val total = message.swipes?.size ?: return
    if (total <= 1) return
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(top = 2.dp),
    ) {
        Surface(
            onClick = { onSwipe(-1) },
            shape = CircleShape,
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.8f),
        ) {
            Text("◀", modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
        }
        Text(
            " ${(message.swipeIndex ?: 0) + 1}/$total ",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Surface(
            onClick = { onSwipe(1) },
            shape = CircleShape,
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.8f),
        ) {
            Text("▶", modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
        }
    }
}

/** 消息气泡时间戳（HH:mm） */
private fun formatTime(epochMs: Long): String {
    if (epochMs <= 0) return ""
    return java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault())
        .format(java.util.Date(epochMs))
}
