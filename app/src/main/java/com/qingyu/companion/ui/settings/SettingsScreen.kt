package com.qingyu.companion.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.BuildConfig
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.theme.Lantern

/**
 * 设置页：
 * - 连接与安全：连接管理（跳配对页）、「退出时清除」二次确认（方案 §6.9）；
 * - 数据：「清除本地缓存」（保留连接）；
 * - 远程访问：内网穿透指引（方案 §5.2 三路线，详见 docs/内网穿透指引.md）；
 * - 关于：版本与 API 兼容信息。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onOpenPairing: () -> Unit,
    onOpenUsage: () -> Unit = {},
    onOpenAnnouncements: () -> Unit = {},
) {
    val container = LocalAppContainer.current
    val vm: SettingsViewModel = viewModel(factory = viewModelFactory {
        initializer { SettingsViewModel(container.repository, container.connectionManager) }
    })
    val ui by vm.ui.collectAsState()
    var confirmWipe by remember { mutableStateOf(false) }
    var showTunnelGuide by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            AppTopBar(
                title = "设置",
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        AppBackground {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Section("连接与安全") {
                RowItem(
                    title = "连接管理",
                    subtitle = "已配对 ${ui.connectionCount} 台 PC，切换 / 移除 / 重新配对",
                    onClick = onOpenPairing,
                )
                ui.activeConnection?.let { conn ->
                    RowItem(
                        title = "当前连接",
                        subtitle = "${conn.name}（${conn.host}:${conn.port}）· 设备 ID ${conn.deviceId.take(8)}",
                    )
                }
                RowItem(
                    title = "退出时清除全部数据",
                    subtitle = "清除本地缓存与全部连接配置，下次启动需重新配对（方案 §6.9）",
                    onClick = { confirmWipe = true },
                    danger = true,
                )
            }

            Section("数据") {
                RowItem(
                    title = "清除本地缓存",
                    subtitle = "仅清除离线会话缓存，保留连接配置",
                    onClick = vm::clearCache,
                    busy = ui.clearingCache,
                )
            }

            Section("远程访问") {
                RowItem(
                    title = "内网穿透指引",
                    subtitle = "局域网外连接 PC 的三条路线（Tailscale / ZeroTier / frp）",
                    onClick = { showTunnelGuide = true },
                )
            }

            Section("关于") {
                RowItem(
                    title = "用量统计",
                    subtitle = "只读查看今日/累计字符用量（阶段三）",
                    onClick = onOpenUsage,
                )
                RowItem(
                    title = "公告",
                    subtitle = "查看来自 PC 侧的公告同步",
                    onClick = onOpenAnnouncements,
                )
                RowItem(
                    title = "轻语伴侣",
                    subtitle = "版本 ${BuildConfig.VERSION_NAME}（build ${BuildConfig.VERSION_CODE}）· API v1",
                )
            }

            ui.message?.let { message ->
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (ui.isError) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.primary
                    },
                )
            }
        }
        }
    }

    if (confirmWipe) {
        AlertDialog(
            onDismissRequest = { confirmWipe = false },
            title = { Text("退出时清除") },
            text = { Text("将删除本地缓存与全部已配对 PC 的连接配置（PC 端数据不受影响）。确认继续？") },
            confirmButton = {
                TextButton(onClick = {
                    confirmWipe = false
                    vm.wipeAll()
                }) { Text("清除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { confirmWipe = false }) { Text("取消") }
            },
        )
    }

    if (showTunnelGuide) {
        TunnelGuideDialog(onDismiss = { showTunnelGuide = false })
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            title,
            style = MaterialTheme.typography.labelLarge,
            color = Lantern,
            modifier = Modifier.padding(start = 6.dp),
        )
        androidx.compose.material3.Surface(
            modifier = Modifier
                .fillMaxWidth()
                .shadow(8.dp, RoundedCornerShape(18.dp), ambientColor = Color.Black.copy(alpha = 0.3f)),
            shape = RoundedCornerShape(18.dp),
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
            border = androidx.compose.foundation.BorderStroke(
                1.dp,
                MaterialTheme.colorScheme.outline.copy(alpha = 0.25f),
            ),
        ) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                content()
            }
        }
    }
}

@Composable
private fun RowItem(
    title: String,
    subtitle: String,
    onClick: (() -> Unit)? = null,
    danger: Boolean = false,
    busy: Boolean = false,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                title,
                style = MaterialTheme.typography.bodyLarge,
                color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
            )
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (busy) {
            Spacer(Modifier.padding(start = 8.dp))
            CircularProgressIndicator(Modifier.padding(8.dp), strokeWidth = 2.dp)
        }
    }
}

/**
 * 内网穿透指引（方案 §5.2 远程访问三条路线）。
 * 完整版见 docs/内网穿透指引.md（PC 侧文档区）。
 */
@Composable
private fun TunnelGuideDialog(onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("远程访问（局域网外连接 PC）") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("1. 推荐：用户自备内网穿透（Tailscale / ZeroTier / frp）", style = MaterialTheme.typography.titleSmall)
                Text("零开发量：安装客户端、登录同一账号即可组网，手机直连 PC 局域网 IP。", style = MaterialTheme.typography.bodySmall)
                Text("2. 自建中继服务（二期评估）", style = MaterialTheme.typography.titleSmall)
                Text("复用 PC 侧 server/ 部署链路做 WS 转发中继；需考虑消息隐私（中继可见明文，建议端到端加密或仅转发密文）。", style = MaterialTheme.typography.bodySmall)
                Text("3. 云厂商 P2P 打洞", style = MaterialTheme.typography.titleSmall)
                Text("复杂度高，不建议。", style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("知道了") }
        },
    )
}
