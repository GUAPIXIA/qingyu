package com.qingyu.companion.ui.sync

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.network.sync.LanSyncAuthClient
import com.qingyu.companion.network.sync.LanSyncTransport
import com.qingyu.companion.network.sync.SyncTransportResult
import com.qingyu.companion.synccore.LanAuth
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * S7-05：局域网同步授权 ViewModel。
 *
 * 流程：扫码解析 → 本地短认证串 → hello → 轮询 PC 确认 → 派生密钥并打开 session。
 * 退后台/离开页面时 [stopPolling]；可 [pauseUpload] 暂停后续传输。
 */
data class SyncAuthUiState(
    val phase: Phase = Phase.Idle,
    val shortAuth: String? = null,
    val qrHost: String? = null,
    val qrExpiresAt: Long? = null,
    val error: String? = null,
    val confirmed: Boolean = false,
) {
    enum class Phase { Idle, Parsing, Handshaking, AwaitingPcConfirm, Confirmed, Failed }
}

class SyncAuthViewModel(
    private val authClient: LanSyncAuthClient = LanSyncAuthClient(),
    private val transport: LanSyncTransport = LanSyncTransport(com.qingyu.companion.network.sync.OkHttpSyncEngine()),
) : ViewModel() {

    private val _state = MutableStateFlow(SyncAuthUiState())
    val state: StateFlow<SyncAuthUiState> = _state.asStateFlow()

    private var pollJob: Job? = null

    /** 扫码结果（原始 JSON） */
    fun onQrScanned(raw: String, now: Long = System.currentTimeMillis()) {
        _state.value = _state.value.copy(phase = SyncAuthUiState.Phase.Parsing, error = null)
        viewModelScope.launch {
            val payload = withContext(Dispatchers.IO) { authClient.parseQr(raw, now) }
            if (payload == null) {
                _state.value = _state.value.copy(
                    phase = SyncAuthUiState.Phase.Failed,
                    error = "二维码无效或已过期，请在 PC 上重新开启授权",
                )
                return@launch
            }
            _state.value = _state.value.copy(
                phase = SyncAuthUiState.Phase.Handshaking,
                qrHost = "${payload.host}:${payload.port}",
                qrExpiresAt = payload.expiresAt,
            )
            val hello = withContext(Dispatchers.IO) { authClient.startHandshake(payload) }
            when (hello) {
                is SyncTransportResult.Ok -> {
                    _state.value = _state.value.copy(
                        phase = SyncAuthUiState.Phase.AwaitingPcConfirm,
                        shortAuth = hello.value,
                    )
                    startPolling()
                }
                is SyncTransportResult.Fail -> {
                    _state.value = _state.value.copy(
                        phase = SyncAuthUiState.Phase.Failed,
                        error = hello.message.ifEmpty { "连接 PC 失败（${hello.code}）" },
                    )
                }
            }
        }
    }

    private fun startPolling() {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (isActive) {
                delay(1500)
                val r = withContext(Dispatchers.IO) { authClient.pollAuthStatus() }
                if (r is SyncTransportResult.Ok && r.value) {
                    val keys = withContext(Dispatchers.IO) { authClient.deriveSessionKeys() }
                    val session = withContext(Dispatchers.IO) { authClient.openSyncSession() }
                    if (keys is SyncTransportResult.Ok && session is SyncTransportResult.Ok) {
                        com.qingyu.companion.network.sync.LanSyncSessionState.markAuthorized(session.value.endpoint)
                        _state.value = _state.value.copy(
                            phase = SyncAuthUiState.Phase.Confirmed,
                            confirmed = true,
                        )
                    } else {
                        _state.value = _state.value.copy(
                            phase = SyncAuthUiState.Phase.Failed,
                            error = "已授权但建立同步会话失败",
                        )
                    }
                    return@launch
                }
                // 过期检查
                val exp = _state.value.qrExpiresAt
                if (exp != null && System.currentTimeMillis() >= exp) {
                    _state.value = _state.value.copy(
                        phase = SyncAuthUiState.Phase.Failed,
                        error = "授权已过期，请在 PC 上重新开启",
                    )
                    return@launch
                }
            }
        }
    }

    fun stopPolling() {
        pollJob?.cancel()
        pollJob = null
    }

    fun pauseUpload() {
        transport.pause()
    }

    fun resumeUpload() {
        transport.resume()
    }

    fun reset() {
        stopPolling()
        authClient.destroy()
        _state.value = SyncAuthUiState()
    }

    override fun onCleared() {
        stopPolling()
        authClient.destroy()
        super.onCleared()
    }
}
