package com.qingyu.companion.diagnostics

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import kotlinx.serialization.json.Json

/**
 * S6-07 诊断导出包的构建与打包（纯 JVM：JSON + zip，JVM 可测）。
 *
 * 保证：
 * - 每个字符串叶子先经 [DiagnosticsRedactor] 字段级脱敏再编码；
 * - 编码后再做一次残留兜底抹除（[DiagnosticsLeakGuard.scrubResiduals]）；
 * - zip 只含 `diagnostics.json` 与 `manifest.json`（条目清单 + 内容哈希），别无其它。
 */
object DiagnosticsBundleBuilder {

    /** 快照 → 脱敏导出文档（结构级排除正文：模型里就没有正文字段） */
    fun build(snapshot: DiagnosticsSnapshot, redactor: DiagnosticsRedactor, generatedAtMs: Long): DiagnosticsBundleDocument =
        DiagnosticsBundleDocument(
            generatedAtMs = generatedAtMs,
            versions = snapshot.versions.copy(
                appVersionName = redactor.redact(snapshot.versions.appVersionName),
                buildType = redactor.redact(snapshot.versions.buildType),
                releaseChannel = redactor.redact(snapshot.versions.releaseChannel),
            ),
            capabilities = redactor.redactMap(snapshot.capabilities),
            dbSchema = snapshot.dbSchema,
            sync = snapshot.sync.copy(counters = redactor.redactCounters(snapshot.sync.counters)),
            connection = snapshot.connection?.let { redactConnection(it, redactor) },
            generation = snapshot.generation?.let { redactGeneration(it, redactor) },
            errors = snapshot.errors.map {
                ErrorRecord(
                    kind = redactor.redact(it.kind),
                    summary = redactor.redact(it.summary),
                    atMs = it.atMs,
                    count = it.count,
                )
            },
        )

    private fun redactConnection(section: ConnectionDiagSection, redactor: DiagnosticsRedactor): ConnectionDiagSection =
        section.copy(
            stateLabel = redactor.redact(section.stateLabel),
            endpointType = section.endpointType?.let(redactor::redact),
            securityMode = section.securityMode?.let(redactor::redact),
            lastFailure = section.lastFailure?.let {
                it.copy(
                    endpointType = redactor.redact(it.endpointType),
                    reasonKey = redactor.redact(it.reasonKey),
                )
            },
            recentResults = section.recentResults.map(redactor::redact),
            counters = redactor.redactCounters(section.counters),
        )

    private fun redactGeneration(section: GenerationDiagSection, redactor: DiagnosticsRedactor): GenerationDiagSection =
        section.copy(
            lastFailure = section.lastFailure?.let {
                ErrorRecord(
                    kind = redactor.redact(it.kind),
                    summary = redactor.redact(it.summary),
                    atMs = it.atMs,
                    count = it.count,
                )
            },
            counters = redactor.redactCounters(section.counters),
        )
}

/** 诊断包打包器：JSON 编码 + zip 封装（纯 JVM） */
object DiagnosticsPackager {

    const val DIAGNOSTICS_ENTRY: String = "diagnostics.json"
    const val MANIFEST_ENTRY: String = "manifest.json"

    private val json = Json {
        prettyPrint = true
        encodeDefaults = true
    }

    /** 文档 → JSON 文本（字段级脱敏后的最后兜底抹除也在此收口） */
    fun toJson(document: DiagnosticsBundleDocument, redactor: DiagnosticsRedactor): String {
        val encoded = json.encodeToString(DiagnosticsBundleDocument.serializer(), document)
        return DiagnosticsLeakGuard.scrubResiduals(encoded, redactor.knownSecrets)
    }

    /** JSON 文本 → 诊断包 zip（diagnostics.json + manifest.json） */
    fun toZip(diagnosticsJson: String, generatedAtMs: Long): ByteArray {
        val manifestJson = buildManifest(diagnosticsJson, generatedAtMs)
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            zip.putNextEntry(ZipEntry(DIAGNOSTICS_ENTRY))
            zip.write(diagnosticsJson.toByteArray(Charsets.UTF_8))
            zip.closeEntry()
            zip.putNextEntry(ZipEntry(MANIFEST_ENTRY))
            zip.write(manifestJson.toByteArray(Charsets.UTF_8))
            zip.closeEntry()
        }
        return out.toByteArray()
    }

    /** 读取 zip 内条目文本（测试回读断言用） */
    fun readEntry(zipBytes: ByteArray, entryName: String): String? {
        ZipInputStream(ByteArrayInputStream(zipBytes)).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: return null
                if (entry.name == entryName) {
                    return zip.readBytes().toString(Charsets.UTF_8)
                }
            }
        }
    }

    /** zip 全部字节按 UTF-8 松散解读（泄密扫描用：字符串常量在 deflate 后仍以原样出现的场景） */
    fun rawTextOf(zipBytes: ByteArray): String = zipBytes.toString(Charsets.UTF_8)

    /** manifest：条目清单 + SHA-256（对已脱敏内容的哈希，非敏感） */
    private fun buildManifest(diagnosticsJson: String, generatedAtMs: Long): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
            .digest(diagnosticsJson.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return buildString {
            append("{\n")
            append("  \"formatVersion\": $DIAGNOSTICS_FORMAT_VERSION,\n")
            append("  \"generatedAtMs\": $generatedAtMs,\n")
            append("  \"entries\": [\n")
            append("    { \"name\": \"$DIAGNOSTICS_ENTRY\", \"sha256\": \"$digest\" }\n")
            append("  ]\n")
            append("}")
        }
    }
}
