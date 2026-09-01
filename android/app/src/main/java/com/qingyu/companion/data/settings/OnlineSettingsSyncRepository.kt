package com.qingyu.companion.data.settings

import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.data.toCompanionError
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.SettingsDto
import com.qingyu.companion.model.SettingsPatchRequestDto
import com.qingyu.companion.model.SettingsPatchResponseDto
import com.qingyu.companion.model.SettingsSnapshotDto
import com.qingyu.companion.network.QingyuApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * [SettingsSyncRepository] 在线实现（方案 §7 C-07）。
 *
 * capability 门控：每次 bind 后首次操作经 [capabilitiesProvider]（serverInfo）协商协议；
 * 含 settings_snapshot_v2 走快照端点，否则 legacy 旧 /settings（UI 标注不支持冲突检测）。
 *
 * 并发模型：refresh/patch/resolve 全部经 [opMutex] 串行；
 * patch 持锁等待（后到的变更在其后顺序应用），refresh 无锁快速跳过（tryLock）。
 */
class OnlineSettingsSyncRepository(
    private val apiProvider: () -> QingyuApi?,
    private val deviceIdProvider: () -> String?,
    private val capabilitiesProvider: suspend () -> Set<String>,
    private val settingsEvents: SharedFlow<CompanionEvent>?,
    private val cacheStore: SettingsCacheStore?,
    private val clock: () -> Long = System::currentTimeMillis,
) : SettingsSyncRepository {

    private val _snapshot = MutableStateFlow<SettingsSnapshot?>(null)
    override val snapshot: StateFlow<SettingsSnapshot?> = _snapshot.asStateFlow()

    private val _status = MutableStateFlow<SettingsSyncStatus>(SettingsSyncStatus.Idle)
    override val status: StateFlow<SettingsSyncStatus> = _status.asStateFlow()

    private val _protocol = MutableStateFlow<SettingsProtocol?>(null)
    override val protocol: StateFlow<SettingsProtocol?> = _protocol.asStateFlow()

    private val opMutex = Mutex()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var eventsJob: Job? = null

    @Volatile
    private var boundDeviceId: String? = null

    override suspend fun bind(deviceId: String) {
        if (boundDeviceId == deviceId && _snapshot.value != null) return
        // 切换 PC（或首次绑定）：先清内存旧 snapshot——绝不把 A 的 activeModel PATCH 到 B
        if (boundDeviceId != deviceId) {
            _snapshot.value = null
            _protocol.value = null
            _status.value = SettingsSyncStatus.Idle
        }
        boundDeviceId = deviceId
        // 加载目标 deviceId 的缓存（离线可看 + 乐观 PATCH 的 baseRevision 起点）
        cacheStore?.load(deviceId)?.let { cached ->
            if (boundDeviceId == deviceId) {
                _snapshot.value = cached.copy(protocol = _protocol.value ?: cached.protocol)
            }
        }
        // WS settings:updated → 去重 refresh（revision 相同跳过）
        eventsJob?.cancel()
        settingsEvents?.let { flow ->
            eventsJob = scope.launch {
                flow.collect { event ->
                    if (event !is CompanionEvent.SettingsUpdated) return@collect
                    if (boundDeviceId != deviceId) return@collect
                    val busy = status.value is SettingsSyncStatus.Saving ||
                        status.value is SettingsSyncStatus.Conflict
                    if (shouldRefreshOnSettingsEvent(_snapshot.value?.revision, event.revision, busy = busy)) {
                        runCatching { refresh(force = false) }
                    }
                }
            }
        }
        runCatching { refresh(force = false) }
    }

    override suspend fun refresh(force: Boolean) {
        val deviceId = boundDeviceId ?: return
        if (opMutex.isLocked && !force) return
        val busy = status.value
        // 保存/冲突挂起期间不打扰乐观编辑（保存结果自带最新快照）
        if (busy is SettingsSyncStatus.Saving || busy is SettingsSyncStatus.Conflict) return
        opMutex.withLock {
            if (boundDeviceId != deviceId) return
            _status.value = SettingsSyncStatus.Refreshing
            val api = apiProvider()
                ?: run {
                    _status.value = SettingsSyncStatus.Failed(null, CompanionError.Offline())
                    return
                }
            val protocol = probeProtocol()
            val result = runCatching { fetchSnapshot(api, protocol) }
            if (boundDeviceId != deviceId) return
            result
                .onSuccess { snap ->
                    _snapshot.value = snap
                    cacheStore?.save(deviceId, snap)
                    _status.value = SettingsSyncStatus.Synced(snap.revision, clock())
                }
                .onFailure { e ->
                    _status.value = SettingsSyncStatus.Failed(null, e.toCompanionError())
                }
        }
    }

    override suspend fun patch(change: SettingsChange) {
        val deviceId = boundDeviceId ?: run {
            _status.value = SettingsSyncStatus.Failed(change, CompanionError.Offline("未连接 PC"))
            return
        }
        val patchJson = buildSettingsPatch(change.values)
        if (patchJson.isEmpty()) return // 全部为白名单外字段（本机权威项），静默丢弃
        opMutex.withLock {
            if (boundDeviceId != deviceId) return
            _status.value = SettingsSyncStatus.Saving(patchJson.keys)
            val api = apiProvider()
                ?: run {
                    // 断线不排队高风险全局设置：直接 Failed + 可重试
                    _status.value = SettingsSyncStatus.Failed(change, CompanionError.Offline())
                    return
                }
            val protocol = probeProtocol()
            // v2 需要 baseRevision：本地无快照时先静默拉一次
            if (protocol == SettingsProtocol.SNAPSHOT_V2 && _snapshot.value?.revision.isNullOrEmpty()) {
                runCatching {
                    fetchSnapshot(api, protocol).also { _snapshot.value = it }
                }.onFailure {
                    _status.value = SettingsSyncStatus.Failed(change, it.toCompanionError())
                    return
                }
            }
            val baseRevision = _snapshot.value?.revision.orEmpty()
            val result = runCatching {
                if (protocol == SettingsProtocol.SNAPSHOT_V2) {
                    api.patchSettingsSnapshot(
                        SettingsPatchRequestDto(
                            baseRevision = baseRevision,
                            patch = patchJson,
                            sourceDeviceId = deviceIdProvider() ?: deviceId,
                        ),
                    ).toDomain()
                } else {
                    api.patchSettings(patchJson)
                    // legacy 无 revision：本地合并视图
                    applyToSnapshot { current ->
                        current.copy(values = mergeLocalOverRemote(current.values, change.values))
                    }
                    null
                }
            }
            if (boundDeviceId != deviceId) return
            result
                .onSuccess { snap ->
                    // v2：服务端返回权威快照；legacy：本地合并视图（applyToSnapshot 已更新）
                    snap?.let { _snapshot.value = it }
                    _snapshot.value?.let { cacheStore?.save(deviceId, it) }
                    _status.value = SettingsSyncStatus.Synced(
                        revision = _snapshot.value?.revision.orEmpty(),
                        at = clock(),
                        fields = patchJson.keys,
                    )
                }
                .onFailure { e ->
                    val err = e.toCompanionError()
                    if (err is CompanionError.Conflict && err.current != null) {
                        // 409：采用远端当前快照 + 进入 Conflict 供 UI 面板处理
                        val remote = err.current.toDomain(probeProtocolCached())
                        _snapshot.value = remote
                        cacheStore?.save(deviceId, remote)
                        _status.value = SettingsSyncStatus.Conflict(change, remote)
                    } else {
                        _status.value = SettingsSyncStatus.Failed(change, err)
                    }
                }
        }
    }

    override suspend fun resolveConflict(strategy: ConflictStrategy) {
        val conflict = _status.value as? SettingsSyncStatus.Conflict ?: return
        when (strategy) {
            // 加载 PC 值：快照已是远端当前值，放弃本地修改
            ConflictStrategy.KeepLocalUseRemote ->
                _status.value = SettingsSyncStatus.Synced(
                    revision = conflict.remote.revision,
                    at = clock(),
                    fields = conflict.local.fields,
                )
            // 再次应用：以远端新 revision 为 base 重新 PATCH
            ConflictStrategy.ApplyLocalAgain -> patch(conflict.local)
            // 关闭：保留远端快照（不自动处理），状态回 Idle
            ConflictStrategy.Dismiss -> _status.value = SettingsSyncStatus.Idle
        }
    }

    /** 释放内部协程（ViewModel onCleared / 容器销毁时调用） */
    fun close() {
        eventsJob?.cancel()
        boundDeviceId = null
        _snapshot.value = null
        _status.value = SettingsSyncStatus.Idle
    }

    // ---------- 私有 ----------

    private fun probeProtocolCached(): SettingsProtocol =
        _protocol.value ?: SettingsProtocol.LEGACY

    /** capability 协商：探测失败（离线）不缓存结果，下次操作重新协商；已有快照沿用其协议 */
    private suspend fun probeProtocol(): SettingsProtocol {
        _protocol.value?.let { return it }
        val caps = runCatching { capabilitiesProvider() }.getOrNull()
            ?: return _snapshot.value?.protocol ?: SettingsProtocol.LEGACY
        return (if (SettingsOwnership.useSnapshotProtocol(caps)) {
            SettingsProtocol.SNAPSHOT_V2
        } else {
            SettingsProtocol.LEGACY
        }).also { _protocol.value = it }
    }

    private suspend fun fetchSnapshot(api: QingyuApi, protocol: SettingsProtocol): SettingsSnapshot =
        if (protocol == SettingsProtocol.SNAPSHOT_V2) {
            api.getSettingsSnapshot().toDomain(SettingsProtocol.SNAPSHOT_V2)
        } else {
            SettingsSnapshot(
                revision = "",
                updatedAt = 0L,
                values = api.getSettings(),
                capabilities = emptySet(),
                protocol = SettingsProtocol.LEGACY,
            )
        }

    private inline fun applyToSnapshot(transform: (SettingsSnapshot) -> SettingsSnapshot) {
        val current = _snapshot.value ?: SettingsSnapshot("", 0L, SettingsDto(), protocol = probeProtocolCached())
        _snapshot.value = transform(current)
    }

    private fun SettingsSnapshotDto.toDomain(protocol: SettingsProtocol = SettingsProtocol.SNAPSHOT_V2) =
        SettingsSnapshot(
            revision = revision,
            updatedAt = updatedAt,
            values = values,
            capabilities = capabilities,
            protocol = protocol,
        )

    private fun SettingsPatchResponseDto.toDomain() = SettingsSnapshot(
        revision = revision,
        updatedAt = updatedAt,
        values = values,
        capabilities = capabilities,
        protocol = SettingsProtocol.SNAPSHOT_V2,
    )
}
