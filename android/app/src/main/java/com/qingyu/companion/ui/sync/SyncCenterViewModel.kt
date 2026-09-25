package com.qingyu.companion.ui.sync

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.network.sync.SyncCoordinator
import com.qingyu.companion.network.sync.SyncRunResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * 阶段 7 S7-07：Android 同步中心。
 *
 * 约束（方案 §7.1）：
 * - 只在用户点击后发起同步；**禁止**启动/进聊天页/联网变化时自动同步；
 * - 「提醒我有未同步更改」只统计本地 backlog，不发网络请求；
 * - 进度/错误只出现在本页，不进聊天页横幅。
 */
data class SyncCenterUiState(
    /** 本地未同步 change 数（backlog，纯本地） */
    val localBacklog: Int = 0,
    val lastSyncAt: Long? = null,
    val lastSyncResult: String? = null,
    val running: Boolean = false,
    val progressLabel: String? = null,
    val sent: Int = 0,
    val received: Int = 0,
    val error: String? = null,
    val remindUnsynced: Boolean = false,
    /** 局域网：是否已有授权会话密钥（S7-05） */
    val lanAuthorized: Boolean = false,
    /** 服务器：是否已配置同步服务器入口（阶段 8；未配置时只显示占位） */
    val serverConfigured: Boolean = false,
)

/**
 * [store] 只读 journal/backlog；[coordinator] 由 UI/容器注入（测试可 Fake）。
 */
class SyncCenterViewModel(
    private val store: LocalStore,
    private val backlogCounter: suspend () -> Int = { 0 },
    private val coordinator: SyncCoordinator? = null,
) : ViewModel() {

    private val _state = MutableStateFlow(SyncCenterUiState())
    val state: StateFlow<SyncCenterUiState> = _state.asStateFlow()

    init {
        refreshBacklog()
        refreshTargets()
    }

    fun refreshBacklog() {
        viewModelScope.launch {
            val n = runCatching { backlogCounter() }.getOrDefault(0)
            _state.value = _state.value.copy(localBacklog = n)
        }
    }

    fun refreshTargets() {
        val targets = coordinator?.availableTargets().orEmpty()
        _state.value = _state.value.copy(
            lanAuthorized = targets.contains(SyncCoordinator.Target.LAN),
            serverConfigured = targets.contains(SyncCoordinator.Target.SERVER),
        )
    }

    fun setRemindUnsynced(enabled: Boolean) {
        _state.value = _state.value.copy(remindUnsynced = enabled)
    }

    /** 用户显式取消 */
    fun cancelSync() {
        if (!_state.value.running) return
        coordinator?.cancel()
        _state.value = _state.value.copy(
            running = false,
            progressLabel = null,
            error = null,
            lastSyncResult = "cancelled",
            lastSyncAt = System.currentTimeMillis(),
        )
    }

    /**
     * 用户点击「开始同步」。未选目标或目标不可用时不发起任何网络请求。
     */
    fun startSync(target: SyncCoordinator.Target = SyncCoordinator.Target.LAN) {
        if (_state.value.running) return
        val c = coordinator ?: return
        if (!c.availableTargets().contains(target)) {
            _state.value = _state.value.copy(error = "目标未配置或未授权")
            return
        }
        _state.value = _state.value.copy(running = true, error = null, progressLabel = "session")
        viewModelScope.launch {
            val result: SyncRunResult = c.run(target) { phase, sent, received ->
                onProgress(phase, sent, received)
            }
            if (result.ok) {
                onSyncSuccess(result.uploaded, result.downloaded)
            } else if (result.error == "cancelled") {
                // cancelSync 已改状态
            } else {
                onSyncFailed(result.error ?: "同步失败", result.retryable)
            }
        }
    }

    /**
     * 用户点击「开始同步」后的进度回调（由 transport 调用）。
     * [phase] 对齐 ServerSyncTransport / Lan 流程阶段名。
     */
    fun onProgress(phase: String, sent: Int, received: Int) {
        _state.value = _state.value.copy(
            running = true,
            progressLabel = phase,
            sent = sent,
            received = received,
            error = null,
        )
    }

    fun onSyncSuccess(uploaded: Int, downloaded: Int) {
        _state.value = _state.value.copy(
            running = false,
            progressLabel = null,
            sent = uploaded,
            received = downloaded,
            lastSyncResult = "ok",
            lastSyncAt = System.currentTimeMillis(),
            error = null,
            localBacklog = 0,
        )
    }

    fun onSyncFailed(message: String, retryable: Boolean) {
        _state.value = _state.value.copy(
            running = false,
            progressLabel = null,
            lastSyncResult = if (retryable) "retryable" else "failed",
            lastSyncAt = System.currentTimeMillis(),
            error = message,
        )
    }

    fun markLanAuthorized() {
        _state.value = _state.value.copy(lanAuthorized = true)
    }
}
