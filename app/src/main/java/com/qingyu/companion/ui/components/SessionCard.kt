package com.qingyu.companion.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
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
import androidx.compose.material.icons.filled.Delete
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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.qingyu.companion.model.SessionPreview
import com.qingyu.companion.ui.theme.TavernBgCard
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 会话卡片（全局会话列表与角色历史会话列表共用）。
 * 对齐 PC 端配色：紫灰玻璃卡 + 角色渐变头像 + 标题 + 预览 + 时间。
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
    /** 是否在标题前显示角色名（全局会话列表 true；角色历史会话页 false 避免重复） */
    showCharacterName: Boolean = true,
) {
    val title = session.title.ifBlank { "未命名会话" }
    val avatarName = session.characterName.ifBlank { title }
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .shadow(10.dp, RoundedCornerShape(20.dp), ambientColor = Color.Black.copy(alpha = 0.35f))
            .combinedClickable(onClick = onClick, onLongClick = onLongClick),
        shape = RoundedCornerShape(20.dp),
        color = TavernBgCard.copy(alpha = 0.94f),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.25f)),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AvatarBubble(name = avatarName, avatarUrl = avatarUrl, size = 48)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                // 角色名独占一行（完整优先，超长省略），便于区分角色
                if (showCharacterName && session.characterName.isNotBlank()) {
                    Text(
                        session.characterName,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.height(2.dp))
                }
                // 会话名 + 时间
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        title,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        formatSessionTime(session.updatedAt),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f),
                    )
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    session.lastMessage.ifBlank { "（无消息）" },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.85f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.width(2.dp))
            IconButton(
                onClick = onDelete,
                modifier = Modifier.size(32.dp),
            ) {
                Icon(
                    Icons.Filled.Delete,
                    contentDescription = "删除",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f),
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

/** 角色头像：有 URL 时加载真头像（PC 端同步），否则按标题首字符生成渐变；加载失败时自动回退渐变 */
@Composable
fun AvatarBubble(name: String, avatarUrl: String? = null, size: Int = 44) {
    val shape = RoundedCornerShape(14.dp)
    val shadowModifier = Modifier
        .size(size.dp)
        .shadow(6.dp, shape, ambientColor = Color.Black.copy(alpha = 0.3f))
    if (avatarUrl != null) {
        var loadFailed by remember(avatarUrl) { mutableStateOf(false) }
        if (loadFailed) {
            GradientFallbackAvatar(name, size, shape, shadowModifier)
        } else {
            AsyncImage(
                model = avatarUrl,
                contentDescription = name,
                contentScale = ContentScale.Crop,
                modifier = shadowModifier
                    .clip(shape),
                onError = { loadFailed = true },
            )
        }
        return
    }
    GradientFallbackAvatar(name, size, shape, shadowModifier)
}

/** 渐变首字兜底头像 */
@Composable
private fun GradientFallbackAvatar(
    name: String,
    size: Int,
    shape: RoundedCornerShape,
    shadowModifier: Modifier,
) {
    val seed = name.hashCode()
    val palette = listOf(
        listOf(Color(0xFFD4A574), Color(0xFF8E633C)), // 暖金
        listOf(Color(0xFF9B7EDE), Color(0xFF5A3F8E)), // 紫罗兰
        listOf(Color(0xFF7EC97E), Color(0xFF3F6F52)), // 松绿
        listOf(Color(0xFFE08C7A), Color(0xFF8E4A3C)), // 珊瑚
        listOf(Color(0xFF5B9BD5), Color(0xFF2E5A85)), // 海洋蓝
        listOf(Color(0xFFE0C068), Color(0xFF8E7A2E)), // 麦金
    )
    val gradient = palette[Math.floorMod(seed, palette.size)]
    Box(
        modifier = shadowModifier
            .clip(shape)
            .background(Brush.linearGradient(gradient)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            name.take(1),
            style = MaterialTheme.typography.titleLarge,
            color = Color.White.copy(alpha = 0.95f),
            fontWeight = FontWeight.Bold,
        )
    }
}

private fun formatSessionTime(epochMs: Long): String {
    if (epochMs <= 0) return ""
    return SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(epochMs))
}
