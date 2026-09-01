package com.qingyu.companion.network

import com.qingyu.companion.data.ConnectionStore
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.network.connection.ConnectionCoordinator
import com.qingyu.companion.network.connection.ConnectionMetrics
import com.qingyu.companion.network.connection.ConnectionState
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * [ConnectionManager] 过渡期门面（B-01）：
 * 全部连接决策委托 [ConnectionCoordinator]（状态流、候选竞速、代次、退避、指标），
 * 既有调用方（ViewModel/Repository/TTS/notification）不一次性全改。
 *
 * 旧构造签名（store + wsClient + debugLog）保留：未显式装配 coordinator 时
 * 在内部按需构建（生产路径由 AppContainer 注入共享实例，见该文件）。
 */
class ConnectionManagerImpl private constructor(
    private val coordinator: ConnectionCoordinator,
) : ConnectionManager {

    constructor(
        store: ConnectionStore,
        wsClient: WsClient,
        debugLog: Boolean,
    ) : this(
        ConnectionCoordinator(
            store = store,
            wsClient = wsClient,
            metrics = ConnectionMetrics(),
            debugLog = debugLog,
        ),
    )

    /** 生产装配入口：共享 coordinator（状态流/指标/观察者由 AppContainer 统一持有）。 */
    companion object {
        fun create(
            coordinator: ConnectionCoordinator,
        ): ConnectionManager = ConnectionManagerImpl(coordinator)
    }

    override val activeConnection: ServerConnection? get() = coordinator.activeConnection
    override val activeFlow: StateFlow<ServerConnection?> get() = coordinator.activeFlow
    override val tokenInvalidated: SharedFlow<Unit> get() = coordinator.tokenInvalidated
    override val connectionState: StateFlow<ConnectionState> get() = coordinator.connectionState

    override suspend fun restore() = coordinator.restore()

    override suspend fun listConnections(): List<ServerConnection> = coordinator.listConnections()

    override suspend fun addConnection(connection: ServerConnection) = coordinator.addConnection(connection)

    override suspend fun switchTo(deviceId: String) = coordinator.switchTo(deviceId)

    override suspend fun remove(deviceId: String) = coordinator.remove(deviceId)

    override suspend fun disconnectAll() = coordinator.disconnectAll()

    override suspend fun checkCompatibility(
        connection: ServerConnection,
    ): ConnectionManager.CompatibilityResult = coordinator.checkCompatibility(connection)

    override fun activeApi(): QingyuApi? = coordinator.activeApi()

    override fun anonApi(connection: ServerConnection): QingyuApi = coordinator.anonApi(connection)

    override fun retryNow() = coordinator.retryNow()

    override fun markAwaitingApproval(serverName: String, expiresAt: Long) =
        coordinator.markAwaitingApproval(serverName, expiresAt)
}
