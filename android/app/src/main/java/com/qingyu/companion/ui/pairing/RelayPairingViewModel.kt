package com.qingyu.companion.ui.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.DeviceIdentity
import com.qingyu.companion.data.relay.RelayCredentialStore
import com.qingyu.companion.data.relay.RelayPairingRepository
import com.qingyu.companion.model.ConnectionMode
import com.qingyu.companion.model.RelayConnectionMeta
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.network.ConnectionManager
import com.qingyu.companion.network.relay.RelayUrlPolicy
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class RelayPairingViewModel(
    private val manager: ConnectionManager,
    private val identity: DeviceIdentity,
    private val repository: RelayPairingRepository,
    private val credentials: RelayCredentialStore,
) : ViewModel() {
    data class UiState(
        val baseUrl: String = RelayUrlPolicy.DEFAULT_BASE_URL,
        val code: String = "",
        val ticket: String? = null,
        val displayName: String = "",
        val pairing: Boolean = false,
        val error: String? = null,
    )
    private val mutable = MutableStateFlow(UiState())
    val ui = mutable.asStateFlow()
    fun baseUrl(value: String) = mutable.update { it.copy(baseUrl = value, ticket = null, error = null) }
    fun code(value: String) = mutable.update { it.copy(code = value.uppercase().take(8), ticket = null, error = null) }
    fun applyQr(raw: String): Boolean = runCatching {
        val qr = repository.parseQr(raw)
        mutable.value = UiState(baseUrl = qr.relayBaseUrl, ticket = qr.ticket, displayName = qr.displayName)
    }.fold({ true }, { mutable.update { state -> state.copy(error = it.message) }; false })

    fun pair(onSuccess: () -> Unit) {
        val state = mutable.value
        if (state.baseUrl.isBlank() || (state.ticket == null && state.code.length != 8)) {
            mutable.update { it.copy(error = "请扫描 Relay 二维码或输入完整的 8 位连接码") }; return
        }
        viewModelScope.launch {
            mutable.update { it.copy(pairing = true, error = null) }
            runCatching {
                val base = RelayUrlPolicy.normalizeBaseUrl(state.baseUrl)
                val result = repository.claimAndWait(state.baseUrl, state.ticket, state.code.takeIf { it.isNotBlank() }, identity.displayName, identity.fingerprint)
                require(result.status == "approved" && result.spaceId != null && result.deviceId != null && result.accessToken != null && result.refreshToken != null) {
                    if (result.status == "rejected") "电脑端已拒绝连接" else "Relay 配对响应不完整"
                }
                credentials.save(result.deviceId, result.accessToken, result.refreshToken)
                manager.addConnection(ServerConnection(
                    name = state.displayName.ifBlank { "服务器连接" }, host = base.host, port = base.port,
                    token = result.accessToken, deviceId = result.deviceId, fingerprint = "relay",
                    mode = ConnectionMode.RELAY,
                    relay = RelayConnectionMeta(state.baseUrl, result.spaceId, result.accessTokenExpiresAt ?: 0),
                ))
            }.onSuccess { mutable.update { it.copy(pairing = false) }; onSuccess() }
                .onFailure { error -> mutable.update { it.copy(pairing = false, error = error.message ?: "Relay 配对失败") } }
        }
    }
}
