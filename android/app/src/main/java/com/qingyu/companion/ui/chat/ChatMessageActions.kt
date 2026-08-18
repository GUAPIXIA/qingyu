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
import com.qingyu.companion.ui.components.stripThought
import com.qingyu.companion.ui.theme.qyColors
import com.qingyu.companion.ui.tts.TtsPlayer
import com.qingyu.companion.utils.uriToCompressedBase64

/** 状态胶囊（TTS 等轻提示）：软底胶囊 */
@Composable
internal fun StatusPill(text: String, isError: Boolean, onClick: () -> Unit) {
    val qy = qyColors()
    Surface(
        color = if (isError) qy.danger.copy(alpha = 0.12f) else qy.accentSoft,
        shape = RoundedCornerShape(50),
        modifier = Modifier
            .padding(horizontal = 16.dp, vertical = 2.dp)
            .clickable(onClick = onClick),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelMedium,
            color = if (isError) qy.danger else qy.accent,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp),
        )
    }
}

/** 消息操作面板（方案 B 底部弹出）：grip + 消息预览 + 44dp 动作行 + 红色删除 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MessageActionDialog(
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
    val qy = qyColors()
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = qy.card,
        shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 18.dp)
                .padding(bottom = 24.dp),
        ) {
            // grip 把手
            Box(
                Modifier
                    .width(36.dp)
                    .height(4.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(qy.line)
                    .align(Alignment.CenterHorizontally)
            )
            Spacer(Modifier.height(14.dp))

            // 消息预览（bg2 软底）
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = qy.bg2,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                    Text(
                        if (message.role == Role.user) "我" else "角色",
                        style = MaterialTheme.typography.labelSmall,
                        color = qy.accent,
                    )
                    Spacer(Modifier.height(2.dp))
                    Text(
                        message.content.replace(Regex("<[^>]+>"), "").trim().ifEmpty { "（空消息）" },
                        style = MaterialTheme.typography.bodySmall,
                        color = qy.soft,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Spacer(Modifier.height(12.dp))

            // 动作行（44dp 行高，图标 + 文字）
            ActionSheetRow(Icons.AutoMirrored.Filled.Reply, "引用回复", onReply)
            ActionSheetRow(Icons.Filled.ContentCopy, "复制文本", onCopy)
            if (message.role == Role.user) {
                ActionSheetRow(Icons.Filled.Edit, "编辑", onEdit)
            }
            if (message.role == Role.assistant) {
                ActionSheetRow(Icons.Filled.Refresh, "重新生成", onRegenerate)
            }
            ActionSheetRow(Icons.Filled.Translate, "翻译", onTranslate)
            ActionSheetRow(Icons.Filled.VolumeUp, "朗读", onSpeak)

            Spacer(Modifier.height(6.dp))
            HorizontalDivider(color = qy.lineSoft)
            Spacer(Modifier.height(6.dp))
            // 破坏性操作独立（低饱和红）
            ActionSheetRow(Icons.Filled.Delete, "删除", onDelete, destructive = true)
        }
    }
}

/** 动作面板行：图标 + 文字（行高 44dp） */
@Composable
private fun ActionSheetRow(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    destructive: Boolean = false,
) {
    val qy = qyColors()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .height(44.dp)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = if (destructive) qy.danger else qy.soft,
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(12.dp))
        Text(
            label,
            style = MaterialTheme.typography.bodyLarge,
            color = if (destructive) qy.danger else qy.text,
        )
    }
}
