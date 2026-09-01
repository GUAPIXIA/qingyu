package com.qingyu.companion.ui.settings.sections

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.qingyu.companion.R
import com.qingyu.companion.network.NetworkModule
import com.qingyu.companion.network.connection.ConnectionState
import com.qingyu.companion.ui.settings.SettingsViewModel
import com.qingyu.companion.ui.settings.components.SettingsNavRow
import com.qingyu.companion.ui.settings.components.SettingsSection
import com.qingyu.companion.ui.settings.failureReasonKey
import com.qingyu.companion.ui.settings.formatConnectionDiagnosticsText
import com.qingyu.companion.ui.settings.retryCountdownSeconds
import com.qingyu.companion.ui.theme.qyColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

/**
 * 连接/数据区：连接管理 / 当前连接 / 诊断卡片 / 退出清除 / 清除缓存 / 远程访问指引
 * E-03 从 SettingsScreen 抽出
 */
@Composable
fun ConnectionDataSection(
    vm: SettingsViewModel,
    ui: SettingsViewModel.UiState,
    onOpenPairing: () -> Unit,
) {
    val qy = qyColors()
    var confirmWipe by remember { mutableStateOf(false) }
    var showTunnelGuide by remember { mutableStateOf(false) }

    SettingsSection(title = stringResource(R.string.settings_section_connection)) {
        SettingsNavRow(
            title = stringResource(R.string.settings_connection_manage),
            subtitle = stringResource(R.string.settings_connection_manage_desc, ui.connectionCount),
            onClick = onOpenPairing,
        )
        ui.activeConnection?.let { conn ->
            SettingsNavRow(
                title = stringResource(R.string.settings_connection_current),
                subtitle = stringResource(
                    R.string.settings_connection_current_desc,
                    conn.name,
                    conn.host,
                    conn.port,
                    conn.deviceId.take(8),
                ),
            )
        }
        ConnectionDiagnosticsCard(vm = vm, ui = ui)
        SettingsNavRow(
            title = stringResource(R.string.settings_connection_wipe),
            subtitle = stringResource(R.string.settings_connection_wipe_desc),
            onClick = { confirmWipe = true },
            danger = true,
        )
    }

    SettingsSection(title = stringResource(R.string.settings_section_data)) {
        SettingsNavRow(
            title = stringResource(R.string.settings_data_clear_cache),
            subtitle = stringResource(R.string.settings_data_clear_cache_desc),
            onClick = vm::clearCache,
            busy = ui.clearingCache,
        )
    }

    SettingsSection(title = stringResource(R.string.settings_section_remote)) {
        SettingsNavRow(
            title = stringResource(R.string.settings_remote_tunnel_guide),
            subtitle = stringResource(R.string.settings_remote_tunnel_guide_desc),
            onClick = { showTunnelGuide = true },
        )
    }

    if (confirmWipe) {
        AlertDialog(
            onDismissRequest = { confirmWipe = false },
            containerColor = qy.card,
            title = { Text(stringResource(R.string.settings_dialog_wipe_title), color = qy.text) },
            text = {
                Text(
                    stringResource(R.string.settings_dialog_wipe_message),
                    color = qy.soft,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmWipe = false
                    vm.wipeAll()
                }) { Text(stringResource(R.string.settings_dialog_wipe_confirm), color = qy.danger) }
            },
            dismissButton = {
                TextButton(onClick = { confirmWipe = false }) { Text(stringResource(R.string.action_cancel), color = qy.soft) }
            },
        )
    }

    if (showTunnelGuide) {
        TunnelGuideDialog(onDismiss = { showTunnelGuide = false })
    }
}

@Composable
private fun ConnectionDiagnosticsCard(vm: SettingsViewModel, ui: SettingsViewModel.UiState) {
    val qy = qyColors()
    val context = LocalContext.current
    val state by vm.connectionState.collectAsStateWithLifecycle()
    val diag = ui.diagnostics
    val reconnecting = state as? ConnectionState.Reconnecting
    val countdownSec by produceState<Int?>(initialValue = null, reconnecting?.nextAttemptAt) {
        val target = reconnecting?.nextAttemptAt
        if (target == null) {
            value = null
            return@produceState
        }
        while (isActive) {
            value = retryCountdownSeconds(target, System.currentTimeMillis())
            delay(500)
        }
    }
    val clipboard = remember(context) {
        context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.settings_diagnostics_title),
                style = MaterialTheme.typography.bodyLarge,
                color = qy.text,
                modifier = Modifier.weight(1f),
            )
            TextButton(
                onClick = {
                    val snapshot = ui.diagnostics
                    if (snapshot != null && clipboard != null) {
                        clipboard.setPrimaryClip(
                            ClipData.newPlainText(
                                "qingyu-diagnostics",
                                formatConnectionDiagnosticsText(snapshot, System.currentTimeMillis()),
                            ),
                        )
                        Toast.makeText(context, R.string.settings_diagnostics_copied, Toast.LENGTH_SHORT).show()
                    }
                },
                enabled = diag != null,
            ) {
                Text(
                    stringResource(R.string.settings_diagnostics_copy),
                    style = MaterialTheme.typography.labelMedium,
                    color = if (diag != null) qy.accent else qy.muted,
                )
            }
        }
        Spacer(Modifier.height(2.dp))
        val endpoint = ui.activeConnection?.let { NetworkModule.endpointOf(it) }
        DiagnosticsRow(
            label = stringResource(R.string.settings_diagnostics_endpoint),
            value = endpoint?.let { "${it.host}:${it.port}" }
                ?: stringResource(R.string.settings_diagnostics_disconnected),
        )
        DiagnosticsRow(
            label = stringResource(R.string.settings_diagnostics_security),
            value = endpoint?.let { ep ->
                val scheme = diag?.securityMode ?: ep.httpScheme()
                "${ep.security.name}（$scheme）"
            } ?: "-",
        )
        DiagnosticsRow(
            label = stringResource(R.string.settings_diagnostics_state),
            value = connectionStateText(state, countdownSec),
            valueColor = if (state is ConnectionState.Connected) qy.ok else qy.soft,
        )
        DiagnosticsRow(
            label = stringResource(R.string.settings_diagnostics_rtt),
            value = diag?.lastRttMs?.let { stringResource(R.string.settings_diagnostics_rtt_value, it) } ?: "-",
        )
        val failure = diag?.lastFailure
        DiagnosticsRow(
            label = stringResource(R.string.settings_diagnostics_last_failure),
            value = if (failure != null) {
                failureReasonText(failure.reason)
            } else {
                stringResource(R.string.settings_diagnostics_no_failure)
            },
            valueColor = if (failure != null) qy.danger else qy.soft,
        )
    }
}

@Composable
private fun DiagnosticsRow(label: String, value: String, valueColor: Color? = null) {
    val qy = qyColors()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodySmall,
            color = qy.muted,
            modifier = Modifier.width(96.dp),
        )
        Text(
            value,
            style = MaterialTheme.typography.bodySmall,
            color = valueColor ?: qy.soft,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun connectionStateText(state: ConnectionState, countdownSec: Int?): String = when (state) {
    ConnectionState.Idle -> stringResource(R.string.settings_diag_state_idle)
    is ConnectionState.Discovering -> stringResource(R.string.settings_diag_state_discovering)
    is ConnectionState.Probing -> stringResource(R.string.settings_diag_state_probing)
    is ConnectionState.AwaitingApproval -> stringResource(R.string.settings_diag_state_awaiting_approval)
    is ConnectionState.Authenticating -> stringResource(R.string.settings_diag_state_authenticating)
    is ConnectionState.ConnectingRealtime -> stringResource(R.string.settings_diag_state_connecting_realtime)
    is ConnectionState.Connected -> stringResource(R.string.settings_diag_state_connected)
    is ConnectionState.UsingCache -> stringResource(R.string.connection_chip_using_cache)
    is ConnectionState.Degraded -> stringResource(R.string.settings_diag_state_degraded)
    is ConnectionState.Reconnecting -> {
        val base = stringResource(R.string.settings_diag_state_reconnecting, state.attempt)
        val cd = countdownSec
        if (cd != null && cd > 0) {
            base + " · " + stringResource(R.string.settings_diagnostics_retry_countdown, cd)
        } else {
            base
        }
    }
    is ConnectionState.NeedsRepair -> when (state.reason) {
        com.qingyu.companion.network.connection.RepairReason.Unauthorized ->
            stringResource(R.string.settings_diag_repair_unauthorized)
        com.qingyu.companion.network.connection.RepairReason.FingerprintChanged ->
            stringResource(R.string.settings_diag_repair_fingerprint)
        com.qingyu.companion.network.connection.RepairReason.ApiIncompatible ->
            stringResource(R.string.settings_diag_repair_api)
        com.qingyu.companion.network.connection.RepairReason.CertificateChanged ->
            stringResource(R.string.settings_diag_repair_certificate)
    }
}

@Composable
private fun failureReasonText(reason: String): String = when (failureReasonKey(reason)) {
    "no_network" -> stringResource(R.string.settings_diag_fail_no_network)
    "dns" -> stringResource(R.string.settings_diag_fail_dns)
    "tcp" -> stringResource(R.string.settings_diag_fail_tcp)
    "tls" -> stringResource(R.string.settings_diag_fail_tls)
    "timeout" -> stringResource(R.string.settings_diag_fail_timeout)
    "server_stopped" -> stringResource(R.string.settings_diag_fail_server_stopped)
    "ws_closed" -> stringResource(R.string.settings_diag_fail_ws_closed)
    "repair" -> stringResource(R.string.settings_diag_fail_repair)
    else -> stringResource(R.string.settings_diag_fail_unknown)
}

@Composable
internal fun TunnelGuideDialog(onDismiss: () -> Unit) {
    val qy = qyColors()
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = qy.card,
        title = { Text(stringResource(R.string.settings_dialog_tunnel_title), color = qy.text) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.settings_dialog_tunnel_desc), color = qy.soft)
                TunnelEntry(
                    name = stringResource(R.string.settings_dialog_tunnel_tailscale),
                    desc = stringResource(R.string.settings_dialog_tunnel_tailscale_desc),
                )
                TunnelEntry(
                    name = stringResource(R.string.settings_dialog_tunnel_zerotier),
                    desc = stringResource(R.string.settings_dialog_tunnel_zerotier_desc),
                )
                TunnelEntry(
                    name = stringResource(R.string.settings_dialog_tunnel_frp),
                    desc = stringResource(R.string.settings_dialog_tunnel_frp_desc),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.msg_intranet_ack), color = qy.accent) }
        },
    )
}

@Composable
private fun TunnelEntry(name: String, desc: String) {
    val qy = qyColors()
    Column {
        Text(
            "• $name",
            style = MaterialTheme.typography.bodyMedium,
            color = qy.accent,
        )
        Text(
            desc,
            style = MaterialTheme.typography.bodySmall,
            color = qy.soft,
            modifier = Modifier.padding(start = 12.dp, bottom = 4.dp),
        )
    }
}
