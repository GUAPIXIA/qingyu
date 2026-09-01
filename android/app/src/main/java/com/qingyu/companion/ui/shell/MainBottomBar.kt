package com.qingyu.companion.ui.shell

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.qingyu.companion.ui.theme.qyColors

/**
 * E-01 手机端底部主栏（<600dp）：会话 / 角色 / 群聊。
 * 设置入口保留页内右上角，不进底栏（方案 B：右上角＝设置）。
 * 紧凑底栏为 64dp，NavigationBarItem 仍保留完整栏宽与 ≥48dp 的可点击高度。
 */
@Composable
fun MainBottomBar(
    selected: MainDestination,
    onSelect: (MainDestination) -> Unit,
    modifier: Modifier = Modifier,
) {
    val qy = qyColors()
    NavigationBar(
        modifier = modifier
            .fillMaxWidth()
            .height(64.dp),
        containerColor = qy.bg2,
        contentColor = qy.text,
        tonalElevation = 0.dp,
    ) {
        MainDestination.entries.forEach { destination ->
            val isSelected = destination == selected
            NavigationBarItem(
                selected = isSelected,
                onClick = { onSelect(destination) },
                icon = {
                    Icon(
                        imageVector = destination.icon(selected = isSelected),
                        contentDescription = stringResource(destination.labelRes),
                        modifier = Modifier.size(22.dp),
                    )
                },
                label = {
                    Text(
                        text = stringResource(destination.labelRes),
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 1,
                    )
                },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = qy.accent,
                    selectedTextColor = qy.accent,
                    unselectedIconColor = qy.muted,
                    unselectedTextColor = qy.muted,
                    indicatorColor = qy.accentSoft,
                ),
            )
        }
    }
}
