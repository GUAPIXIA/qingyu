package com.qingyu.companion.diagnostics

import kotlinx.coroutines.CancellationException

/**
 * S6-07 诊断收集（P2 同口径：diagnostics.connection / diagnostics.generation 以元数据与计数为主）。
 * 收集层只产出 [DiagnosticsSnapshot]；脱敏与打包在 [DiagnosticsBundleBuilder] / [DiagnosticsPackager]。
 */

/** 诊断收集器：各数据源实现此接口供导出服务调用（AppContainer 装配） */
fun interface DiagnosticsCollector {
    suspend fun collect(): DiagnosticsSnapshot
}

/** 版本信息源（AppContainer 传入 BuildConfig / 系统版本投影） */
fun interface DiagnosticsVersionSource {
    fun versionSection(): VersionSection
}

/** 数据库 schema 版本源（CacheDatabase / QingyuLocalDatabase / LocalEnvelope 的版本常量） */
fun interface DiagnosticsSchemaSource {
    fun schemaSection(): DbSchemaSection
}

/** 同步摘要源（outbox / envelope 计数投影） */
fun interface DiagnosticsSyncSource {
    fun syncSection(): SyncSummarySection
}

/**
 * 逐项注入的收集器：每个数据源单独降级——
 * 任一源抛错只在 errors 里留一条脱敏记录，导出不中断（诊断包必须能在异常状态下产出）。
 */
class SnapshotDiagnosticsCollector(
    private val versions: DiagnosticsVersionSource,
    private val dbSchema: DiagnosticsSchemaSource,
    private val sync: DiagnosticsSyncSource,
    private val capabilities: () -> Map<String, String> = { emptyMap() },
    private val connection: (suspend () -> ConnectionDiagSection?)? = null,
    private val generation: () -> GenerationDiagSection? = { null },
    private val clock: () -> Long = System::currentTimeMillis,
) : DiagnosticsCollector {

    override suspend fun collect(): DiagnosticsSnapshot {
        val errors = mutableListOf<ErrorRecord>()
        val versionsSection = guard(errors, "versions") { versions.versionSection() }
            ?: VersionSection()
        val schemaSection = guard(errors, "dbSchema") { dbSchema.schemaSection() }
            ?: DbSchemaSection(0, 0, 0)
        val syncSection = guard(errors, "sync") { sync.syncSection() }
            ?: SyncSummarySection()
        val capabilitiesMap = guard(errors, "capabilities") { capabilities() }
            ?: emptyMap()
        val connectionSource = connection
        val connectionSection = if (connectionSource != null) {
            guardSuspend(errors, "connection") { connectionSource() }
        } else {
            null
        }
        val generationSection = guard(errors, "generation") { generation() }
        return DiagnosticsSnapshot(
            versions = versionsSection,
            capabilities = capabilitiesMap,
            dbSchema = schemaSection,
            sync = syncSection,
            connection = connectionSection,
            generation = generationSection,
            errors = errors,
        )
    }

    private fun <T> guard(errors: MutableList<ErrorRecord>, kind: String, block: () -> T): T? =
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            errors += ErrorRecord(kind = kind, summary = "${e::class.java.name}: ${e.message ?: ""}", atMs = clock())
            null
        }

    private suspend fun <T> guardSuspend(errors: MutableList<ErrorRecord>, kind: String, block: suspend () -> T): T? =
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            errors += ErrorRecord(kind = kind, summary = "${e::class.java.name}: ${e.message ?: ""}", atMs = clock())
            null
        }
}

