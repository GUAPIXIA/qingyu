package com.qingyu.companion.diagnostics

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-07 诊断导出包**泄密红线**测试：
 * 注入带 API Key / token / 消息正文 / 用户名路径的样本 → 断言导出（JSON 与 zip 原始字节）
 * 里搜不到任一原串；同时断言导出结构只含版本/能力/schema/同步摘要/脱敏错误。
 */
class DiagnosticsBundleRedactionTest {

    // ---------- 样本（红线注入物） ----------
    private val apiKeySample = "sk-proj-AbCdEfGh1234567890-_XyZ"
    private val jwtSample = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"
    private val registeredTokenSample = "rt_Zq7Xk2Pn4Lm9Vb1Wc3"
    private val messageContentSample = "今晚八点老地方见，别带手机"
    private val linuxUserPathSample = "/home/alice/projects/qingyu/err.log"
    private val windowsUserPathSample = """C:\Users\bob\AppData\files\cache.db"""
    private val emailSample = "zhangsan@example.com"
    private val urlCredentialSample = "https://user:passw0rd@10.0.0.5:8080/api"

    /** 全部红线原串 */
    private val allRawSecrets: List<String>
        get() = listOf(
            apiKeySample,
            jwtSample,
            registeredTokenSample,
            messageContentSample,
            "alice",
            "bob",
            "zhangsan",
            "passw0rd",
        )

    private fun redactor() = DiagnosticsRedactor(
        knownSecrets = listOf(registeredTokenSample, messageContentSample),
    )

    /** 把红线样本注入到诊断快照的自由文本里（错误摘要、能力值、连接状态标签） */
    private fun poisonedSnapshot(): DiagnosticsSnapshot = DiagnosticsSnapshot(
        versions = VersionSection(
            appVersionName = "1.2.3",
            appVersionCode = 123,
            buildType = "release",
            releaseChannel = "stable",
            androidApiLevel = 34,
        ),
        capabilities = mapOf(
            "chat.local" to "enabled",
            "model.api" to "enabled key=$apiKeySample",
            "sync.note" to "last error at $urlCredentialSample",
        ),
        dbSchema = DbSchemaSection(cacheDbVersion = 7, localDbVersion = 3, syncEnvelopeSchemaVersion = 1),
        sync = SyncSummarySection(
            pendingOutbox = 1,
            sentEnvelopes = 42L,
            receivedEnvelopes = 17L,
            appliedRemoteChanges = 15L,
            conflicts = 0,
            lastSyncAtMs = 1_700_000_000_000L,
            counters = mapOf("ws_event_drop" to 3L),
        ),
        connection = ConnectionDiagSection(
            stateLabel = "degraded(rest=$urlCredentialSample)",
            endpointType = "TLS_SYSTEM",
            securityMode = "pairing_v2",
            serverIdHash = DiagnosticsRedactor.hashId("srv-pc-001"),
            apiVersion = 2,
            pairingProtocolVersion = 2,
            lastRttMs = 45L,
            lastConnectedAtMs = 1_700_000_000_000L,
            lastFailure = ConnectionFailureRecord(
                startedAtMs = 1_699_999_000_000L,
                endpointType = "LOCAL_CLEARTEXT",
                reasonKey = "tls",
            ),
            recentAttempts = 7,
            recentResults = listOf("connected", "failed", "connected"),
            counters = mapOf("ws_event_drop" to 3L),
        ),
        generation = GenerationDiagSection(
            started = 3L,
            completed = 2L,
            failed = 1L,
            interrupted = 0L,
            totalDurationMs = 9_000L,
            maxDurationMs = 5_000L,
            avgDurationMs = 3_000L,
            lastFailure = ErrorRecord(
                kind = "Timeout",
                summary = "生成超时，正文片段：$messageContentSample token=$registeredTokenSample",
                atMs = 1_699_999_500_000L,
            ),
            counters = mapOf("partial_failure" to 1L),
        ),
        errors = listOf(
            ErrorRecord(
                kind = "IOException",
                summary = "读取 $linuxUserPathSample 失败，凭据 $registeredTokenSample",
                atMs = 1_699_999_100_000L,
            ),
            ErrorRecord(
                kind = "Unauthorized",
                summary = "鉴权失败 header=Bearer $jwtSample api_key=$apiKeySample",
                atMs = 1_699_999_200_000L,
            ),
            ErrorRecord(
                kind = "Unknown",
                summary = "发生在 $windowsUserPathSample，联系 $emailSample，正文「$messageContentSample」",
                atMs = 1_699_999_300_000L,
            ),
        ),
    )

    private fun buildExport(redactor: DiagnosticsRedactor): Pair<String, ByteArray> {
        val document = DiagnosticsBundleBuilder.build(poisonedSnapshot(), redactor, generatedAtMs = 1_700_000_100_000L)
        val json = DiagnosticsPackager.toJson(document, redactor)
        return json to DiagnosticsPackager.toZip(json, generatedAtMs = 1_700_000_100_000L)
    }

    @Test
    fun `导出JSON里搜不到任何注入的秘密原串`() = runTest {
        val (json, _) = buildExport(redactor())
        for (secret in allRawSecrets) {
            assertFalse("导出里搜到原串「$secret」，诊断包外泄用户秘密/正文（红线）", secret in json)
            assertFalse(
                "导出里搜到转义形态的「$secret」，诊断包外泄用户秘密/正文（红线）",
                DiagnosticsLeakGuard.jsonEscape(secret) in json,
            )
        }
    }

    @Test
    fun `导出zip原始字节里搜不到任何注入的秘密原串`() = runTest {
        val (_, zip) = buildExport(redactor())
        val zipText = DiagnosticsPackager.rawTextOf(zip)
        for (secret in allRawSecrets) {
            assertFalse("诊断包 zip 字节里搜到原串「$secret」，随包外泄（红线）", secret in zipText)
        }
    }

    @Test
    fun `导出结构只含元数据与计数（无正文字段）`() = runTest {
        val (json, _) = buildExport(redactor())
        val doc = Json.decodeFromString(DiagnosticsBundleDocument.serializer(), json)
        assertEquals("诊断包格式版本被改动会导致收件方解析错位", 1, doc.formatVersion)
        assertEquals("版本信息丢失会让诊断失去基准", "1.2.3", doc.versions.appVersionName)
        assertEquals("能力清单丢失会让诊断失去基准", "enabled", doc.capabilities["chat.local"])
        assertEquals("数据库 schema 版本丢失会无法定位迁移问题", 7, doc.dbSchema.cacheDbVersion)
        assertEquals("同步摘要计数丢失会无法定位同步问题", 3L, doc.sync.counters["ws_event_drop"])
        assertEquals("连接诊断计数丢失会无法定位连接问题", 7, doc.connection?.recentAttempts)
        assertEquals("生成诊断计数丢失会无法定位生成问题", 2L, doc.generation?.completed)
        assertEquals("脱敏错误记录丢失会无法定位崩溃问题", 3, doc.errors.size)
        // 结构级红线：根与各节都不得出现正文/内容类字段
        for (forbiddenKey in listOf("\"content\"", "\"body\"", "\"message\"", "\"text\"")) {
            assertFalse("导出结构出现正文类字段 $forbiddenKey，正文可能随包外泄（红线）", forbiddenKey in json)
        }
    }

    @Test
    fun `serverId只以哈希形态入包`() = runTest {
        val (json, _) = buildExport(redactor())
        assertFalse("serverId 明文入包会暴露用户部署标识", "srv-pc-001" in json)
        val doc = Json.decodeFromString(DiagnosticsBundleDocument.serializer(), json)
        assertEquals(
            "serverId 应以单向哈希入包，否则标识泄露",
            DiagnosticsRedactor.hashId("srv-pc-001"),
            doc.connection?.serverIdHash,
        )
    }

    @Test
    fun `泄密终检能发现残留原串`() {
        val leaks = DiagnosticsLeakGuard.findKnownSecrets(
            "残留在导出里的正文：$messageContentSample",
            listOf(messageContentSample),
        )
        assertTrue("泄密终检漏报会让带密的包被导出（红线）", leaks.isNotEmpty())
        val escapedLeaks = DiagnosticsLeakGuard.findKnownSecrets(
            """{"k":"${DiagnosticsLeakGuard.jsonEscape(messageContentSample)}"}""",
            listOf(messageContentSample),
        )
        assertTrue("泄密终检必须覆盖 JSON 转义形态", escapedLeaks.isNotEmpty())
    }

    @Test
    fun `兜底抹除能把残留原串清干净`() {
        val raw = "错误摘要：正文「$messageContentSample」 token=$registeredTokenSample"
        val escaped = """{"summary":"${DiagnosticsLeakGuard.jsonEscape(raw)}"}"""
        val scrubbed = DiagnosticsLeakGuard.scrubResiduals(
            escaped,
            listOf(messageContentSample, registeredTokenSample),
        )
        assertFalse("兜底抹除后仍残留正文（红线）", messageContentSample in scrubbed)
        assertFalse("兜底抹除后仍残留 token（红线）", registeredTokenSample in scrubbed)
    }

    @Test
    fun `端到端导出成功且写出的是可解析诊断包`() = runTest {
        val sink = CapturingSink(succeed = true)
        val service = DiagnosticsExportService(
            collector = DiagnosticsCollector { poisonedSnapshot() },
            secrets = { listOf(registeredTokenSample, messageContentSample) },
            sink = sink,
            clock = { 1_700_000_100_000L },
        )
        val result = service.export()
        assertTrue("导出应成功，否则用户拿不到诊断包", result is DiagnosticsExportResult.Success)
        result as DiagnosticsExportResult.Success
        assertTrue("导出文件名应带 .zip 扩展名便于分享", result.fileName.endsWith(".zip"))
        assertEquals("落盘内容缺失会导致包损坏", 1, sink.written.size)
        val zip = sink.written.values.single()
        val json = DiagnosticsPackager.readEntry(zip, DiagnosticsPackager.DIAGNOSTICS_ENTRY)
        assertTrue("诊断包缺少 diagnostics.json", json != null)
        val doc = Json.decodeFromString(DiagnosticsBundleDocument.serializer(), json!!)
        assertEquals("端到端导出的诊断内容与快照不一致", 3, doc.errors.size)
        for (secret in allRawSecrets) {
            assertFalse("端到端导出仍残留原串「$secret」（红线）", secret in json)
        }
    }

    @Test
    fun `收集器整体失败也降级导出最小包`() = runTest {
        val sink = CapturingSink(succeed = true)
        val service = DiagnosticsExportService(
            collector = DiagnosticsCollector { throw IllegalStateException("collector boom") },
            secrets = { emptyList() },
            sink = sink,
            clock = { 1_700_000_100_000L },
        )
        val result = service.export()
        assertTrue("收集失败也必须能导出，否则故障时无诊断可交", result is DiagnosticsExportResult.Success)
        val json = DiagnosticsPackager.readEntry(
            sink.written.values.single(),
            DiagnosticsPackager.DIAGNOSTICS_ENTRY,
        )!!
        assertTrue("降级包应记录收集失败这条脱敏错误", "collector" in json)
    }

    @Test
    fun `写盘失败返回稳定原因而不是抛错`() = runTest {
        val service = DiagnosticsExportService(
            collector = DiagnosticsCollector { poisonedSnapshot() },
            secrets = { emptyList() },
            sink = CapturingSink(succeed = false),
            clock = { 1_700_000_100_000L },
        )
        val result = service.export()
        assertTrue("写盘失败应降级为稳定结果，不能把异常抛给 UI", result is DiagnosticsExportResult.Failure)
        assertEquals(
            "失败原因键被改动会让 UI 无法映射提示文案",
            "write_failed",
            (result as DiagnosticsExportResult.Failure).reason,
        )
    }

    private class CapturingSink(private val succeed: Boolean) : DiagnosticsExportSink {
        val written = LinkedHashMap<String, ByteArray>()
        override fun write(fileName: String, bytes: ByteArray): Boolean {
            if (!succeed) return false
            written[fileName] = bytes
            return true
        }
    }
}
