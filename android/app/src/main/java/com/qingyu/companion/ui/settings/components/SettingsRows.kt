package com.qingyu.companion.ui.settings.components

import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.qingyu.companion.ui.theme.qyColors

/**
 * 设置导航行：标题 + 副标题 + 可选忙碌态 + 右箭头
 * E-03 抽取自 SettingsScreen
 */
@Composable
fun SettingsNavRow(
    title: String,
    subtitle: String,
    onClick: (() -> Unit)? = null,
    busy: Boolean = false,
    danger: Boolean = false,
) {
    val qy = qyColors()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .clickable(enabled = onClick != null) { onClick?.invoke() }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                title,
                style = MaterialTheme.typography.bodyLarge,
                color = if (danger) qy.danger else qy.text,
            )
            Spacer(Modifier.height(2.dp))
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = qy.soft,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (busy) {
            CircularProgressIndicator(
                Modifier.padding(start = 8.dp).size(16.dp),
                strokeWidth = 2.dp,
                color = qy.accent,
            )
        } else if (onClick != null) {
            Icon(
                Icons.Filled.ChevronRight,
                contentDescription = null,
                tint = qy.muted,
                modifier = Modifier.padding(start = 8.dp),
            )
        }
    }
}

/**
 * 设置开关行：标题 + 副标题 + Switch
 * E-03 抽取自 SettingsScreen（SettingSwitchRow → 公共复用）
 */
@Composable
fun SettingsSwitchRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    val qy = qyColors()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = qy.text)
            Spacer(Modifier.height(2.dp))
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = qy.soft,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(8.dp))
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
        )
    }
}
