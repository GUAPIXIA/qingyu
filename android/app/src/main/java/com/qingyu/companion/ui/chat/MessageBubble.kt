package com.qingyu.companion.ui.chat

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
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
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Translate
import androidx.compose.material.icons.filled.VolumeUp
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
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontStyle
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
import com.qingyu.companion.ui.components.ImageViewerDialog
import com.qingyu.companion.ui.components.MarkdownText
import com.qingyu.companion.ui.components.MessageImages
import com.qingyu.companion.ui.components.QuickSettingsPanel
import com.qingyu.companion.ui.components.extractThought
import com.qingyu.companion.ui.components.resolveImageUrl
import com.qingyu.companion.ui.components.scaledForChat
import com.qingyu.companion.ui.components.stripThought
import com.qingyu.companion.ui.theme.qyColors
import com.qingyu.companion.ui.tts.TtsPlayer
import com.qingyu.companion.utils.uriToCompressedBase64

/** 日期分隔：中线 + cap 字 */
@Composable
internal fun DateHeaderRow(label: String) {
    val qy = qyColors()
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
                    .background(qy.line.copy(alpha = 0.6f))
            )
            Spacer(Modifier.width(10.dp))
            Text(
                label,
                style = MaterialTheme.typography.labelSmall,
                color = qy.muted,
            )
            Spacer(Modifier.width(10.dp))
            Box(
                Modifier
                    .width(24.dp)
                    .height(1.dp)
                    .background(qy.line.copy(alpha = 0.6f))
            )
        }
    }
}

/** 本地待发送/失败消息气泡：me-bg + 描边，发送中进度，失败重试 */
@Composable
internal fun PendingBubble(
    pending: PendingMessage,
    onRetry: () -> Unit,
    fontScale: Float = 1f,
    spacingMultiplier: Float = 1f,
) {
    val qy = qyColors()
    val spacing = spacingMultiplier.coerceIn(0.6f, 1.6f)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = (4 * spacing).dp),
        horizontalArrangement = Arrangement.End,
    ) {
        Surface(
            color = qy.meBubble.copy(alpha = 0.6f),
            shape = BubbleShape(isUser = true),
            border = BorderStroke(1.dp, qy.line),
            modifier = Modifier.widthIn(max = 300.dp),
        ) {
            Column(Modifier.padding(horizontal = 10.dp, vertical = (10 * spacing).dp)) {
                Text(
                    pending.content,
                    style = MaterialTheme.typography.bodyMedium.scaledForChat(fontScale),
                    color = qy.text,
                )
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    modifier = Modifier.padding(top = (6 * spacing).dp),
                ) {
                    if (pending.failed) {
                        Text(
                            "发送失败",
                            style = MaterialTheme.typography.labelSmall.scaledForChat(fontScale),
                            color = qy.danger,
                        )
                        TextButton(onClick = onRetry) { Text("重试", color = qy.accent) }
                    } else {
                        CircularProgressIndicator(
                            modifier = Modifier.size(12.dp),
                            strokeWidth = 2.dp,
                            color = qy.accent,
                        )
                        Text(
                            "发送中…",
                            style = MaterialTheme.typography.labelSmall.scaledForChat(fontScale),
                            color = qy.muted,
                        )
                    }
                }
            }
        }
    }
}

/** 流式气泡：ai-bg + 呼吸光标 */
@Composable
internal fun StreamingBubble(
    text: String,
    fontScale: Float = 1f,
    spacingMultiplier: Float = 1f,
) {
    val qy = qyColors()
    val spacing = spacingMultiplier.coerceIn(0.6f, 1.6f)
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
            .padding(vertical = (4 * spacing).dp),
        horizontalArrangement = Arrangement.Start,
    ) {
        Surface(
            color = qy.aiBubble,
            shape = BubbleShape(isUser = false),
            modifier = Modifier.widthIn(max = 300.dp),
        ) {
            Column(Modifier.padding(horizontal = 10.dp, vertical = (10 * spacing).dp)) {
                MarkdownText(
                    extractThought(text).content,
                    style = MaterialTheme.typography.bodyLarge.copy(color = qy.text),
                    fontScale = fontScale,
                    spacingMultiplier = spacing,
                )
                Text(
                    "▍",
                    color = qy.accent,
                    style = MaterialTheme.typography.bodyLarge.scaledForChat(fontScale),
                    modifier = Modifier.alpha(blink),
                )
            }
        }
    }
}

/** 气泡形状（方案 B）：AI=16/左上6，用户=18/右上6 */
private fun BubbleShape(isUser: Boolean): RoundedCornerShape =
    if (isUser) {
        RoundedCornerShape(topStart = 18.dp, topEnd = 6.dp, bottomStart = 18.dp, bottomEnd = 18.dp)
    } else {
        RoundedCornerShape(topStart = 6.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 16.dp)
    }

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun MessageBubble(
    message: Message,
    referencedMessage: Message? = null,
    /** 角色名（气泡上方标签；空白时回退「角色」） */
    characterName: String = "",
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
    /** 本地 UI 偏好：字体缩放系数（1f = 标准） */
    fontScale: Float = 1f,
    /** 本地 UI 偏好：消息间距倍数（1f = 标准） */
    spacingMultiplier: Float = 1f,
) {
    val qy = qyColors()
    val isUser = message.role == Role.user
    val isSystem = message.role == Role.system
    val extraction = remember(message.content) { extractThought(message.content) }

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
    // 本地 UI 偏好：消息间距同时控制气泡间距和气泡内的垂直留白。
    val spacing = spacingMultiplier.coerceIn(0.6f, 1.6f)
    val bubbleSpacingDp = (7 * spacing).dp
    val bubbleInnerVertical = (9 * spacing).dp
    val contentGap = (6 * spacing).dp

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .alpha(bubbleAlpha)
            .padding(vertical = bubbleSpacingDp),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
            modifier = Modifier.widthIn(max = 312.dp),
        ) {
            // 角色名标签（cap 11sp 弱文字）
            if (!isUser && !isSystem) {
                Text(
                    characterName.ifBlank { "角色" },
                    style = MaterialTheme.typography.labelSmall.scaledForChat(fontScale),
                    color = qy.muted,
                    modifier = Modifier.padding(start = 4.dp, bottom = 2.dp),
                )
            }
            Surface(
                color = if (isUser) qy.meBubble else qy.aiBubble,
                shape = BubbleShape(isUser),
                border = if (isUser) BorderStroke(1.dp, qy.line) else null,
                modifier = Modifier
                    .combinedClickable(onClick = {}, onLongClick = onLongPress),
            ) {
                Column(Modifier.padding(horizontal = 13.dp, vertical = bubbleInnerVertical)) {
                    // 引用块
                    referencedMessage?.let { ref ->
                        Surface(
                            color = qy.bg.copy(alpha = 0.5f),
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
                                style = MaterialTheme.typography.labelSmall.scaledForChat(fontScale),
                                color = qy.muted,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.padding(6.dp),
                            )
                        }
                        Spacer(Modifier.height(contentGap))
                    }

                    // 内心想法：在对话文字上方（左 3dp 细条 + 强调软底 + 斜体）
                    if (extraction.thought != null && !isSystem) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(bottom = contentGap)
                                .clip(
                                    RoundedCornerShape(
                                        topStart = 0.dp, topEnd = 8.dp,
                                        bottomStart = 8.dp, bottomEnd = 8.dp,
                                    )
                                )
                                .background(qy.accentSoft),
                        ) {
                            Box(
                                Modifier
                                    .width(3.dp)
                                    .fillMaxHeight()
                                    .background(qy.accent),
                            )
                            Column(Modifier.padding(horizontal = 11.dp, vertical = (7 * spacing).dp)) {
                                Text(
                                    "内心想法",
                                    style = MaterialTheme.typography.labelSmall.scaledForChat(fontScale),
                                    color = qy.accent,
                                )
                                Spacer(Modifier.height((2 * spacing).dp))
                                MarkdownText(
                                    extraction.thought,
                                    style = MaterialTheme.typography.bodySmall.copy(
                                        color = qy.soft,
                                        fontStyle = FontStyle.Italic,
                                    ),
                                    onUserBubble = isUser,
                                    fontScale = fontScale,
                                    spacingMultiplier = spacing,
                                )
                            }
                        }
                    }

                    // 正文（body 14.5 · 1.7 行距）
                    MarkdownText(
                        extraction.content,
                        style = MaterialTheme.typography.bodyLarge.copy(
                            color = qy.text,
                        ),
                        onUserBubble = isUser,
                        fontScale = fontScale,
                        spacingMultiplier = spacing,
                    )

                    // 图片（imageUrls 已拼接完整 URL）
                    if (imageUrls.isNotEmpty()) {
                        Spacer(Modifier.height(contentGap))
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
                                    .background(qy.lineSoft)
                            )
                            Text(
                                text = translation,
                                style = MaterialTheme.typography.bodySmall.scaledForChat(fontScale).copy(
                                    color = qy.soft,
                                    fontStyle = FontStyle.Italic,
                                ),
                                modifier = Modifier.padding(top = contentGap),
                            )
                        }
                    }

                    // token 用量
                    message.usage?.let { u ->
                        Text(
                            text = "↑${u.promptTokens} · ↓${u.completionTokens} · 共 ${u.totalTokens} tokens",
                            style = MaterialTheme.typography.labelSmall.scaledForChat(fontScale),
                            color = qy.muted.copy(alpha = 0.8f),
                            modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                }
            }

            // 时间戳
            Text(
                text = formatTime(message.timestamp),
                style = MaterialTheme.typography.labelSmall,
                color = qy.muted.copy(alpha = 0.7f),
                modifier = Modifier.padding(start = 4.dp, end = 4.dp, top = 2.dp),
            )

            // 气泡操作排（对齐 PC 端 MessageActionBar）
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(start = 2.dp, top = 1.dp),
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
    val qy = qyColors()
    Text(
        text = label,
        style = MaterialTheme.typography.labelSmall,
        color = if (onClick != null) qy.muted else qy.muted.copy(alpha = 0.4f),
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
    val qy = qyColors()
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(top = 2.dp),
    ) {
        Surface(
            onClick = { onSwipe(-1) },
            shape = CircleShape,
            color = qy.bg2,
        ) {
            Text(
                "◀",
                color = qy.soft,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }
        Text(
            " ${(message.swipeIndex ?: 0) + 1}/$total ",
            style = MaterialTheme.typography.labelSmall,
            color = qy.muted,
        )
        Surface(
            onClick = { onSwipe(1) },
            shape = CircleShape,
            color = qy.bg2,
        ) {
            Text(
                "▶",
                color = qy.soft,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }
    }
}

/** 消息气泡时间戳（HH:mm） */
private fun formatTime(epochMs: Long): String {
    if (epochMs <= 0) return ""
    return java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault())
        .format(java.util.Date(epochMs))
}
