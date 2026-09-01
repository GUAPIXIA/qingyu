package com.qingyu.companion.network.connection

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** B-07 指标：环形上限 100、脱敏约束、JSON-lines 往返。 */
class ConnectionMetricsTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private fun metric(id: String, ts: Long = 0L, result: String = ConnectionMetrics.RESULT_FAILED) =
        ConnectionMetric(
            attemptId = id,
            deviceIdHash = "hash-$id",
            startedAt = ts,
            endpointType = "LOCAL_CLEARTEXT",
            discoveryMs = 10,
            probeMs = 25,
            wsMs = null,
            result = result,
            failureReason = if (result == ConnectionMetrics.RESULT_CONNECTED) null else "timeout",
        )

    @Test
    fun `ring buffer keeps last 100 dropping oldest`() {
        val ring = MetricRingBuffer(capacity = 100)
        repeat(150) { ring.add(metric("a$it", ts = it.toLong())) }
        assertEquals(100, ring.size)
        val snapshot = ring.snapshot()
        assertEquals("a50", snapshot.first().attemptId)
        assertEquals("a149", snapshot.last().attemptId)
    }

    @Test
    fun `evicted entries reported on overflow only`() {
        val ring = MetricRingBuffer(capacity = 2)
        assertTrue(ring.add(metric("1")).isEmpty())
        assertTrue(ring.add(metric("2")).isEmpty())
        val evicted = ring.add(metric("3"))
        assertEquals(listOf("1"), evicted.map { it.attemptId })
        assertEquals(listOf("2", "3"), ring.snapshot().map { it.attemptId })
    }

    @Test
    fun `record caps stored metrics at 100 via store api`() = runTest {
        val metrics = ConnectionMetrics(file = null)
        repeat(250) { metrics.record(metric("m$it", ts = it.toLong())) }
        val recent = metrics.recent()
        assertEquals(100, recent.size)
        assertEquals("m150", recent.first().attemptId)
        assertEquals("m249", recent.last().attemptId)
    }

    @Test
    fun `json lines encode decode round trip preserves fields`() {
        val original = ConnectionMetric(
            attemptId = "id-1",
            deviceIdHash = "abc123",
            startedAt = 1_700_000_000_000L,
            endpointType = "TLS_SYSTEM",
            discoveryMs = null,
            probeMs = 42,
            wsMs = 130,
            result = ConnectionMetrics.RESULT_CONNECTED,
            failureReason = null,
        )
        val line = ConnectionMetrics.encodeLine(original)
        val decoded = ConnectionMetrics.decodeLine(line)
        assertEquals(original, decoded)
    }

    @Test
    fun `decode tolerates garbage lines`() {
        assertNull(ConnectionMetrics.decodeLine("not json"))
        assertNull(ConnectionMetrics.decodeLine(""))
        assertNull(ConnectionMetrics.decodeLine("{}"))
    }

    @Test
    fun `metrics persist to jsonl file and reload after restart`() = runTest {
        val file = java.io.File(tempFolder.root, "metrics/m.jsonl")
        val first = ConnectionMetrics(file = file)
        first.record(metric("p1", ts = 1))
        first.record(metric("p2", ts = 2, result = ConnectionMetrics.RESULT_CONNECTED))
        assertEquals(2, file.readLines().filter { it.isNotBlank() }.size)

        // 模拟进程重启：同一文件新建收集器
        val restarted = ConnectionMetrics(file = file)
        val loaded = restarted.recent()
        assertEquals(listOf("p1", "p2"), loaded.map { it.attemptId })
    }

    @Test
    fun `file ring truncates to capacity`() = runTest {
        val file = java.io.File(tempFolder.root, "m.jsonl")
        val metrics = ConnectionMetrics(file = file, capacity = 5)
        repeat(10) { metrics.record(metric("x$it", ts = it.toLong())) }
        val lines = file.readLines().filter { it.isNotBlank() }
        assertEquals(5, lines.size)
        assertEquals(5, metrics.recent().size)
        assertEquals("x9", metrics.recent().last().attemptId)
    }

    @Test
    fun `device id hash is stable short and not raw`() {
        val hash = ConnectionMetrics.hashDeviceId("dev-9")
        assertEquals(12, hash.length)
        assertEquals(hash, ConnectionMetrics.hashDeviceId("dev-9"))
        assertFalse(hash.contains("dev-9"))
    }

    @Test
    fun `increment 累加计数并纳入诊断快照（F-03 前置）`() = runTest {
        val metrics = ConnectionMetrics(file = null)
        assertEquals(0L, metrics.counter("ws_event_drop"))
        repeat(3) { metrics.increment("ws_event_drop") }
        metrics.increment("other_key")
        assertEquals(3L, metrics.counter("ws_event_drop"))
        assertEquals(1L, metrics.counter("other_key"))
        assertEquals(0L, metrics.counter("never_used"))
        // 诊断快照 counters 输出（仅键名+次数，无敏感数据）
        val diagnostics = metrics.snapshotForDiagnostics(state = null, connection = null)
        assertEquals(3L, diagnostics.counters["ws_event_drop"])
        assertEquals(2, diagnostics.counters.size)
    }

    @Test
    fun `diagnostics snapshot exposes no secrets and summarizes state`() = runTest {
        val metrics = ConnectionMetrics(file = null)
        metrics.record(metric("d1", ts = 100))
        metrics.record(metric("d2", ts = 200, result = ConnectionMetrics.RESULT_CONNECTED))
        val diagnostics = metrics.snapshotForDiagnostics(
            state = ConnectionState.Connected(
                deviceId = "dev-1",
                endpoint = ConnectionEndpoint("192.168.1.10", 8321, TransportSecurity.LOCAL_CLEARTEXT),
                connectedAt = 123,
                rttMs = 25,
            ),
            connection = ServerConnectionSummary(
                deviceIdHash = "hash",
                serverId = "srv",
                endpointType = "LOCAL_CLEARTEXT",
                securityMode = "http",
                apiVersion = 1,
                pairingProtocolVersion = 1,
            ),
        )
        assertTrue(diagnostics.stateLabel.startsWith("connected"))
        assertEquals("http", diagnostics.securityMode)
        assertEquals("srv", diagnostics.serverId)
        assertNotNull(diagnostics.lastConnectedAt)
        assertEquals(2, diagnostics.recentAttempts)
        val text = diagnostics.toString()
        assertFalse("诊断不得含 token 字段值", text.contains("jwt"))
        assertFalse(text.contains("pairingCode"))
    }
}
