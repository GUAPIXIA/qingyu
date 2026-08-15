package com.qingyu.companion.ui.pairing

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.network.DiscoveredPc
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.theme.Accent
import com.qingyu.companion.ui.theme.AssistantBubble
import com.qingyu.companion.ui.theme.SuccessGreen
import com.qingyu.companion.ui.theme.TavernBorder
import com.qingyu.companion.ui.theme.TavernBgCard
import com.qingyu.companion.ui.theme.UserBubble

/**
 * 配对页：品牌首屏 + 扫码/手动配对 + 已配对设备管理（mDNS 发现）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairingScreen(onPaired: () -> Unit) {
    val container = LocalAppContainer.current
    val vm: PairingViewModel = viewModel(factory = viewModelFactory {
        initializer {
            PairingViewModel(
                connectionManager = container.connectionManager,
                deviceIdentity = container.deviceIdentity,
                nsdDiscovery = container.nsdDiscovery,
            )
        }
    })
    val ui by vm.ui.collectAsState()
    val context = LocalContext.current

    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val raw = result.contents
        if (raw != null && !vm.applyQrScan(raw)) {
            vm.showError("无效的配对二维码，请确认是 PC 端「设置 → 手机连接」页面的二维码")
        }
    }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            scanLauncher.launch(scanOptions())
        } else {
            vm.showError("需要相机权限才能扫码配对，也可手动输入主机/端口/配对码")
        }
    }

    val startScan: () -> Unit = {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            scanLauncher.launch(scanOptions())
        } else {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    Scaffold(
        containerColor = Color.Transparent,
        topBar = { AppTopBar(title = "") },
    ) { padding ->
        AppBackground {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                // 品牌首屏
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(top = 10.dp, bottom = 4.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            "轻语",
                            style = MaterialTheme.typography.headlineLarge,
                            color = MaterialTheme.colorScheme.onBackground,
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "灯火之下，与角色对话",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                // 扫码主入口（琥珀渐变主按钮）
                Button(
                    onClick = startScan,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp)
                        .shadow(16.dp, RoundedCornerShape(18.dp)),
                    shape = RoundedCornerShape(18.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Accent,
                        contentColor = Color(0xFF3B2410),
                    ),
                ) {
                    Text(
                        "扫码配对",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                    )
                }

                // mDNS 自动发现
                if (ui.discovered.isNotEmpty()) {
                    AnimatedVisibility(
                        visible = true,
                        enter = fadeIn() + slideInVertically(initialOffsetY = { it / 3 }),
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(
                                "发现局域网内的 PC",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            ui.discovered.forEach { pc ->
                                DiscoveredPcRow(pc = pc, onClick = { vm.applyDiscovered(pc) })
                            }
                        }
                    }
                }

                // 手动配对表单（玻璃卡）
                GlassCard {
                    Text(
                        "手动连接",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        "在 PC 端「设置 → 手机连接」开启后，填入主机、端口与配对码。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(10.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        GlassTextField(
                            value = ui.host,
                            onValueChange = vm::onHostChange,
                            label = "主机（IP）",
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.width(8.dp))
                        GlassTextField(
                            value = ui.port,
                            onValueChange = vm::onPortChange,
                            label = "端口",
                            modifier = Modifier.width(104.dp),
                        )
                    }
                    Spacer(Modifier.height(8.dp))
                    GlassTextField(
                        value = ui.pairingCode,
                        onValueChange = vm::onPairingCodeChange,
                        label = "配对码（一次性）",
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(12.dp))
                    Button(
                        onClick = { vm.pair(onPaired) },
                        enabled = !ui.pairing,
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(14.dp),
                    ) {
                        if (ui.pairing) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(16.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onPrimary,
                            )
                            Spacer(Modifier.width(8.dp))
                        }
                        Text(if (ui.pairing) "等待 PC 端确认…" else "连接")
                    }
                }

                // 已配对设备
                if (ui.connections.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            "已配对设备",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        ui.connections.forEach { conn ->
                            ConnectionRow(
                                connection = conn,
                                isActive = conn.deviceId == ui.activeDeviceId,
                                onEnter = onPaired,
                                onSwitch = { vm.switchTo(conn.deviceId) },
                                onRemove = { vm.remove(conn.deviceId) },
                            )
                        }
                    }
                }

                ui.error?.let {
                    Text(
                        text = it,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(vertical = 4.dp),
                    )
                }
                Spacer(Modifier.height(8.dp))
            }
        }
    }
}

/** 玻璃卡片：半透明表面 + 细腻描边 + 柔和投影 */
@Composable
fun GlassCard(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .shadow(10.dp, RoundedCornerShape(20.dp), ambientColor = Color.Black.copy(alpha = 0.35f)),
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.35f)),
    ) {
        Column(
            Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            content()
        }
    }
}

/** 圆角输入框：透明底 + 细描边 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GlassTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        modifier = modifier,
        singleLine = true,
        shape = RoundedCornerShape(12.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.6f),
            unfocusedContainerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.4f),
            focusedBorderColor = Accent,
            unfocusedBorderColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.5f),
            focusedLabelColor = Accent,
        ),
    )
}

@Composable
private fun DiscoveredPcRow(pc: DiscoveredPc, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.8f),
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
    ) {
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // 信号点
            Box(
                Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(AssistantBubble)
            )
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    pc.name.ifBlank { "未命名 PC" },
                    style = MaterialTheme.typography.bodyLarge,
                )
                Text(
                    "${pc.host}:${pc.port}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                "填入",
                style = MaterialTheme.typography.labelMedium,
                color = Accent,
            )
        }
    }
}

@Composable
private fun ConnectionRow(
    connection: ServerConnection,
    isActive: Boolean,
    onEnter: () -> Unit,
    onSwitch: () -> Unit,
    onRemove: () -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = if (isActive) {
            MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.55f)
        } else {
            MaterialTheme.colorScheme.surface.copy(alpha = 0.85f)
        },
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (isActive) Accent.copy(alpha = 0.5f) else MaterialTheme.colorScheme.outline.copy(alpha = 0.3f),
        ),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(10.dp)
                    .clip(CircleShape)
                    .background(
                        if (isActive) SuccessGreen else TavernBorder,
                    )
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        connection.name,
                        style = MaterialTheme.typography.bodyLarge,
                        maxLines = 1,
                    )
                    if (isActive) {
                        Spacer(Modifier.width(6.dp))
                        Text(
                            "当前",
                            style = MaterialTheme.typography.labelSmall,
                            color = Accent,
                        )
                    }
                }
                Text(
                    "${connection.host}:${connection.port}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (isActive) {
                Button(
                    onClick = onEnter,
                    shape = RoundedCornerShape(10.dp),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                ) {
                    Text("进入", style = MaterialTheme.typography.labelLarge)
                }
            } else {
                Surface(
                    onClick = onSwitch,
                    shape = RoundedCornerShape(10.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant,
                ) {
                    Text(
                        "切换",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                    )
                }
            }
            IconButton(onClick = onRemove) {
                Icon(
                    Icons.Filled.Delete,
                    contentDescription = "移除",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

private val SuccessGreen = Color(0xFF6FBF9E)

/** 构建 ZXing 扫码配置（仅 QR_CODE，提示语指向 PC 端配对二维码） */
private fun scanOptions(): ScanOptions =
    ScanOptions().apply {
        setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        setPrompt("扫描 PC 端配对二维码")
        setBeepEnabled(false)
    }
