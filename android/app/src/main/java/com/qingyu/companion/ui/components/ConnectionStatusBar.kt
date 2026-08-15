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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.qingyu.companion.network.WsClient
import com.qingyu.companion.ui.theme.Lantern
import com.qingyu.companion.ui.theme.MintGreen
import com.qingyu.companion.ui.theme.NightSky
import com.qingyu.companion.ui.theme.PaperDim

/**
 * 连接状态栏：色点 + 文案，点击可进入配对/管理页（方案 §3.1 连接管理、断线重连可视化）。
 */
@Composable
fun ConnectionStatusBar(
    state: WsClient.State,
    onTap: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val (color, label) = when (state) {
        WsClient.State.CONNECTED -> MintGreen to "已连接"
        WsClient.State.CONNECTING -> NightSky to "连接中"
        WsClient.State.RECONNECTING -> Lantern to "重连中"
        WsClient.State.DISCONNECTED -> MaterialTheme.colorScheme.error to "未连接"
    }
    Row(
        modifier = modifier.clickable(onClick = onTap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(10.dp)
                .background(color, CircleShape)
        )
        Spacer(Modifier.width(6.dp))
        Text(text = label, style = MaterialTheme.typography.labelMedium)
    }
}
