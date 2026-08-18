package com.qingyu.companion.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.qingyu.companion.network.WsClient
import com.qingyu.companion.ui.theme.qyColors

/**
 * 连接状态栏：胶囊色点 + 文案，点击可进入配对/管理页（方案 §3.1 连接管理、断线重连可视化）。
 * 方案 B：纯色胶囊（accentSoft/danger 软底），小圆点指示状态，无边框无阴影。
 */
@Composable
fun ConnectionStatusBar(
    state: WsClient.State,
    onTap: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val qy = qyColors()
    val connected = state == WsClient.State.CONNECTED
    val offline = state == WsClient.State.DISCONNECTED
    val label = when (state) {
        WsClient.State.CONNECTED -> "已连接"
        WsClient.State.CONNECTING -> "连接中"
        WsClient.State.RECONNECTING -> "重连中"
        WsClient.State.DISCONNECTED -> "未连接"
    }
    val fg = when {
        connected -> qy.accent
        offline -> qy.danger
        else -> qy.soft
    }
    val capsuleBg = when {
        connected -> qy.accentSoft
        offline -> qy.danger.copy(alpha = 0.12f)
        else -> qy.bg2
    }
    val dot = when {
        connected -> qy.accent
        offline -> qy.danger
        else -> qy.warn
    }
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(capsuleBg)
            .clickable(onClick = onTap)
            .padding(horizontal = 7.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(5.dp)
                .background(dot, CircleShape)
        )
        Spacer(Modifier.width(4.dp))
        Text(text = label, style = MaterialTheme.typography.labelSmall, color = fg)
    }
}
