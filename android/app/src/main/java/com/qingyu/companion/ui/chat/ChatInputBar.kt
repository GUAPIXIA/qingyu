package com.qingyu.companion.ui.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AutoFixHigh
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Image
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.qingyu.companion.R
import com.qingyu.companion.model.QuickReply
import com.qingyu.companion.ui.theme.qyColors

/** 快捷回复条：极淡胶囊 */
@Composable
internal fun QuickReplyBar(replies: List<QuickReply>, onSend: (QuickReply) -> Unit) {
    if (replies.isEmpty()) return
    val qy = qyColors()
    LazyRow(
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp),
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

/**
 * 附件菜单（E-04）：低频操作收口（续写 / 润色 / 图片），
 * 减少键盘弹出后输入区占高。菜单项与文案全部走 strings.xml。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AttachmentMenu(
    onContinue: () -> Unit,
    onPolish: () -> Unit,
    onPickImage: () -> Unit,
    onDismiss: () -> Unit,
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
            Text(
                stringResource(R.string.chat_attachment_title),
                style = MaterialTheme.typography.titleMedium,
                color = qy.text,
                modifier = Modifier.padding(vertical = 6.dp),
            )
            Spacer(Modifier.height(6.dp))
            AttachmentRow(Icons.Filled.Edit, stringResource(R.string.chat_attachment_continue), onContinue)
            AttachmentRow(Icons.Filled.AutoFixHigh, stringResource(R.string.chat_attachment_polish), onPolish)
            AttachmentRow(Icons.Filled.Image, stringResource(R.string.chat_attachment_image), onPickImage)
        }
    }
}

/** 附件菜单行（48dp 触控目标） */
@Composable
private fun AttachmentRow(icon: ImageVector, label: String, onClick: () -> Unit) {
    val qy = qyColors()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(48.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = qy.soft,
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(12.dp))
        Text(
            label,
            style = MaterialTheme.typography.bodyLarge,
            color = qy.text,
        )
    }
}

/**
 * 待发送消息的错误动作条（E-04 状态语义）：
 * - 发送失败：重试发送（vm.retryPending）；
 * - AI 失败（用户消息已提交）：仅重试 AI，不重复用户消息（vm.retryGeneration）；
 * - 离线排队：等待网络，可取消（vm.cancelPending）。
 */
@Composable
internal fun PendingErrorActions(
    pending: com.qingyu.companion.model.PendingMessage,
    connection: com.qingyu.companion.network.WsClient.State,
    onRetry: () -> Unit,
    onRetryGeneration: () -> Unit,
    onCancel: () -> Unit,
) {
    val qy = qyColors()
    val offline = connection == com.qingyu.companion.network.WsClient.State.DISCONNECTED ||
        connection == com.qingyu.companion.network.WsClient.State.RECONNECTING
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier.padding(top = 6.dp),
    ) {
        when {
            pending.failed && offline -> {
                Text(
                    stringResource(R.string.chat_error_waiting_network),
                    style = MaterialTheme.typography.labelSmall,
                    color = qy.muted,
                )
                TextButton(onClick = onCancel) {
                    Text(stringResource(R.string.chat_error_cancel_queued), color = qy.soft)
                }
            }

            pending.failed -> {
                Text(
                    stringResource(R.string.chat_error_send_failed),
                    style = MaterialTheme.typography.labelSmall,
                    color = qy.danger,
                )
                TextButton(onClick = onRetry) {
                    Text(stringResource(R.string.chat_error_retry_send), color = qy.accent)
                }
                TextButton(onClick = onRetryGeneration) {
                    Text(stringResource(R.string.chat_error_retry_generation), color = qy.accent)
                }
            }

            else -> {
                androidx.compose.material3.CircularProgressIndicator(
                    modifier = Modifier.size(12.dp),
                    strokeWidth = 2.dp,
                    color = qy.accent,
                )
                Text(
                    stringResource(R.string.chat_error_sending),
                    style = MaterialTheme.typography.labelSmall,
                    color = qy.muted,
                )
            }
        }
    }
}

/**
 * 输入栏（极简）：无边框紧凑胶囊（bg2 半透明）＋ 附件入口 + 30dp 圆形发送键。
 * E-04：附件菜单（续写/润色/图片）与错误动作语义接入。
 */
@Composable
internal fun InputBar(
    value: String,
    onValueChange: (String) -> Unit,
    streaming: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onPickImage: () -> Unit,
    onShowAttachments: () -> Unit,
    hasImage: Boolean = false,
) {
    val qy = qyColors()
    val canSend = value.isNotBlank() || hasImage
    Surface(
        color = qy.bg2.copy(alpha = 0.9f),
        shape = RoundedCornerShape(16.dp),
        border = BorderStroke(1.dp, qy.line.copy(alpha = 0.65f)),
        modifier = Modifier
            .padding(start = 12.dp, end = 12.dp, top = 3.dp, bottom = 6.dp)
            .fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // 附件入口（E-04：低频操作收口，48dp 触控目标）
            val addAttachmentLabel = stringResource(R.string.chat_cd_add_attachment)
            IconButton(
                onClick = onShowAttachments,
                modifier = Modifier
                    .size(32.dp)
                    .semantics { contentDescription = addAttachmentLabel },
            ) {
                Icon(
                    Icons.Filled.Add,
                    contentDescription = null,
                    tint = qy.muted,
                    modifier = Modifier.size(18.dp),
                )
            }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 32.dp, max = 96.dp),
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = qy.text),
                cursorBrush = SolidColor(qy.accent),
                maxLines = 4,
                decorationBox = { innerTextField ->
                    Box {
                        if (value.isEmpty()) {
                            Text(
                                stringResource(R.string.chat_input_hint),
                                style = MaterialTheme.typography.bodyMedium,
                                color = qy.muted,
                            )
                        }
                        innerTextField()
                    }
                },
            )
            Spacer(Modifier.width(4.dp))
            if (streaming) {
                val stopLabel = stringResource(R.string.chat_cd_stop_generation)
                Surface(
                    onClick = onStop,
                    shape = CircleShape,
                    color = qy.danger,
                    modifier = Modifier.semantics { contentDescription = stopLabel },
                ) {
                    Box(
                        modifier = Modifier.size(30.dp),
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
                    enabled = canSend,
                    shape = CircleShape,
                    color = if (canSend) qy.accent else qy.line.copy(alpha = 0.55f),
                    contentColor = if (canSend) qy.onAccent else qy.muted,
                ) {
                    Box(
                        modifier = Modifier.size(32.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.AutoMirrored.Filled.Send,
                            contentDescription = stringResource(R.string.cd_send),
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
        }
    }
}
