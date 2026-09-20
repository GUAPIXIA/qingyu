package com.qingyu.companion.ui.startup

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * 启动决策状态。
 *
 * **阶段 4 收口：这里只依据本地状态决策，不存在任何「回退到 PC 伴侣模式」的状态。**
 * 旧的四态（`NeedsPairing` / `Ready` / `ReadyWithoutActive`）此前是伴侣模式时代的产物，
 * 在本地优先决策落地后**永远不会被产出**——但导航层仍在渲染它们，
 * 构成一条「代码与导航中的旧伴侣模式回退入口」（阶段 4 完成定义明确禁止）。
 * 现已删除；PC 连接仅作为**用户主动**入口保留在设置/会话页（阶段 7 主动同步需要）。
 */
sealed interface StartupState {
    data object LoadingLocalState : StartupState
    /** 已有本地资料/主库：无需 PC 即可进入主界面 */
    data object LocalReady : StartupState
    /** 本地资料未初始化：引导创建本地资料（不是配对页） */
    data object NeedsLocalSetup : StartupState
}

/**
 * 阶段 3 本地优先启动决策（纯函数）。
 *
 * 规则（S3-07）：
 * - 已有本地资料或本地主库 → `LocalReady`，直接进主界面；
 * - 其余（含旧伴侣缓存、什么都没有）→ `NeedsLocalSetup` 走本地初始化向导；
 * - 连接数**不参与**进入主界面的判定。
 */
data class LocalStartupSnapshot(
    val hasLocalProfile: Boolean = false,
    val hasLocalDb: Boolean = false,
    val hasLegacyCache: Boolean = false,
    val connectionCount: Int = 0,
)

fun decideStartupStateLocal(snapshot: LocalStartupSnapshot): StartupState {
    if (snapshot.hasLocalProfile || snapshot.hasLocalDb) return StartupState.LocalReady
    return StartupState.NeedsLocalSetup
}

private const val ENCRYPTED_PLACEHOLDER_PREFIX = "ENC:"

/**
 * 启动页 ViewModel：进入即读取一次本地快照并决策。
 *
 * 决策**只看本地**（`localSnapshotProvider`），不读连接列表、不做网络判断；
 * 因此启动路径上不可能出现「需要配对 PC」这一结果。
 * 网络恢复由 AppContainer.start() 的异步 restore() 并行进行。
 */
class StartupViewModel(
    private val localSnapshotProvider: suspend () -> LocalStartupSnapshot = { LocalStartupSnapshot() },
) : ViewModel() {

    private val _state = MutableStateFlow<StartupState>(StartupState.LoadingLocalState)
    val state: StateFlow<StartupState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            // 本地快照读取失败兜底为「需要本地初始化」：仅存储 IO 异常才会发生，不吞诊断
            val local = runCatching { localSnapshotProvider() }.getOrDefault(LocalStartupSnapshot())
            _state.value = decideStartupStateLocal(local)
        }
    }
}