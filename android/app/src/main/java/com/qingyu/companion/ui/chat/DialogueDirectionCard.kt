package com.qingyu.companion.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.qingyu.companion.R
import com.qingyu.companion.model.DialogueDirection
import com.qingyu.companion.ui.theme.qyColors

/**
 * 气泡外的“下一步方向”卡片：点选只回填输入框，不自动发送。
 * 草稿非空时先内联确认，避免覆盖用户正在编辑的内容（对齐桌面端 §3.1）。
 */
@Composable
internal fun DialogueDirectionCard(
    directions: List<DialogueDirection>,
    /** 是否为最新一条消息；仅最新一条允许“换一批”。 */
    canRegenerate: Boolean,
    onSelect: (DialogueDirection) -> Unit,
    /** 当前草稿，用于判断是否需要覆盖确认。 */
    currentDraft: () -> String,
    onRegenerate: (() -> Unit)? = null,
    error: String? = null,
    modifier: Modifier = Modifier,
) {
    val qy = qyColors()
    var selectedId by remember(directions) { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf<DialogueDirection?>(null) }

    fun commit(direction: DialogueDirection) {
        onSelect(direction)
        selectedId = direction.id
        pending = null
    }

    Column(
        modifier = modifier
            .widthIn(max = 320.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(qy.bg2.copy(alpha = 0.6f))
            .border(1.dp, qy.line, RoundedCornerShape(12.dp))
            .padding(10.dp),
    ) {
        Text(
            stringResource(R.string.chat_directions_title),
            style = MaterialTheme.typography.labelSmall,
            color = qy.soft,
        )
        Spacer(Modifier.height(6.dp))

        directions.forEach { direction ->
            val selected = selectedId == direction.id
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 2.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (selected) qy.accentSoft else qy.bg.copy(alpha = 0.5f))
                    .border(
                        1.dp,
                        if (selected) qy.accent.copy(alpha = 0.5f) else qy.line,
                        RoundedCornerShape(8.dp),
                    )
                    .padding(horizontal = 8.dp, vertical = 7.dp),
                verticalAlignment = Alignment.Top,
            ) {
                val onClick = {
                    val current = currentDraft().trim()
                    if (current.isEmpty() || current == direction.content.trim()) {
                        commit(direction)
                    } else {
                        pending = direction
                    }
                }
                Text(
                    direction.label,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (selected) qy.accent else qy.muted,
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(if (selected) qy.accentSoft else qy.bg2)
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                )
                Spacer(Modifier.padding(horizontal = 3.dp))
                Text(
                    direction.content,
                    style = MaterialTheme.typography.labelSmall,
                    color = qy.muted,
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(6.dp))
                        .clickableNoRipple(onClick),
                )
            }
        }

        pending?.let { direction ->
            Spacer(Modifier.height(6.dp))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(qy.accentSoft)
                    .padding(horizontal = 8.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(R.string.chat_directions_overwrite),
                    style = MaterialTheme.typography.labelSmall,
                    color = qy.muted,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        stringResource(R.string.chat_directions_cancel),
                        style = MaterialTheme.typography.labelSmall,
                        color = qy.muted,
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickableNoRipple { pending = null }
                            .padding(horizontal = 8.dp, vertical = 3.dp),
                    )
                    Text(
                        stringResource(R.string.chat_directions_replace),
                        style = MaterialTheme.typography.labelSmall,
                        color = qy.accent,
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickableNoRipple { commit(direction) }
                            .padding(horizontal = 8.dp, vertical = 3.dp),
                    )
                }
            }
        }

        if (error != null) {
            Spacer(Modifier.height(4.dp))
            Text(error, style = MaterialTheme.typography.labelSmall, color = qy.danger)
        }

        if (canRegenerate && onRegenerate != null) {
            Spacer(Modifier.height(4.dp))
            Text(
                stringResource(R.string.chat_directions_regenerate),
                style = MaterialTheme.typography.labelSmall,
                color = qy.muted,
                modifier = Modifier
                    .align(Alignment.End)
                    .clip(RoundedCornerShape(6.dp))
                    .clickableNoRipple(onRegenerate)
                    .padding(horizontal = 8.dp, vertical = 3.dp),
            )
        }
    }
}

/** 无涟漪点击（对齐现有 ActionChip 的轻量交互）。 */
@Suppress("ComposableModifierFactory")
@Composable
private fun Modifier.clickableNoRipple(onClick: () -> Unit): Modifier =
    this.clickable(
        enabled = true,
        indication = null,
        interactionSource = remember { MutableInteractionSource() },
        onClick = onClick,
    )
