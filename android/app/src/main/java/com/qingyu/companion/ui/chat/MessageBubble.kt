package com.qingyu.companion.ui.chat

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.qingyu.companion.R
import com.qingyu.companion.model.Message
import com.qingyu.companion.model.PendingMessage
import com.qingyu.companion.model.Role
import com.qingyu.companion.ui.components.MarkdownText
import com.qingyu.companion.ui.components.MessageImages
import com.qingyu.companion.ui.components.extractThought
import com.qingyu.companion.ui.components.scaledForChat
import com.qingyu.companion.ui.components.translatedMessageContent
import com.qingyu.companion.ui.theme.qyColors
import com.qingyu.companion.utils.SearchUtils
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

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

/**
 * 本地待发送/失败消息气泡：me-bg + 描边，发送中进度。
 * E-04 错误动作语义：发送失败 → 重试发送；AI 失败 → 仅重试 AI；
 * 离线排队 → 等待网络，可取消。
 */
@Composable
internal fun PendingBubble(
    pending: PendingMessage,
    onRetry: () -> Unit,
    onRetryGeneration: () -> Unit,
    onCancel: () -> Unit,
    connection: com.qingyu.companion.network.WsClient.State,
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
                PendingErrorActions(
                    pending = pending,
                    connection = connection,
                    onRetry = onRetry,
                    onRetryGeneration = onRetryGeneration,
                    onCancel = onCancel,
                )
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

/**
 * 搜索命中文本（E-05）：命中区间高亮（accent 底 + accent 字），
 * 复用 SearchUtils.highlightMatches；无查询时原样渲染。
 */
@Composable
internal fun searchHighlightedText(text: String, query: String): androidx.compose.ui.text.AnnotatedString {
    val qy = qyColors()
    if (query.isBlank()) return androidx.compose.ui.text.AnnotatedString(text)
    return buildAnnotatedString {
        SearchUtils.highlightMatches(text, query).forEach { (part, hit) ->
            if (hit) {
                withStyle(
                    SpanStyle(
                        color = qy.accent,
                        background = qy.accent.copy(alpha = 0.16f),
                        fontStyle = FontStyle.Normal,
                    )
                ) { append(part) }
            } else {
                append(part)
            }
        }
    }
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
    isTranslating: Boolean = false,
    onDelete: (() -> Unit)? = null,
    /** 本地 UI 偏好：字体缩放系数（1f = 标准） */
    fontScale: Float = 1f,
    /** 本地 UI 偏好：消息间距倍数（1f = 标准） */
    spacingMultiplier: Float = 1f,
    /** 搜索高亮（E-05）：非空时正文/引用/翻译命中区间高亮 */
    searchQuery: String = "",
) {
    val qy = qyColors()
    val isUser = message.role == Role.user
    val isSystem = message.role == Role.system
    val displayedContent = remember(message.content, message.translation) {
        translatedMessageContent(message.content, message.translation)
    }
    val extraction = remember(displayedContent) { extractThought(displayedContent) }

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
        val config = LocalConfiguration.current
        val bubbleMax = when {
            config.screenWidthDp < 360 -> 260.dp
            config.screenWidthDp < 600 -> 312.dp
            else -> 420.dp
        }
        Column(
            horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
            modifier = Modifier.widthIn(max = bubbleMax),
        ) {
            // 角色名标签（cap 11sp 弱文字）
            if (!isUser && !isSystem) {
                Text(
                    characterName.ifBlank { stringResource(R.string.chat_role_placeholder) },
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
                            val refRole = if (ref.role == Role.user) {
                                stringResource(R.string.chat_you)
                            } else {
                                stringResource(R.string.chat_other)
                            }
                            val refContent = translatedMessageContent(ref.content, ref.translation)
                            val refPreview = refContent.take(40)
                            val refTail = if (refContent.length > 40) "…" else ""
                            Text(
                                text = searchHighlightedText(
                                    stringResource(R.string.chat_reply_prefix_fmt, refRole, refPreview) + refTail,
                                    searchQuery,
                                ),
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
                                    stringResource(R.string.chat_inner_thought),
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

                    if (isTranslating) {
                        Row(
                            modifier = Modifier.padding(top = contentGap),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            CircularProgressIndicator(
                                modifier = Modifier.width(12.dp).height(12.dp),
                                strokeWidth = 1.5.dp,
                                color = qy.accent,
                            )
                            Spacer(Modifier.width(6.dp))
                            Text(
                                stringResource(R.string.chat_action_translating),
                                style = MaterialTheme.typography.labelSmall.scaledForChat(fontScale),
                                color = qy.accent,
                            )
                        }
                    }

                    // token 用量
                    message.usage?.let { u ->
                        Text(
                            text = stringResource(
                                R.string.chat_token_usage_fmt,
                                u.promptTokens,
                                u.completionTokens,
                                u.totalTokens,
                            ),
                            style = MaterialTheme.typography.labelSmall.scaledForChat(fontScale),
                            color = qy.muted.copy(alpha = 0.8f),
                            modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                }
            }

            // 时间与气泡操作共用一行；窄屏时可横向滑动查看完整操作。
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(start = 2.dp, top = 1.dp),
                horizontalArrangement = Arrangement.spacedBy(0.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = formatTime(message.timestamp),
                    style = MaterialTheme.typography.labelSmall,
                    color = qy.muted.copy(alpha = 0.7f),
                    modifier = Modifier.padding(horizontal = 4.dp),
                )

                if (isUser) {
                    ActionChip(stringResource(R.string.chat_action_copy), onCopy)
                    ActionChip(stringResource(R.string.chat_action_edit), onEdit)
                    ActionChip(stringResource(R.string.chat_action_delete), onDelete)
                } else {
                    ActionChip(
                        stringResource(if (isTranslating) R.string.chat_action_translating else R.string.chat_action_translate),
                        onTranslate.takeUnless { isTranslating },
                    )
                    ActionChip(stringResource(R.string.chat_action_speak), onSpeak)
                    ActionChip(stringResource(R.string.chat_action_copy), onCopy)
                    ActionChip(stringResource(R.string.chat_action_edit), onEdit)
                    ActionChip(stringResource(R.string.chat_action_regenerate), onRegenerate)
                    ActionChip(stringResource(R.string.chat_action_delete), onDelete)
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
            stringResource(R.string.chat_swipe_fmt, (message.swipeIndex ?: 0) + 1, total),
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
    return SimpleDateFormat("HH:mm", Locale.getDefault())
        .format(Date(epochMs))
}
