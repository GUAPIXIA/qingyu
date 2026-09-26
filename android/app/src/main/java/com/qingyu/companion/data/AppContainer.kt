package com.qingyu.companion.data

import android.content.Context
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.room.Room
import com.qingyu.companion.BuildConfig
import com.qingyu.companion.network.NetworkStack
import com.qingyu.companion.network.models.ModelClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

/**
 * 手动依赖装配（无 Hilt，保持工程轻量）。
 * S9-07：旧伴侣网络栈（远程 REST / 伴侣 WS / PC 连接状态机 / 在线设置同步）已删除；
 * 只保留独立客户端本体 + 新同步。
 */
class AppContainer(context: Context) {

    private val appContext = context.applicationContext

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    val json: Json = com.qingyu.companion.network.NetworkModule.json

    /** 本地 UI 偏好（字体缩放/消息间距，纯显示） */
    val uiPrefsStore: UiPrefsStore = UiPrefsStore(appContext)
    val draftStore: DraftStore = DraftStore(appContext)

    /** 阶段 5 §2：内容编辑器（角色/世界书/预设/人设/正则/快捷回复）的草稿区。 */
    val contentDraftStore: ContentDraftStore = PreferencesContentDraftStore(appContext)
    val deviceIdentity: DeviceIdentity = DeviceIdentity(appContext)

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
    val modelClient: ModelClient = ModelClient()

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
     */
    suspend fun localStartupSnapshot(): com.qingyu.companion.ui.startup.LocalStartupSnapshot {
        val counts = runCatching { localSyncRepository.localCounts() }.getOrNull()
        val genesis = runCatching { localSyncRepository.migrationGenesisId() }.getOrNull()
        val connectionCount = runCatching { localSyncRepository.listConnectionProfiles().size }.getOrDefault(0)
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

    // ---------- 共享网络栈（sync / media / 模型直连派生） ----------

    val networkStack: NetworkStack = NetworkStack(debugLog = BuildConfig.DEBUG)

    /**
     * 阶段 4 S4-06：**单聊数据源已切到本地权威库**。
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
            memorySummary = com.qingyu.companion.chatcore.LocalMemorySummaryService(
                store = localSyncRepository,
                gateway = com.qingyu.companion.chatcore.ModelClientGateway(modelClient),
            ),
            activeProfileAndKey = {
                activeLocalProfile() to activeLocalProfileId()?.let { profileId -> readSecretOrNull(profileId) }
            },
            auxGateway = com.qingyu.companion.chatcore.ModelClientGateway(modelClient),
            groupGeneration = com.qingyu.companion.chatcore.LocalGroupGenerationUseCase(
                store = localSyncRepository,
                gateway = com.qingyu.companion.chatcore.ModelClientGateway(modelClient),
                profileProvider = { activeLocalProfile() },
                apiKeyProvider = { activeLocalProfileId()?.let { profileId -> readSecretOrNull(profileId) } },
            ),
            groupMemory = com.qingyu.companion.chatcore.LocalGroupMemoryService(
                store = localSyncRepository,
                gateway = com.qingyu.companion.chatcore.ModelClientGateway(modelClient),
            ),
        )

    val repository: ChatRepository = chatRepository

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

    /** TTS：本地系统 TTS（S9-07：PC 中转拉流已删除） */
    val ttsPlayer: com.qingyu.companion.ui.tts.TtsPlayer =
        com.qingyu.companion.ui.tts.SystemTtsPlayer(appContext)

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

    /** P1-C 5.3 通知分发（生成/记忆/连接/安全 4 渠道） */
    val notificationDispatcher: com.qingyu.companion.ui.notification.NotificationDispatcher =
        com.qingyu.companion.ui.notification.NotificationDispatcher(appContext, uiPrefsStore, generationTracker)

    /**
     * 应用启动后挂载通知门控。
     */
    fun start() {
        notificationDispatcher.start()
    }

    /** 进程终止（真机一般不调用；测试/热重载清理用） */
    fun stop() {
        // 本地模式无长连接需要拆除
    }
}

/** 提供 [AppContainer] 的 Compose 局部（在 MainActivity 注入） */
val LocalAppContainer = staticCompositionLocalOf<AppContainer> {
    error("AppContainer 未注入")
}
