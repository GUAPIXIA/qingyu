package com.qingyu.companion.data.settings

import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.model.SettingsDto
import kotlinx.coroutines.flow.StateFlow

/**
 * 设置同步 v2 领域模型与仓库接口（实施文档 §7 C-07）。
 *
 * 关键不变式：
 * - revision 是不透明字符串（PC 侧 sha256(安全子集)），客户端只做等值比较；
 * - 缓存按 deviceId 隔离，切换 PC 必须先清内存旧 snapshot（不把 A 的 activeModel PATCH 到 B）；
 * - 断线不排队高风险全局设置：直接 Failed（可重试），不做静默重放；
 * - 本机权威项（UiPrefsStore：主题/字号/间距/背景/应用锁/通知）绝不进入 PATCH，
 *   白名单在 [SettingsOwnership.SYNCABLE_FIELDS] 强制过滤。
 */

/** 设置协议：capability 协商结果（serverInfo capabilities 含 settings_snapshot_v2 → V2） */
enum class SettingsProtocol {
    /** 快照端点：乐观并发（baseRevision + 409 冲突检测） */
    SNAPSHOT_V2,

    /** 旧版 PC：直接 PATCH /settings，无冲突检测 */
    LEGACY,
}

/** 领域快照（DTO → 内存态；protocol 决定后续 patch 走哪条路径） */
data class SettingsSnapshot(
    val revision: String,
    val updatedAt: Long,
    val values: SettingsDto,
    val capabilities: Set<String> = emptySet(),
    val protocol: SettingsProtocol = SettingsProtocol.SNAPSHOT_V2,
)

/** 一次待应用/已失败的本地变更集（字段名 → 新值；字段名必属白名单） */
data class SettingsChange(
    val values: Map<String, Any?>,
) {
    val fields: Set<String> get() = values.keys
}

/** 冲突解决策略（C-08 底部面板两个动作 + 关闭） */
enum class ConflictStrategy {
    /** 加载 PC 值：放弃本次本地修改，采用远端快照 */
    KeepLocalUseRemote,

    /** 再次应用：以远端新 revision 为 base 重新 PATCH 本地改动 */
    ApplyLocalAgain,

    /** 关闭面板：保留本地未保存视图，不再自动处理 */
    Dismiss,
}

/** 同步状态机（每 PC 设置行的四态渲染依据，C-08） */
sealed interface SettingsSyncStatus {
    data object Idle : SettingsSyncStatus
    data object Refreshing : SettingsSyncStatus
    data class Saving(val fields: Set<String>) : SettingsSyncStatus

    /** fields：本批同步成功的字段（UI 行级勾/时间；首轮或纯刷新为空集） */
    data class Synced(
        val revision: String,
        val at: Long,
        val fields: Set<String> = emptySet(),
    ) : SettingsSyncStatus

    /** 409：local=本次修改，remote=PC 当前快照（面板展示"PC 当前值 vs 本次修改"） */
    data class Conflict(val local: SettingsChange, val remote: SettingsSnapshot) : SettingsSyncStatus

    /** 失败（change=null 表示刷新失败而非保存失败）；断线不排队，直接可重试 */
    data class Failed(val change: SettingsChange?, val error: CompanionError) : SettingsSyncStatus
}

/**
 * WS settings:updated 去重决策（纯函数，JVM 可测）：
 * 事件 revision 与本地已知 revision 相同 → 跳过（含自身 PATCH 的回声）；
 * force → 总是刷新；正在保存/冲突挂起 → 不打扰乐观编辑（保存完成后自然对齐或被 409 捕获）。
 */
fun shouldRefreshOnSettingsEvent(
    currentRevision: String?,
    eventRevision: String,
    force: Boolean = false,
    busy: Boolean = false,
): Boolean {
    if (force) return !busy
    if (busy) return false
    if (currentRevision == null) return true
    if (currentRevision.isEmpty()) return true // legacy 快照无 revision，事件本不该到；防御性刷新
    return eventRevision != currentRevision
}

/** 变更集合并（纯函数）：同字段后者覆盖前者（debounce 窗口内的连续输入合并语义） */
fun mergeSettingsChanges(first: SettingsChange?, second: SettingsChange): SettingsChange {
    if (first == null || first.values.isEmpty()) return second
    return SettingsChange(first.values + second.values)
}

/** 行级同步态（C-08 四态渲染的纯函数投影；冲突由全局面板承载，行上不重复标红） */
enum class FieldSyncState { Idle, Editing, Synced, Failed }

fun fieldSyncStateFor(status: SettingsSyncStatus, field: String): FieldSyncState = when (status) {
    is SettingsSyncStatus.Saving ->
        if (field in status.fields) FieldSyncState.Editing else FieldSyncState.Idle
    is SettingsSyncStatus.Synced ->
        if (field in status.fields) FieldSyncState.Synced else FieldSyncState.Idle
    is SettingsSyncStatus.Failed ->
        if (status.change?.values?.containsKey(field) == true) FieldSyncState.Failed else FieldSyncState.Idle
    is SettingsSyncStatus.Conflict, SettingsSyncStatus.Idle, SettingsSyncStatus.Refreshing ->
        FieldSyncState.Idle
}

/** 快照字段值的中性文本呈现（冲突面板/副标题复用，非 UI 文案） */
fun renderFieldValue(value: Any?): String = when (value) {
    null -> "（空）"
    is Boolean -> if (value) "开" else "关"
    is Double -> if (value % 1.0 == 0.0) value.toInt().toString() else value.toString()
    else -> value.toString()
}

interface SettingsSyncRepository {

    /** 当前绑定 PC 的设置快照（null = 未绑定/未加载成功） */
    val snapshot: StateFlow<SettingsSnapshot?>

    /** 同步状态机 */
    val status: StateFlow<SettingsSyncStatus>

    /** 当前协议（capability 协商结果；null = 未探测） */
    val protocol: StateFlow<SettingsProtocol?>

    /**
     * 绑定当前活跃 PC（deviceId 变更 = 切换 PC）：
     * 清空内存旧 snapshot → 加载目标 deviceId 的缓存 → 后台刷新。幂等。
     */
    suspend fun bind(deviceId: String)

    /** 拉取快照（v2 或 legacy）；WS 事件经 [shouldRefreshOnSettingsEvent] 去重后调用 */
    suspend fun refresh(force: Boolean = false)

    /** 提交变更（乐观并发 PATCH；legacy 直接保存；断线 → Failed 可重试，不排队） */
    suspend fun patch(change: SettingsChange)

    /** 冲突解决（非 Conflict 状态调用为 no-op） */
    suspend fun resolveConflict(strategy: ConflictStrategy)
}
