package com.qingyu.companion.ui.pairing

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.qingyu.companion.ui.components.QyErrorBanner

@Composable
fun RelayPairingContent(ui: RelayPairingViewModel.UiState, vm: RelayPairingViewModel, onPaired: () -> Unit, onScan: () -> Unit) {
    GlassCard {
        Text("服务器连接")
        Text("适用于移动网络和不同 Wi-Fi，需要在电脑端确认。")
        Spacer(Modifier.height(10.dp))
        Button(onClick = onScan, modifier = Modifier.fillMaxWidth()) { Text("扫描服务器二维码") }
        Spacer(Modifier.height(8.dp))
        GlassTextField(ui.baseUrl, vm::baseUrl, "Relay HTTPS 地址", Modifier.fillMaxWidth())
        Spacer(Modifier.height(8.dp))
        GlassTextField(ui.code, vm::code, "8 位连接码", Modifier.fillMaxWidth())
        Spacer(Modifier.height(12.dp))
        Button(onClick = { vm.pair(onPaired) }, enabled = !ui.pairing, modifier = Modifier.fillMaxWidth()) {
            if (ui.pairing) CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.height(16.dp))
            Text(if (ui.pairing) "等待电脑端确认…" else "连接")
        }
        ui.error?.let { Spacer(Modifier.height(8.dp)); QyErrorBanner(it, onRetry = null, retryable = false) }
    }
}
