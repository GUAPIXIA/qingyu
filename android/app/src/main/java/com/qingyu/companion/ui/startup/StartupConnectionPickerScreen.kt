package com.qingyu.companion.ui.startup

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.res.stringResource
import com.qingyu.companion.R
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.data.StartupRepositoryImpl
import com.qingyu.companion.data.StartupSnapshot
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.theme.qyColors
import kotlinx.coroutines.launch

/**
 * 启动设备选择页（A-03 CONNECTION_PICKER）：
 * 有已配对连接但无有效 active（id 丢失 / 指向已删除设备 / active token 解密失败）时进入。
 * 不自动选择设备——由用户点选后 switchTo 激活（等待本地激活完成）并进会话；
 * 也可跳转配对页新增设备。token 解密失败的连接标记"需要修复连接"：仅诊断提示，不删数据。
 * 数据只读本地快照（[StartupRepositoryImpl]），不等待网络。
 */
@Composable
fun StartupConnectionPickerScreen(
    onOpenPairing: () -> Unit,
    onPicked: () -> Unit,
) {
    val container = LocalAppContainer.current
    val qy = qyColors()
    val scope = rememberCoroutineScope()

    var snapshot by remember { mutableStateOf<StartupSnapshot?>(null) }
    var switchingDeviceId by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        snapshot = runCatching { StartupRepositoryImpl(container.connectionStore).loadStartupSnapshot() }
            .getOrDefault(StartupSnapshot())
    }

    Scaffold(
        containerColor = Color.Transparent,
        topBar = { AppTopBar(title = stringResource(R.string.startup_picker_title)) },
    ) { padding ->
        AppBackground {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    stringResource(R.string.startup_picker_heading),
                    style = MaterialTheme.typography.titleMedium,
                    color = qy.text,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    stringResource(R.string.startup_picker_desc),
                    style = MaterialTheme.typography.bodySmall,
                    color = qy.soft,
                )
                Spacer(Modifier.height(4.dp))

                val current = snapshot
                if (current == null) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        strokeWidth = 2.dp,
                        color = qy.accent,
                    )
                } else {
                    current.connections.forEach { conn ->
                        StartupConnectionRow(
                            connection = conn,
                            needsRepair = conn.deviceId in current.corruptedDeviceIds,
                            enabled = switchingDeviceId == null,
                            busy = switchingDeviceId == conn.deviceId,
                            onClick = {
                                switchingDeviceId = conn.deviceId
                                scope.launch {
                                    // 等待本地激活（setActive + activate）完成再进会话；WS 建链异步不阻塞
                                    runCatching { container.connectionManager.switchTo(conn.deviceId) }
                                    switchingDeviceId = null
                                    onPicked()
                                }
                            },
                        )
                    }
                    if (current.connections.isEmpty()) {
                        Text(
                            stringResource(R.string.startup_picker_empty),
                            style = MaterialTheme.typography.bodyMedium,
                            color = qy.soft,
                        )
                    }
                }

                Button(
                    onClick = onOpenPairing,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(48.dp),
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = qy.accent,
                        contentColor = qy.onAccent,
                    ),
                ) {
                    Text(stringResource(R.string.startup_picker_new_pc), fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

/** 设备条目：名称 + 主机:端口；token 损坏时显示"需要修复连接"提示（不删数据） */
@Composable
private fun StartupConnectionRow(
    connection: ServerConnection,
    needsRepair: Boolean,
    enabled: Boolean,
    busy: Boolean,
    onClick: () -> Unit,
) {
    val qy = qyColors()
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(qy.bg2)
            .border(1.dp, qy.line, RoundedCornerShape(14.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                connection.name,
                style = MaterialTheme.typography.titleMedium,
                color = qy.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (busy) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = qy.accent)
            } else if (needsRepair) {
                Text(
                    stringResource(R.string.startup_picker_needs_repair),
                    style = MaterialTheme.typography.labelSmall,
                    color = qy.danger,
                )
            }
        }
        Text(
            "${connection.host}:${connection.port}",
            style = MaterialTheme.typography.bodySmall,
            color = qy.soft,
        )
    }
}
