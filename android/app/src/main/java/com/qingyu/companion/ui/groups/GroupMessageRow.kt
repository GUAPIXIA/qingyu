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


/** 群聊消息行（方案 B）：成员名 cap 弱文字；用户气泡 me-bg + 描边，角色气泡 ai-bg 无边框 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun GroupMessageRow(
    message: GroupMessage,
    speakerName: (String) -> String,
    /** @提及高亮名单（群成员名，@角色名 高亮显示） */
    mentionNames: List<String> = emptyList(),
    onLongPress: () -> Unit = {},
    onCopy: (() -> Unit)? = null,
    onEdit: (() -> Unit)? = null,
    onTranslate: (() -> Unit)? = null,
    onDelete: (() -> Unit)? = null,
) {
    val qy = qyColors()
    val isUser = message.isUser
    val name = speakerName(message.characterId)
    val extraction = remember(message.content) { extractThought(message.content) }
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
    ) {
        if (!isUser) {
            Text(
                name,
                style = MaterialTheme.typography.labelSmall,
                color = qy.muted,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.padding(start = 4.dp, bottom = 2.dp),
            )
        }
        Surface(
            color = if (isUser) qy.meBubble else qy.aiBubble,
            shape = GroupBubbleShape(isUser),
            border = if (isUser) BorderStroke(1.dp, qy.line) else null,
            modifier = Modifier
                .widthIn(max = 300.dp)
                .combinedClickable(onClick = {}, onLongClick = onLongPress),
        ) {
            Column(Modifier.padding(horizontal = 13.dp, vertical = 9.dp)) {
                // 心理描写块：正文上方（左 3dp accent 细条 + accentSoft 底 + 斜体）
                if (extraction.thought != null) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(bottom = 7.dp)
                            .height(IntrinsicSize.Min)
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
                        Column(Modifier.padding(horizontal = 11.dp, vertical = 7.dp)) {
                            Text(
                                "内心想法",
                                style = MaterialTheme.typography.labelSmall,
                                color = qy.accent,
                            )
                            Spacer(Modifier.height(2.dp))
                            MarkdownText(
                                extraction.thought,
                                style = MaterialTheme.typography.bodySmall.copy(
                                    color = qy.soft,
                                    fontStyle = FontStyle.Italic,
                                ),
                                onUserBubble = isUser,
                                mentionNames = mentionNames,
                            )
                        }
                    }
                }
                if (extraction.content.isNotBlank()) {
                    // 用户/角色消息统一走 Markdown 渲染（用户消息对齐 PC：Markdown + 气泡内配色适配）
                    MarkdownText(
                        extraction.content,
                        style = MaterialTheme.typography.bodyMedium.copy(color = qy.text),
                        onUserBubble = isUser,
                        mentionNames = mentionNames,
                    )
                }
                // 翻译译文（斜体灰显）
                message.translation?.let { raw ->
                    val translation = stripThought(raw)
                    if (translation.isNotEmpty()) {
                        Spacer(
                            Modifier
                                .fillMaxWidth()
                                .height(1.dp)
                                .background(qy.lineSoft),
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = translation,
                            style = MaterialTheme.typography.bodyMedium.copy(
                                color = qy.soft,
                                fontStyle = FontStyle.Italic,
                            ),
                        )
                    }
                }
                Text(
                    formatTime(message.timestamp),
                    style = MaterialTheme.typography.labelSmall,
                    color = qy.muted,
                    modifier = Modifier.padding(top = 2.dp),
                )
                // 气泡操作排（翻译/复制/编辑/删除）
                Row(
                    modifier = Modifier.padding(start = 2.dp, top = 1.dp),
                    horizontalArrangement = Arrangement.spacedBy(0.dp),
                ) {
                    GroupActionChip("翻译", onTranslate)
                    GroupActionChip("复制", onCopy)
                    GroupActionChip("编辑", onEdit)
                    GroupActionChip("删除", onDelete)
                }
            }
        }
    }
}

/** 群气泡形状（对齐单聊规范）：用户=18/右上6，角色=16/左上6 */

/** 群气泡形状（对齐单聊规范）：用户=18/右上6，角色=16/左上6 */
private fun GroupBubbleShape(isUser: Boolean): RoundedCornerShape =
    if (isUser) {
        RoundedCornerShape(topStart = 18.dp, topEnd = 6.dp, bottomStart = 18.dp, bottomEnd = 18.dp)
    } else {
        RoundedCornerShape(topStart = 6.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 16.dp)
    }

@Composable
private fun GroupActionChip(label: String, onClick: (() -> Unit)?) {
    val qy = qyColors()
    Text(
        text = label,
        style = MaterialTheme.typography.labelSmall,
        color = if (onClick != null) {
            qy.muted
        } else {
            qy.muted.copy(alpha = 0.4f)
        },
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(enabled = onClick != null) { onClick?.invoke() }
            .padding(horizontal = 6.dp, vertical = 4.dp),
    )
}

private fun formatTime(epochMs: Long): String {
    if (epochMs <= 0) return ""
    return SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(epochMs))
}
