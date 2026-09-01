package com.qingyu.companion.ui.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.R
import com.qingyu.companion.data.DeviceIdentity
import com.qingyu.companion.model.PairRequest
import com.qingyu.companion.model.PairingQrInvalidReason
import com.qingyu.companion.model.PairingQrPayload
import com.qingyu.companion.model.PairingQrResult
import com.qingyu.companion.model.PairingQrV2Endpoint
import com.qingyu.companion.model.PairingQrV2Payload
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.model.parsePairingQr
import com.qingyu.companion.network.ConnectionManager
import com.qingyu.companion.network.DiscoveredPc
import com.qingyu.companion.network.NetworkModule
import com.qingyu.companion.network.NsdDiscovery
import com.qingyu.companion.network.connection.ConnectionEndpoint
import com.qingyu.companion.network.connection.EndpointNormalizer
import com.qingyu.companion.network.connection.FailureReason
import com.qingyu.companion.network.connection.TransportSecurity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import retrofit2.HttpException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/**
 * 配对页 ViewModel：已配对列表管理 + 扫码/手动输 IP 配对（方案 §5.1）。
 *
 * 扫码（D-02/D-03）：二维码经 [parsePairingQr] 双格式解析——
 * - v2（`{version:2, scheme:"qingyu-pair", ...}`）：首个可用 endpoint 填连接表单，
 *   全部候选端点与 serverId/capabilities/expiresAt 暂存 UiState，配对成功后并入保存记录；
 * - 旧格式（`{host, port, fingerprint}`）：fingerprint 兼任一次性配对码（原行为不变）；
 * - 非法：按 [PairingQrInvalidReason] 给出 strings.xml 中对应用户文案。
 *
 * 配对请求发出后调用 [ConnectionManager.markAwaitingApproval]（B-01），
 * 让连接状态栏在等待 PC 人工确认期间展示 AwaitingApproval。
 */
class PairingViewModel(
    private val connectionManager: ConnectionManager,
    /** 生产从 AppContainer 注入；null 仅用于 JVM 单测（配合 deviceName/deviceFingerprint 覆盖） */
    deviceIdentity: DeviceIdentity? = null,
    private val nsdDiscovery: NsdDiscovery? = null,
    /** JVM 单测注入覆盖；生产恒为 null（取自 [deviceIdentity]） */
    deviceName: String? = null,
    /** JVM 单测注入覆盖；生产恒为 null（取自 [deviceIdentity]） */
    deviceFingerprint: String? = null,
) : ViewModel() {

    /** 配对请求上报的设备名（PairRequest.deviceName） */
    private val reportedDeviceName: String = deviceName ?: deviceIdentity?.displayName ?: "轻语 Android"

    /** 配对请求上报的本机指纹（PairRequest.deviceFingerprint） */
    private val reportedFingerprint: String = deviceFingerprint ?: deviceIdentity?.fingerprint ?: ""

    data class UiState(
        val connections: List<ServerConnection> = emptyList(),
        val activeDeviceId: String? = null,
        val host: String = "",
        val port: String = "8321",
        val pairingCode: String = "",
        val pairing: Boolean = false,
        val error: String? = null,
        /**
         * 错误文案（strings.xml 资源；与 [error] 互斥）：扫码解析失败（D-03）与
         * 配对失败（不可达/版本不兼容/请求异常，E-02 文案统一入资源）均走此字段
         */
        val errorResId: Int? = null,
        /** mDNS 自动发现的 PC（点击填入表单） */
        val discovered: List<DiscoveredPc> = emptyList(),
        // ---- QR v2 扫码暂存（D-02）：手动修改主机/端口即作废，配对成功后并入保存记录 ----
        /** 规范化后的全部候选端点（空 = 本次不是 v2 扫码或已被手动覆盖） */
        val scannedEndpoints: List<ConnectionEndpoint> = emptyList(),
        /** PC 实例稳定标识（QR v2 serverId） */
        val scannedServerId: String? = null,
        /** PC 能力集合（QR v2 capabilities） */
        val scannedCapabilities: Set<String> = emptySet(),
        /** 配对码/二维码过期时刻（epoch millis；0 = 未知） */
        val scannedExpiresAt: Long = 0L,
        /** PC 端展示名（QR v2 displayName，用于「等待在 XX 上确认」提示） */
        val scannedDisplayName: String = "",
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
                errorResId = null,
            ).clearScanned()
        }
    }

    fun refreshConnections() {
        viewModelScope.launch {
            val conns = connectionManager.listConnections()
            _ui.update { it.copy(connections = conns) }
        }
    }

    fun onHostChange(value: String) =
        _ui.update { it.copy(host = value, error = null, errorResId = null).clearScanned() }

    fun onPortChange(value: String) =
        _ui.update { it.copy(port = value, error = null, errorResId = null).clearScanned() }

    fun onPairingCodeChange(value: String) =
        _ui.update { it.copy(pairingCode = value, error = null, errorResId = null) }

    /** 设置错误提示（供 UI 事件使用） */
    fun showError(message: String) = _ui.update { it.copy(error = message, errorResId = null) }

    /**
     * 解析扫码得到的二维码 JSON 并填入配对表单（D-02/D-03 三分支，见类注释）。
     * 失败时在 UiState 设置 [UiState.errorResId]（按原因区分的用户文案）。
     * @return 是否解析成功
     */
    fun applyQrScan(raw: String): Boolean {
        return when (val decision = decideQrScan(raw, NetworkModule.json)) {
            is QrScanDecision.V2 -> {
                _ui.update {
                    it.copy(
                        host = decision.host,
                        port = decision.port.toString(),
                        pairingCode = decision.pairingCode,
                        scannedEndpoints = decision.endpoints,
                        scannedServerId = decision.serverId,
                        scannedCapabilities = decision.capabilities,
                        scannedExpiresAt = decision.expiresAt,
                        scannedDisplayName = decision.displayName,
                        error = null,
                        errorResId = null,
                    )
                }
                true
            }

            is QrScanDecision.Legacy -> {
                _ui.update {
                    it.copy(
                        host = decision.host,
                        port = decision.port.toString(),
                        pairingCode = decision.pairingCode,
                        error = null,
                        errorResId = null,
                    ).clearScanned()
                }
                true
            }

            is QrScanDecision.Rejected -> {
                _ui.update { it.copy(error = null, errorResId = decision.reason.errorResId()) }
                false
            }
        }
    }

    fun pair(onSuccess: () -> Unit) {
        val host = _ui.value.host.trim()
        val port = _ui.value.port.trim().toIntOrNull()
        val code = _ui.value.pairingCode.trim()
        if (host.isEmpty() || port == null || port !in 1..65535 || code.isEmpty()) {
            _ui.update { it.copy(error = null, errorResId = R.string.pairing_form_missing_fields) }
            return
        }
        // QR v2 暂存元数据：非空 = 本次配对来自 v2 扫码（且主机/端口未被手动改过）
        val scanned = _ui.value
        val isQrV2 = scanned.scannedEndpoints.isNotEmpty()
        viewModelScope.launch {
            _ui.update { it.copy(pairing = true, error = null, errorResId = null) }
            try {
                // 配对前的匿名探测连接：token/deviceId 占位
                val probe = ServerConnection(
                    name = host,
                    host = host,
                    port = port,
                    token = "",
                    deviceId = "",
                    fingerprint = code.ifEmpty { reportedFingerprint },
                )
                val candidates = if (isQrV2) {
                    scanned.scannedEndpoints
                } else {
                    listOf(EndpointNormalizer.normalize(host, port))
                }
                var selectedProbe: ServerConnection? = null
                var lastFailure: FailureReason = FailureReason.Unknown
                for (endpoint in candidates) {
                    val candidate = probe.copy(host = endpoint.host, port = endpoint.port)
                    when (val compat = connectionManager.checkCompatibility(candidate)) {
                        is ConnectionManager.CompatibilityResult.Unreachable -> {
                            lastFailure = compat.reason
                        }

                        is ConnectionManager.CompatibilityResult.UpgradeRequired -> {
                            val targetRes = if (compat.side == ConnectionManager.CompatibilityResult.Side.ANDROID) {
                                R.string.pairing_error_incompatible_android
                            } else {
                                R.string.pairing_error_incompatible_pc
                            }
                            _ui.update { it.copy(pairing = false, error = null, errorResId = targetRes) }
                            return@launch
                        }

                        ConnectionManager.CompatibilityResult.Compatible -> {
                            selectedProbe = candidate
                            break
                        }
                    }
                }
                if (selectedProbe == null) {
                    _ui.update {
                        it.copy(pairing = false, error = null, errorResId = lastFailure.pairingErrorResId())
                    }
                    return@launch
                }
                // B-01：配对请求已发出，等待 PC 端人工确认期间让连接状态栏展示「等待确认」
                // （expiresAt 取 QR v2 的配对码有效期；legacy 无该信息传 0）
                connectionManager.markAwaitingApproval(
                    serverName = scanned.scannedDisplayName.ifBlank { "$host:$port" },
                    expiresAt = scanned.scannedExpiresAt,
                )
                val response = connectionManager.anonApi(selectedProbe).pair(
                    PairRequest(
                        pairingCode = code,
                        deviceName = reportedDeviceName,
                        deviceFingerprint = reportedFingerprint,
                    )
                )
                val full = selectedProbe.copy(
                    name = "${selectedProbe.host}:${selectedProbe.port}",
                    token = response.token,
                    deviceId = response.deviceId,
                    // D-02：QR v2 元数据在首次配对即入库（serverId/capabilities/候选端点/协议版本）；
                    // legacy 路径保持空，由 ConnectionCoordinator 首次 /server/info 握手回填（B-02）
                    serverId = scanned.scannedServerId,
                    capabilities = scanned.scannedCapabilities,
                    pairingProtocolVersion = if (isQrV2) PairingQrV2Payload.VERSION else probe.pairingProtocolVersion,
                    endpoints = scanned.scannedEndpoints,
                )
                connectionManager.addConnection(full)
                _ui.update { it.copy(pairing = false) }
                onSuccess()
            } catch (e: Exception) {
                _ui.update {
                    it.copy(pairing = false, error = null, errorResId = pairingExceptionErrorResId(e))
                }
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

    /** 手动改主机/端口或切换发现目标后，QR v2 暂存元数据全部作废 */
    private fun UiState.clearScanned(): UiState = copy(
        scannedEndpoints = emptyList(),
        scannedServerId = null,
        scannedCapabilities = emptySet(),
        scannedExpiresAt = 0L,
        scannedDisplayName = "",
    )
}

// ---------- 扫码三分支决策（D-03，纯函数便于 JVM 单测） ----------

/** applyQrScan 的决策结果：v2 成功 / legacy 回退 / 无效拒绝 */
internal sealed interface QrScanDecision {
    /** v2 解析成功：host/port 已取首个可用 endpoint，endpoints 为规范化后的全部候选 */
    data class V2(
        val host: String,
        val port: Int,
        val pairingCode: String,
        val endpoints: List<ConnectionEndpoint>,
        val serverId: String?,
        val capabilities: Set<String>,
        val expiresAt: Long,
        val displayName: String,
    ) : QrScanDecision

    /** 旧格式 {host, port, fingerprint}：fingerprint 兼任一次性配对码 */
    data class Legacy(
        val host: String,
        val port: Int,
        val pairingCode: String,
    ) : QrScanDecision

    /** 无效：reason 映射 strings.xml 文案（见 [PairingQrInvalidReason.errorResId]） */
    data class Rejected(val reason: PairingQrInvalidReason) : QrScanDecision
}

/**
 * 扫码三分支决策：v2 成功 → 首个可用 endpoint 填连接字段；
 * 旧格式 → legacy 字段直填；非法 → [QrScanDecision.Rejected]（不抛异常）。
 */
internal fun decideQrScan(
    raw: String,
    json: Json,
    now: Long = System.currentTimeMillis(),
): QrScanDecision {
    return when (val result = parsePairingQr(raw, json, now)) {
        is PairingQrResult.V2 -> {
            val endpoints = result.payload.endpoints.mapNotNull { it.toConnectionEndpoint(result.payload) }
            val first = endpoints.firstOrNull()
            if (first == null) {
                // 解析层认定有可用 endpoint 但规范化后全部不可构造（理论罕见）：按无端点拒绝
                QrScanDecision.Rejected(PairingQrInvalidReason.NO_VALID_ENDPOINT)
            } else {
                QrScanDecision.V2(
                    host = first.host,
                    port = first.port,
                    pairingCode = result.payload.pairingCode.trim(),
                    endpoints = endpoints,
                    serverId = result.payload.serverId.takeIf { it.isNotBlank() },
                    capabilities = result.payload.capabilities,
                    expiresAt = result.payload.expiresAt,
                    displayName = result.payload.displayName,
                )
            }
        }

        is PairingQrResult.Legacy -> QrScanDecision.Legacy(
            host = result.payload.host.trim(),
            port = result.payload.port,
            pairingCode = result.payload.fingerprint,
        )

        is PairingQrResult.Invalid -> QrScanDecision.Rejected(result.reason)
    }
}

/**
 * QR v2 endpoint → 规范化 [ConnectionEndpoint]：
 * - host/port 不合法或无法解析 → null（调用方过滤）；
 * - QR 声明 TLS_PINNED 且携带证书指纹 → 按声明确权构造（阶段 D pinning）；
 * - 其余（含 LOCAL_CLEARTEXT 声明）走 [EndpointNormalizer.normalize] 推断安全等级——
 *   公网地址强制 TLS_SYSTEM，不因 QR 声明而破坏「公网禁止明文」安全不变量。
 */
internal fun PairingQrV2Endpoint.toConnectionEndpoint(payload: PairingQrV2Payload): ConnectionEndpoint? {
    if (port !in 1..65535) return null
    val cleaned = EndpointNormalizer.sanitize(host) ?: return null
    if (security == TransportSecurity.TLS_PINNED.name && !payload.certificatePin.isNullOrBlank()) {
        return runCatching {
            ConnectionEndpoint(cleaned.host, port, TransportSecurity.TLS_PINNED, payload.certificatePin)
        }.getOrNull()
    }
    return runCatching { EndpointNormalizer.normalize(cleaned.host, port) }.getOrNull()
}

/** 解析失败原因 → 用户可见文案（strings.xml；避免 UI 层硬编码） */
internal fun PairingQrInvalidReason.errorResId(): Int = when (this) {
    PairingQrInvalidReason.NOT_JSON,
    PairingQrInvalidReason.LEGACY_INCOMPLETE,
    -> R.string.pairing_qr_invalid

    PairingQrInvalidReason.VERSION_UNSUPPORTED -> R.string.pairing_qr_version_unsupported
    PairingQrInvalidReason.SCHEME_MISMATCH -> R.string.pairing_qr_scheme_mismatch
    PairingQrInvalidReason.EXPIRED -> R.string.pairing_qr_expired
    PairingQrInvalidReason.NO_VALID_ENDPOINT -> R.string.pairing_qr_no_endpoint
    PairingQrInvalidReason.MISSING_PAIRING_CODE -> R.string.pairing_qr_missing_code
}

/** 匿名探测失败→可操作的配对提示，不向 UI 泄漏底层异常文本。 */
internal fun FailureReason.pairingErrorResId(): Int = when (this) {
    FailureReason.NoNetwork -> R.string.pairing_error_no_network
    FailureReason.Dns -> R.string.pairing_error_dns
    FailureReason.Tcp -> R.string.pairing_error_tcp
    FailureReason.Tls -> R.string.pairing_error_tls
    FailureReason.Timeout -> R.string.pairing_error_timeout
    FailureReason.ServerStopped -> R.string.pairing_error_wrong_service
    FailureReason.WsClosed,
    FailureReason.Unknown,
    -> R.string.pairing_error_unreachable
}

/** POST /auth/pair 失败→配对阶段精确提示。 */
internal fun pairingExceptionErrorResId(error: Throwable): Int {
    val chain = generateSequence(error) { it.cause }.toList()
    val http = chain.filterIsInstance<HttpException>().firstOrNull()
    if (http != null) {
        return when (http.code()) {
            400 -> R.string.pairing_error_bad_request
            401 -> R.string.pairing_error_code_invalid
            408 -> R.string.pairing_error_approval_rejected
            429 -> R.string.pairing_error_rate_limited
            else -> R.string.pairing_error_server_rejected
        }
    }
    return when {
        chain.any { it is SocketTimeoutException } -> R.string.pairing_error_approval_timeout
        chain.any { it is UnknownHostException } -> R.string.pairing_error_dns
        chain.any { it is ConnectException } -> R.string.pairing_error_tcp
        chain.any { it is SSLException } -> R.string.pairing_error_tls
        else -> R.string.pairing_error_failed
    }
}
