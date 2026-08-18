package com.qingyu.companion.ui.settings

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.BuildConfig
import com.qingyu.companion.data.ChatFontScale
import com.qingyu.companion.data.ChatSpacing
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.data.ThemeMode
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.theme.qyColors
import kotlinx.coroutines.launch

/**
 * 设置页（方案 B · 情感极简 · 分组卡片）：
 * - 外观：主题模式 / 聊天字体 / 消息间距 / 角色封面背景（本地偏好，不回写 PC）；
 * - 连接与安全：连接管理、当前连接、退出时清除；
 * - 数据：清除本地缓存；
 * - 远程访问：内网穿透指引（Tailscale / ZeroTier / frp）；
 * - 关于：用量统计 / 公告 / 版本 / 检查更新。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onOpenPairing: () -> Unit,
    onOpenUsage: () -> Unit = {},
    onOpenAnnouncements: () -> Unit = {},
) {
    val qy = qyColors()
    val container = LocalAppContainer.current
    val vm: SettingsViewModel = viewModel(factory = viewModelFactory {
        initializer { SettingsViewModel(container.repository, container.connectionManager) }
    })
    val ui by vm.ui.collectAsState()
    var confirmWipe by remember { mutableStateOf(false) }
    var showTunnelGuide by remember { mutableStateOf(false) }
    var showFontOptions by remember { mutableStateOf(false) }
    var showSpacingOptions by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    // 本地 UI 偏好（字体缩放/消息间距/主题/封面背景）
    val fontScale by container.uiPrefsStore.fontScale.collectAsState(initial = 1f)
    val spacingMult by container.uiPrefsStore.spacingMultiplier.collectAsState(initial = 1f)
    val themeMode by container.uiPrefsStore.themeMode.collectAsState(initial = ThemeMode.SYSTEM)
    val bgEnabled by container.uiPrefsStore.chatBackground.collectAsState(initial = true)

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            AppTopBar(
                title = "设置",
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "返回",
                            tint = qy.soft,
                        )
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
                Section("外观") {
                    // 主题模式（三档：深色/浅色/跟随系统）
                    OptionPickerRow(
                        label = "主题模式",
                        subtitle = themeMode.label,
                        options = ThemeMode.entries,
                        selected = themeMode,
                        labelOf = { it.label },
                        onSelect = { mode -> scope.launch { container.uiPrefsStore.setThemeMode(mode) } },
                    )
                    // 聊天字体大小
                    SettingNavRow(
                        title = "聊天字体大小",
                        subtitle = "${ChatFontScale.entries.firstOrNull { it.scale == fontScale }?.label ?: "标准"} · 即时生效",
                        onClick = {
                            showFontOptions = !showFontOptions
                            showSpacingOptions = false
                        },
                    )
                    if (showFontOptions) {
                        Column {
                            ChatFontScale.entries.forEach { option ->
                                SettingChoiceRow(
                                    title = option.label,
                                    subtitle = "正文与行距 ×${option.scale}",
                                    selected = option.scale == fontScale,
                                    onClick = {
                                        scope.launch { container.uiPrefsStore.setFontScale(option) }
                                        showFontOptions = false
                                    },
                                )
                            }
                        }
                    }
                    // 消息间距
                    SettingNavRow(
                        title = "消息间距",
                        subtitle = "${ChatSpacing.entries.firstOrNull { it.multiplier == spacingMult }?.label ?: "标准"} · 段落与气泡同步",
                        onClick = {
                            showSpacingOptions = !showSpacingOptions
                            showFontOptions = false
                        },
                    )
                    if (showSpacingOptions) {
                        Column {
                            ChatSpacing.entries.forEach { option ->
                                SettingChoiceRow(
                                    title = option.label,
                                    subtitle = "气泡、段落与 Markdown 块 ×${option.multiplier}",
                                    selected = option.multiplier == spacingMult,
                                    onClick = {
                                        scope.launch { container.uiPrefsStore.setSpacing(option) }
                                        showSpacingOptions = false
                                    },
                                )
                            }
                        }
                    }
                    // 角色封面背景
                    SettingSwitchRow(
                        title = "角色封面背景",
                        subtitle = "对话页使用角色封面作沉浸背景",
                        checked = bgEnabled,
                        onCheckedChange = { enabled -> scope.launch { container.uiPrefsStore.setChatBackground(enabled) } },
                    )
                }

                Section("连接与安全") {
                    SettingNavRow(
                        title = "连接管理",
                        subtitle = "已配对 ${ui.connectionCount} 台 PC，切换 / 移除 / 重新配对",
                        onClick = onOpenPairing,
                    )
                    ui.activeConnection?.let { conn ->
                        SettingNavRow(
                            title = "当前连接",
                            subtitle = "${conn.name}（${conn.host}:${conn.port}）· 设备 ID ${conn.deviceId.take(8)}",
                        )
                    }
                    SettingNavRow(
                        title = "退出时清除全部数据",
                        subtitle = "清除本地缓存与全部连接配置，下次启动需重新配对",
                        onClick = { confirmWipe = true },
                        danger = true,
                    )
                }

                Section("数据") {
                    SettingNavRow(
                        title = "清除本地缓存",
                        subtitle = "仅清除离线会话缓存，保留连接配置",
                        onClick = vm::clearCache,
                        busy = ui.clearingCache,
                    )
                }

                Section("远程访问") {
                    SettingNavRow(
                        title = "内网穿透指引",
                        subtitle = "局域网外连接 PC 的三条路线（Tailscale / ZeroTier / frp）",
                        onClick = { showTunnelGuide = true },
                    )
                }

                Section("关于") {
                    SettingNavRow(
                        title = "用量统计",
                        subtitle = "只读查看今日/累计字符用量",
                        onClick = onOpenUsage,
                    )
                    SettingNavRow(
                        title = "公告",
                        subtitle = "查看来自 PC 侧的公告同步",
                        onClick = onOpenAnnouncements,
                    )
                    SettingNavRow(
                        title = "轻语伴侣",
                        subtitle = "版本 ${BuildConfig.VERSION_NAME}（build ${BuildConfig.VERSION_CODE}）· API v1",
                    )
                    SettingNavRow(
                        title = "检查更新",
                        subtitle = when {
                            ui.checkingVersion -> "正在获取最新版本…"
                            ui.latestVersion != null -> "服务器最新版本 ${ui.latestVersion!!.effectiveVersion}"
                            else -> "从公告服务器获取最新版本号"
                        },
                        onClick = vm::checkVersion,
                        busy = ui.checkingVersion,
                    )
                }

                ui.message?.let { message ->
                    Text(
                        text = message,
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (ui.isError) qy.danger else qy.accent,
                    )
                }
            }
        }
    }

    ui.latestVersion?.let { info ->
        val context = LocalContext.current
        AlertDialog(
            onDismissRequest = vm::clearLatestVersion,
            containerColor = qy.card,
            title = { Text("最新版本 ${info.effectiveVersion}", color = qy.text) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("当前版本 ${BuildConfig.VERSION_NAME}（build ${BuildConfig.VERSION_CODE}）", color = qy.soft)
                    if (info.effectiveChangelog.isNotBlank()) {
                        Text(
                            "更新内容",
                            style = MaterialTheme.typography.labelLarge,
                            color = qy.accent,
                        )
                        Text(
                            info.effectiveChangelog,
                            style = MaterialTheme.typography.bodySmall,
                            color = qy.soft,
                        )
                    }
                    if (info.effectiveDownloadUrl.isBlank()) {
                        Text(
                            "本次更新暂无下载链接",
                            style = MaterialTheme.typography.bodySmall,
                            color = qy.soft,
                        )
                    }
                }
            },
            confirmButton = {
                if (info.effectiveDownloadUrl.isNotBlank()) {
                    TextButton(onClick = {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(info.effectiveDownloadUrl)))
                    }) { Text("下载", color = qy.accent) }
                }
            },
            dismissButton = {
                TextButton(onClick = vm::clearLatestVersion) { Text("关闭", color = qy.soft) }
            },
        )
    }

    if (confirmWipe) {
        AlertDialog(
            onDismissRequest = { confirmWipe = false },
            containerColor = qy.card,
            title = { Text("退出时清除", color = qy.text) },
            text = {
                Text(
                    "将删除本地缓存与全部已配对 PC 的连接配置（PC 端数据不受影响）。确认继续？",
                    color = qy.soft,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmWipe = false
                    vm.wipeAll()
                }) { Text("清除", color = qy.danger) }
            },
            dismissButton = {
                TextButton(onClick = { confirmWipe = false }) { Text("取消", color = qy.soft) }
            },
        )
    }

    if (showTunnelGuide) {
        TunnelGuideDialog(onDismiss = { showTunnelGuide = false })
    }
}

/** 设置分组卡片：标题 + 内容（bg2 圆角卡片内嵌行） */
@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    val qy = qyColors()
    Column(Modifier.fillMaxWidth()) {
        Text(
            title,
            style = MaterialTheme.typography.labelMedium,
            color = qy.muted,
            modifier = Modifier.padding(start = 4.dp, bottom = 6.dp),
        )
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

/** 设置导航行：标题 + 副标题 + 可选忙碌态 + 右箭头 */
@Composable
internal fun SettingNavRow(
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
                Modifier.padding(start = 8.dp),
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

/** 设置开关行：标题 + 副标题 + Switch */
@Composable
internal fun SettingSwitchRow(
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

/** 可展开设置的单项选择行：只高亮真正选中的档位。 */
@Composable
private fun SettingChoiceRow(
    title: String,
    subtitle: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val qy = qyColors()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 26.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                title,
                style = MaterialTheme.typography.bodyMedium,
                color = if (selected) qy.accent else qy.text,
            )
            Text(
                subtitle,
                style = MaterialTheme.typography.labelSmall,
                color = qy.soft,
            )
        }
        if (selected) {
            Text("当前", style = MaterialTheme.typography.labelSmall, color = qy.accent)
        }
    }
}

/** 选项行：点击选中高亮（泛型，用于字体/间距/主题等枚举选项） */
@Composable
internal fun <T> OptionPickerRow(
    label: String,
    subtitle: String = "",
    options: List<T>,
    selected: T,
    labelOf: (T) -> String,
    onSelect: (T) -> Unit,
) {
    val qy = qyColors()
    val isSelected = options.any { it == selected }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .clickable { onSelect(selected) }
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                label,
                style = MaterialTheme.typography.bodyLarge,
                color = if (isSelected) qy.accent else qy.text,
            )
            if (subtitle.isNotBlank()) {
                Spacer(Modifier.height(2.dp))
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = qy.soft,
                )
            }
        }
        if (isSelected) {
            Box(
                Modifier
                    .padding(start = 8.dp)
                    .background(qy.accent.copy(alpha = 0.15f), RoundedCornerShape(8.dp))
                    .padding(horizontal = 8.dp, vertical = 3.dp),
            ) {
                Text("当前", style = MaterialTheme.typography.labelSmall, color = qy.accent)
            }
        }
    }
}

/** 内网穿透指引对话框（方案 §5.2 三路线：Tailscale / ZeroTier / frp） */
@Composable
internal fun TunnelGuideDialog(onDismiss: () -> Unit) {
    val qy = qyColors()
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = qy.card,
        title = { Text("内网穿透指引", color = qy.text) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("局域网外连接 PC 的三条路线（任选其一）：", color = qy.soft)
                listOf(
                    "Tailscale" to "安装并登录同一账号，两端自动组网，配置最简单，推荐首选",
                    "ZeroTier" to "自建虚拟局域网，需要两端加入同一 Network ID",
                    "frp" to "自建服务器做反向代理，适合有公网服务器的用户",
                ).forEach { (name, desc) ->
                    Row(verticalAlignment = Alignment.Top) {
                        Text(
                            "• $name",
                            style = MaterialTheme.typography.bodyMedium,
                            color = qy.accent,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    Text(
                        desc,
                        style = MaterialTheme.typography.bodySmall,
                        color = qy.soft,
                        modifier = Modifier.padding(start = 12.dp, bottom = 4.dp),
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("知道了", color = qy.accent) }
        },
    )
}
