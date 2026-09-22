package com.qingyu.companion.diagnostics

import com.qingyu.companion.network.connection.ConnectionDiagnostics
import com.qingyu.companion.network.connection.DiagnosticsFailure
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-07 P2 诊断同口径单测：
 * - diagnostics.connection：只含元数据与计数，serverId 哈希化；
 * - diagnostics.generation：只含次数/时长/脱敏错误；
 * - 收集器逐源降级（单源失败不毁整包）；
 * - 泄密扫描与文件落盘降级。
 */
class DiagnosticsSectionsTest {

    // ---------- diagnostics.connection ----------

    private fun connectionDiagnostics() = ConnectionDiagnostics(
        stateLabel = "connected(rtt=45ms)",
        endpointType = "TLS_SYSTEM",
        securityMode = "pairing_v2",
        serverId = "srv-pc-001",
        apiVersion = 2,
        pairingProtocolVersion = 2,
        lastRttMs = 45L,
        lastConnectedAt = 1_700_000_000_000L,
        lastFailure = DiagnosticsFailure(
            startedAt = 1_699_999_000_000L,
            endpointType = "LOCAL_CLEARTEXT",
            reason = "tls",
        ),
        recentAttempts = 7,
        recentResults = listOf("connected", "failed"),
        counters = mapOf("ws_event_drop" to 3L),
    )

    @Test
    fun `连接诊断只含元数据与计数且serverId哈希化`() {
        val section = connectionDiagnostics().toConnectionDiagSection()
        assertEquals("状态标签丢失会让连接诊断失去基准", "connected(rtt=45ms)", section.stateLabel)
        assertEquals("尝试次数丢失会无法评估连接稳定性", 7, section.recentAttempts)
        assertEquals("事件计数丢失会无法排查事件堆积", 3L, section.counters["ws_event_drop"])
        assertEquals("失败原因键丢失会无法归因", "tls", section.lastFailure?.reasonKey)
        val hash = section.serverIdHash
        assertTrue("serverId 必须哈希化，明文标识会暴露用户部署", hash != null && hash == DiagnosticsRedactor.hashId("srv-pc-001"))
        assertFalse("哈希值不得可逆回原串拼接", "srv-pc-001" in (hash ?: ""))
    }

    // ---------- diagnostics.generation ----------

    @Test
    fun `生成诊断只含计数时长与一条脱敏错误`() {
        val recorder = GenerationDiagnosticsRecorder()
        recorder.onStarted("s1", atMs = 1_000L)
        recorder.onCompleted("s1", atMs = 4_000L)
        recorder.onStarted("s2", atMs = 5_000L)
        recorder.onFailed("s2", atMs = 8_000L, errorKind = "Timeout", errorSummary = "生成超时")
        recorder.onStarted("s3", atMs = 9_000L)
        recorder.onInterrupted("s3", atMs = 9_500L)
        recorder.increment("partial_failure")

        val section = recorder.snapshot()
        assertEquals("开始次数统计错误会误判生成活跃度", 3L, section.started)
        assertEquals("完成次数统计错误会误判生成成功率", 1L, section.completed)
        assertEquals("失败次数统计错误会误判生成成功率", 1L, section.failed)
        assertEquals("中断次数统计错误会误判用户行为", 1L, section.interrupted)
        assertEquals("总时长统计错误会误判生成耗时", 6_500L, section.totalDurationMs)
        assertEquals("最大时长统计错误会误判长尾耗时", 3_000L, section.maxDurationMs)
        assertEquals("平均时长统计错误会误判生成耗时", 2_166L, section.avgDurationMs)
        assertEquals("自定义计数器丢失会无法排查局部失败", 1L, section.counters["partial_failure"])
        assertEquals("最后错误类型丢失会无法归因", "Timeout", section.lastFailure?.kind)
    }

    @Test
    fun `未开始的会话结束时不会产生负时长`() {
        val recorder = GenerationDiagnosticsRecorder()
        recorder.onCompleted("ghost", atMs = 100L)
        val section = recorder.snapshot()
        assertEquals("幽灵会话不应计时", 0L, section.totalDurationMs)
        assertNull("没有完成样本时不应给出平均值", section.avgDurationMs)
    }

    // ---------- 收集器逐源降级 ----------

    @Test
    fun `收集器单源失败只留脱敏错误不毁整包`() = runTest {
        val collector = SnapshotDiagnosticsCollector(
            versions = DiagnosticsVersionSource {
                VersionSection("1.2.3", 123, "release", "stable", 34)
            },
            dbSchema = DiagnosticsSchemaSource {
                throw IllegalStateException("schema read failed")
            },
            sync = DiagnosticsSyncSource {
                SyncSummarySection(pendingOutbox = 2, counters = mapOf("ws_event_drop" to 3L))
            },
            capabilities = { mapOf("chat.local" to "enabled") },
            clock = { 1_700_000_000_000L },
        )
        val snapshot = collector.collect()
        assertEquals("版本源正常却丢版本，说明降级逻辑误伤", "1.2.3", snapshot.versions.appVersionName)
        assertEquals("同步源正常却丢同步摘要，说明降级逻辑误伤", 2, snapshot.sync.pendingOutbox)
        assertEquals("schema 源失败应留一条错误记录", 1, snapshot.errors.size)
        assertEquals("错误记录应标注失败来源", "dbSchema", snapshot.errors.first().kind)
        assertFalse(
            "错误摘要里不得残留原始异常路径/秘密",
            "C:\\Users" in snapshot.errors.first().summary,
        )
    }

    // ---------- 泄密扫描 ----------

    @Test
    fun `泄密扫描能识别密钥形态与用户名路径`() {
        val hits = DiagnosticsLeakGuard.findSuspiciousPatterns(
            "key sk-proj-AbCdEfGh1234567890-_XyZ at /home/alice/err.log",
        )
        assertTrue("密钥形态未被扫描识别，带密的包会被放行", hits.any { it.startsWith("sk-") })
        assertTrue("用户名路径未被扫描识别，身份会被放行", hits.any { it.contains("alice") })
        val clean = DiagnosticsLeakGuard.findSuspiciousPatterns("state=connected schema=7 reason=tls")
        assertTrue("干净文本不应误报，否则诊断永远导不出", clean.isEmpty())
    }

    @Test
    fun `文件落盘成功与失败都返回稳定结果`() {
        val dir = Files.createTempDirectory("qy-diagnostics-test").toFile()
        try {
            val sink = FileDiagnosticsExportSink(dir)
            assertTrue("正常目录写盘应成功", sink.write("diag.zip", byteArrayOf(1, 2, 3)))
            assertTrue("写盘后的文件应存在", File(dir, "diag.zip").length() == 3L)

            val blocker = File(dir, "blocker")
            blocker.writeText("not a dir")
            val badSink = FileDiagnosticsExportSink(blocker)
            assertFalse("写盘失败应返回 false 由上层降级，不能抛错", badSink.write("diag.zip", byteArrayOf(1)))
        } finally {
            dir.deleteRecursively()
        }
    }
}
