package com.qingyu.companion.diagnostics

import kotlinx.coroutines.CancellationException

/**
 * S6-07 诊断导出服务（纯逻辑 + 落盘抽象，JVM 可测）。
 * 流程：收集 → 脱敏构建 → JSON → zip 打包 → 泄密终检 → 写出。
 * 红线终检：成品 zip 字节里搜到任何已知秘密原串即判导出失败，绝不写出带密的包。
 */

/** 导出落盘抽象（真机接 SAF / 应用缓存目录；测试用内存实现） */
fun interface DiagnosticsExportSink {
    /** 写出文件；返回是否成功 */
    fun write(fileName: String, bytes: ByteArray): Boolean
}

/** java.io.File 落盘实现（应用私有目录；JVM 可测） */
class FileDiagnosticsExportSink(private val dir: java.io.File) : DiagnosticsExportSink {
    override fun write(fileName: String, bytes: ByteArray): Boolean = try {
        dir.mkdirs()
        java.io.File(dir, fileName).writeBytes(bytes)
        true
    } catch (e: Exception) {
        false
    }
}

sealed interface DiagnosticsExportResult {
    /** 导出成功（sha256 为 zip 内容哈希，便于收件方对账） */
    data class Success(val fileName: String, val sha256: String, val entryCount: Int) : DiagnosticsExportResult

    /** 导出失败（写盘失败 / 泄密终检未过）；reason 为稳定原因键 */
    data class Failure(val reason: String) : DiagnosticsExportResult
}

class DiagnosticsExportService(
    private val collector: DiagnosticsCollector,
    /** 已知秘密注册（token / API Key / 消息正文等）：导出前必须全部抹净 */
    private val secrets: () -> List<String>,
    private val sink: DiagnosticsExportSink,
    private val clock: () -> Long = System::currentTimeMillis,
) {

    /**
     * 导出诊断包。
     * 收集器整体失败也降级为「最小包」（版本为空壳 + 脱敏错误记录），保证诊断永远可导出。
     */
    suspend fun export(): DiagnosticsExportResult {
        val nowMs = clock()
        val knownSecrets = try {
            secrets()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyList()
        }
        val redactor = DiagnosticsRedactor(knownSecrets)
        val snapshot = try {
            collector.collect()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            DiagnosticsSnapshot(
                versions = VersionSection(),
                dbSchema = DbSchemaSection(0, 0, 0),
                errors = listOf(
                    ErrorRecord(kind = "collector", summary = "${e::class.java.name}: ${e.message ?: ""}", atMs = nowMs),
                ),
            )
        }
        val document = DiagnosticsBundleBuilder.build(snapshot, redactor, nowMs)
        val json = DiagnosticsPackager.toJson(document, redactor)

        // 泄密终检（第一道）：JSON 文本里不得再出现任何已知秘密原串（含转义形态）；
        // 不过检就不打包、不落盘——宁可导出失败，不产出带密的诊断包。
        if (DiagnosticsLeakGuard.findKnownSecrets(json, knownSecrets).isNotEmpty()) {
            return DiagnosticsExportResult.Failure("leak_detected")
        }
        val zip = DiagnosticsPackager.toZip(json, nowMs)

        // 泄密终检（第二道）：zip 原始字节（UTF-8 宽松解读）复核
        val zipText = DiagnosticsPackager.rawTextOf(zip)
        if (DiagnosticsLeakGuard.findKnownSecrets(zipText, knownSecrets).isNotEmpty()) {
            return DiagnosticsExportResult.Failure("leak_detected")
        }

        val fileName = fileNameFor(nowMs)
        if (!sink.write(fileName, zip)) {
            return DiagnosticsExportResult.Failure("write_failed")
        }
        return DiagnosticsExportResult.Success(
            fileName = fileName,
            sha256 = sha256Of(zip),
            entryCount = 2,
        )
    }

    private fun fileNameFor(nowMs: Long): String {
        val fmt = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US)
        return "qingyu-diagnostics-${fmt.format(java.util.Date(nowMs))}.zip"
    }

    private fun sha256Of(bytes: ByteArray): String =
        java.security.MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }
}
