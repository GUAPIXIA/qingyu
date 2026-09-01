package com.qingyu.companion.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Translate
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.qingyu.companion.R
import com.qingyu.companion.model.Message
import com.qingyu.companion.model.Role
import com.qingyu.companion.ui.theme.qyColors

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
    onCopyMarkdown: (() -> Unit)? = null,
    onShare: (() -> Unit)? = null,
    onEdit: () -> Unit,
    onTranslate: () -> Unit,
    onRegenerate: () -> Unit,
    onSpeak: () -> Unit,
    onBranch: () -> Unit,
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
                        if (message.role == Role.user) stringResource(R.string.chat_msg_me) else stringResource(R.string.chat_role_placeholder),
                        style = MaterialTheme.typography.labelSmall,
                        color = qy.accent,
                    )
                    Spacer(Modifier.height(2.dp))
                    Text(
                        message.content.replace(Regex("<[^>]+>"), "").trim().ifEmpty { stringResource(R.string.chat_msg_empty) },
                        style = MaterialTheme.typography.bodySmall,
                        color = qy.soft,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Spacer(Modifier.height(12.dp))

            // 动作行（44dp 行高，图标 + 文字）
            ActionSheetRow(Icons.AutoMirrored.Filled.Reply, stringResource(R.string.chat_action_reply), onReply)
            ActionSheetRow(Icons.Filled.ContentCopy, stringResource(R.string.chat_action_copy), onCopy)
            if (onCopyMarkdown != null) {
                ActionSheetRow(Icons.Filled.ContentCopy, stringResource(R.string.chat_action_copy_markdown), onCopyMarkdown)
            }
            if (onShare != null) {
                ActionSheetRow(Icons.Filled.Share, stringResource(R.string.chat_action_share), onShare)
            }
            if (message.role == Role.user) {
                ActionSheetRow(Icons.Filled.Edit, stringResource(R.string.chat_action_edit), onEdit)
            }
            if (message.role == Role.assistant) {
                ActionSheetRow(Icons.Filled.Refresh, stringResource(R.string.chat_action_regenerate), onRegenerate)
            }
            ActionSheetRow(Icons.Filled.Translate, stringResource(R.string.chat_action_translate), onTranslate)
            ActionSheetRow(Icons.Filled.VolumeUp, stringResource(R.string.chat_action_speak), onSpeak)
            ActionSheetRow(Icons.Filled.AccountTree, stringResource(R.string.chat_action_branch), onBranch)

            Spacer(Modifier.height(6.dp))
            HorizontalDivider(color = qy.lineSoft)
            Spacer(Modifier.height(6.dp))
            // 破坏性操作独立（低饱和红）
            ActionSheetRow(Icons.Filled.Delete, stringResource(R.string.chat_action_delete), onDelete, destructive = true)
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
