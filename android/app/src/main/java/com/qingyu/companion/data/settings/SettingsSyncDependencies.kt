package com.qingyu.companion.data.settings

import android.content.Context
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.RejectedFieldDto
import com.qingyu.companion.model.SettingsPatchRequestDto
import com.qingyu.companion.model.SettingsPatchResponseDto
import com.qingyu.companion.network.ConnectionManager
import com.qingyu.companion.network.QingyuApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * 设置同步的最小依赖注入面（阶段 C；AppContainer 归主代理，本文件提供工厂，
 * SettingsViewModel 经参数注入，默认走 [createSettingsSyncRepository]）。
 *
 * 主代理后续在 AppContainer 接线清单（全部为现有暴露成员的组装，无需改这些类）：
 * ```
 * // 1) 成员定义（AppContainer 构造体内）：
 * val settingsCacheStore = SettingsCacheStore(appContext, json)
 * val settingsRejectionRegistry = SettingsRejectionRegistry()
 * val settingsSyncRepository: SettingsSyncRepository = createSettingsSyncRepository(
 *     SettingsSyncDependencies(
 *         apiProvider = { connectionManager.activeApi() },
 *         deviceIdProvider = { connectionManager.activeConnection?.deviceId },
 *         capabilitiesProvider = {
 *             val active = connectionManager.activeConnection
 *                 ?: throw IllegalStateException("未连接 PC")
 *             connectionManager.anonApi(active).serverInfo().capabilities
 *         },
 *         settingsEvents = wsClient.events,   // 或 repository.events
 *         cacheStore = settingsCacheStore,
 *         rejectionRegistry = settingsRejectionRegistry,
 *     ),
 * )
 * // 2) 活跃连接变化时绑定（connectionManager.activeFlow 收集处或 switchTo 后）：
 * scope.launch { settingsSyncRepository.bind(deviceId) }
 * // 3) remove(deviceId)/wipeLocalData 时：settingsCacheStore.clear(deviceId) / clearAll()
 * ```
 * 接线现状：AppContainer 已按上述清单完成接线（api/deviceId/capabilities 现取自 connectionManager，
 * settingsEvents 接 wsClient.events，cacheStore/rejectionRegistry 为容器字段），SettingsViewModel
 * 注入共享仓库、跨页状态连续；仅当未接线时 SettingsViewModel 才用默认工厂自建同构仓库（行为一致，
 * 只是缓存目录按 appContext 解析）。
 */
data class SettingsSyncDependencies(
    /** 当前活跃连接的鉴权 API（null = 未连接） */
    val apiProvider: () -> QingyuApi?,
    /** 当前活跃 PC 的 deviceId（null = 未绑定） */
    val deviceIdProvider: () -> String?,
    /** serverInfo capabilities 探测；旧 PC 缺字段/失败 → 空集 → legacy 降级（正确行为） */
    val capabilitiesProvider: suspend () -> Set<String>,
    /** WS 事件流（settings:updated 去重 refresh 用；null = 不实时订阅） */
    val settingsEvents: SharedFlow<CompanionEvent>? = null,
    /** 快照磁盘缓存（null = 仅内存，离线不回看） */
    val cacheStore: SettingsCacheStore? = null,
    /** v2 PATCH rejectedFields 行级记录器（null = 不记录，UI 无「PC 拒绝」行级反馈） */
    val rejectionRegistry: SettingsRejectionRegistry? = null,
)

fun createSettingsSyncRepository(deps: SettingsSyncDependencies): SettingsSyncRepository {
    // rejectedFields 捕获：仓库把 v2 PATCH 响应整体转快照后丢弃 rejectedFields/appliedFields，
    // 在 API 出口（仓库唯一取 API 的路径）包一层捕获器，PC 拒绝信息不丢。
    val apiProvider = deps.rejectionRegistry?.let { registry ->
        { deps.apiProvider()?.let { api -> RejectionCapturingApi(api, registry) } }
    } ?: deps.apiProvider
    return OnlineSettingsSyncRepository(
        apiProvider = apiProvider,
        deviceIdProvider = deps.deviceIdProvider,
        capabilitiesProvider = deps.capabilitiesProvider,
        settingsEvents = deps.settingsEvents,
        cacheStore = deps.cacheStore,
    )
}

/**
 * v2 PATCH「PC 拒绝字段」记录器（阶段 C 轻量行级反馈的数据源）。
 *
 * 按 deviceId 隔离（多 PC 不串台）：PC 返回 appliedFields → 撤销对应行的拒绝态
 * （用户重新保存成功即自愈）；返回 rejectedFields → 记录 field → reason，
 * UI（SettingsViewModel）据此把该行投影为失败态「PC 拒绝：<reason>」。
 */
class SettingsRejectionRegistry(private val clock: () -> Long = System::currentTimeMillis) {

    data class RejectedEntry(val reason: String, val at: Long)

    private val _byDevice = MutableStateFlow<Map<String, Map<String, RejectedEntry>>>(emptyMap())

    /** deviceId → (field → 拒绝记录)；UI 只读 */
    val byDevice: StateFlow<Map<String, Map<String, RejectedEntry>>> = _byDevice.asStateFlow()

    /** 一次 v2 PATCH 响应的捕获结果（applied 清旧账，rejected 记新账） */
    fun onPatchResponse(sourceDeviceId: String?, applied: List<String>, rejected: List<RejectedFieldDto>) {
        val key = sourceDeviceId ?: return
        _byDevice.update { byDevice ->
            val next = byDevice[key].orEmpty()
                .minus(applied.toSet())
                .plus(rejected.map { it.field }.zip(rejected.map { RejectedEntry(it.reason, clock()) }))
            if (next.isEmpty()) byDevice - key else byDevice + (key to next)
        }
    }

    /** 某台 PC 当前被拒绝的字段（field → reason；无则空表） */
    fun reasonsFor(deviceId: String?): Map<String, String> =
        byDevice.value[deviceId].orEmpty().mapValues { it.value.reason }

    /** 连接被移除时清理该 PC 的拒绝记录（AppContainer remove 路径调用） */
    fun clearDevice(deviceId: String) {
        _byDevice.update { it - deviceId }
    }

    /** 退出时清除（AppContainer wipe 路径调用） */
    fun clearAll() {
        _byDevice.value = emptyMap()
    }
}

/** API 出口捕获器：仅拦截 v2 快照 PATCH 响应，其余成员原样委托（Kotlin 接口委托 + 单点覆写）。 */
internal class RejectionCapturingApi(
    private val impl: QingyuApi,
    private val registry: SettingsRejectionRegistry,
) : QingyuApi by impl {
    override suspend fun patchSettingsSnapshot(body: SettingsPatchRequestDto): SettingsPatchResponseDto {
        val response = impl.patchSettingsSnapshot(body)
        // 409 冲突走异常路径不会到这里；成功响应才可能携带 rejectedFields
        registry.onPatchResponse(body.sourceDeviceId, response.appliedFields, response.rejectedFields)
        return response
    }
}

/**
 * 默认装配（不动 AppContainer）：活跃 API 经 ConnectionManager 现取；
 * capabilities 经匿名 serverInfo（旧 PC 不返回该字段 → 空集 → legacy，符合降级要求）。
 * eventsProvider 传 ChatRepository/WsClient 的事件流以启用实时去重刷新。
 */
fun createSettingsSyncRepository(
    connectionManager: ConnectionManager,
    eventsProvider: (() -> SharedFlow<CompanionEvent>?)? = null,
    context: Context? = null,
): SettingsSyncRepository {
    val cache = context?.let { SettingsCacheStore(it) }
    return OnlineSettingsSyncRepository(
        apiProvider = { connectionManager.activeApi() },
        deviceIdProvider = { connectionManager.activeConnection?.deviceId },
        capabilitiesProvider = {
            val active = connectionManager.activeConnection
                ?: throw IllegalStateException("未连接 PC")
            connectionManager.anonApi(active).serverInfo().capabilities
        },
        settingsEvents = eventsProvider?.let { runCatching { it() }.getOrNull() },
        cacheStore = cache,
    )
}
