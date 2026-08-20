package com.qingyu.companion.data

import android.content.Context
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.room.Room
import com.qingyu.companion.BuildConfig
import com.qingyu.companion.network.ConnectionManager
import com.qingyu.companion.network.ConnectionManagerImpl
import com.qingyu.companion.network.NetworkModule
import com.qingyu.companion.network.NsdDiscovery
import com.qingyu.companion.network.WsClient
import com.qingyu.companion.network.WsClientImpl
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

    val json: Json = NetworkModule.json

    val connectionStore: ConnectionStore = DataStoreConnectionStore(appContext, json)
    /** 本地 UI 偏好（字体缩放/消息间距，纯显示不回写 PC） */
    val uiPrefsStore: UiPrefsStore = UiPrefsStore(appContext)
    val draftStore: DraftStore = DraftStore(appContext)
    val deviceIdentity: DeviceIdentity = DeviceIdentity(appContext)

    val database: CacheDatabase = Room.databaseBuilder(
        appContext,
        CacheDatabase::class.java,
        CacheDatabase.DB_NAME,
    )
        .fallbackToDestructiveMigration()
        .build()

    val wsClient: WsClient = WsClientImpl(json)
    val connectionManager: ConnectionManager =
        ConnectionManagerImpl(connectionStore, wsClient, debugLog = BuildConfig.DEBUG)

    /** mDNS 局域网自动发现（方案 §5.1 锦上添花，主路径仍为扫码/手动输 IP） */
    val nsdDiscovery: NsdDiscovery = NsdDiscovery(appContext)
    val repository: ChatRepository =
        OnlineChatRepository(connectionManager, connectionStore, wsClient, database, json)

    /** TTS：PC 合成中转音频流，ExoPlayer 播放（方案 §3.3） */
    val ttsPlayer: TtsPlayer = ExoPlayerTtsPlayer(appContext, connectionManager)

    /** P1-4.2 全局生成状态跟踪（单聊+群聊），供后台策略与通知使用 */
    val generationTracker: GenerationTracker = GenerationTracker()

    /** P1-4.2 生命周期感知后台策略（前台保持 WS，60s 后空闲断开） */
    val wsLifecycleManager: WsLifecycleManager = WsLifecycleManager(appContext, wsClient, connectionManager, generationTracker)

    /** P1-C 5.3 通知分发（生成/记忆/连接/安全 4 渠道） */
    val notificationDispatcher: com.qingyu.companion.ui.notification.NotificationDispatcher =
        com.qingyu.companion.ui.notification.NotificationDispatcher(appContext, uiPrefsStore, generationTracker, connectionManager)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** 应用启动后恢复上次活跃连接并自动建链，同时挂载生命周期观察 */
    fun start() {
        wsLifecycleManager.attach()
        notificationDispatcher.start()
        scope.launch { connectionManager.restore() }
    }
}

/** 提供 [AppContainer] 的 Compose 局部（在 MainActivity 注入） */
val LocalAppContainer = staticCompositionLocalOf<AppContainer> {
    error("AppContainer 未注入")
}
