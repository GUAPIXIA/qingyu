package com.qingyu.companion.ui.sync

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.qingyu.companion.R
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.QyErrorBanner

/**
 * S7-05：局域网同步授权页。
 *
 * 扫 PC「同步中心」的授权二维码 → 本地生成密钥并显示短认证串 →
 * 等 PC 用户核对确认 → 自动进入已授权。
 */
@Composable
fun SyncAuthScreen(
    onConfirmed: () -> Unit,
    onBack: () -> Unit,
    vm: SyncAuthViewModel = viewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents
        if (!contents.isNullOrEmpty()) {
            vm.onQrScanned(contents)
        }
    }

    AppBackground {
        Column(Modifier.fillMaxSize()) {
            AppTopBar(
                title = stringResource(R.string.sync_auth_title),
                navigationIcon = {
                    TextButton(onClick = onBack) {
                        Text(stringResource(R.string.sync_auth_cancel))
                    }
                },
            )
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    text = stringResource(R.string.sync_auth_intro),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                if (state.error != null) {
                    QyErrorBanner(message = state.error.orEmpty(), onRetry = { vm.reset() })
                }

                when (state.phase) {
                    SyncAuthUiState.Phase.Idle -> {
                        Button(
                            onClick = {
                                scanLauncher.launch(
                                    ScanOptions().apply {
                                        setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                                        setPrompt("扫描 PC 同步中心的授权二维码")
                                        setBeepEnabled(false)
                                    },
                                )
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(stringResource(R.string.sync_auth_scan))
                        }
                    }
                    SyncAuthUiState.Phase.Parsing, SyncAuthUiState.Phase.Handshaking -> {
                        Text(stringResource(R.string.sync_auth_connecting))
                    }
                    SyncAuthUiState.Phase.AwaitingPcConfirm -> {
                        Text(
                            text = stringResource(R.string.sync_auth_compare),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            text = state.shortAuth ?: "------",
                            fontFamily = FontFamily.Monospace,
                            fontSize = 36.sp,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        state.qrHost?.let {
                            Text(
                                text = it,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Text(
                            text = stringResource(R.string.sync_auth_wait_pc),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        TextButton(onClick = { vm.reset() }) {
                            Text(stringResource(R.string.sync_auth_cancel))
                        }
                    }
                    SyncAuthUiState.Phase.Confirmed -> {
                        Text(
                            text = stringResource(R.string.sync_auth_ok),
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Button(onClick = onConfirmed, modifier = Modifier.fillMaxWidth()) {
                            Text(stringResource(R.string.sync_auth_continue))
                        }
                    }
                    SyncAuthUiState.Phase.Failed -> {
                        Button(
                            onClick = { vm.reset() },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(stringResource(R.string.sync_auth_retry))
                        }
                    }
                }
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}
