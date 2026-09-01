package com.qingyu.companion.network.connection

import com.qingyu.companion.data.ConnectionStore
import com.qingyu.companion.data.relay.RelayCredentialStore
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.model.ConnectionMode
import com.qingyu.companion.model.relay.RelayStatus
import com.qingyu.companion.model.relay.RelayRefreshRequest
import com.qingyu.companion.network.relay.RelayCacheStatusInterceptor
import com.qingyu.companion.network.relay.RelayStatusStore
import com.qingyu.companion.network.relay.RelayTokenAuthenticator
import com.qingyu.companion.network.relay.RelayTokenProvider
import com.qingyu.companion.network.ConnectionManager
import com.qingyu.companion.network.NetworkModule
import com.qingyu.companion.network.NetworkStack
import com.qingyu.companion.network.QingyuApi
import com.qingyu.companion.network.WsClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import java.util.UUID
import kotlin.math.roundToLong
import kotlin.random.Random

/**
 * 重连退避（B-06）：
 * `0s, 1s, 2s, 4s, 8s, 15s, 30s，之后维持 30s`，jitter = ±20%。
 * 成功连接、用户手动重试、NetworkAvailable 均可重置（由调用方重新从 attempt=1 开始）。
 *
 * 纯函数实现，[jitterFactor] 显式传入 [-1, 1]，便于 JVM 单测断言边界：
 * - factor = 0 → 恰好 base；
 * - factor = -1 → base × 0.8（下界）；
 * - factor = +1 → base × 1.2（上界）。
 */
object ReconnectBackoff {

    /** 各次尝试（1 起）的基础延迟毫秒；越界取末位（封顶 30s）。 */
    val BASE_DELAYS_MS: List<Long> = listOf(0L, 1_000L, 2_000L, 4_000L, 8_000L, 15_000L, 30_000L)

    const val JITTER_RATIO = 0.20

    /** attempt 从 1 开始；返回未加 jitter 的基础延迟。 */
    fun baseDelayMs(attempt: Int): Long {
        val index = (attempt - 1).coerceIn(0, BASE_DELAYS_MS.lastIndex)
        return BASE_DELAYS_MS[index]
    }

    /**
     * 加 jitter 后的实际延迟。[jitterFactor] 超出 [-1,1] 会被钳制，
     * 结果四舍五入；base=0（首次）时 jitter 无效果，保证 0s 立即重试。
     */
    fun delayMs(attempt: Int, jitterFactor: Double): Long {
        val base = baseDelayMs(attempt)
        if (base == 0L) return 0L
        val factor = jitterFactor.coerceIn(-1.0, 1.0)
        return (base * (1.0 + JITTER_RATIO * factor)).roundToLong()
    }

    /** 使用默认随机源的便捷重载。 */
    fun delayMs(attempt: Int, random: Random = Random.Default): Long =
        delayMs(attempt, random.nextDouble(-1.0, 1.0))
}

/**
 * 连接协调器（B-01）：设备级连接的唯一决策点。
 *
 * 职责边界（方案 §6 B-01 职责划分）：
 * - [ConnectionStore] 只持久化；
 * - 本类决定连接目标与状态（候选竞速 → 鉴权 → 实时建链 → 退避重连）；
 * - [NetworkStack]（B-04）创建/复用网络对象；
 * - [WsClient] 只对指定 endpoint 建链，不自行选择设备；
 * - ViewModel 只消费 [connectionState]，不拼接网络错误。
 *
 * 实现 [ConnectionManager]：过渡期 `ConnectionManagerImpl` 直接委托本类，调用方零改动。
 *
 * 并发模型：所有连接尝试收敛于单一 [connectJob]（launchAttempt 先 cancel 后启动），
 * 每次尝试绑定一个 [ConnectionLease]（B-05）；探测回调、WS 镜像、重连定时器
 * 完成前一律经 [ConnectionGenerators.isCurrent] 校验，旧代次结果不得修改新状态。
 */
class ConnectionCoordinator(
    private val store: ConnectionStore,
    private val wsClient: WsClient,
    private val metrics: ConnectionMetrics,
    private val stack: NetworkStack = NetworkModule.sharedStack,
    private val debugLog: Boolean = false,
    /** 仅 Relay 注入；null 保持 JVM 测试与 LAN 构造兼容。 */
    private val relayCredentials: RelayCredentialStore? = null,
    private val connectivity: ConnectivityObserver? = null,
    /** mDNS 等外部候选来源（AppContainer 装配；JVM 测试注入 fake）。 */
    private val extraCandidates: () -> List<ConnectionEndpoint> = { emptyList() },
    /** JVM 测试注入 fake 竞速；真机默认短超时 HTTP 探测。 */
    private val prober: EndpointProber = EndpointProber(HttpEndpointProber(stack.probeClient())::probe),
    /** JVM 测试注入 fake 鉴权；null = 真机默认 REST serverInfo 握手（401/403 → Unauthorized）。 */
    private val authCheckOverride: (suspend (ServerConnection, ConnectionEndpoint) -> RepairReason?)? = null,
    private val clock: () -> Long = System::currentTimeMillis,
    private val random: Random = Random.Default,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) : ConnectionManager {

    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Idle)
    /** 连接全生命周期状态流（B-01） */
    override val connectionState: StateFlow<ConnectionState> = _state.asStateFlow()

    private val _active = MutableStateFlow<ServerConnection?>(null)
    override val activeFlow: StateFlow<ServerConnection?> = _active.asStateFlow()
    override val activeConnection: ServerConnection? get() = _active.value

    private val _tokenInvalidated = MutableSharedFlow<Unit>(extraBufferCapacity = 4)
    override val tokenInvalidated: SharedFlow<Unit> = _tokenInvalidated.asSharedFlow()

    /** 连接代次仲裁（B-05），对外只读（诊断/UI 接线用）。 */
    val generators = ConnectionGenerators()

    private var connectJob: kotlinx.coroutines.Job? = null
    private var reconnectJob: kotlinx.coroutines.Job? = null
    private var wsWatchdog: kotlinx.coroutines.Job? = null

    /** 当前退避轮次（0 = 未失败/已重置）；成功连接、手动重试、网络恢复均重置（B-06）。 */
    @Volatile private var attempt = 0

    @Volatile private var lastProbeRttMs = 0L
    @Volatile private var lastProbeApiVersion: Int? = null
    @Volatile private var wsAttemptStartMs = 0L
    /** 上一次网络事件驱动的自动重连时刻（null = 从未，首轮不的去重保护） */
    @Volatile private var lastAutoTriggerMs: Long? = null

    /** WS 镜像计数：DISCONNECTED→RECONNECTING 连发时用于展示，真实退避在 WsClientImpl 内部。 */
    @Volatile private var wsMirrorAttempt = 0

    /** B-04：API 缓存键 = deviceId + endpoint URL + tokenGeneration（token 内容变更即换代）。 */
    private var cachedApi: Pair<String, QingyuApi>? = null
    private val relayStatusStore = RelayStatusStore()
    private val relayTokenProviders = mutableMapOf<String, RelayTokenProvider>()

    init {
        observeWsState()
        scope.launch {
            relayStatusStore.state.collect { status ->
                if (_active.value?.mode != ConnectionMode.RELAY) return@collect
                when (status) {
                    is RelayStatus.UsingCache -> setState(ConnectionState.UsingCache(status.cacheAgeMs, status.pcOnline))
                    RelayStatus.CacheExpired -> setState(ConnectionState.Degraded(false, wsClient.state.value == WsClient.State.CONNECTED, FailureReason.ServerStopped))
                    RelayStatus.TokenInvalidated -> _tokenInvalidated.tryEmit(Unit)
                    else -> Unit
                }
            }
        }
        connectivity?.let { observer ->
            scope.launch {
                observer.events.collect { event -> onConnectivityEvent(event) }
            }
        }
    }

    // ---------- ConnectionManager 契约（调用方不一次性全改） ----------

    override suspend fun restore() {
        refreshKnownConnections()
        val active = store.getActive()
        _active.value = active
        if (active == null) {
            generators.retire()
            setState(ConnectionState.Idle)
            return
        }
        // 已连接且 WS 正常：不重复建链（WsLifecycleManager 回前台也会调 restore）
        if (_state.value is ConnectionState.Connected && wsClient.state.value == WsClient.State.CONNECTED) return
        if (connectJob?.isActive == true) return
        launchAttempt(resetBackoff = true)
    }

    override suspend fun listConnections(): List<ServerConnection> {
        val all = store.loadAll()
        knownConnections = all
        return all
    }

    private suspend fun refreshKnownConnections() {
        knownConnections = runCatching { store.loadAll() }.getOrDefault(knownConnections)
    }

    override suspend fun addConnection(connection: ServerConnection) {
        store.save(connection)
        store.setActive(connection.deviceId)
        _active.value = connection
        knownConnections = (knownConnections.filterNot { it.deviceId == connection.deviceId } + connection)
        launchAttempt(resetBackoff = true)
    }

    override suspend fun switchTo(deviceId: String) {
        val target = listConnections().firstOrNull { it.deviceId == deviceId } ?: return
        store.setActive(deviceId)
        _active.value = target
        launchAttempt(resetBackoff = true)
    }

    override suspend fun remove(deviceId: String) {
        store.remove(deviceId)
        knownConnections = knownConnections.filterNot { it.deviceId == deviceId }
        if (_active.value?.deviceId == deviceId) {
            retireActive()
        }
    }

    override suspend fun disconnectAll() {
        store.setActive(null)
        retireActive()
    }

    override fun retryNow() {
        if (_active.value == null) return
        launchAttempt(resetBackoff = true)
    }

    override fun markAwaitingApproval(serverName: String, expiresAt: Long) {
        // 配对挂起确认：仅在尚未 Connected 时覆盖展示状态（B-01）
        val cur = _state.value
        if (cur is ConnectionState.Connected) return
        setState(ConnectionState.AwaitingApproval(serverName, expiresAt))
    }

    override suspend fun checkCompatibility(
        connection: ServerConnection,
    ): ConnectionManager.CompatibilityResult {
        val endpoint = EndpointNormalizer.normalize(connection.host, connection.port)
        val outcome = HttpEndpointProber(stack.probeClient()).probe(endpoint)
        if (!outcome.success || outcome.apiVersion == null) {
            return ConnectionManager.CompatibilityResult.Unreachable(
                outcome.failureReason ?: FailureReason.ServerStopped,
            )
        }
        return if (outcome.apiVersion == SUPPORTED_API_VERSION) {
            ConnectionManager.CompatibilityResult.Compatible
        } else {
            val side = if (outcome.apiVersion > SUPPORTED_API_VERSION) {
                ConnectionManager.CompatibilityResult.Side.ANDROID
            } else {
                ConnectionManager.CompatibilityResult.Side.PC
            }
            ConnectionManager.CompatibilityResult.UpgradeRequired(side)
        }
    }

    override fun activeApi(): QingyuApi? {
        val connection = _active.value ?: return null
        val endpoint = NetworkModule.endpointOf(connection)
        // 缓存键（B-04）：deviceId + endpoint + tokenGeneration——
        // tokenGeneration 取 token 内容哈希，重新配对（同 deviceId 新 token）也能失效重建
        val key = "${connection.deviceId}|${connection.mode}|${NetworkModule.baseUrlOf(connection)}|${connection.relay?.tokenGeneration ?: 0}|${connection.token.hashCode()}"
        cachedApi?.let { if (it.first == key) return it.second }
        val api = authenticatedApi(connection, endpoint)
        cachedApi = key to api
        return api
    }

    override fun anonApi(connection: ServerConnection): QingyuApi {
        // 配对/协商目标恒为表单指向的 host/port（不走 lastSuccessfulEndpoint 覆盖）；
        // 独立长超时 pairing client：PC 人工确认最长 55s，禁止复用 2s 探测超时（B-03）
        val endpoint = EndpointNormalizer.normalize(connection.host, connection.port)
        return stack.api(stack.pairingClient(), endpoint)
    }

    // ---------- 按 URL 归属解析令牌（B-04，Coil/静态资源用） ----------

    /** 已加载连接的低频快照：图片等旧页面 URL 可能指向非活跃 PC，按归属发 token 防串台。 */
    @Volatile private var knownConnections: List<ServerConnection> = emptyList()

    /**
     * 解析 [host]:[port] 所属连接的 token：
     * 1. 当前活跃连接端点匹配 → 活跃 token（代次守卫已内含在 endpointOf 的最新回填里）；
     * 2. 否则在已配对列表找端点匹配者 → 该 PC 的 token；
     * 3. 均不匹配 → null（匿名请求，绝不把 A 的 token 发给 B）。
     */
    fun tokenForEndpoint(host: String, port: Int): String? {
        fun matches(connection: ServerConnection): Boolean {
            val endpoint = NetworkModule.endpointOf(connection)
            return endpoint.host.equals(host, ignoreCase = true) && endpoint.port == port
        }
        _active.value?.takeIf { matches(it) }?.let { return it.token }
        return knownConnections.firstOrNull { it.deviceId != _active.value?.deviceId && matches(it) }?.token
    }

    // ---------- 诊断（B-07，UI 接线由主代理完成） ----------

    /** 脱敏诊断快照：当前状态 + 最近指标（不含 token/配对码/正文）。 */
    suspend fun snapshotForDiagnostics(): ConnectionDiagnostics {
        val connection = _active.value
        val summary = connection?.let {
            val endpoint = NetworkModule.endpointOf(it)
            ServerConnectionSummary(
                deviceIdHash = ConnectionMetrics.hashDeviceId(it.deviceId),
                serverId = it.serverId,
                endpointType = endpoint.security.name,
                securityMode = endpoint.httpScheme(),
                apiVersion = lastProbeApiVersion,
                pairingProtocolVersion = it.pairingProtocolVersion,
            )
        }
        return metrics.snapshotForDiagnostics(_state.value, summary)
    }

    // ---------- 连接主循环 ----------

    /** 单飞启动一次连接尝试；[resetBackoff]=true 时清零退避轮次。 */
    private fun launchAttempt(resetBackoff: Boolean) {
        if (resetBackoff) attempt = 0
        connectJob?.cancel()
        reconnectJob?.cancel()
        wsWatchdog?.cancel()
        connectJob = scope.launch {
            val connection = _active.value ?: return@launch
            runAttempt(connection)
        }
    }

    /** 一次完整尝试：Discovering → Probing（竞速）→ Authenticating → ConnectingRealtime → Connected。 */
    private suspend fun runAttempt(connection: ServerConnection) {
        val startedAt = clock()
        val attemptId = UUID.randomUUID().toString()
        val baseEndpoint = NetworkModule.endpointOf(connection)
        // B-05：connect/switch/重连每一次都建立新代次，旧回调整体作废
        val lease = generators.advance(connection.deviceId, baseEndpoint)
        cachedApi = null
        // 新代次意味着旧实时链路作废（切网/重试时旧 socket 可能仍 CONNECTED）
        if (wsClient.state.value == WsClient.State.CONNECTED) wsClient.disconnect()
        if (connection.mode == ConnectionMode.RELAY) {
            setState(ConnectionState.Authenticating(baseEndpoint))
            val authFailure = authenticate(connection, baseEndpoint)
            if (!generators.isCurrent(lease)) return
            if (authFailure == RepairReason.Unauthorized) {
                setState(ConnectionState.NeedsRepair(connection.deviceId, RepairReason.Unauthorized))
                return
            }
            setState(ConnectionState.ConnectingRealtime(baseEndpoint))
            wsAttemptStartMs = clock()
            wsClient.connect(connection, lease)
            wsWatchdog = scope.launch {
                val connected = withTimeoutOrNull(WS_CONNECT_TIMEOUT_MS) {
                    wsClient.state.first { it == WsClient.State.CONNECTED || !generators.isCurrent(lease) }
                } != null
                if (!connected && generators.isCurrent(lease)) {
                    wsClient.disconnect()
                    scheduleReconnect(FailureReason.Timeout)
                }
            }
            return
        }
        setState(ConnectionState.Discovering(connection.deviceId))

        val ranked = EndpointCandidates.build(connection, extraCandidates())
        if (ranked.isEmpty()) {
            recordFailure(attemptId, connection, baseEndpoint, startedAt, null, null, FailureReason.Tcp)
            scheduleReconnect(FailureReason.Tcp)
            return
        }
        setState(ConnectionState.Probing(connection.deviceId, ranked.map { it.endpoint }))

        val probeStart = clock()
        val outcome = when (val race = prober.race(ranked, connection.serverId)) {
            is ProbeRaceResult.Winner -> race.outcome
            is ProbeRaceResult.NoCandidate -> {
                val reason = race.failures.lastOrNull()?.failureReason ?: FailureReason.ServerStopped
                val discoveryMs = clock() - probeStart
                recordFailure(attemptId, connection, baseEndpoint, startedAt, discoveryMs, null, reason)
                if (generators.isCurrent(lease)) scheduleReconnect(reason)
                return
            }
        }
        // 探测完成时代次已变（用户切换 PC/断网重建）：旧结果作废（B-05）
        if (!generators.isCurrent(lease)) return
        val discoveryMs = clock() - probeStart
        lastProbeRttMs = outcome.rttMs
        lastProbeApiVersion = outcome.apiVersion

        // 竞速胜出：回填 serverId/capabilities/lastSuccessfulEndpoint（B-02 首次成功握手回填）
        val updated = connection.copy(
            serverId = outcome.serverId ?: connection.serverId,
            capabilities = outcome.capabilities.ifEmpty { connection.capabilities },
            lastSuccessfulEndpoint = outcome.endpoint,
            endpoints = (connection.endpoints + outcome.endpoint).distinctBy {
                EndpointCandidates.dedupeKey(it)
            },
        )
        generators.restamp(lease, outcome.endpoint)
        _active.value = updated
        store.save(updated)

        // API 兼容性：版本不符不做无限重连，直接 NeedsRepair
        val apiVersion = outcome.apiVersion
        if (apiVersion != null && apiVersion != SUPPORTED_API_VERSION) {
            setState(ConnectionState.NeedsRepair(updated.deviceId, RepairReason.ApiIncompatible))
            recordNeedsRepair(attemptId, updated, outcome.endpoint, startedAt, discoveryMs, outcome.rttMs)
            return
        }

        setState(ConnectionState.Authenticating(outcome.endpoint))
        val authFailure = authenticate(updated, outcome.endpoint)
        if (!generators.isCurrent(lease)) return
        if (authFailure != null) {
            if (authFailure == RepairReason.Unauthorized) {
                setState(ConnectionState.NeedsRepair(updated.deviceId, RepairReason.Unauthorized))
                recordNeedsRepair(attemptId, updated, outcome.endpoint, startedAt, discoveryMs, outcome.rttMs)
            } else {
                recordFailure(attemptId, updated, outcome.endpoint, startedAt, discoveryMs, outcome.rttMs, FailureReason.ServerStopped)
                scheduleReconnect(FailureReason.ServerStopped)
            }
            return
        }

        // WS 建链；Connected 由 observeWsState 镜像收敛，本协程只做看门狗
        setState(ConnectionState.ConnectingRealtime(outcome.endpoint))
        wsAttemptStartMs = clock()
        wsClient.connect(updated, lease)
        wsWatchdog?.cancel()
        wsWatchdog = scope.launch {
            val connected = withTimeoutOrNull(WS_CONNECT_TIMEOUT_MS) {
                wsClient.state.first { state ->
                    state == WsClient.State.CONNECTED || !generators.isCurrent(lease)
                }
            } != null
            if (connected) return@launch
            if (!generators.isCurrent(lease)) return@launch
            // 15s 未 Connected：杀掉半开 socket，走协调器退避（避免 WsClientImpl 内层无限循环叠乘）
            wsClient.disconnect()
            recordFailure(
                attemptId, updated, outcome.endpoint, startedAt, discoveryMs, outcome.rttMs,
                FailureReason.Timeout, wsMs = clock() - wsAttemptStartMs,
            )
            scheduleReconnect(FailureReason.Timeout)
        }
    }

    /**
     * 鉴权握手（可注入 fake 供 JVM 测试）：默认携带当前 token 的 serverInfo，401/403 → Unauthorized。
     * 注意必须显式判 null——fake 返回 null 表示"鉴权通过"，不能落入 ?: 回退分支。
     */
    private suspend fun authenticate(connection: ServerConnection, endpoint: ConnectionEndpoint): RepairReason? {
        val override = authCheckOverride
        return if (override != null) override(connection, endpoint) else authenticateByRest(connection, endpoint)
    }

    private suspend fun authenticateByRest(connection: ServerConnection, endpoint: ConnectionEndpoint): RepairReason? =
        withTimeoutOrNull(AUTH_TIMEOUT_MS) {
            try {
                authenticatedApi(connection, endpoint).serverInfo()
                null
            } catch (t: Throwable) {
                if (t is retrofit2.HttpException && (t.code() == 401 || t.code() == 403)) {
                    _tokenInvalidated.tryEmit(Unit)
                    RepairReason.Unauthorized
                } else {
                    null // 网络抖动交给 WS 建链与后续重连兜底，不误报 NeedsRepair
                }
            }
        } ?: run {
            // 鉴权超时不判死：继续尝试 WS（可能仅是 REST 面拥塞）
            null
        }

    private fun authenticatedApi(connection: ServerConnection, endpoint: ConnectionEndpoint): QingyuApi {
        if (connection.mode == ConnectionMode.RELAY) {
            val credentials = relayCredentials
            val provider = relayTokenProviders.getOrPut(connection.deviceId) {
                RelayTokenProvider(credentials?.access(connection.deviceId) ?: connection.token)
            }
            val clientBuilder = stack.restClient(tokenProvider = provider::accessToken).newBuilder()
                .addNetworkInterceptor(RelayCacheStatusInterceptor(relayStatusStore))
            if (credentials != null) {
                clientBuilder.authenticator(RelayTokenAuthenticator(
                    provider = provider,
                    refresh = { refreshRelayAccess(connection, credentials) },
                    onInvalidated = {
                        relayStatusStore.update(RelayStatus.TokenInvalidated)
                        _tokenInvalidated.tryEmit(Unit)
                    },
                ))
            }
            return stack.api(clientBuilder.build(), connection)
        }
        val client = stack.restClient(
            tokenProvider = {
                // B-04/B-05：按请求读取当前活跃连接的语义 token（而非构建时刻的冻结值）——
                // 重配对/刷新后同一 API 实例自动用新 token；活跃连接已换设备时返回 null 匿名发出
                val cur = _active.value
                if (cur != null && cur.deviceId == connection.deviceId) cur.token else null
            },
            onUnauthorized = { _tokenInvalidated.tryEmit(Unit) },
        )
        return stack.api(client, connection)
    }

    /** OkHttp Authenticator 线程上的单次轮换；Authenticator 自身负责 single-flight 与最多重放一次。 */
    private fun refreshRelayAccess(connection: ServerConnection, credentials: RelayCredentialStore): String? = runCatching {
        val refreshToken = credentials.refresh(connection.deviceId) ?: return null
        val relay = requireNotNull(connection.relay)
        val tokens = runBlocking {
            stack.relayApi(stack.pairingClient(), relay.baseUrl).refresh(RelayRefreshRequest(refreshToken))
        }
        credentials.save(connection.deviceId, tokens.accessToken, tokens.refreshToken)
        val current = _active.value
        if (current?.deviceId == connection.deviceId && current.mode == ConnectionMode.RELAY) {
            val updated = current.copy(
                token = tokens.accessToken,
                relay = current.relay?.copy(
                    accessTokenExpiresAt = tokens.accessTokenExpiresAt,
                    tokenGeneration = current.relay.tokenGeneration + 1,
                ),
            )
            _active.value = updated
            cachedApi = null
            runBlocking { store.save(updated) }
            // WsClient 的重连会复用 Session 内凭据，轮换后以同一租约重建以免之后拿旧 token。
            generators.current.value?.takeIf { generators.isCurrentDevice(it) }?.let { lease ->
                scope.launch { wsClient.disconnect(); wsClient.connect(updated, lease) }
            }
        }
        tokens.accessToken
    }.getOrNull()

    private fun retireActive() {
        // disconnect/remove：递增代次让一切在途回调作废（B-05）
        generators.retire()
        connectJob?.cancel()
        reconnectJob?.cancel()
        wsWatchdog?.cancel()
        connectJob = null
        reconnectJob = null
        wsWatchdog = null
        attempt = 0
        _active.value = null
        cachedApi = null
        relayTokenProviders.clear()
        wsClient.disconnect()
        setState(ConnectionState.Idle)
    }

    // ---------- 退避重连（B-06） ----------

    private fun scheduleReconnect(reason: FailureReason) {
        val connection = _active.value ?: return
        // 无网时不空转退避：转 Degraded 并等 Available 事件驱动重连（B-06）
        if (connectivity != null && !connectivity.hasActiveNetwork()) {
            reconnectJob?.cancel()
            setState(ConnectionState.Degraded(restAvailable = false, wsAvailable = false, reason = FailureReason.NoNetwork))
            return
        }
        attempt += 1
        val delayMs = ReconnectBackoff.delayMs(attempt, random)
        setState(ConnectionState.Reconnecting(attempt, clock() + delayMs, reason))
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(delayMs)
            val current = _active.value ?: return@launch
            runAttempt(current)
        }
    }

    private fun onConnectivityEvent(event: ConnectivityEvent) {
        val connection = _active.value
        when (event) {
            ConnectivityEvent.Available -> {
                // WS 内层退避解除暂停（B-06）；外层是否立即重探由下面状态判定
                wsClient.onNetworkAvailable()
                if (connection == null) return
                val cur = _state.value
                if (cur is ConnectionState.Connected ||
                    cur is ConnectionState.NeedsRepair ||
                    cur is ConnectionState.Probing ||
                    cur is ConnectionState.Authenticating ||
                    cur is ConnectionState.ConnectingRealtime
                ) return
                // 去重：300ms 窗口内忽略连发事件（Wi-Fi 重关联抖动）
                val now = clock()
                if (lastAutoTriggerMs?.let { now - it < AUTO_TRIGGER_DEDUPE_MS } == true) return
                lastAutoTriggerMs = now
                // 取消尚未开始的退避，立即探测（B-06）
                launchAttempt(resetBackoff = true)
            }

            ConnectivityEvent.Lost -> {
                // 暂停 WS 无效重连循环（B-06），并把 coordinator 的退避计时一并挂起：
                // 状态转 Degraded 后，runAttempt 的失败路径仍会 scheduleReconnect，
                // 但重连启动前会再次检查网络（见 hasNetwork），无网时改为等待 Available 事件
                wsClient.onNetworkLost()
                if (connection == null) return
                if (_state.value is ConnectionState.NeedsRepair) return
                reconnectJob?.cancel()
                setState(ConnectionState.Degraded(restAvailable = false, wsAvailable = false, reason = FailureReason.NoNetwork))
            }

            is ConnectivityEvent.Changed -> {
                // 同网络能力抖动（速率变化等）：不打断已建连接
            }

            is ConnectivityEvent.Switched -> {
                // 网络易主（Wi-Fi↔蜂窝/换 SSID）：旧端点大概率失效，建新代次重连（B-06）
                if (connection == null) return
                if (_state.value is ConnectionState.NeedsRepair) return
                val now = clock()
                if (lastAutoTriggerMs?.let { now - it < AUTO_TRIGGER_DEDUPE_MS } == true) return
                lastAutoTriggerMs = now
                launchAttempt(resetBackoff = true)
            }
        }
    }

    // ---------- WS 状态镜像 ----------

    private fun observeWsState() {
        scope.launch {
            wsClient.state.collect { wsState ->
                val connection = _active.value ?: return@collect
                val lease = generators.current.value ?: return@collect
                if (!generators.isCurrent(lease)) return@collect
                when (wsState) {
                    WsClient.State.CONNECTED -> {
                        wsMirrorAttempt = 0
                        attempt = 0
                        val now = clock()
                        setState(
                            ConnectionState.Connected(
                                deviceId = connection.deviceId,
                                endpoint = lease.endpoint,
                                connectedAt = now,
                                rttMs = lastProbeRttMs,
                            ),
                        )
                        // 回填上次成功时间戳（候选优先级与诊断用；token 等旧字段不删）
                        if (connection.lastConnectedAt == 0L || now - connection.lastConnectedAt > 60_000) {
                            val stamped = connection.copy(
                                lastConnectedAt = now,
                                lastSuccessfulEndpoint = if (connection.mode == ConnectionMode.LAN) lease.endpoint else connection.lastSuccessfulEndpoint,
                            )
                            _active.value = stamped
                            store.save(stamped)
                        }
                    }

                    WsClient.State.RECONNECTING -> {
                        wsMirrorAttempt += 1
                        setState(
                            ConnectionState.Reconnecting(
                                attempt = wsMirrorAttempt,
                                nextAttemptAt = clock() + ReconnectBackoff.baseDelayMs(wsMirrorAttempt),
                                reason = FailureReason.WsClosed,
                            ),
                        )
                    }

                    WsClient.State.CONNECTING -> {
                        if (_state.value !is ConnectionState.ConnectingRealtime &&
                            _state.value !is ConnectionState.Connected
                        ) {
                            setState(ConnectionState.ConnectingRealtime(lease.endpoint))
                        }
                    }

                    WsClient.State.DISCONNECTED -> {
                        val cur = _state.value
                        if (cur is ConnectionState.Connected || cur is ConnectionState.Reconnecting) {
                            // 协调器未介入的断开（如 WsLifecycleManager 后台策略）：
                            // 只降级展示，不触发探测风暴；回前台 restore()/retryNow() 再收敛
                            setState(
                                ConnectionState.Degraded(
                                    restAvailable = true,
                                    wsAvailable = false,
                                    reason = FailureReason.WsClosed,
                                ),
                            )
                        }
                    }
                }
            }
        }
    }

    // ---------- 指标（B-07，异步旁路，失败不影响主流程） ----------

    private fun recordFailure(
        attemptId: String,
        connection: ServerConnection,
        endpoint: ConnectionEndpoint,
        startedAt: Long,
        discoveryMs: Long?,
        probeMs: Long?,
        reason: FailureReason,
        wsMs: Long? = null,
    ) {
        scope.launch {
            runCatching {
                metrics.record(
                    ConnectionMetric(
                        attemptId = attemptId,
                        deviceIdHash = ConnectionMetrics.hashDeviceId(connection.deviceId),
                        startedAt = startedAt,
                        endpointType = endpoint.security.name,
                        discoveryMs = discoveryMs,
                        probeMs = probeMs,
                        wsMs = wsMs,
                        result = ConnectionMetrics.RESULT_FAILED,
                        failureReason = reason.name(),
                    ),
                )
            }
        }
    }

    private fun recordNeedsRepair(
        attemptId: String,
        connection: ServerConnection,
        endpoint: ConnectionEndpoint,
        startedAt: Long,
        discoveryMs: Long?,
        probeMs: Long?,
    ) {
        scope.launch {
            runCatching {
                metrics.record(
                    ConnectionMetric(
                        attemptId = attemptId,
                        deviceIdHash = ConnectionMetrics.hashDeviceId(connection.deviceId),
                        startedAt = startedAt,
                        endpointType = endpoint.security.name,
                        discoveryMs = discoveryMs,
                        probeMs = probeMs,
                        wsMs = null,
                        result = ConnectionMetrics.RESULT_NEEDS_REPAIR,
                        failureReason = "repair",
                    ),
                )
            }
        }
    }

    private fun setState(state: ConnectionState) {
        _state.value = state
    }

    private companion object {
        const val SUPPORTED_API_VERSION = 1
        const val WS_CONNECT_TIMEOUT_MS = 15_000L
        const val AUTH_TIMEOUT_MS = 6_000L
        const val AUTO_TRIGGER_DEDUPE_MS = 300L
    }
}

/** FailureReason 的稳定短名（指标文件用，与枚举名解耦）。 */
internal fun FailureReason.name(): String = when (this) {
    FailureReason.NoNetwork -> "no_network"
    FailureReason.Dns -> "dns"
    FailureReason.Tcp -> "tcp"
    FailureReason.Tls -> "tls"
    FailureReason.Timeout -> "timeout"
    FailureReason.ServerStopped -> "server_stopped"
    FailureReason.WsClosed -> "ws_closed"
    FailureReason.Unknown -> "unknown"
}
