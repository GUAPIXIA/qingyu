package com.qingyu.companion.ui.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.DeviceIdentity
import com.qingyu.companion.model.PairRequest
import com.qingyu.companion.model.PairingQrPayload
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.network.ConnectionManager
import com.qingyu.companion.network.DiscoveredPc
import com.qingyu.companion.network.NetworkModule
import com.qingyu.companion.network.NsdDiscovery
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.decodeFromString

/**
 * 配对页 ViewModel：已配对列表管理 + 扫码/手动输 IP 配对（方案 §5.1）。
 *
 * 注：MVP 中二维码/手动输入的「配对码」与 ServerConnection.fingerprint 同源
 * （PC 桥接层尚未落地，暂以一次性配对码兼任重连校验指纹；待 PC 侧实现真实公钥指纹后替换）。
 */
class PairingViewModel(
    private val connectionManager: ConnectionManager,
    private val deviceIdentity: DeviceIdentity,
    private val nsdDiscovery: NsdDiscovery? = null,
) : ViewModel() {

    data class UiState(
        val connections: List<ServerConnection> = emptyList(),
        val activeDeviceId: String? = null,
        val host: String = "",
        val port: String = "8321",
        val pairingCode: String = "",
        val pairing: Boolean = false,
        val error: String? = null,
        /** mDNS 自动发现的 PC（点击填入表单） */
        val discovered: List<DiscoveredPc> = emptyList(),
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    init {
        refreshConnections()
        viewModelScope.launch {
            connectionManager.activeFlow.collect { active ->
                _ui.update { it.copy(activeDeviceId = active?.deviceId) }
            }
        }
        // mDNS 自动发现：进入配对页即启动，离开时停止（NsdManager 生命周期敏感）
        nsdDiscovery?.let { discovery ->
            discovery.start()
            viewModelScope.launch {
                discovery.devices.collect { devices ->
                    _ui.update { it.copy(discovered = devices) }
                }
            }
        }
    }

    override fun onCleared() {
        nsdDiscovery?.stop()
        super.onCleared()
    }

    /** 点击发现的 PC：填充主机/端口（配对码仍需扫码或手动输入） */
    fun applyDiscovered(pc: DiscoveredPc) {
        _ui.update {
            it.copy(
                host = pc.host,
                port = pc.port.toString(),
                error = null,
            )
        }
    }

    fun refreshConnections() {
        viewModelScope.launch {
            val conns = connectionManager.listConnections()
            _ui.update { it.copy(connections = conns) }
        }
    }

    fun onHostChange(value: String) = _ui.update { it.copy(host = value, error = null) }

    fun onPortChange(value: String) = _ui.update { it.copy(port = value, error = null) }

    fun onPairingCodeChange(value: String) = _ui.update { it.copy(pairingCode = value, error = null) }

    /** 设置错误提示（供扫码解析失败等 UI 事件使用） */
    fun showError(message: String) = _ui.update { it.copy(error = message) }

    /**
     * 解析扫码得到的二维码 JSON（{host, port, fingerprint}）并填入配对表单。
     * 按方案 §5.1 约定：二维码中 fingerprint 兼任一次性配对码。
     * @return 是否解析成功
     */
    fun applyQrScan(raw: String): Boolean {
        val qr = runCatching { NetworkModule.json.decodeFromString<PairingQrPayload>(raw) }.getOrNull()
            ?: return false
        // 校验必填字段，空值直接判无效二维码（给出更精确的错误而非等到 pair() 通用校验）
        if (qr.host.isBlank() || qr.port !in 1..65535 || qr.fingerprint.isBlank()) return false
        _ui.update {
            it.copy(
                host = qr.host,
                port = qr.port.toString(),
                pairingCode = qr.fingerprint,
                error = null,
            )
        }
        return true
    }

    fun pair(onSuccess: () -> Unit) {
        val host = _ui.value.host.trim()
        val port = _ui.value.port.trim().toIntOrNull()
        val code = _ui.value.pairingCode.trim()
        if (host.isEmpty() || port == null || port !in 1..65535 || code.isEmpty()) {
            _ui.update { it.copy(error = "请填写主机、端口和 PC 端一次性配对码") }
            return
        }
        viewModelScope.launch {
            _ui.update { it.copy(pairing = true, error = null) }
            try {
                // 配对前的匿名探测连接：token/deviceId 占位
                val probe = ServerConnection(
                    name = host,
                    host = host,
                    port = port,
                    token = "",
                    deviceId = "",
                    fingerprint = code.ifEmpty { deviceIdentity.fingerprint },
                )
                val compat = connectionManager.checkCompatibility(probe)
                when (compat) {
                    ConnectionManager.CompatibilityResult.Unreachable -> {
                        _ui.update {
                            it.copy(pairing = false, error = "无法连接 PC：请确认 PC 端已开启「手机连接」且与本机同一局域网")
                        }
                        return@launch
                    }

                    is ConnectionManager.CompatibilityResult.UpgradeRequired -> {
                        val target = if (compat.side == ConnectionManager.CompatibilityResult.Side.ANDROID) {
                            "安卓端"
                        } else {
                            "PC 端"
                        }
                        _ui.update { it.copy(pairing = false, error = "版本不兼容：请升级 $target") }
                        return@launch
                    }

                    ConnectionManager.CompatibilityResult.Compatible -> Unit
                }
                val response = connectionManager.anonApi(probe).pair(
                    PairRequest(
                        pairingCode = code,
                        deviceName = deviceIdentity.displayName,
                        deviceFingerprint = deviceIdentity.fingerprint,
                    )
                )
                val full = probe.copy(
                    name = "$host:$port",
                    token = response.token,
                    deviceId = response.deviceId,
                )
                connectionManager.addConnection(full)
                _ui.update { it.copy(pairing = false) }
                onSuccess()
            } catch (e: Exception) {
                _ui.update { it.copy(pairing = false, error = e.message ?: "配对失败，请检查 PC 端是否开启手机连接") }
            }
        }
    }

    fun switchTo(deviceId: String) {
        viewModelScope.launch { connectionManager.switchTo(deviceId) }
    }

    fun remove(deviceId: String) {
        viewModelScope.launch {
            connectionManager.remove(deviceId)
            refreshConnections()
        }
    }
}
