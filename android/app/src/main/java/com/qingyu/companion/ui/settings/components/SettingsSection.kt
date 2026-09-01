package com.qingyu.companion.ui.settings.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.qingyu.companion.ui.theme.qyColors

/**
 * 设置分组卡片：标题 + 可选所有权标签（「仅本机」/「同步到当前 PC」）+ 内容
 * E-03 抽取自 SettingsScreen，编排容器与各 Section 复用
 */
@Composable
fun SettingsSection(title: String, tag: String? = null, content: @Composable () -> Unit) {
    val qy = qyColors()
    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 4.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                title,
                style = MaterialTheme.typography.labelMedium,
                color = qy.muted,
            )
            if (tag != null) {
                Spacer(Modifier.width(8.dp))
                Surface(
                    color = qy.accentSoft,
                    shape = RoundedCornerShape(50),
                ) {
                    Text(
                        tag,
                        style = MaterialTheme.typography.labelSmall,
                        color = qy.accent,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                    )
                }
            }
        }
        Surface(
            color = qy.bg2.copy(alpha = 0.7f),
            shape = RoundedCornerShape(14.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(vertical = 4.dp)) {
                content()
            }
        }
    }
}
