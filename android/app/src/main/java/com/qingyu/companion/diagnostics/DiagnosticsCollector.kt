package com.qingyu.companion.diagnostics

import com.qingyu.companion.network.connection.ConnectionDiagnostics
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

/**
 * 连接诊断投影（P2，diagnostics.connection）：ConnectionDiagnostics → 只含元数据与计数。
 * serverId 只以单向哈希入包（[DiagnosticsRedactor.hashId]），不落明文 host/标识。
 */
fun ConnectionDiagnostics.toConnectionDiagSection(): ConnectionDiagSection =
    ConnectionDiagSection(
        stateLabel = stateLabel,
        endpointType = endpointType,
        securityMode = securityMode,
        serverIdHash = serverId?.let { DiagnosticsRedactor.hashId(it) },
        apiVersion = apiVersion,
        pairingProtocolVersion = pairingProtocolVersion,
        lastRttMs = lastRttMs,
        lastConnectedAtMs = lastConnectedAt,
        lastFailure = lastFailure?.let {
            ConnectionFailureRecord(
                startedAtMs = it.startedAt,
                endpointType = it.endpointType,
                reasonKey = it.reason,
            )
        },
        recentAttempts = recentAttempts,
        recentResults = recentResults,
        counters = counters,
    )

/**
 * 生成诊断记录器（P2，diagnostics.generation）：只记次数、时长与一条脱敏前错误摘要，
 * 不记任何生成内容（提示词 / 回复 / 角色名都不进诊断）。
 * 纯逻辑，JVM 可测；由 ChatViewModel / GroupChatViewModel 的生成事件接线。
 */
class GenerationDiagnosticsRecorder {
    private var started: Long = 0L
    private var completed: Long = 0L
    private var failed: Long = 0L
    private var interrupted: Long = 0L
    private var totalDurationMs: Long = 0L
    private var maxDurationMs: Long = 0L
    private var lastFailure: ErrorRecord? = null
    private val counters = LinkedHashMap<String, Long>()
    private val openStarts = HashMap<String, Long>()

    /** 开始生成（sessionId 仅作关联键，不入诊断包） */
    fun onStarted(sessionId: String, atMs: Long) {
        started += 1
        openStarts[sessionId] = atMs
    }

    /** 正常完成 */
    fun onCompleted(sessionId: String, atMs: Long) {
        completed += 1
        closeSession(sessionId, atMs)
    }

    /** 生成失败（错误摘要脱敏在打包阶段完成） */
    fun onFailed(sessionId: String, atMs: Long, errorKind: String, errorSummary: String) {
        failed += 1
        closeSession(sessionId, atMs)
        lastFailure = ErrorRecord(kind = errorKind, summary = errorSummary, atMs = atMs)
    }

    /** 用户中断 / 取消 */
    fun onInterrupted(sessionId: String, atMs: Long) {
        interrupted += 1
        closeSession(sessionId, atMs)
    }

    /** 固定枚举计数器（如 partial_failure） */
    fun increment(key: String) {
        counters[key] = (counters[key] ?: 0L) + 1L
    }

    fun snapshot(): GenerationDiagSection {
        val finished = completed + failed + interrupted
        return GenerationDiagSection(
            started = started,
            completed = completed,
            failed = failed,
            interrupted = interrupted,
            totalDurationMs = totalDurationMs,
            maxDurationMs = maxDurationMs,
            avgDurationMs = if (finished > 0) totalDurationMs / finished else null,
            lastFailure = lastFailure,
            counters = counters.toMap(),
        )
    }

    private fun closeSession(sessionId: String, atMs: Long) {
        val start = openStarts.remove(sessionId) ?: return
        val duration = (atMs - start).coerceAtLeast(0L)
        totalDurationMs += duration
        if (duration > maxDurationMs) maxDurationMs = duration
    }
}
