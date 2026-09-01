package com.qingyu.companion.ui.startup

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.StartupRepository
import com.qingyu.companion.data.StartupSnapshot
import com.qingyu.companion.model.ServerConnection
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * 启动决策四态（A-03）。
 * [StartupState.Ready.needsRepair]：active 命中但其 token 解密失败（EncryptedPrefs 丢失），
 * 不删数据；导航层将其引导至 CONNECTION_PICKER 作为"需要修复连接"入口（保持简单）。
 */
sealed interface StartupState {
    data object LoadingLocalState : StartupState
    data object NeedsPairing : StartupState
    data class Ready(val activeDeviceId: String, val needsRepair: Boolean = false) : StartupState
    data class ReadyWithoutActive(val connections: List<ServerConnection>) : StartupState
}

/**
 * 启动决策纯函数（单测目标）：只依据本地快照，不做任何网络判断。
 * - 空 store -> NeedsPairing
 * - active 命中现存连接 -> Ready(activeDeviceId)；token 为 ENC: 占位（解密失败）时 needsRepair=true
 * - 有连接但 active id 丢失 / 指向已删除设备 / active token 损坏 -> ReadyWithoutActive（不自动选、不删数据）
 * - active id 存在但列表为空 -> NeedsPairing（视为无连接）
 */
fun decideStartupState(snapshot: StartupSnapshot): StartupState {
    val connections = snapshot.connections
    if (connections.isEmpty()) return StartupState.NeedsPairing
    val active = snapshot.activeConnection
    if (active != null && connections.any { it.deviceId == active.deviceId }) {
        val repair = active.token.startsWith(ENCRYPTED_PLACEHOLDER_PREFIX) ||
            active.deviceId in snapshot.corruptedDeviceIds
        return StartupState.Ready(activeDeviceId = active.deviceId, needsRepair = repair)
    }
    // active 为 null（无记录或记录指向已删除设备）或交叉比对不命中：展示设备选择，不擅自选错 PC
    return StartupState.ReadyWithoutActive(connections)
}

private const val ENCRYPTED_PLACEHOLDER_PREFIX = "ENC:"

/**
 * 启动页 ViewModel：进入即读取一次本地快照并决策。
 * 只读 DataStore（[StartupRepository.loadStartupSnapshot]），不等待 DNS/REST/WS；
 * 网络恢复仍由 AppContainer.start() 的异步 restore() 并行进行。
 */
class StartupViewModel(
    private val startupRepository: StartupRepository,
) : ViewModel() {

    private val _state = MutableStateFlow<StartupState>(StartupState.LoadingLocalState)
    val state: StateFlow<StartupState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            // 快照读取失败兜底为 NeedsPairing：仅 DataStore IO 异常才会发生，不吞诊断
            val snapshot = runCatching { startupRepository.loadStartupSnapshot() }
                .getOrDefault(StartupSnapshot())
            _state.value = decideStartupState(snapshot)
        }
    }
}
