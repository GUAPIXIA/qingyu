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

    /** 阶段 5 §2：内容编辑器（角色/世界书/预设/人设/正则/快捷回复）的草稿区。 */
    val contentDraftStore: ContentDraftStore = PreferencesContentDraftStore(appContext)
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

    // ---------- 阶段 3：本地权威库（独立文件，不升级 companion-cache） ----------

    /**
     * `qingyu-local.db`：
     * - 独立文件，**绝不**原地升级 `qingyu-companion-cache`（旧库只读导入）；
     * - 不注册任何 destructive fallback：迁移缺失时抛异常并停留在迁移修复页（阶段 3 §5）；
     * - 每次打开显式开启外键（删除策略见 LocalEntities 的 ForeignKey 声明）。
     */
    val localDatabase: com.qingyu.companion.local.db.QingyuLocalDatabase = Room.databaseBuilder(
        appContext,
        com.qingyu.companion.local.db.QingyuLocalDatabase::class.java,
        com.qingyu.companion.local.db.QingyuLocalDatabase.NAME,
    )
        // 阶段 4 S4-05：v1→v2（记忆版本/CAS 与任务类型）为显式迁移，只增列、不重建表。
        // 不注册任何 destructive fallback：缺迁移时抛异常并停留在迁移修复页（阶段 3 §5）。
        .addMigrations(*com.qingyu.companion.local.db.QingyuLocalDatabase.MIGRATIONS)
        .addCallback(com.qingyu.companion.local.db.QingyuLocalDatabase.FOREIGN_KEYS_CALLBACK)
        .build()

    /**
     * S3-04：秘密存储。Keystore 不可用（无安全硬件/测试环境）时降级为内存实现，
     * **绝不**回退为明文落盘；`TokenCrypto`/EncryptedSharedPreferences 另有独立封装。
     */
    val secretStore: com.qingyu.companion.security.SecretStore = runCatching {
        com.qingyu.companion.security.KeystoreSecretStore(appContext)
    }.getOrElse {
        com.qingyu.companion.security.InMemorySecretStore()
    }

    /** S3-01：本地权威 Repository（Room 实现；业务表/journal/head 同事务） */
    val localSyncRepository: com.qingyu.companion.local.domain.RoomLocalSyncRepository =
        com.qingyu.companion.local.domain.RoomLocalSyncRepository(
            db = localDatabase,
            deviceId = deviceIdentity.deviceInstallationId,
        )

    /** S3-06：连接档案 public/secret 双事务仓库（UI 只见掩码）。 */
    val connectionProfileRepository: com.qingyu.companion.security.ConnectionProfileRepository =
        com.qingyu.companion.security.ConnectionProfileRepository(localSyncRepository, secretStore)

    /** S3-04：设置分区（public 进同步 envelope；device 仅本机）。 */
    val localSettingsRepository: com.qingyu.companion.local.settings.LocalSettingsRepository =
        com.qingyu.companion.local.settings.LocalSettingsRepository(localSyncRepository)

    /** S3-05：模型直连执行层（不依赖 PC）。 */
    val modelClient: com.qingyu.companion.network.models.ModelClient =
        com.qingyu.companion.network.models.ModelClient()

    /** S3-02：旧伴侣缓存只读快照读取器与迁移导入器 */
    val legacyCacheReader: com.qingyu.companion.local.migration.LegacyCacheReader =
        com.qingyu.companion.local.migration.LegacyCacheReader(appContext)
    val legacyCacheImporter: com.qingyu.companion.local.migration.LegacyCacheImporter =
        com.qingyu.companion.local.migration.LegacyCacheImporter(legacyCacheReader)

    /** 阶段 3 本地初始化只做一次（设备状态 + 默认更新检查偏好） */
    @Volatile
    private var localBootstrapDone = false

    /**
     * S3-07：启动决策所需的本地快照（只读，不访问网络）。
     *
     * - `hasLocalDb`：`qingyu-local.db` 已有内容或已初始化设备状态 → 可直接进主界面；
     * - `hasLegacyCache`：存在旧伴侣缓存（或已被扫描过的快照）→ 需要用户显式选择迁移方式；
     * - `connectionCount`：仅用于「同步中心」入口，不再是进入主界面的前提。
     */
    suspend fun localStartupSnapshot(): com.qingyu.companion.ui.startup.LocalStartupSnapshot {
        val counts = runCatching { localSyncRepository.localCounts() }.getOrNull()
        val genesis = runCatching { localSyncRepository.migrationGenesisId() }.getOrNull()
        val connectionCount = runCatching { connectionStore.loadAll().size }.getOrDefault(0)
        val hasLocalDb = counts != null && (!counts.isEmpty || counts.heads > 0 || genesis != null)
        val hasLegacyCache = legacyCacheReader.legacyDatabaseExists() || legacyCacheReader.snapshotExists()
        return com.qingyu.companion.ui.startup.LocalStartupSnapshot(
            hasLocalProfile = hasLocalDb,
            hasLocalDb = hasLocalDb,
            hasLegacyCache = hasLegacyCache,
            connectionCount = connectionCount,
        )
    }

    /**
     * 本地启动 bootstrap（幂等）：
     * 首次启动创建本地资料并写入设备 dot 起点；**不**自动同步、不连接 PC。
     * 返回 true 表示本地已可用（无需配对即可进入主界面）。
     */
    suspend fun ensureLocalBootstrapped(): Boolean {
        if (localBootstrapDone) return true
        return runCatching {
            localSyncRepository.initDeviceState()
            if (localSyncRepository.listConnectionProfiles().isEmpty() &&
                localSyncRepository.journalCount("local") == 0
            ) {
                localSyncRepository.putDeviceSetting(
                    com.qingyu.companion.local.settings.DeviceSettingKey.ThemeMode.key,
                    "\"system\"",
                )
            }
            localBootstrapDone = true
            true
        }.getOrElse { false }
    }

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

    /**
     * 阶段 4 S4-06：**单聊数据源已切到本地权威库**。
     *
     * 依据阶段 4 §S4-06「界面不得出现旧远程运行模式或回退入口」与完成定义
     * 「关闭 PC 和 Relay 后仍能连续多轮聊天」：
     * - 会话、消息、生成全部走 `qingyu-local.db` + 本地直连模型；
     * - PC 仅作为**可选**的同步/管理对端，不再是聊天前提；
     * - 因此这里不再提供「切回远程聊天」的开关——回退入口本身就是禁止项。
     *
     * 尚未迁移到本地的能力（世界书/预设编辑、翻译、快捷回复、群聊、公告、用量汇总、长记忆总结）
     * 由 [LocalChatRepository] 返回可行动的空结果，UI 不应崩溃或静默失败。
     */
    val chatRepository: com.qingyu.companion.data.local.LocalChatRepository =
        com.qingyu.companion.data.local.LocalChatRepository(
            store = localSyncRepository,
            generation = com.qingyu.companion.chatcore.LocalChatGenerationUseCase(
                store = localSyncRepository,
                gateway = com.qingyu.companion.chatcore.ModelClientGateway(modelClient),
                profileProvider = { activeLocalProfile() },
                apiKeyProvider = { activeLocalProfileId()?.let { profileId -> readSecretOrNull(profileId) } },
            ),
            requestIdFactory = { com.qingyu.companion.chatcore.Ulid.newId() },
            // S4-05：长记忆总结（自动触发）。与生成本身共用同一档案与密钥来源。
            memorySummary = com.qingyu.companion.chatcore.LocalMemorySummaryService(
                store = localSyncRepository,
                gateway = com.qingyu.companion.chatcore.ModelClientGateway(modelClient),
            ),
            activeProfileAndKey = {
                activeLocalProfile() to activeLocalProfileId()?.let { profileId -> readSecretOrNull(profileId) }
            },
            // 辅助任务（翻译等一次性补全）与主生成共用同一执行层
            auxGateway = com.qingyu.companion.chatcore.ModelClientGateway(modelClient),
            // 阶段 6 S6-01(d)：群聊本地生成闭环（与单聊同档案/密钥来源；设置面用 PC 默认值）
            groupGeneration = com.qingyu.companion.chatcore.LocalGroupGenerationUseCase(
                store = localSyncRepository,
                gateway = com.qingyu.companion.chatcore.ModelClientGateway(modelClient),
                profileProvider = { activeLocalProfile() },
                apiKeyProvider = { activeLocalProfileId()?.let { profileId -> readSecretOrNull(profileId) } },
            ),
            // 阶段 6 S6-01(e)：群长记忆摘要（自动触发；与生成共用执行层）
            groupMemory = com.qingyu.companion.chatcore.LocalGroupMemoryService(
                store = localSyncRepository,
                gateway = com.qingyu.companion.chatcore.ModelClientGateway(modelClient),
            ),
        )

    val repository: ChatRepository = chatRepository

    /**
     * 当前用于本地生成的连接档案（取排序最靠前的一份）。
     * 档案选择 UI（多档案切换）属阶段 5；阶段 4 先保证「有档案即可直连」。
     */
    private suspend fun activeLocalProfile(): com.qingyu.companion.network.models.ConnectionProfilePublic? {
        val profile = runCatching { connectionProfileRepository.listProfiles().firstOrNull() }.getOrNull()
            ?: return null
        return com.qingyu.companion.network.models.ConnectionProfilePublic(
            id = profile.id,
            provider = com.qingyu.companion.network.models.ModelProvider.fromWire(profile.provider)
                ?: com.qingyu.companion.network.models.ModelProvider.OpenAI,
            baseUrl = profile.baseUrl,
            model = profile.model,
            allowHttp = profile.allowHttp,
        )
    }

    private suspend fun activeLocalProfileId(): String? =
        runCatching { connectionProfileRepository.listProfiles().firstOrNull()?.id }.getOrNull()

    private suspend fun readSecretOrNull(profileId: String): String? =
        runCatching { connectionProfileRepository.readSecret(profileId) }.getOrNull()

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

    /**
     * 阶段 7 S7-07 / 阶段 8：同步协调器（同步中心唯一网络入口）。
     * **仅用户点击同步时**运行；未授权/未配置不建 session。
     */
    val syncCoordinator: com.qingyu.companion.network.sync.SyncCoordinator =
        com.qingyu.companion.network.sync.DefaultSyncCoordinator(
            lanAuthorized = { com.qingyu.companion.network.sync.LanSyncSessionState.authorized },
            serverConfigured = { false /* 阶段 8 服务器配置落盘后改为读本地设置 */ },
            lanRunner = { onProgress ->
                val engine = com.qingyu.companion.network.sync.OkHttpSyncEngine()
                val transport = com.qingyu.companion.network.sync.LanSyncTransport(engine)
                val runner = com.qingyu.companion.network.sync.LanSyncRunner(
                    transport = transport,
                    endpointProvider = { com.qingyu.companion.network.sync.LanSyncSessionState.endpoint },
                    authorized = { com.qingyu.companion.network.sync.LanSyncSessionState.authorized },
                    collectUpload = { emptyList() /* journal backlog → envelopes 接线见阶段 7 收尾 */ },
                    applyDownload = { emptyMap() /* staging apply 接线见阶段 7 收尾 */ },
                )
                runner.run(onProgress)
            },
            serverRunner = { _ ->
                com.qingyu.companion.network.sync.SyncRunResult(
                    ok = false,
                    error = "服务器同步未配置",
                    retryable = false,
                )
            },
        )


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
