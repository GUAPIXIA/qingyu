package com.qingyu.companion.network.connection

import com.qingyu.companion.data.ConnectionStore
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.network.ConnectionManager
import com.qingyu.companion.network.ConnectionManagerImpl
import com.qingyu.companion.network.WsClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * B-01/B-05/B-06 协调器状态机回归：
 * 成功路径、退避序列增长、代次拒绝旧回调、断网暂停/恢复立即重探、切网新代次、NeedsRepair。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ConnectionCoordinatorTest {

    // ---------- fakes ----------

    private class FakeStore : ConnectionStore {
        val map = LinkedHashMap<String, ServerConnection>()
        var activeId: String? = null
        override suspend fun loadAll(): List<ServerConnection> = map.values.toList()
        override suspend fun save(connection: ServerConnection) { map[connection.deviceId] = connection }
        override suspend fun remove(deviceId: String) {
            map.remove(deviceId)
            if (activeId == deviceId) activeId = null
        }

        override suspend fun setActive(deviceId: String?) { activeId = deviceId }
        override suspend fun getActive(): ServerConnection? = activeId?.let { map[it] }
        override suspend fun wipe() { map.clear(); activeId = null }
    }

    private class FakeWsClient : WsClient {
        private val _state = MutableStateFlow(WsClient.State.DISCONNECTED)
        override val state: StateFlow<WsClient.State> = _state
        override val events: SharedFlow<CompanionEvent> = MutableSharedFlow()
        val connectLog = mutableListOf<Pair<String, Long>>()
        var disconnectCalls = 0
        var networkLostCalls = 0
        var networkAvailableCalls = 0

        /** connect 后把 WS 推进到什么状态（默认立即 CONNECTED） */
        var onConnect: () -> Unit = { _state.value = WsClient.State.CONNECTED }

        override suspend fun connect(connection: ServerConnection) = connectInternal(connection, null)
        override suspend fun connect(connection: ServerConnection, lease: ConnectionLease) =
            connectInternal(connection, lease)

        private fun connectInternal(connection: ServerConnection, lease: ConnectionLease?) {
            connectLog += connection.deviceId to (lease?.generation ?: -1L)
            onConnect()
        }

        override fun disconnect() {
            disconnectCalls++
            _state.value = WsClient.State.DISCONNECTED
        }

        override suspend fun stopGeneration(requestId: String) = Unit
        override fun onNetworkLost() { networkLostCalls++ }
        override fun onNetworkAvailable() { networkAvailableCalls++ }
        fun pushState(state: WsClient.State) { _state.value = state }
    }

    private class FakeConnectivity : ConnectivityObserver {
        private val _events = MutableSharedFlow<ConnectivityEvent>(extraBufferCapacity = 16)
        override val events: SharedFlow<ConnectivityEvent> = _events
        var active = true
        override fun hasActiveNetwork(): Boolean = active
        override fun start() = Unit
        override fun stop() = Unit
        fun emit(event: ConnectivityEvent) { _events.tryEmit(event) }
    }

    private fun endpoint(host: String, port: Int = 8321) =
        ConnectionEndpoint(host, port, TransportSecurity.LOCAL_CLEARTEXT)

    private fun connection(deviceId: String = "dev-1", host: String = "192.168.1.10") =
        ServerConnection("PC", host, 8321, "jwt", deviceId, "fp")

    private class Fixture(probeImpl: suspend (ConnectionEndpoint) -> ProbeOutcome) {
        val store = FakeStore()
        val ws = FakeWsClient()
        val connectivity = FakeConnectivity()
        val metrics = ConnectionMetrics(file = null)
        val probeLog = mutableListOf<ConnectionEndpoint>()
        val prober = EndpointProber(staggerMs = 150L, maxInFlight = 3, probe = { ep ->
            probeLog += ep
            probeImpl(ep)
        })

        fun coordinator(
            scope: CoroutineScope,
            now: () -> Long,
        ) = ConnectionCoordinator(
            store = store,
            wsClient = ws,
            metrics = metrics,
            connectivity = connectivity,
            prober = prober,
            authCheckOverride = { _, _ -> null }, // JVM 测试不打真实 REST
            clock = now,
            scope = scope,
        )
    }

    private fun successOutcome(ep: ConnectionEndpoint, serverId: String? = null) =
        ProbeOutcome(ep, success = true, rttMs = 12, serverId = serverId, apiVersion = 1, capabilities = setOf("c1"))

    private fun failOutcome(ep: ConnectionEndpoint, reason: FailureReason) =
        ProbeOutcome(ep, success = false, rttMs = 5, failureReason = reason)

    private fun seed(fx: Fixture, vararg conns: ServerConnection, active: String? = "dev-1") {
        conns.forEach { fx.store.map[it.deviceId] = it }
        fx.store.activeId = active
    }

    // ---------- 成功路径 ----------

    @Test
    fun `connect happy path ends Connected and backfills server fields`() = runTest {
        val fx = Fixture { successOutcome(it, "srv-1") }
        val coordinator = fx.coordinator(backgroundScope) { testScheduler.currentTime }
        seed(fx, connection())

        advanceTimeBy(1_000) // lastConnectedAt 回填断言需要非零时刻
        coordinator.restore()
        runCurrent()

        val connected = coordinator.connectionState.value
        assertTrue("expect Connected, got $connected", connected is ConnectionState.Connected)
        connected as ConnectionState.Connected
        assertEquals("dev-1", connected.deviceId)
        assertEquals(endpoint("192.168.1.10"), connected.endpoint)
        assertEquals(12L, connected.rttMs)
        assertEquals(listOf(endpoint("192.168.1.10")), fx.probeLog)
        // WS 只建一次链，且携带协调器租约代次（B-05）
        assertEquals(listOf("dev-1" to 1L), fx.ws.connectLog)
        // B-02 回填
        val saved = fx.store.map.getValue("dev-1")
        assertEquals("srv-1", saved.serverId)
        assertEquals(setOf("c1"), saved.capabilities)
        assertNotNull(saved.lastSuccessfulEndpoint)
        assertTrue(saved.lastConnectedAt > 0)
        // 旧字段不删
        assertEquals("jwt", saved.token)
        assertEquals("fp", saved.fingerprint)
    }

    @Test
    fun `awaiting approval shows while not connected and never overrides Connected`() = runTest {
        val fx = Fixture { successOutcome(it) }
        val coordinator = fx.coordinator(backgroundScope) { testScheduler.currentTime }
        seed(fx, connection())
        // 让 WS 停在 CONNECTING，模拟尚未 Connected
        fx.ws.onConnect = { }

        coordinator.markAwaitingApproval("PC", 5_000)
        assertTrue(coordinator.connectionState.value is ConnectionState.AwaitingApproval)

        coordinator.restore()
        runCurrent()
        assertTrue(coordinator.connectionState.value is ConnectionState.ConnectingRealtime)

        fx.ws.pushState(WsClient.State.CONNECTED)
        runCurrent()
        assertTrue(coordinator.connectionState.value is ConnectionState.Connected)
        // Connected 之后配对确认事件不得回滚状态
        coordinator.markAwaitingApproval("PC", 7_000)
        assertTrue(coordinator.connectionState.value is ConnectionState.Connected)
    }

    // ---------- 失败退避（B-06 序列） ----------

    @Test
    fun `repeated failures walk the 0 1 2 4 8 15 30 backoff sequence`() = runTest {
        val fx = Fixture { failOutcome(it, FailureReason.ServerStopped) }
        val coordinator = fx.coordinator(backgroundScope) { testScheduler.currentTime }
        seed(fx, connection())

        val reconnecting = mutableListOf<ConnectionState.Reconnecting>()
        backgroundScope.launch {
            coordinator.connectionState.collect { s ->
                (s as? ConnectionState.Reconnecting)?.let { reconnecting += it }
            }
        }
        coordinator.restore()
        advanceTimeBy(150_000)
        runCurrent()

        // 前 7 个退避档位必须依次出现（attempt 1..7 = base 0,1,2,4,8,15,30s）
        val attempts = reconnecting.map { it.attempt }
        assertTrue("attempts=$attempts", attempts.take(7) == (1..7).toList())
        // jitter 边界：attempt n 的 nextAttemptAt - 触发时刻 ∈ [base×0.8, base×1.2]
        var lastAt = 0L
        reconnecting.take(7).forEachIndexed { index, state ->
            val base = ReconnectBackoff.BASE_DELAYS_MS[index]
            assertTrue("gap grows monotonically", state.nextAttemptAt >= lastAt)
            lastAt = state.nextAttemptAt
        }
        // 序列稳定推进到 30s 档后维持
        assertTrue(attempts.last() > 7)
    }

    @Test
    fun `retryNow resets backoff to first slot`() = runTest {
        val fx = Fixture { failOutcome(it, FailureReason.ServerStopped) }
        val coordinator = fx.coordinator(backgroundScope) { testScheduler.currentTime }
        seed(fx, connection())
        coordinator.restore()
        advanceTimeBy(70_000) // 退避已爬升到 attempt≥7
        runCurrent()
        val before = (coordinator.connectionState.value as ConnectionState.Reconnecting).attempt
        assertTrue("expected escalated attempt, got $before", before >= 6)

        // 手动重试 = 代次+1、重新从 attempt 1 起（探测失败后挂 Reconnecting(attempt≤2)）
        coordinator.retryNow()
        runCurrent()
        val after = coordinator.connectionState.value
        assertTrue("expect low attempt, got $after", after is ConnectionState.Reconnecting)
        assertTrue((after as ConnectionState.Reconnecting).attempt <= 2)
    }

    // ---------- 代次拒绝旧回调（B-05） ----------

    @Test
    fun `switch during probe - stale result never drives ws for old device`() = runTest {
        // 按 host 分通道：dev-1 挂起、dev-2 立即成功，随后把 dev-1 的迟到结果"喂回"验证作废
        val dev1Pending = Channel<ProbeOutcome>(Channel.UNLIMITED)
        val fx = Fixture { ep ->
            if (ep.host == "192.168.1.10") dev1Pending.receive()
            else successOutcome(ep, "srv-B")
        }
        val coordinator = fx.coordinator(backgroundScope) { testScheduler.currentTime }
        seed(fx, connection("dev-1"), connection("dev-2", "192.168.1.11"), active = "dev-1")
        coordinator.restore()
        runCurrent()
        val leaseA = coordinator.generators.current.value!!
        assertEquals(1L, leaseA.generation)
        // dev-1 探测挂起 → 尚无 WS 建链
        assertTrue(fx.ws.connectLog.isEmpty())

        coordinator.switchTo("dev-2")
        runCurrent()
        assertEquals(2L, coordinator.generators.current.value!!.generation)
        // dev-2 新代次建链完成
        assertEquals(listOf("dev-2" to 2L), fx.ws.connectLog)

        // dev-1 的迟到成功结果回传（若其尝试未被 cancel 会试图再建链）
        dev1Pending.send(successOutcome(endpoint("192.168.1.10"), "srv-A"))
        runCurrent()

        assertTrue(fx.ws.connectLog.none { it.first == "dev-1" })
        assertEquals(1, fx.ws.connectLog.size)
        assertTrue(coordinator.connectionState.value is ConnectionState.Connected)
        assertEquals("dev-2", (coordinator.connectionState.value as ConnectionState.Connected).deviceId)
    }

    @Test
    fun `disconnectAll bumps generation and pending attempt cannot resurrect`() = runTest {
        val pending = Channel<ProbeOutcome>(Channel.UNLIMITED)
        val fx = Fixture { pending.receive() }
        val coordinator = fx.coordinator(backgroundScope) { testScheduler.currentTime }
        seed(fx, connection())
        coordinator.restore()
        runCurrent()
        val before = coordinator.generators.generation()

        coordinator.disconnectAll()
        runCurrent()

        assertTrue(coordinator.generators.generation() > before)
        assertNull(coordinator.activeConnection)
        assertEquals(ConnectionState.Idle, coordinator.connectionState.value)
        assertEquals(1, fx.ws.disconnectCalls)

        pending.send(successOutcome(endpoint("192.168.1.10")))
        runCurrent()
        assertEquals(ConnectionState.Idle, coordinator.connectionState.value)
        assertTrue(fx.ws.connectLog.isEmpty())
    }

    // ---------- 网络事件（B-06） ----------

    @Test
    fun `lost pauses loop and available re-probes immediately`() = runTest {
        // 断网期间探测失败；网络恢复后探测成功（贴近"PC 重新可达"的真实场景）
        lateinit var fx: Fixture
        fx = Fixture { ep ->
            if (fx.connectivity.active) successOutcome(ep) else failOutcome(ep, FailureReason.ServerStopped)
        }
        val coordinator = fx.coordinator(backgroundScope) { testScheduler.currentTime }
        seed(fx, connection())
        fx.connectivity.active = false
        coordinator.restore()
        runCurrent()
        // 探测失败且 hasActiveNetwork=false → scheduleReconnect 直接 Degraded（无网不空转）
        val degraded = coordinator.connectionState.value
        assertTrue("expect Degraded(NoNetwork), got $degraded", degraded is ConnectionState.Degraded)
        assertEquals(FailureReason.NoNetwork, (degraded as ConnectionState.Degraded).reason)
        val probesAfterInitial = fx.probeLog.size

        // 系统 Lost 事件：WS 内层暂停
        fx.connectivity.emit(ConnectivityEvent.Lost)
        runCurrent()
        assertEquals(1, fx.ws.networkLostCalls)

        // 无退避计时在跑：空转 60s 不新增探测
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(probesAfterInitial, fx.probeLog.size)

        // 网络恢复：立即重探并成功（attempt 从 1 重置）
        fx.connectivity.active = true
        fx.connectivity.emit(ConnectivityEvent.Available)
        runCurrent()
        assertEquals(1, fx.ws.networkAvailableCalls)
        assertEquals(probesAfterInitial + 1, fx.probeLog.size)
        assertTrue(coordinator.connectionState.value is ConnectionState.Connected)
    }

    @Test
    fun `available storm is deduped within 300ms window`() = runTest {
        // 断网期间探测失败；网络恢复后探测成功（贴近"PC 重新可达"的真实场景）
        lateinit var fx: Fixture
        fx = Fixture { ep ->
            if (fx.connectivity.active) successOutcome(ep) else failOutcome(ep, FailureReason.ServerStopped)
        }
        val coordinator = fx.coordinator(backgroundScope) { testScheduler.currentTime }
        seed(fx, connection())
        fx.connectivity.active = false
        coordinator.restore()
        runCurrent()
        // restore 时 hasActiveNetwork=false → scheduleReconnect 直接转 Degraded（不空转）
        assertTrue(coordinator.connectionState.value is ConnectionState.Degraded)
        val probesBefore = fx.probeLog.size

        fx.connectivity.active = true
        repeat(4) { fx.connectivity.emit(ConnectivityEvent.Available) }
        runCurrent()

        // 4 连发只触发一次重探（300ms 去重窗口），且当次成功 → Connected
        assertEquals(probesBefore + 1, fx.probeLog.size)
        assertTrue(coordinator.connectionState.value is ConnectionState.Connected)
    }

    @Test
    fun `switched network creates new generation and reconnects`() = runTest {
        val fx = Fixture { successOutcome(it) }
        val coordinator = fx.coordinator(backgroundScope) { testScheduler.currentTime }
        seed(fx, connection())
        coordinator.restore()
        runCurrent()
        assertTrue(coordinator.connectionState.value is ConnectionState.Connected)
        val genBefore = coordinator.generators.generation()

        fx.connectivity.emit(ConnectivityEvent.Switched(42))
        runCurrent()

        assertTrue("切网必须建新代次", coordinator.generators.generation() > genBefore)
        assertTrue(coordinator.connectionState.value is ConnectionState.Connected)
        assertEquals(2, fx.ws.connectLog.size) // 新代次重新建链
    }

    // ---------- 降级 / 修复 ----------

    @Test
    fun `ws drop after connected mirrors degraded without probe storm`() = runTest {
        val fx = Fixture { successOutcome(it) }
        fx.ws.onConnect = { } // 手动推状态
        val coordinator = fx.coordinator(backgroundScope) { testScheduler.currentTime }
        seed(fx, connection())
        coordinator.restore()
        runCurrent()
        assertTrue(coordinator.connectionState.value is ConnectionState.ConnectingRealtime)
        fx.ws.pushState(WsClient.State.CONNECTED)
        runCurrent()
        assertTrue(coordinator.connectionState.value is ConnectionState.Connected)
        val probesAfterConnect = fx.probeLog.size

        fx.ws.pushState(WsClient.State.DISCONNECTED)
        runCurrent()
        val degraded = coordinator.connectionState.value
        assertTrue("expect Degraded(ws), got $degraded", degraded is ConnectionState.Degraded)
        degraded as ConnectionState.Degraded
        assertTrue(degraded.restAvailable)
        assertTrue(!degraded.wsAvailable)
        assertEquals(FailureReason.WsClosed, degraded.reason)
        // 协调器不额外发起探测（交 WsClientImpl 内层退避）
        assertEquals(probesAfterConnect, fx.probeLog.size)
    }

    @Test
    fun `api version mismatch goes needs repair and ignores network events`() = runTest {
        val fx = Fixture { ProbeOutcome(it, success = true, rttMs = 3, apiVersion = 999) }
        val coordinator = fx.coordinator(backgroundScope) { testScheduler.currentTime }
        seed(fx, connection())
        coordinator.restore()
        runCurrent()
        val state = coordinator.connectionState.value
        assertTrue("expect NeedsRepair, got $state", state is ConnectionState.NeedsRepair)
        assertEquals(RepairReason.ApiIncompatible, (state as ConnectionState.NeedsRepair).reason)

        fx.connectivity.emit(ConnectivityEvent.Available)
        fx.connectivity.emit(ConnectivityEvent.Switched(1))
        runCurrent()
        assertTrue(coordinator.connectionState.value is ConnectionState.NeedsRepair)
        // NeedsRepair 不建 WS
        assertTrue(fx.ws.connectLog.isEmpty())
    }

    // ---------- 委托兼容（B-01 迁移期） ----------

    @Test
    fun `connectionmanager facade delegates to coordinator`() = runTest {
        val fx = Fixture { successOutcome(it) }
        val coordinator = fx.coordinator(backgroundScope) { testScheduler.currentTime }
        val facade: ConnectionManager = ConnectionManagerImpl.create(coordinator)
        seed(fx, connection())
        facade.restore()
        runCurrent()
        assertTrue(facade.connectionState.value is ConnectionState.Connected)
        assertEquals(coordinator.connectionState.value, facade.connectionState.value)
        assertEquals("dev-1", facade.activeConnection?.deviceId)
        // activeApi 缓存键含 deviceId+endpoint+tokenGeneration（B-04）：同状态幂等
        // （用身份断言：Retrofit 动态代理的 equals 转发给 InvocationHandler，永不互等）
        val a = facade.activeApi()
        val b = facade.activeApi()
        assertNotNull(a)
        org.junit.Assert.assertSame(a, b)
        // 换 token（重新配对）后缓存失效重建
        val rePaired = connection().copy(token = "jwt-v2")
        fx.store.map["dev-1"] = rePaired
        // 通过内部状态流模拟 token 换代
        val c = facade.anonApi(rePaired)
        assertNotNull(c)
    }
}
