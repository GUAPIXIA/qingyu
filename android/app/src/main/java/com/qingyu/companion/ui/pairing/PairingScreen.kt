package com.qingyu.companion.ui.pairing

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.qingyu.companion.R
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.data.relay.RelayCredentialStore
import com.qingyu.companion.data.relay.RelayPairingRepository
import com.qingyu.companion.model.ConnectionMode
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.QyErrorBanner
import com.qingyu.companion.ui.theme.qyColors


/**
 * 配对页：品牌首屏 + 扫码/手动配对 + 已配对设备管理（mDNS 发现）。
 * E-02：扫码/手动配对的失败态统一用 [QyErrorBanner] 呈现（不再裸 Text），
 * 文案全部来自 strings.xml；进行中态保留按钮内进度 + 「等待 PC 端确认…」；
 * E-06：根布局 imePadding，键盘弹起时输入面不被遮挡。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairingScreen(onPaired: () -> Unit) {
    val container = LocalAppContainer.current
    val context = LocalContext.current
    val vm: PairingViewModel = viewModel(factory = viewModelFactory {
        initializer {
            PairingViewModel(
                connectionManager = container.connectionManager,
                deviceIdentity = container.deviceIdentity,
                nsdDiscovery = container.nsdDiscovery,
            )
        }
    })
    val ui by vm.ui.collectAsStateWithLifecycle()
    val relayVm: RelayPairingViewModel = viewModel(factory = viewModelFactory {
        initializer {
            RelayPairingViewModel(
                manager = container.connectionManager,
                identity = container.deviceIdentity,
                repository = RelayPairingRepository(),
                credentials = RelayCredentialStore(context.applicationContext),
            )
        }
    })
    val relayUi by relayVm.ui.collectAsStateWithLifecycle()
    var connectionMode by rememberSaveable { mutableStateOf(ConnectionMode.LAN) }
    val qy = qyColors()
    // 组合期解析的资源文案（回调闭包内不可调用 stringResource）
    val scanPrompt = stringResource(R.string.pairing_scan_prompt)
    val cameraPermissionDenied = stringResource(R.string.pairing_error_camera_permission)

    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val raw = result.contents
        // 解析失败文案由 ViewModel 按原因（D-03）设置 errorResId，这里不再覆盖
        if (raw != null) {
            if (connectionMode == ConnectionMode.LAN) vm.applyQrScan(raw) else relayVm.applyQr(raw)
        }
    }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            scanLauncher.launch(scanOptions(scanPrompt))
        } else {
            vm.showError(cameraPermissionDenied)
        }
    }

    val startScan: () -> Unit = {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            scanLauncher.launch(scanOptions(scanPrompt))
        } else {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            AppTopBar(
                title = stringResource(R.string.pairing_title),
            )
        },
    ) { padding ->
        AppBackground {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .imePadding()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    ConnectionMethodCard(
                        title = "局域网连接",
                        description = "同一 Wi-Fi，直连 PC",
                        selected = connectionMode == ConnectionMode.LAN,
                        onClick = { connectionMode = ConnectionMode.LAN },
                        modifier = Modifier.weight(1f),
                    )
                    ConnectionMethodCard(
                        title = "服务器连接",
                        description = "移动网络、异地连接",
                        selected = connectionMode == ConnectionMode.RELAY,
                        onClick = { connectionMode = ConnectionMode.RELAY },
                        modifier = Modifier.weight(1f),
                    )
                }

                // 扫码主入口（accent 主按钮）
                if (connectionMode == ConnectionMode.LAN) Button(
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
                        stringResource(R.string.pairing_scan_action),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                    )
                }

                // mDNS 自动发现
                if (connectionMode == ConnectionMode.LAN && ui.discovered.isNotEmpty()) {
                    AnimatedVisibility(
                        visible = true,
                        enter = fadeIn() + slideInVertically(initialOffsetY = { it / 3 }),
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(
                                stringResource(R.string.pairing_discovered_title),
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
                            stringResource(R.string.pairing_paired_devices_title),
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
                if (connectionMode == ConnectionMode.LAN) GlassCard {
                    Text(
                        stringResource(R.string.pairing_manual_title),
                        style = MaterialTheme.typography.titleMedium,
                        color = qy.text,
                    )
                    Text(
                        stringResource(R.string.pairing_manual_desc),
                        style = MaterialTheme.typography.bodySmall,
                        color = qy.soft,
                    )
                    Spacer(Modifier.height(10.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        GlassTextField(
                            value = ui.host,
                            onValueChange = vm::onHostChange,
                            label = stringResource(R.string.pairing_host_label),
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.width(8.dp))
                        GlassTextField(
                            value = ui.port,
                            onValueChange = vm::onPortChange,
                            label = stringResource(R.string.pairing_port_label),
                            modifier = Modifier.width(104.dp),
                        )
                    }
                    Spacer(Modifier.height(8.dp))
                    GlassTextField(
                        value = ui.pairingCode,
                        onValueChange = vm::onPairingCodeChange,
                        label = stringResource(R.string.pairing_code_label),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(12.dp))
                    Button(
                        onClick = { vm.pair(onPaired) },
                        enabled = !ui.pairing,
                        modifier = Modifier
                            .fillMaxWidth()
                            .minimumInteractiveComponentSize(),
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
                        Text(
                            if (ui.pairing) {
                                stringResource(R.string.pairing_awaiting_approval)
                            } else {
                                stringResource(R.string.pairing_connect)
                            },
                        )
                    }

                    // 失败态（E-02）：扫码按原因的文案（strings.xml）优先；配对表单/网络错误次之。
                    // 配对失败不自动重试（避免重复发配对请求），由用户修正输入后再点连接。
                    val errorText = ui.errorResId?.let { resId ->
                        stringResource(resId)
                    } ?: ui.error
                    errorText?.let {
                        Spacer(Modifier.height(8.dp))
                        QyErrorBanner(
                            message = it,
                            onRetry = null,
                            retryable = false,
                        )
                    }
                } else {
                    RelayPairingContent(relayUi, relayVm, onPaired, startScan)
                }
            }
        }
    }
}
