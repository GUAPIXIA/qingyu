package com.qingyu.companion.diagnostics

import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-07 诊断包打包单测：zip 结构（diagnostics.json + manifest.json）、
 * manifest 内容哈希对账、JSON 往返不丢结构。
 */
class DiagnosticsPackagerTest {

    private fun sampleDocument() = DiagnosticsBundleDocument(
        generatedAtMs = 1_700_000_100_000L,
        versions = VersionSection("1.2.3", 123, "release", "stable", 34),
        capabilities = mapOf("chat.local" to "enabled"),
        dbSchema = DbSchemaSection(7, 3, 1),
        sync = SyncSummarySection(sentEnvelopes = 42L, receivedEnvelopes = 17L, counters = mapOf("ws_event_drop" to 3L)),
        connection = ConnectionDiagSection(stateLabel = "idle", recentAttempts = 7),
        generation = GenerationDiagSection(started = 3L, completed = 2L),
        errors = listOf(ErrorRecord("IOException", "***", 1_699_999_100_000L)),
    )

    @Test
    fun `诊断包含diagnostics与manifest两个条目`() {
        val redactor = DiagnosticsRedactor()
        val json = DiagnosticsPackager.toJson(sampleDocument(), redactor)
        val zip = DiagnosticsPackager.toZip(json, generatedAtMs = 1_700_000_100_000L)
        assertEquals(
            "diagnostics.json 条目内容与编码结果不一致，收件方会拿到坏数据",
            json,
            DiagnosticsPackager.readEntry(zip, DiagnosticsPackager.DIAGNOSTICS_ENTRY),
        )
        assertNotNull("诊断包缺少 manifest.json，收件方无法对账", DiagnosticsPackager.readEntry(zip, DiagnosticsPackager.MANIFEST_ENTRY))
        assertNull("不存在的条目应返回 null", DiagnosticsPackager.readEntry(zip, "not-exist.json"))
    }

    @Test
    fun `manifest里的sha256与diagnostics内容对得上`() {
        val redactor = DiagnosticsRedactor()
        val json = DiagnosticsPackager.toJson(sampleDocument(), redactor)
        val zip = DiagnosticsPackager.toZip(json, generatedAtMs = 1_700_000_100_000L)
        val manifest = DiagnosticsPackager.readEntry(zip, DiagnosticsPackager.MANIFEST_ENTRY)!!
        val expected = MessageDigest.getInstance("SHA-256")
            .digest(json.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        assertTrue("manifest 的内容哈希对不上，收件方会误判包被篡改", expected in manifest)
        assertTrue("manifest 应标注 diagnostics.json 条目名", DiagnosticsPackager.DIAGNOSTICS_ENTRY in manifest)
    }

    @Test
    fun `JSON往返不丢结构`() {
        val redactor = DiagnosticsRedactor()
        val document = sampleDocument()
        val json = DiagnosticsPackager.toJson(document, redactor)
        val decoded = Json.decodeFromString(DiagnosticsBundleDocument.serializer(), json)
        assertEquals("JSON 往返后版本字段丢失", document.versions, decoded.versions)
        assertEquals("JSON 往返后 schema 字段丢失", document.dbSchema, decoded.dbSchema)
        assertEquals("JSON 往返后同步摘要丢失", document.sync, decoded.sync)
        assertEquals("JSON 往返后连接诊断丢失", document.connection, decoded.connection)
        assertEquals("JSON 往返后生成诊断丢失", document.generation, decoded.generation)
        assertEquals("JSON 往返后错误记录丢失", document.errors, decoded.errors)
    }

    @Test
    fun `最小快照（无连接无生成无错误）也能打包`() {
        val redactor = DiagnosticsRedactor()
        val document = DiagnosticsBundleDocument(
            generatedAtMs = 1L,
            versions = VersionSection(),
            capabilities = emptyMap(),
            dbSchema = DbSchemaSection(0, 0, 0),
            sync = SyncSummarySection(),
        )
        val json = DiagnosticsPackager.toJson(document, redactor)
        val zip = DiagnosticsPackager.toZip(json, generatedAtMs = 1L)
        val decoded = Json.decodeFromString(
            DiagnosticsBundleDocument.serializer(),
            DiagnosticsPackager.readEntry(zip, DiagnosticsPackager.DIAGNOSTICS_ENTRY)!!,
        )
        assertNull("最小快照不应凭空造出连接诊断", decoded.connection)
        assertNull("最小快照不应凭空造出生成诊断", decoded.generation)
        assertTrue("最小快照不应凭空造出错误", decoded.errors.isEmpty())
        assertFalse("最小快照不该带正文类字段", "\"content\"" in json)
    }
}
