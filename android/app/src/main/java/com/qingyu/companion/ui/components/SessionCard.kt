package com.qingyu.companion.ui.components

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import androidx.compose.ui.res.stringResource
import com.qingyu.companion.R
import com.qingyu.companion.model.SessionPreview
import com.qingyu.companion.ui.theme.qyColors
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 会话列表只展示用户实际可见的正文，包含被服务端截断的未闭合 thought。 */
fun sessionPreviewText(lastMessage: String, emptyFallback: String = "（无可见正文）"): String {
    val withoutClosedBlocks = stripThought(lastMessage)
    val withoutTruncatedBlock = normalizeThoughtTags(withoutClosedBlocks)
        .replace(Regex("""<thought(?:\s[^>]*)?>[\s\S]*$""", RegexOption.IGNORE_CASE), "")
        .trim()
    return withoutTruncatedBlock.ifBlank { emptyFallback }
}

/** 全局会话页使用“角色名-对话名”；角色历史页保留简洁的对话名。 */
fun sessionDisplayTitle(
    sessionTitle: String,
    characterName: String,
    includeCharacterName: Boolean,
    unnamedFallback: String = "未命名会话",
): String {
    val conversation = sessionTitle.trim().ifBlank { unnamedFallback }
    val character = characterName.trim()
    return if (includeCharacterName && character.isNotBlank()) {
        "$character-$conversation"
    } else {
        conversation
    }
}

/**
 * 会话列表行（方案 B）：38dp 圆头像 + 标题/预览 + 时间右对齐。
 * 纯内容行，hover 由 Surface 按压反馈承担。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SessionCard(
    session: SessionPreview,
    onClick: () -> Unit,
    onLongClick: () -> Unit = {},
    onDelete: () -> Unit,
    /** 角色头像 URL（已解析完整地址）；null 时用渐变首字 */
    avatarUrl: String? = null,
    /** 是否在预览前显示角色名行（全局会话列表 true；角色历史会话页 false） */
    showCharacterName: Boolean = true,
) {
    val qy = qyColors()
    val title = sessionDisplayTitle(
        sessionTitle = session.title,
        characterName = session.characterName,
        includeCharacterName = showCharacterName,
        unnamedFallback = stringResource(R.string.msg_unnamed_session),
    )
    val avatarName = session.characterName.ifBlank { title }
    // lastMessage 由 PC 桥接层按消息 timestamp 计算，安卓端只负责展示最新摘要。
    val latestMessage = sessionPreviewText(session.lastMessage, stringResource(R.string.msg_preview_empty))
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongClick),
        shape = RoundedCornerShape(12.dp),
        color = qy.card,
        border = BorderStroke(1.dp, qy.line),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 10.dp, end = 6.dp, top = 9.dp, bottom = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AvatarBubble(name = avatarName, avatarUrl = avatarUrl, size = 38)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        title,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Medium,
                        color = qy.text,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                }
                val preview = latestMessage
                Spacer(Modifier.height(1.dp))
                Text(
                    preview,
                    style = MaterialTheme.typography.bodySmall,
                    color = qy.muted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.width(6.dp))
            Text(
                formatSessionTime(session.updatedAt),
                style = MaterialTheme.typography.labelSmall,
                color = qy.muted,
                modifier = Modifier.padding(top = 2.dp),
            )
            Spacer(Modifier.width(2.dp))
            IconButton(
                onClick = onDelete,
                modifier = Modifier.size(28.dp),
            ) {
                Icon(
                    Icons.Outlined.DeleteOutline,
                    contentDescription = stringResource(R.string.cd_delete),
                    tint = qy.muted.copy(alpha = 0.55f),
                    modifier = Modifier.size(16.dp),
                )
            }
        }
    }
}

/**
 * 角色头像：有 URL 时加载真头像；否则按名称首字生成 Morandi 低饱和渐变。
 */
@Composable
fun AvatarBubble(name: String, avatarUrl: String? = null, size: Int = 44) {
    val shape = CircleShape
    val modifier = Modifier.size(size.dp)
    if (avatarUrl != null) {
        var loadFailed by remember(avatarUrl) { mutableStateOf(false) }
        if (loadFailed) {
            GradientFallbackAvatar(name, size, modifier)
        } else {
            AsyncImage(
                model = avatarUrl,
                contentDescription = name,
                contentScale = ContentScale.Crop,
                modifier = modifier.clip(shape),
                onError = { loadFailed = true },
            )
        }
        return
    }
    GradientFallbackAvatar(name, size, modifier)
}

/** Morandi 低饱和渐变首字兜底头像（与方案 B 色板同族） */
@Composable
private fun GradientFallbackAvatar(
    name: String,
    size: Int,
    modifier: Modifier,
) {
    val qy = qyColors()
    val seed = name.hashCode()
    val palette = listOf(
        listOf(Color(0xFF3A2F2A), Color(0xFF2A2623)), // 样例同款暖灰
        listOf(Color(0xFF443730), Color(0xFF2E2823)),
        listOf(Color(0xFF36322B), Color(0xFF262320)),
        listOf(Color(0xFF3E342C), Color(0xFF2B241F)),
    )
    val gradient = palette[Math.floorMod(seed, palette.size)]
    Box(
        modifier = modifier
            .clip(CircleShape)
            .background(Brush.linearGradient(gradient)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            name.take(1),
            style = MaterialTheme.typography.titleLarge,
            color = qy.accent,
            fontWeight = FontWeight.Medium,
        )
    }
}

private fun formatSessionTime(epochMs: Long): String {
    if (epochMs <= 0) return ""
    return SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(epochMs))
}
