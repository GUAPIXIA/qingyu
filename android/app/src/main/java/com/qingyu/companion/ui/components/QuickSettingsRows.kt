package com.qingyu.companion.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.model.LorebookDto
import com.qingyu.companion.model.PresetDto
import com.qingyu.companion.ui.theme.qyColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch


/** 分区：cap 小标题 + 内容，区距统一 16dp */
@Composable
internal fun PanelSection(title: String, content: @Composable () -> Unit) {
    val qy = qyColors()
    Column {
        Text(
            title,
            style = MaterialTheme.typography.labelSmall,
            color = qy.muted,
            modifier = Modifier.padding(start = 6.dp),
        )
        Spacer(Modifier.height(7.dp))
        content()
        Spacer(Modifier.height(16.dp))
    }
}

/** 卡片行：bg2 圆角 14 统一容器（lambda 内可用 weight） */

/** 卡片行：bg2 圆角 14 统一容器（lambda 内可用 weight） */
@Composable
internal fun CardRow(
    verticalPadding: Int = 12,
    content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(qyColors().bg2)
            .padding(horizontal = 12.dp, vertical = verticalPadding.dp),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

/** 空态提示 */

/** 空态提示 */
@Composable
internal fun EmptyHint(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = qyColors().muted,
        modifier = Modifier.padding(start = 6.dp, top = 2.dp, bottom = 2.dp),
    )
}

/** 键值行：标签 + 右侧值（bg2 卡片） */

/** 键值行：标签 + 右侧值（bg2 卡片） */
@Composable
internal fun ValueRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(qyColors().bg2)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodyLarge,
            color = qyColors().text,
            modifier = Modifier.weight(1f),
        )
        Text(
            value,
            style = MaterialTheme.typography.bodySmall,
            color = qyColors().muted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** 软底信息卡（摘要/事实展示） */

/** 软底信息卡（摘要/事实展示） */
@Composable
internal fun InfoCard(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(qyColors().accentSoft)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        content()
    }
}

/** 勾选行：自绘圆形勾选指示 + 标题/副标题 + 右侧计数（选中 accentSoft 底） */

/** 勾选行：自绘圆形勾选指示 + 标题/副标题 + 右侧计数（选中 accentSoft 底） */
@Composable
internal fun CheckRow(
    checked: Boolean,
    title: String,
    subtitle: String?,
    trailing: String?,
    onToggle: () -> Unit,
) {
    val qy = qyColors()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(if (checked) qy.accentSoft else qy.bg2)
            .clickable(onClick = onToggle)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CheckIndicator(checked)
        Spacer(Modifier.width(11.dp))
        Column(Modifier.weight(1f)) {
            Text(
                title,
                style = MaterialTheme.typography.bodyLarge,
                color = qy.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle != null) {
                Text(
                    subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = qy.muted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (trailing != null) {
            Text(
                trailing,
                style = MaterialTheme.typography.labelSmall,
                color = qy.muted,
            )
        }
    }
}

/** 单选行：自绘圆形选中指示 + 标题/副标题（选中 accentSoft 底） */

/** 单选行：自绘圆形选中指示 + 标题/副标题（选中 accentSoft 底） */
@Composable
internal fun SelectRow(
    selected: Boolean,
    title: String,
    subtitle: String? = null,
    onClick: () -> Unit,
) {
    val qy = qyColors()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(if (selected) qy.accentSoft else qy.bg2)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioIndicator(selected)
        Spacer(Modifier.width(11.dp))
        Column(Modifier.weight(1f)) {
            Text(
                title,
                style = MaterialTheme.typography.bodyLarge,
                color = qy.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle != null) {
                Text(
                    subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = qy.muted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** 勾选指示：20dp 圆圈，选中时 accent 实心 + 勾 */

/** 勾选指示：20dp 圆圈，选中时 accent 实心 + 勾 */
@Composable
private fun CheckIndicator(checked: Boolean) {
    val qy = qyColors()
    Box(
        modifier = Modifier
            .size(20.dp)
            .clip(CircleShape)
            .background(if (checked) qy.accent else androidx.compose.ui.graphics.Color.Transparent)
            .border(
                1.5.dp,
                if (checked) qy.accent else qy.line,
                CircleShape,
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (checked) {
            Icon(
                Icons.Filled.Check,
                contentDescription = null,
                tint = qy.onAccent,
                modifier = Modifier.size(13.dp),
            )
        }
    }
}

/** 单选指示：20dp 圆圈 + 内 8dp 实心点 */

/** 单选指示：20dp 圆圈 + 内 8dp 实心点 */
@Composable
private fun RadioIndicator(selected: Boolean) {
    val qy = qyColors()
    Box(
        modifier = Modifier
            .size(20.dp)
            .clip(CircleShape)
            .border(1.5.dp, if (selected) qy.accent else qy.line, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        if (selected) {
            Box(
                Modifier
                    .size(9.dp)
                    .clip(CircleShape)
                    .background(qy.accent)
            )
        }
    }
}
