package com.qingyu.companion.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.data.userMessage
import com.qingyu.companion.data.settings.ConflictStrategy
import com.qingyu.companion.data.settings.SettingsProtocol
import com.qingyu.companion.data.settings.SettingsChange
import com.qingyu.companion.data.settings.SettingsSyncRepository
import com.qingyu.companion.data.settings.SettingsSyncStatus
import com.qingyu.companion.data.settings.mergeSettingsChanges
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.model.SettingsDto
import com.qingyu.companion.model.VersionInfo
import com.qingyu.companion.network.ConnectionManager
import com.qingyu.companion.network.connection.ConnectionDiagnostics
import com.qingyu.companion.network.connection.ConnectionState
import com.qingyu.companion.data.settings.SettingsRejectionRegistry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 设置页 ViewModel（方案 §6.9 / §7 C-08）。
 * - 既有：缓存清除 / 全量抹除 / 版本检查 / 连接列表；
 * - 新增（阶段 C）：PC 权威设置区（同步到当前 PC）经 [SettingsSyncRepository]：
 *   四态保存语义（修改中/已同步/失败重试/冲突面板）、滑块 300ms debounce 合并、
 *   点击类立即提交防重复、capability 缺失降级 legacy（直接保存语义 + UI 标注）。
 * - 本机权威项（主题/字号/间距/背景/应用锁/通知）仍走 UiPrefsStore，绝不进 PATCH。
 */
class SettingsViewModel(
    private val repository: ChatRepository,
    private val connectionManager: ConnectionManager,
    private val settingsSync: SettingsSyncRepository? = null,
    /** 仓库是否本 VM 私有（默认工厂自建=true；AppContainer 共享注入=false，不得在 onCleared 关闭） */
    private val settingsSyncOwned: Boolean = true,
    /** B-07 诊断快照提供方（AppContainer 注入 coordinator.snapshotForDiagnostics；null = 不展示诊断卡片数据） */
    private val diagnosticsProvider: (suspend () -> ConnectionDiagnostics?)? = null,
    /** v2 PATCH「PC 拒绝字段」记录器（AppContainer 共享实例；null = 无行级拒绝反馈） */
    private val rejectionRegistry: SettingsRejectionRegistry? = null,
) : ViewModel() {

    data class UiState(
        val clearingCache: Boolean = false,
        val wiping: Boolean = false,
        /** 操作结果提示（info/error 复用，设置页单行提示） */
        val message: String? = null,
        val isError: Boolean = false,
        /** 已配对连接数（关于区展示） */
        val connectionCount: Int = 0,
        /** 当前活跃连接（连接详情区展示） */
        val activeConnection: ServerConnection? = null,
        /** 服务器最新版本信息（关于区「检查更新」，null=未检查/获取失败） */
        val latestVersion: VersionInfo? = null,
        /** 版本检查进行中 */
        val checkingVersion: Boolean = false,
        // ---------- 阶段 C：PC 设置同步 ----------
        /** 当前 PC 快照 values（乐观渲染基底） */
        val pcSettings: SettingsDto? = null,
        val syncStatus: SettingsSyncStatus = SettingsSyncStatus.Idle,
        /** capability 协商结果（null=未探测/未连接；LEGACY=旧版 PC 直接保存） */
        val syncProtocol: SettingsProtocol? = null,
        /** debounce 窗口内未提交的字段（滑块乐观显示值） */
        val pendingChanges: Map<String, Any?> = emptyMap(),
        /** PC 模型/预设候选（点击类行数据；空=未加载） */
        val pcModels: List<String> = emptyList(),
        val pcPresets: List<Pair<String, String>> = emptyList(), // id to name
        val pcListsLoading: Boolean = false,
        val pcListsError: String? = null,
        // ---------- 阶段 B-07：连接诊断卡片 ----------
        /** 脱敏诊断快照（endpoint/安全模式/最近 RTT/失败原因/尝试次数）；null=未注入或未取到 */
        val diagnostics: ConnectionDiagnostics? = null,
        // ---------- 阶段 C：rejectedFields 行级反馈 ----------
        /** 当前活跃 PC 拒绝的字段（field → PC 给出的 reason） */
        val rejectedFields: Map<String, String> = emptyMap(),
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    /** 连接状态（诊断卡片展示 + 重试倒计时；lifecycle-aware 收集在 UI 层） */
    val connectionState: StateFlow<ConnectionState> get() = connectionManager.connectionState

    /** 滑块 debounce 窗口（C-08：300ms 合并连续输入） */
    private val debounceWindowMs = 300L
    private var debounceJob: Job? = null
    private var syncedFlashJob: Job? = null
    private var lastBoundDeviceId: String? = null
    private var listsLoadedFor: String? = null

    init {
        refreshConnections()
        viewModelScope.launch {
            connectionManager.activeFlow.collect { active ->
                _ui.update { it.copy(activeConnection = active) }
                projectRejections()
                bindSettingsSync(active)
            }
        }
        // 连接诊断（B-07）：状态每次变化后重取脱敏快照（首条当前值也会触发一次刷新）
        if (diagnosticsProvider != null) {
            viewModelScope.launch {
                connectionManager.connectionState.collect {
                    refreshDiagnostics()
                }
            }
        }
        // rejectedFields 行级反馈（阶段 C）：拒绝记录变化 → 重新按活跃 PC 投影
        rejectionRegistry?.let { registry ->
            viewModelScope.launch {
                registry.byDevice.collect { projectRejections() }
            }
        }
        settingsSync?.let { sync ->
            viewModelScope.launch {
                sync.snapshot.collect { snap ->
                    _ui.update { it.copy(pcSettings = snap?.values) }
                }
            }
            viewModelScope.launch {
                sync.status.collect { status ->
                    _ui.update { it.copy(syncStatus = status) }
                    // 「已同步」勾为瞬时反馈：3s 后回落 Idle（独立 job，不阻塞后续状态分发）
                    syncedFlashJob?.cancel()
                    if (status is SettingsSyncStatus.Synced) {
                        syncedFlashJob = viewModelScope.launch {
                            delay(SYNCED_FLASH_MS)
                            if (_ui.value.syncStatus === status) {
                                _ui.update { it.copy(syncStatus = SettingsSyncStatus.Idle) }
                            }
                        }
                    }
                }
            }
            viewModelScope.launch {
                sync.protocol.collect { p ->
                    _ui.update { it.copy(syncProtocol = p) }
                }
            }
        }
    }

    /** 重取脱敏诊断快照（IO 轻量：环形内存 + 首次惰性读 JSON-lines；失败静默保留旧值） */
    private suspend fun refreshDiagnostics() {
        val provider = diagnosticsProvider ?: return
        val snapshot = runCatching { provider() }.getOrNull() ?: return
        _ui.update { it.copy(diagnostics = snapshot) }
    }

    /** 拒绝记录 → 当前活跃 PC 的 field→reason 投影（切换 PC / 记录变化时刷新） */
    private fun projectRejections() {
        val registry = rejectionRegistry ?: return
        val reasons = registry.reasonsFor(_ui.value.activeConnection?.deviceId)
        _ui.update { it.copy(rejectedFields = reasons) }
    }

    /** 切换 PC 绑定：deviceId 变更 → 仓库清内存旧 snapshot + 加载目标缓存 */
    private fun bindSettingsSync(active: ServerConnection?) {        val sync = settingsSync ?: return
        val deviceId = active?.deviceId ?: return
        viewModelScope.launch {
            try {
                sync.bind(deviceId)
                lastBoundDeviceId = deviceId
                loadPcLists(deviceId)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // 仓库内部已统一转 CompanionError 到 status；绑定失败不打断设置页
            }
        }
    }

    /** 模型/预设候选列表（点击类行的数据源；失败仅提示，不阻塞快照读写） */
    private fun loadPcLists(deviceId: String) {
        if (listsLoadedFor == deviceId) return
        listsLoadedFor = deviceId
        viewModelScope.launch {
            _ui.update { it.copy(pcListsLoading = true, pcListsError = null) }
            val result = runCatching {
                val models = repository.listModels()
                val presets = repository.listPresets().map { it.id to it.name }
                models to presets
            }
            result
                .onSuccess { (models, presets) ->
                    _ui.update {
                        it.copy(
                            pcModels = models,
                            pcPresets = presets,
                            pcListsLoading = false,
                        )
                    }
                }
                .onFailure { e ->
                    listsLoadedFor = null
                    _ui.update {
                        it.copy(
                            pcListsLoading = false,
                            pcListsError = if (e is CompanionError) e.userMessage() else e.message,
                        )
                    }
                }
        }
    }

    /** 立即提交（点击类：开关/选项/保存按钮）：防重复=同字段保存中忽略 */
    fun commitPcField(field: String, value: Any?) {
        val sync = settingsSync ?: return
        val state = _ui.value
        if (state.syncStatus is SettingsSyncStatus.Saving && field in state.syncStatus.fields) return
        // 同字段若有 debounce 挂起值，取消挂起避免旧值覆盖
        cancelDebounce(field)
        viewModelScope.launch {
            sync.patch(SettingsChange(mapOf(field to value)))
        }
    }

    /** 滑块输入：合并进 pending，300ms debounce 窗口后一次性 PATCH */
    fun changePcSlider(field: String, value: Double) {
        val sync = settingsSync ?: return
        _ui.update { it.copy(pendingChanges = it.pendingChanges + (field to value)) }
        debounceJob?.cancel()
        debounceJob = viewModelScope.launch {
            delay(debounceWindowMs)
            val pending = _ui.value.pendingChanges
            _ui.update { it.copy(pendingChanges = emptyMap()) }
            if (pending.isNotEmpty()) {
                sync.patch(SettingsChange(pending))
            }
        }
    }

    /** 合并连续变更（纯函数语义入口，供测试与批量提交复用） */
    fun coalesceChanges(existing: Map<String, Any?>, incoming: Map<String, Any?>): Map<String, Any?> =
        mergeSettingsChanges(
            existing.takeIf { it.isNotEmpty() }?.let(::SettingsChange),
            SettingsChange(incoming),
        ).values

    private fun cancelDebounce(field: String) {
        val pending = _ui.value.pendingChanges
        if (pending.containsKey(field)) {
            val next = pending - field
            _ui.update { it.copy(pendingChanges = next) }
            if (next.isEmpty()) debounceJob?.cancel()
        }
    }

    /** 失败重试（红色「未同步」点击） */
    fun retrySync() {
        val sync = settingsSync ?: return
        val status = _ui.value.syncStatus
        viewModelScope.launch {
            when (status) {
                is SettingsSyncStatus.Failed ->
                    if (status.change != null) sync.patch(status.change) else sync.refresh(force = true)
                else -> sync.refresh(force = true)
            }
        }
    }

    /** 冲突面板动作 */
    fun resolveConflict(strategy: ConflictStrategy) {
        val sync = settingsSync ?: return
        viewModelScope.launch { runCatching { sync.resolveConflict(strategy) } }
    }

    /** 下拉/进入时手动刷新 PC 快照 */
    fun refreshPcSettings() {
        val sync = settingsSync ?: return
        viewModelScope.launch { runCatching { sync.refresh(force = true) } }
    }

    /** 行级乐观显示值：pending(debounce) > 快照 values 由 UI 读取 */
    fun pendingValue(field: String): Any? = _ui.value.pendingChanges[field]

    fun refreshConnections() {
        viewModelScope.launch {
            val count = connectionManager.listConnections().size
            _ui.update { it.copy(connectionCount = count) }
        }
    }

    /** 仅清本地缓存（保留连接配置） */
    fun clearCache() {
        if (_ui.value.clearingCache) return
        viewModelScope.launch {
            _ui.update { it.copy(clearingCache = true, message = null) }
            try {
                repository.clearLocalCache()
                _ui.update {
                    it.copy(clearingCache = false, message = "本地缓存已清除（连接配置保留）", isError = false)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update {
                    it.copy(clearingCache = false, message = e.message ?: "清除缓存失败", isError = true)
                }
            }
        }
    }

    /** 退出时清除：清缓存 + 移除全部连接（二次确认在 UI 层） */
    fun wipeAll() {
        if (_ui.value.wiping) return
        viewModelScope.launch {
            _ui.update { it.copy(wiping = true, message = null) }
            try {
                repository.wipeLocalData()
                _ui.update {
                    it.copy(
                        wiping = false,
                        message = "已清除全部本地数据，下次启动需重新配对",
                        isError = false,
                        connectionCount = 0,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update {
                    it.copy(wiping = false, message = e.message ?: "清除失败", isError = true)
                }
            }
        }
    }

    fun clearMessage() = _ui.update { it.copy(message = null) }

    /** 从公告服务器获取最新版本号（走 PC 桥接层 /api/v1/version，统一错误模型） */
    fun checkVersion() {
        if (_ui.value.checkingVersion) return
        viewModelScope.launch {
            _ui.update { it.copy(checkingVersion = true, message = null) }
            try {
                val info = repository.fetchVersionInfo()
                _ui.update { it.copy(checkingVersion = false, latestVersion = info) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val msg = if (e is CompanionError) e.userMessage() else e.message ?: "检查更新失败"
                _ui.update {
                    it.copy(checkingVersion = false, message = msg, isError = true)
                }
            }
        }
    }

    /** 关闭版本信息弹窗 */
    fun clearLatestVersion() = _ui.update { it.copy(latestVersion = null) }

    override fun onCleared() {
        super.onCleared()
        debounceJob?.cancel()
        if (settingsSyncOwned) {
            (settingsSync as? com.qingyu.companion.data.settings.OnlineSettingsSyncRepository)?.close()
        }
    }

    private companion object {
        /** 「已同步」勾的瞬时展示时长（C-08：短暂显示后回落） */
        const val SYNCED_FLASH_MS = 3_000L
    }
}
