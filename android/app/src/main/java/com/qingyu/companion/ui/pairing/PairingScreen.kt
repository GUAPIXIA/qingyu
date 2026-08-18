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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
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
import com.qingyu.companion.ui.theme.qyColors


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
    val qy = qyColors()

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
        topBar = {
            AppTopBar(
                title = "连接设备",
            )
        },
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
                // 扫码主入口（accent 主按钮）
                Button(
                    onClick = startScan,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp),
                    shape = RoundedCornerShape(18.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = qy.accent,
                        contentColor = qy.onAccent,
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
                                color = qy.soft,
                            )
                            ui.discovered.forEach { pc ->
                                DiscoveredPcRow(pc = pc, onClick = { vm.applyDiscovered(pc) })
                            }
                        }
                    }
                }

                // 已配对设备
                if (ui.connections.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            "已配对设备",
                            style = MaterialTheme.typography.labelMedium,
                            color = qy.soft,
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

                // 手动配对表单
                GlassCard {
                    Text(
                        "手动连接",
                        style = MaterialTheme.typography.titleMedium,
                        color = qy.text,
                    )
                    Text(
                        "在 PC 端「设置 → 手机连接」开启后，填入主机与端口即可配对（配对码可选，扫码自动填充）。",
                        style = MaterialTheme.typography.bodySmall,
                        color = qy.soft,
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
                        label = "配对码（可选）",
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(12.dp))
                    Button(
                        onClick = { vm.pair(onPaired) },
                        enabled = !ui.pairing,
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(14.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = qy.accent,
                            contentColor = qy.onAccent,
                        ),
                    ) {
                        if (ui.pairing) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(16.dp),
                                strokeWidth = 2.dp,
                                color = qy.onAccent,
                            )
                            Spacer(Modifier.width(8.dp))
                        }
                        Text(if (ui.pairing) "等待 PC 端确认…" else "连接")
                    }
                }

                ui.error?.let {
                    Text(
                        text = it,
                        color = qy.danger,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(vertical = 4.dp),
                    )
                }
                Spacer(Modifier.height(8.dp))
            }
        }
    }
}

/** 卡片容器：纯色底 + 1dp 细描边，无阴影 */
