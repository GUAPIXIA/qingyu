package com.qingyu.companion.ui.shell

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.qingyu.companion.ui.theme.qyColors

/**
 * E-01 平板端侧边导航栏（>=600dp）：会话 / 角色 / 群聊，内容区占满剩余宽度。
 * NavigationRailItem 触控目标 ≥48dp。
 */
@Composable
fun MainNavigationRail(
    selected: MainDestination,
    onSelect: (MainDestination) -> Unit,
    modifier: Modifier = Modifier,
) {
    val qy = qyColors()
    NavigationRail(
        modifier = modifier.width(80.dp),
        containerColor = qy.bg2,
        contentColor = qy.text,
    ) {
        Spacer(Modifier.height(12.dp))
        MainDestination.entries.forEach { destination ->
            val isSelected = destination == selected
            NavigationRailItem(
                selected = isSelected,
                onClick = { onSelect(destination) },
                icon = {
                    Icon(
                        imageVector = destination.icon(selected = isSelected),
                        contentDescription = stringResource(destination.labelRes),
                        modifier = Modifier.size(24.dp),
                    )
                },
                label = {
                    Text(
                        text = stringResource(destination.labelRes),
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 1,
                    )
                },
                colors = NavigationRailItemDefaults.colors(
                    selectedIconColor = qy.accent,
                    selectedTextColor = qy.accent,
                    unselectedIconColor = qy.muted,
                    unselectedTextColor = qy.muted,
                    indicatorColor = qy.accentSoft,
                ),
                modifier = Modifier.align(Alignment.CenterHorizontally),
            )
        }
    }
}
