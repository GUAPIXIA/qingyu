package com.qingyu.companion.network.connection

import com.qingyu.companion.model.ServerConnection
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

/** B-03 候选构建（去重+优先级）与竞速规则回归。 */
class EndpointProbeTest {

    private fun local(host: String, port: Int = 8321) =
        ConnectionEndpoint(host, port, TransportSecurity.LOCAL_CLEARTEXT)

    private fun connection(
        host: String = "192.168.1.10",
        port: Int = 8321,
        endpoints: List<ConnectionEndpoint> = emptyList(),
        lastSuccess: ConnectionEndpoint? = null,
    ) = ServerConnection(
        name = "PC",
        host = host,
        port = port,
        token = "t",
        deviceId = "dev-1",
        fingerprint = "fp",
        endpoints = endpoints,
        lastSuccessfulEndpoint = lastSuccess,
    )

    // ---------- 候选去重与优先级 ----------

    @Test
    fun `candidate order is lastSuccess then qr then mdns then manual then legacy`() {
        val qr = local("192.168.1.50", 8321)
        val mdns = local("192.168.1.60", 8321)
        val manual = local("192.168.1.70", 8321)
        // lastSuccess 取 CGNAT 段，与 legacy（host 192.168.1.10）互不去重
        val last = local("100.64.5.6", 8321)
        val ranked = EndpointCandidates.build(
            connection(endpoints = listOf(qr), lastSuccess = last),
            discovered = listOf(mdns),
            manual = manual,
        )
        assertEquals(
            listOf(
                CandidateOrigin.LAST_SUCCESS,
                CandidateOrigin.QR,
                CandidateOrigin.MDNS,
                CandidateOrigin.MANUAL,
                CandidateOrigin.LEGACY,
            ),
            ranked.map { it.origin },
        )
        assertEquals(
            listOf(last, qr, mdns, manual, local("192.168.1.10", 8321)),
            ranked.map { it.endpoint },
        )
    }

    @Test
    fun `duplicate host port security collapses to first origin`() {
        // lastSuccess 与 legacy 同 host/port/security → 去重后只剩 LAST_SUCCESS
        val last = local("192.168.1.10", 8321)
        val ranked = EndpointCandidates.build(
            connection(endpoints = listOf(local("192.168.1.10", 8321)), lastSuccess = last),
            discovered = listOf(local("192.168.1.10", 8321)),
            manual = local("192.168.1.10", 8321),
        )
        assertEquals(1, ranked.size)
        assertEquals(CandidateOrigin.LAST_SUCCESS, ranked.single().origin)
        assertEquals(TransportSecurity.LOCAL_CLEARTEXT, ranked.single().endpoint.security)
    }

    @Test
    fun `same host different port or security are distinct candidates`() {
        val a = local("192.168.1.10", 8321)
        val b = ConnectionEndpoint("192.168.1.10", 8443, TransportSecurity.TLS_SYSTEM)
        val ranked = EndpointCandidates.build(connection(endpoints = listOf(a, b)), discovered = listOf(local("192.168.1.10", 8321)))
        assertEquals(listOf(CandidateOrigin.QR, CandidateOrigin.QR), ranked.map { it.origin })
    }

    @Test
    fun `legacy synthesis skipped when host unparseable but core kept`() {
        // 公网 host 也可合成 TLS 端点；非法端口则只丢兜底不丢其他候选
        val ranked = EndpointCandidates.build(
            ServerConnection("n", "192.168.1.5", 0, "t", "d", "f"),
            discovered = listOf(local("10.0.0.9")),
        )
        assertEquals(listOf(CandidateOrigin.MDNS), ranked.map { it.origin })
    }

    @Test
    fun `serverId match rule treats unknown as permissive strict otherwise`() {
        assertTrue(EndpointCandidates.serverIdMatches(null, "any"))
        assertTrue(EndpointCandidates.serverIdMatches("s1", null))
        assertTrue(EndpointCandidates.serverIdMatches("s1", "s1"))
        assertTrue(!EndpointCandidates.serverIdMatches("s1", "s2"))
    }

    // ---------- 竞速调度 ----------

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `first candidate probes immediately others staggered and concurrency capped at three`() = runTest {
        val started = mutableListOf<Pair<ConnectionEndpoint, Long>>()
        val lock = Any()
        var inFlight = 0
        var maxInFlight = 0
        val endpoints = (1..5).map { local("192.168.1.$it") }
        val prober = EndpointProber(
            probe = { endpoint ->
                synchronized(lock) {
                    started += endpoint to testScheduler.currentTime
                    inFlight++
                    maxInFlight = maxOf(maxInFlight, inFlight)
                }
                // 单次探测 400ms > stagger 150ms：并发上限真实受压
                delay(400)
                synchronized(lock) { inFlight-- }
                ProbeOutcome(endpoint, success = false, rttMs = 400, failureReason = FailureReason.Timeout)
            },
        )
        val result = prober.race(
            endpoints.map { RankedEndpoint(it, CandidateOrigin.QR) },
            expectedServerId = null,
        )
        assertTrue(result is ProbeRaceResult.NoCandidate)
        assertEquals(5, (result as ProbeRaceResult.NoCandidate).failures.size)
        // 第一候选 t=0；其余 t=150ms 起（stagger）
        assertEquals(0L, started.first().second)
        started.drop(1).forEach { (_, t) -> assertTrue("start=$t", t >= 150L) }
        // 并发必须被钳制在 3，且确实达到过 3（证明钳制生效而非串行）
        assertEquals(5, started.size)
        assertEquals("maxInFlight=$maxInFlight", 3, maxInFlight)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `fast mismatched serverId candidate loses to slower matching one`() = runTest {
        val wrong = local("192.168.1.20")
        val right = local("192.168.1.21")
        val prober = EndpointProber(
            probe = { endpoint ->
                when (endpoint) {
                    // 错误 PC 响应极快（0ms）
                    wrong -> ProbeOutcome(endpoint, success = true, rttMs = 0, serverId = "other-pc")
                    // 目标 PC 慢但 serverId 匹配
                    else -> {
                        delay(50)
                        ProbeOutcome(endpoint, success = true, rttMs = 50, serverId = "target")
                    }
                }
            },
            staggerMs = 10L,
        )
        val result = prober.race(
            listOf(RankedEndpoint(wrong, CandidateOrigin.QR), RankedEndpoint(right, CandidateOrigin.QR)),
            expectedServerId = "target",
        )
        assertTrue(result is ProbeRaceResult.Winner)
        result as ProbeRaceResult.Winner
        assertEquals(right, result.outcome.endpoint)
        assertEquals("target", result.outcome.serverId)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `winner cancels remaining probes`() = runTest {
        val fast = local("192.168.1.30")
        val slowCancelled = CompletableDeferred<Boolean>()
        val prober = EndpointProber(
            probe = { endpoint ->
                if (endpoint == fast) {
                    delay(50) // 让慢候选先启动，验证胜出后被取消
                    ProbeOutcome(endpoint, success = true, rttMs = 50, serverId = "s")
                } else {
                    try {
                        delay(600_000L) // 永不自然完成，等竞速胜出后取消
                        ProbeOutcome(endpoint, success = true, rttMs = 600_000)
                    } finally {
                        slowCancelled.complete(true)
                    }
                }
            },
            staggerMs = 5L,
        )
        val result = prober.race(
            listOf(
                RankedEndpoint(fast, CandidateOrigin.LAST_SUCCESS),
                RankedEndpoint(local("192.168.1.31"), CandidateOrigin.QR),
            ),
            expectedServerId = "s",
        )
        assertTrue(result is ProbeRaceResult.Winner)
        assertEquals(fast, (result as ProbeRaceResult.Winner).outcome.endpoint)
        // race 返回前必须已取消慢探测（虚拟时间下未取消则永不返回）
        assertTrue("slow probe was not cancelled", slowCancelled.isCompleted)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `empty candidates yields NoCandidate without probing`() = runTest {
        var probes = 0
        val prober = EndpointProber(probe = { ep -> probes++; ProbeOutcome(ep, success = true, rttMs = 0L) })
        val result = prober.race(emptyList(), null)
        assertTrue(result is ProbeRaceResult.NoCandidate)
        assertEquals(0, probes)
    }

    @Test
    fun `probe failure classification maps throwables`() {
        assertEquals(FailureReason.Timeout, EndpointProber.classifyThrowable(java.net.SocketTimeoutException()))
        assertEquals(FailureReason.Dns, EndpointProber.classifyThrowable(java.net.UnknownHostException()))
        assertEquals(FailureReason.Tcp, EndpointProber.classifyThrowable(java.net.ConnectException()))
        assertEquals(FailureReason.Tls, EndpointProber.classifyThrowable(javax.net.ssl.SSLException("boom")))
        assertEquals(FailureReason.Unknown, EndpointProber.classifyThrowable(RuntimeException()))
    }

    @Test
    fun `blocking HTTP probe leaves caller thread`() {
        MockWebServer().use { server ->
            server.enqueue(
                MockResponse()
                    .setResponseCode(200)
                    .setBody("""{"apiVersion":1,"appVersion":"test"}"""),
            )
            server.start()
            val networkThread = AtomicReference<Thread>()
            val client = OkHttpClient.Builder()
                .addInterceptor { chain ->
                    networkThread.set(Thread.currentThread())
                    chain.proceed(chain.request())
                }
                .build()
            Executors.newSingleThreadExecutor { runnable ->
                Thread(runnable, "simulated-compose-main")
            }.asCoroutineDispatcher().use { callerDispatcher ->
                runBlocking(callerDispatcher) {
                    val callerThread = Thread.currentThread()
                    val outcome = HttpEndpointProber(client).probe(
                        local("127.0.0.1", server.port),
                    )

                    assertTrue(outcome.success)
                    assertNotSame(
                        "Synchronous OkHttp execute must not run on the Compose caller thread",
                        callerThread,
                        networkThread.get(),
                    )
                }
            }
        }
    }
}
