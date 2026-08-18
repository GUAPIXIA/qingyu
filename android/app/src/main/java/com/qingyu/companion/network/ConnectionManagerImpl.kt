package com.qingyu.companion.network

import com.qingyu.companion.data.ConnectionStore
import com.qingyu.companion.model.ServerConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * [ConnectionManager] 实现：以 [ConnectionStore] 为持久化后端，
 * 激活连接时驱动 [WsClient] 建链，并按连接缓存 Retrofit 实例。
 */
class ConnectionManagerImpl(
    private val store: ConnectionStore,
    private val wsClient: WsClient,
    private val debugLog: Boolean,
) : ConnectionManager {

    private val _active = MutableStateFlow<ServerConnection?>(null)
    override val activeFlow: StateFlow<ServerConnection?> = _active.asStateFlow()
    override val activeConnection: ServerConnection? get() = _active.value

    private val _tokenInvalidated = MutableSharedFlow<Unit>(extraBufferCapacity = 4)
    override val tokenInvalidated: SharedFlow<Unit> = _tokenInvalidated.asSharedFlow()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** 按 deviceId 缓存已构建的鉴权 API，避免每次调用重建 Retrofit */
    private var cachedApi: Pair<String, QingyuApi>? = null

    override suspend fun restore() {
        val active = store.getActive()
        _active.value = active
        active?.let { wsClient.connect(it) }
    }

    override suspend fun listConnections(): List<ServerConnection> = store.loadAll()

    override suspend fun addConnection(connection: ServerConnection) {
        store.save(connection)
        store.setActive(connection.deviceId)
        activate(connection)
    }

    override suspend fun switchTo(deviceId: String) {
        val target = store.loadAll().firstOrNull { it.deviceId == deviceId } ?: return
        store.setActive(deviceId)
        activate(target)
    }

    override suspend fun remove(deviceId: String) {
        store.remove(deviceId)
        if (_active.value?.deviceId == deviceId) {
            store.setActive(null)
            _active.value = null
            cachedApi = null
            wsClient.disconnect()
        }
    }

    override suspend fun disconnectAll() {
        store.setActive(null)
        _active.value = null
        cachedApi = null
        wsClient.disconnect()
    }

    override suspend fun checkCompatibility(
        connection: ServerConnection,
    ): ConnectionManager.CompatibilityResult {
        val info = runCatching { anonApi(connection).serverInfo() }.getOrNull()
            ?: return ConnectionManager.CompatibilityResult.Unreachable
        return if (info.apiVersion == SUPPORTED_API_VERSION) {
            ConnectionManager.CompatibilityResult.Compatible
        } else {
            // PC 比安卓新 -> 升级安卓；PC 比安卓旧 -> 升级 PC
            val side = if (info.apiVersion > SUPPORTED_API_VERSION) {
                ConnectionManager.CompatibilityResult.Side.ANDROID
            } else {
                ConnectionManager.CompatibilityResult.Side.PC
            }
            ConnectionManager.CompatibilityResult.UpgradeRequired(side)
        }
    }

    override fun activeApi(): QingyuApi? {
        val connection = _active.value ?: return null
        cachedApi?.let { if (it.first == connection.deviceId) return it.second }
        val api = buildApi(connection, authenticated = true)
        cachedApi = connection.deviceId to api
        return api
    }

    override fun anonApi(connection: ServerConnection): QingyuApi = buildApi(connection, authenticated = false)

    private fun buildApi(connection: ServerConnection, authenticated: Boolean): QingyuApi {
        val token = if (authenticated) connection.token else null
        val client = NetworkModule.createHttpClient(
            token = token,
            debugLog = debugLog,
            // 令牌失效（PC 吊销/过期）：上报事件，UI 提示重新配对
            onUnauthorized = { _tokenInvalidated.tryEmit(Unit) },
        )
        return NetworkModule.createApi(client, connection)
    }

    private fun activate(connection: ServerConnection) {
        _active.value = connection
        cachedApi = null
        scope.launch { wsClient.connect(connection) }
    }

    private companion object {
        const val SUPPORTED_API_VERSION = 1
    }
}
