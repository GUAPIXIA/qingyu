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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
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


/** 快捷回复条：极淡胶囊 */
@Composable
internal fun QuickReplyBar(replies: List<QuickReply>, onSend: (QuickReply) -> Unit) {
    if (replies.isEmpty()) return
    val qy = qyColors()
    LazyRow(
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(replies, key = { it.id }) { reply ->
            Surface(
                onClick = { onSend(reply) },
                shape = RoundedCornerShape(50),
                color = qy.accentSoft,
            ) {
                Text(
                    reply.label,
                    style = MaterialTheme.typography.bodySmall,
                    color = qy.accent,
                    maxLines = 1,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                )
            }
        }
    }
}

/** 输入栏（极简）：无边框胶囊（bg2 半透明）＋ 36dp 圆形发送键 */
@Composable
internal fun InputBar(
    value: String,
    onValueChange: (String) -> Unit,
    streaming: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onPickImage: () -> Unit,
    hasImage: Boolean = false,
) {
    val qy = qyColors()
    Surface(
        color = qy.bg2.copy(alpha = 0.95f),
        shape = RoundedCornerShape(21.dp),
        modifier = Modifier
            .padding(horizontal = 12.dp, vertical = 0.dp)
            .fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = onPickImage,
                modifier = Modifier.size(32.dp),
            ) {
                Icon(
                    Icons.Filled.Add,
                    contentDescription = "添加图片",
                    tint = qy.soft,
                    modifier = Modifier.size(20.dp),
                )
            }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 32.dp, max = 120.dp),
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = qy.text),
                cursorBrush = SolidColor(qy.accent),
                maxLines = 4,
                decorationBox = { innerTextField ->
                    Box {
                        if (value.isEmpty()) {
                            Text(
                                "输入消息…",
                                style = MaterialTheme.typography.bodyLarge,
                                color = qy.muted,
                            )
                        }
                        innerTextField()
                    }
                },
            )
            Spacer(Modifier.width(6.dp))
            if (streaming) {
                Surface(
                    onClick = onStop,
                    shape = CircleShape,
                    color = qy.danger,
                ) {
                    Box(
                        modifier = Modifier.size(32.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "■",
                            style = MaterialTheme.typography.titleSmall,
                            color = Color.White,
                        )
                    }
                }
            } else {
                Surface(
                    onClick = onSend,
                    enabled = value.isNotBlank() || hasImage,
                    shape = CircleShape,
                    color = if (value.isNotBlank() || hasImage) qy.accent else qy.line,
                    contentColor = qy.onAccent,
                ) {
                    Box(
                        modifier = Modifier.size(32.dp),
                        contentAlignment = Alignment.Center,
                    ) {
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
