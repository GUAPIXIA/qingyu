package com.qingyu.companion.data

import android.content.Context
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.room.Room
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
        ConnectionManagerImpl(connectionStore, wsClient, debugLog = true)

    /** mDNS 局域网自动发现（方案 §5.1 锦上添花，主路径仍为扫码/手动输 IP） */
    val nsdDiscovery: NsdDiscovery = NsdDiscovery(appContext)
    val repository: ChatRepository =
        OnlineChatRepository(connectionManager, connectionStore, wsClient, database, json)

    /** TTS：PC 合成中转音频流，ExoPlayer 播放（方案 §3.3） */
    val ttsPlayer: TtsPlayer = ExoPlayerTtsPlayer(appContext, connectionManager)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** 应用启动后恢复上次活跃连接并自动建链 */
    fun start() {
        scope.launch { connectionManager.restore() }
    }
}

/** 提供 [AppContainer] 的 Compose 局部（在 MainActivity 注入） */
val LocalAppContainer = staticCompositionLocalOf<AppContainer> {
    error("AppContainer 未注入")
}
