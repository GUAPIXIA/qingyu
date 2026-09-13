package com.qingyu.companion.data

import android.content.Context
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.room.Room
import com.qingyu.companion.BuildConfig
import com.qingyu.companion.network.ConnectionManager
import com.qingyu.companion.network.ConnectionManagerImpl
import com.qingyu.companion.network.NetworkModule
import com.qingyu.companion.network.NetworkStack
import com.qingyu.companion.network.NsdDiscovery
import com.qingyu.companion.network.WsClient
import com.qingyu.companion.network.WsClientImpl
import com.qingyu.companion.network.connection.AndroidConnectivityObserver
import com.qingyu.companion.network.connection.ConnectionCoordinator
import com.qingyu.companion.network.connection.ConnectionEndpoint
import com.qingyu.companion.network.connection.ConnectionMetrics
import com.qingyu.companion.network.connection.ConnectivityObserver
import com.qingyu.companion.network.connection.EndpointNormalizer
import com.qingyu.companion.data.relay.RelayCredentialStore
import com.qingyu.companion.data.settings.SettingsCacheStore
import com.qingyu.companion.data.settings.SettingsRejectionRegistry
import com.qingyu.companion.data.settings.SettingsSyncDependencies
import com.qingyu.companion.data.settings.SettingsSyncRepository
import com.qingyu.companion.data.settings.createSettingsSyncRepository
import com.qingyu.companion.ui.tts.ExoPlayerTtsPlayer
import com.qingyu.companion.ui.tts.TtsPlayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

/**
 * 手动依赖装配（无 Hilt，保持工程轻量）。
 * 单例对象图：网络层 -> 数据层 -> UI 层共享；[start] 恢复上次连接。
 */
class AppContainer(context: Context) {

    private val appContext = context.applicationContext

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    val json: Json = NetworkModule.json

    // ---------- 阶段 C：PC 设置同步（接线①②④：缓存存储 / 拒绝记录器 / 删除路径清理） ----------

    /** 设置快照磁盘缓存（按 deviceId 隔离；SettingsSyncRepository 离线回看 + 删除连接时清理） */
    val settingsCacheStore: SettingsCacheStore = SettingsCacheStore(appContext, json)

    /** v2 PATCH「PC 拒绝字段」行级记录（rejectedFields 经 API 出口捕获；VM 消费） */
    val settingsRejectionRegistry: SettingsRejectionRegistry = SettingsRejectionRegistry()

    /**
     * 接线④：ConnectionStore 装饰器——删除单台 PC（ConnectionManager.remove →
     * coordinator.store.remove）同步清该 PC 的设置快照缓存与拒绝记录；
     * 「退出时清除」（OnlineChatRepository.wipeLocalData → store.wipe）清全部。
     * ChatRepository / ConnectionCoordinator 均经本字段持有，两条删除路径无需各自改动。
     */
    val connectionStore: ConnectionStore = SettingsCacheCleaningConnectionStore(
        delegate = DataStoreConnectionStore(appContext, json),
        settingsCacheStore = settingsCacheStore,
        rejectionRegistry = settingsRejectionRegistry,
    )
    /** 本地 UI 偏好（字体缩放/消息间距，纯显示不回写 PC） */
    val uiPrefsStore: UiPrefsStore = UiPrefsStore(appContext)
    val draftStore: DraftStore = DraftStore(appContext)
    val deviceIdentity: DeviceIdentity = DeviceIdentity(appContext)
    val relayCredentialStore: RelayCredentialStore = RelayCredentialStore(appContext)

    // F-05：不再全库 fallbackToDestructiveMigration（会连带清掉 outbox，违反方案 §16.3
    // "Migration 失败时先备份/隔离 Outbox，不直接清库"）。
    // - v4→v5：显式迁移 CacheDatabase.MIGRATION_4_5（仅 ALTER 扩 outbox 列，outbox 存活）；
    // - v5→v6：显式迁移 CacheDatabase.MIGRATION_5_6（仅 CREATE TABLE task_cursors，F-02）；
    // - v6→v7：显式迁移 CacheDatabase.MIGRATION_6_7（仅 ALTER 扩 cached_messages 收尾状态列，S6）；
    // - 今后的 cached_sessions/cached_messages 重建只允许写在对应版本的显式 Migration SQL 内；
    // - v1/v2/v3 老库：outbox 表 v4 才引入、库中无 outbox 数据，允许精准破坏性重建。
    //   （Room 2.6.1 的 API：仅 int... 变体；2.7+ 才有 dropAllTables 重载）
    val database: CacheDatabase = Room.databaseBuilder(
        appContext,
        CacheDatabase::class.java,
        CacheDatabase.DB_NAME,
    )
        .addMigrations(CacheDatabase.MIGRATION_4_5, CacheDatabase.MIGRATION_5_6, CacheDatabase.MIGRATION_6_7)
        // Room 2.6.1 仅有 int... 变体（dropAllTables 重载为 Room 2.7+）；v≤3 无 outbox 表，全量重建安全
        .fallbackToDestructiveMigrationFrom(1, 2, 3)
        .build()

    // ---------- 阶段 B：共享网络栈 / 协调器 / 连接观察者 ----------

    /** B-04：全应用共享一套 Dispatcher/ConnectionPool/DNS（REST/WS/Coil/TTS/探测派生） */
    val networkStack: NetworkStack = NetworkStack(debugLog = BuildConfig.DEBUG)

    /** B-07：连接指标（最近 100 次尝试，JSON-lines 私有目录；不用 Room——阶段 F 负责 DB） */
    val connectionMetrics: ConnectionMetrics =
        ConnectionMetrics(file = java.io.File(appContext.filesDir, "metrics/connection-metrics.jsonl"))

    /** F-03：WsClient 事件丢弃计数经 [ConnectionMetrics.increment] 进入诊断快照 */
    val wsClient: WsClient = WsClientImpl(
        json,
        clientProvider = { networkStack.webSocketClient() },
        metrics = connectionMetrics,
    )

    /** mDNS 局域网自动发现（方案 §5.1 锦上添花，主路径仍为扫码/手动输 IP） */
    val nsdDiscovery: NsdDiscovery = NsdDiscovery(appContext)

    /** B-06：网络连通性观察（Application 生命周期管理，页面销毁不注销） */
    val connectivityObserver: ConnectivityObserver = AndroidConnectivityObserver(appContext)

    /** B-01/B-05：连接协调器——连接决策唯一权威源 */
    val connectionCoordinator: ConnectionCoordinator = ConnectionCoordinator(
        store = connectionStore,
        wsClient = wsClient,
        metrics = connectionMetrics,
        stack = networkStack,
        debugLog = BuildConfig.DEBUG,
        relayCredentials = relayCredentialStore,
        connectivity = connectivityObserver,
        extraCandidates = { discoveredEndpoints() },
    )

    /** 过渡期门面：调用方（ViewModel/Repository/TTS）仍按 ConnectionManager 使用 */
    val connectionManager: ConnectionManager = ConnectionManagerImpl.create(connectionCoordinator)
    val repository: ChatRepository =
        OnlineChatRepository(connectionManager, connectionStore, wsClient, database, json)

    // ---------- 阶段 C：PC 设置同步（接线①②③：共享仓库，SettingsViewModel 不再自建） ----------

    /**
     * PC 设置同步共享仓库：
     * - api/deviceId 随活跃连接现取（切换 PC 无需重建）；
     * - capabilities 经匿名 serverInfo 协商（旧 PC → legacy 降级）；
     * - settingsEvents 接 WS 事件流（settings:updated 去重刷新）；
     * - cacheStore/rejectionRegistry 见上。
     */
    val settingsSyncRepository: SettingsSyncRepository = createSettingsSyncRepository(
        SettingsSyncDependencies(
            apiProvider = { connectionManager.activeApi() },
            deviceIdProvider = { connectionManager.activeConnection?.deviceId },
            capabilitiesProvider = {
                val active = connectionManager.activeConnection
                    ?: throw IllegalStateException("未连接 PC")
                connectionManager.anonApi(active).serverInfo().capabilities
            },
            settingsEvents = wsClient.events,
            cacheStore = settingsCacheStore,
            rejectionRegistry = settingsRejectionRegistry,
        ),
    )

    /** TTS：PC 合成中转音频流，ExoPlayer 播放（方案 §3.3） */
    val ttsPlayer: TtsPlayer = ExoPlayerTtsPlayer(appContext, connectionManager)

    /** P1-4.2 全局生成状态跟踪（单聊+群聊），供后台策略与通知使用 */
    val generationTracker: GenerationTracker = GenerationTracker()

    /** P1-4.2 生命周期感知后台策略（前台保持 WS，60s 后空闲断开） */
    val wsLifecycleManager: WsLifecycleManager = WsLifecycleManager(appContext, wsClient, connectionManager, generationTracker)

    /** P1-C 5.3 通知分发（生成/记忆/连接/安全 4 渠道） */
    val notificationDispatcher: com.qingyu.companion.ui.notification.NotificationDispatcher =
        com.qingyu.companion.ui.notification.NotificationDispatcher(appContext, uiPrefsStore, generationTracker, connectionManager)

    /** mDNS 发现结果 → 候选端点（解析 IP/端口；解析失败静默跳过） */
    private fun discoveredEndpoints(): List<ConnectionEndpoint> =
        nsdDiscovery.devices.value.mapNotNull { pc ->
            runCatching { EndpointNormalizer.normalize(pc.host, pc.port) }.getOrNull()
        }

    /**
     * 应用启动后恢复上次活跃连接并自动建链，同时挂载生命周期观察。
     * B-06：ConnectivityObserver 由 Application 级容器统一 start/stop（进程存活期间不注销）。
     * C 接线②：活跃连接变化 → 设置同步仓库 bind（切 PC 清内存旧快照 + 加载缓存 + 后台刷新）。
     * F 阶段接线：
     * - F-04：启动一次性 legacy 发件箱归属修复（含活跃连接就绪后的补跑）；
     * - F-03：WsClient critical 事件丢弃 → reconciliationRequests → REST 重拉该会话；
     * - F-01：连接建立且 capabilities 命中 task_events_v2 → task:subscribe。
     */
    fun start() {
        connectivityObserver.start()
        wsLifecycleManager.attach()
        notificationDispatcher.start()
        scope.launch {
            runCatching { repository.repairLegacyOutbox() }
        }
        scope.launch {
            connectionManager.activeFlow.collect { active ->
                val deviceId = active?.deviceId ?: return@collect
                runCatching { settingsSyncRepository.bind(deviceId) }
                // 活跃连接就绪/切换后补跑归属修复（覆盖启动早期无 active 的时刻）
                runCatching { repository.repairLegacyOutbox() }
            }
        }
        scope.launch {
            wsClient.reconciliationRequests.collect { sessionId ->
                runCatching { repository.refreshSession(sessionId) }
            }
        }
        scope.launch {
            wsClient.events.collect { event ->
                if (event is com.qingyu.companion.model.CompanionEvent.RelayCommandCompleted) {
                    runCatching { repository.completeRelayCommand(event.commandId, event.resultStatus, event.message) }
                } else if (event is com.qingyu.companion.model.CompanionEvent.RelayCommandExpired) {
                    runCatching { repository.expireRelayCommand(event.commandId) }
                }
            }
        }
        scope.launch {
            wsClient.state.collect { state ->
                if (state == WsClient.State.CONNECTED) {
                    runCatching { repository.subscribeTaskEvents() }
                }
            }
        }
        scope.launch { connectionManager.restore() }
    }

    /** 进程终止（真机一般不调用；测试/热重载清理用） */
    fun stop() {
        connectivityObserver.stop()
    }
}

/**
 * [ConnectionStore] 装饰器（阶段 C 接线④）：删除连接的既有调用点
 * （PairingViewModel → ConnectionManager.remove → coordinator；SettingsScreen →
 * OnlineChatRepository.wipeLocalData → store.wipe）无需改动，存储层统一同步清理
 * 该 PC 的设置快照缓存与「PC 拒绝字段」记录，避免残留离线快照被新连接误用。
 */
private class SettingsCacheCleaningConnectionStore(
    private val delegate: ConnectionStore,
    private val settingsCacheStore: SettingsCacheStore,
    private val rejectionRegistry: SettingsRejectionRegistry,
) : ConnectionStore by delegate {
    override suspend fun remove(deviceId: String) {
        delegate.remove(deviceId)
        settingsCacheStore.clear(deviceId)
        rejectionRegistry.clearDevice(deviceId)
    }

    override suspend fun wipe() {
        delegate.wipe()
        settingsCacheStore.clearAll()
        rejectionRegistry.clearAll()
    }
}

/** 提供 [AppContainer] 的 Compose 局部（在 MainActivity 注入） */
val LocalAppContainer = staticCompositionLocalOf<AppContainer> {
    error("AppContainer 未注入")
}
