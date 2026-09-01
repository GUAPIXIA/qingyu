package com.qingyu.companion.ui.pairing

import com.qingyu.companion.R
import com.qingyu.companion.model.PairRequest
import com.qingyu.companion.model.PairResponse
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.network.ConnectionManager
import com.qingyu.companion.network.QingyuApi
import com.qingyu.companion.network.connection.ConnectionState
import com.qingyu.companion.network.connection.FailureReason
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.lang.reflect.Proxy

/**
 * PairingViewModel 扫码接线单测（Fake ConnectionManager + JDK 代理 QingyuApi）：
 * - v2 扫码 → 配对成功后 serverId/capabilities/协议版本/候选端点入库（D-02）；
 * - markAwaitingApproval（B-01）在配对请求发出时上报（serverName/expiresAt 正确）；
 * - legacy 扫码 → 保持原路径（协议版本 1、无候选端点回填）；
 * - 无效二维码 → 拒绝并按原因设置 strings.xml 文案；
 * - 扫码后手动改主机 → v2 元数据作废回退 legacy 行为。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class PairingViewModelQrFlowTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var manager: FakeConnectionManager
    private lateinit var vm: PairingViewModel

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        manager = FakeConnectionManager()
        vm = PairingViewModel(
            connectionManager = manager,
            deviceName = "测试手机",
            deviceFingerprint = "fp-android",
        )
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private val v2Qr = """
        {"version":2,"scheme":"qingyu-pair","serverId":"srv-1","displayName":"测试PC",
         "apiVersion":1,"capabilities":["settings_snapshot_v2","settings_events_v1"],
         "pairingCode":"code-123","expiresAt":1799999999999,
         "endpoints":[{"host":"192.168.1.10","port":8321,"security":"LOCAL_CLEARTEXT"},
                      {"host":"qingyu.local","port":8322}]}
    """.trimIndent()

    @Test
    fun `v2 扫码配对成功后回填 serverId capabilities 协议版本与候选端点`() = runTest(dispatcher) {
        assertTrue(vm.applyQrScan(v2Qr))
        // 首个 endpoint 填表单；v2 元数据暂存
        assertEquals("192.168.1.10", vm.ui.value.host)
        assertEquals("8321", vm.ui.value.port)
        assertEquals("code-123", vm.ui.value.pairingCode)
        assertEquals("srv-1", vm.ui.value.scannedServerId)
        assertEquals(2, vm.ui.value.scannedEndpoints.size)
        assertNull(vm.ui.value.errorResId)

        var succeeded = false
        vm.pair { succeeded = true }
        advanceUntilIdle()

        assertTrue(succeeded)
        // B-01：配对请求发出即上报等待确认（serverName = QR displayName，expiresAt = QR 有效期）
        assertEquals(listOf("测试PC" to 1799999999999L), manager.awaiting)
        // 配对请求字段来自扫码与设备身份
        val request = manager.pairRequests.single()
        assertEquals("code-123", request.pairingCode)
        assertEquals("测试手机", request.deviceName)
        assertEquals("fp-android", request.deviceFingerprint)
        // D-02：保存的连接回填 v2 元数据 + pair 响应
        val saved = manager.saved.single()
        assertEquals("srv-1", saved.serverId)
        assertEquals(setOf("settings_snapshot_v2", "settings_events_v1"), saved.capabilities)
        assertEquals(2, saved.pairingProtocolVersion)
        assertEquals(2, saved.endpoints.size)
        assertEquals("jwt-1", saved.token)
        assertEquals("dev-1", saved.deviceId)
        assertEquals("192.168.1.10", saved.host)
        assertEquals(8321, saved.port)
        assertEquals("code-123", saved.fingerprint)
    }

    @Test
    fun `v2 首个端点不可达时自动尝试下一个端点`() = runTest(dispatcher) {
        manager.onCheckCompatibility = { connection ->
            if (connection.host == "192.168.1.10") {
                ConnectionManager.CompatibilityResult.Unreachable(FailureReason.Tcp)
            } else {
                ConnectionManager.CompatibilityResult.Compatible
            }
        }
        assertTrue(vm.applyQrScan(v2Qr))

        var succeeded = false
        vm.pair { succeeded = true }
        advanceUntilIdle()

        assertTrue(succeeded)
        assertEquals(listOf("192.168.1.10", "qingyu.local"), manager.compatibilityChecks)
        assertEquals("qingyu.local", manager.saved.single().host)
        assertEquals(8322, manager.saved.single().port)
    }

    @Test
    fun `连接失败原因映射为可操作的独立提示`() {
        assertEquals(R.string.pairing_error_no_network, FailureReason.NoNetwork.pairingErrorResId())
        assertEquals(R.string.pairing_error_timeout, FailureReason.Timeout.pairingErrorResId())
        assertEquals(R.string.pairing_error_tcp, FailureReason.Tcp.pairingErrorResId())
        assertEquals(R.string.pairing_error_dns, FailureReason.Dns.pairingErrorResId())
        assertEquals(R.string.pairing_error_tls, FailureReason.Tls.pairingErrorResId())
        assertEquals(R.string.pairing_error_wrong_service, FailureReason.ServerStopped.pairingErrorResId())
    }

    @Test
    fun `legacy 扫码保持原路径 协议版本 1 且无 v2 回填`() = runTest(dispatcher) {
        assertTrue(vm.applyQrScan("""{"host":"10.0.0.2","port":8321,"fingerprint":"fp-pc"}"""))
        assertEquals("10.0.0.2", vm.ui.value.host)
        assertEquals("fp-pc", vm.ui.value.pairingCode)
        // legacy 分支清空 v2 暂存
        assertTrue(vm.ui.value.scannedEndpoints.isEmpty())
        assertNull(vm.ui.value.scannedServerId)

        vm.pair { }
        advanceUntilIdle()

        val saved = manager.saved.single()
        assertEquals(1, saved.pairingProtocolVersion)
        assertTrue(saved.endpoints.isEmpty())
        assertNull(saved.serverId)
        assertTrue(saved.capabilities.isEmpty())
        assertEquals("fp-pc", saved.fingerprint)
        // serverName 无 displayName 时回退 host:port；legacy 无有效期传 0
        assertEquals(listOf("10.0.0.2:8321" to 0L), manager.awaiting)
    }

    @Test
    fun `无效二维码拒绝并按原因设置文案 表单不被污染`() = runTest(dispatcher) {
        assertFalse(vm.applyQrScan("not-json"))

        assertEquals(R.string.pairing_qr_invalid, vm.ui.value.errorResId)
        assertNull(vm.ui.value.error)
        assertEquals("", vm.ui.value.host)
        assertTrue(manager.awaiting.isEmpty())
        assertTrue(manager.saved.isEmpty())
    }

    @Test
    fun `过期二维码提示重新生成`() = runTest(dispatcher) {
        val expired = """
            {"version":2,"scheme":"qingyu-pair","pairingCode":"c","expiresAt":1699000000000,
             "endpoints":[{"host":"192.168.1.10","port":8321}]}
        """.trimIndent()

        assertFalse(vm.applyQrScan(expired))

        assertEquals(R.string.pairing_qr_expired, vm.ui.value.errorResId)
        assertEquals("", vm.ui.value.host)
    }

    @Test
    fun `扫码后手动改主机作废 v2 元数据回退 legacy 行为`() = runTest(dispatcher) {
        assertTrue(vm.applyQrScan(v2Qr))
        vm.onHostChange("10.0.0.9")
        assertTrue(vm.ui.value.scannedEndpoints.isEmpty())
        assertNull(vm.ui.value.scannedServerId)

        vm.pair { }
        advanceUntilIdle()

        val saved = manager.saved.single()
        assertEquals(1, saved.pairingProtocolVersion)
        assertTrue(saved.endpoints.isEmpty())
        assertNull(saved.serverId)
        assertTrue(saved.capabilities.isEmpty())
        assertEquals("10.0.0.9", saved.host)
    }
}

// ---------- 测试替身 ----------

/** Fake ConnectionManager：记录配对请求/保存连接/awaitingApproval 上报。 */
private class FakeConnectionManager : ConnectionManager {
    override val activeConnection: ServerConnection?
        get() = activeFlow.value
    override val activeFlow = MutableStateFlow<ServerConnection?>(null)
    override val tokenInvalidated = MutableSharedFlow<Unit>()
    override val connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Idle)

    val awaiting = mutableListOf<Pair<String, Long>>()
    val saved = mutableListOf<ServerConnection>()
    val pairRequests = mutableListOf<PairRequest>()
    val compatibilityChecks = mutableListOf<String>()
    var onCheckCompatibility: (ServerConnection) -> ConnectionManager.CompatibilityResult = {
        ConnectionManager.CompatibilityResult.Compatible
    }
    var pairResponse: PairResponse = PairResponse(token = "jwt-1", deviceId = "dev-1")

    override suspend fun restore() = Unit

    override suspend fun listConnections(): List<ServerConnection> = saved.toList()

    override suspend fun addConnection(connection: ServerConnection) {
        saved += connection
        activeFlow.value = connection
    }

    override suspend fun switchTo(deviceId: String) = Unit

    override suspend fun remove(deviceId: String) = Unit

    override suspend fun disconnectAll() = Unit

    override suspend fun checkCompatibility(connection: ServerConnection): ConnectionManager.CompatibilityResult {
        compatibilityChecks += connection.host
        return onCheckCompatibility(connection)
    }

    override fun activeApi(): QingyuApi? = null

    override fun anonApi(connection: ServerConnection): QingyuApi = fakeQingyuApi { request ->
        pairRequests += request
        pairResponse
    }

    override fun markAwaitingApproval(serverName: String, expiresAt: Long) {
        awaiting += serverName to expiresAt
    }
}

/**
 * JDK 动态代理 QingyuApi：配对流程只用到 pair()，其余方法显式失败。
 * 代理（而非手写实现）可避免接口增删方法时测试替身失配。
 */
private fun fakeQingyuApi(onPair: (PairRequest) -> PairResponse): QingyuApi =
    Proxy.newProxyInstance(
        QingyuApi::class.java.classLoader,
        arrayOf<Class<*>>(QingyuApi::class.java),
    ) { proxy, method, args ->
        when (method.name) {
            "pair" -> onPair(args?.get(0) as PairRequest)
            "toString" -> "FakeQingyuApi"
            "hashCode" -> System.identityHashCode(proxy)
            "equals" -> proxy === args?.get(0)
            else -> error("FakeQingyuApi: 配对流程不应调用 ${method.name}")
        }
    } as QingyuApi
