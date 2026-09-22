package com.qingyu.companion.diagnostics

import kotlinx.serialization.Serializable

/**
 * S6-07 诊断导出包的数据模型（纯 Kotlin，JVM 可测）。
 *
 * 红线（阶段 6 实施方案 §S6-07）：诊断包**不含正文和秘密**——
 * - 模型结构上不存在消息正文 / 角色内容字段（结构级排除）；
 * - 自由文本（错误信息等）一律经 [DiagnosticsRedactor] 脱敏后才可入包；
 * - 允许出现的只有版本、能力、数据库 schema 版本、同步摘要（计数为主）、
 *   连接/生成诊断（元数据与计数）与脱敏错误。
 */

/** 诊断包格式版本（导出结构变更时 +1） */
const val DIAGNOSTICS_FORMAT_VERSION: Int = 1

/** 客户端版本与构建信息 */
@Serializable
data class VersionSection(
    val appVersionName: String = "",
    val appVersionCode: Int = 0,
    val buildType: String = "",
    val releaseChannel: String = "",
    /** Android SDK int（如 34）；仅系统版本元数据，不含设备指纹 */
    val androidApiLevel: Int? = null,
)

/** 数据库 / 契约 schema 版本（迁移排障用，只有整数） */
@Serializable
data class DbSchemaSection(
    /** 缓存库（CacheDatabase）Room 版本 */
    val cacheDbVersion: Int,
    /** 本地独立库（QingyuLocalDatabase）Room 版本 */
    val localDbVersion: Int,
    /** 同步 envelope 的 payload schema 版本 */
    val syncEnvelopeSchemaVersion: Int,
)

/** 同步摘要：只含计数与时间戳，不含任何同步内容 */
@Serializable
data class SyncSummarySection(
    val pendingOutbox: Int = 0,
    val sentEnvelopes: Long = 0L,
    val receivedEnvelopes: Long = 0L,
    val appliedRemoteChanges: Long = 0L,
    val conflicts: Int = 0,
    val lastSyncAtMs: Long? = null,
    /** 固定枚举键名 → 次数（如 ws_event_drop）；键名与值均为元数据 */
    val counters: Map<String, Long> = emptyMap(),
)

/** 连接诊断（P2，diagnostics.connection）：元数据与计数，无明文 host / token */
@Serializable
data class ConnectionDiagSection(
    val stateLabel: String = "",
    val endpointType: String? = null,
    val securityMode: String? = null,
    /** serverId 的单向哈希前缀（12 hex），不落明文 */
    val serverIdHash: String? = null,
    val apiVersion: Int? = null,
    val pairingProtocolVersion: Int? = null,
    val lastRttMs: Long? = null,
    val lastConnectedAtMs: Long? = null,
    val lastFailure: ConnectionFailureRecord? = null,
    val recentAttempts: Int = 0,
    val recentResults: List<String> = emptyList(),
    val counters: Map<String, Long> = emptyMap(),
)

@Serializable
data class ConnectionFailureRecord(
    val startedAtMs: Long,
    val endpointType: String,
    /** 稳定失败原因键（如 tls / timeout），非原始异常文本 */
    val reasonKey: String,
)

/** 生成诊断（P2，diagnostics.generation）：计数与时长统计，无生成内容 */
@Serializable
data class GenerationDiagSection(
    val started: Long = 0L,
    val completed: Long = 0L,
    val failed: Long = 0L,
    val interrupted: Long = 0L,
    val totalDurationMs: Long = 0L,
    val maxDurationMs: Long = 0L,
    val avgDurationMs: Long? = null,
    val lastFailure: ErrorRecord? = null,
    val counters: Map<String, Long> = emptyMap(),
)

/**
 * 脱敏错误记录：只有稳定类型名 + 经 [DiagnosticsRedactor] 清洗的摘要文本。
 * 禁止塞入消息正文；收集方若接触过用户内容，必须把它注册进 [DiagnosticsRedactor] 的
 * knownSecrets，保证导出前被抹掉。
 */
@Serializable
data class ErrorRecord(
    /** 稳定类型键（如 CompanionError 类名 / IOException） */
    val kind: String,
    /** 已脱敏的错误摘要（截断、抹秘密） */
    val summary: String,
    val atMs: Long,
    val count: Int = 1,
)

/** 收集完成、尚未脱敏的诊断快照（允许携带待脱敏自由文本） */
data class DiagnosticsSnapshot(
    val versions: VersionSection,
    val capabilities: Map<String, String> = emptyMap(),
    val dbSchema: DbSchemaSection,
    val sync: SyncSummarySection = SyncSummarySection(),
    val connection: ConnectionDiagSection? = null,
    val generation: GenerationDiagSection? = null,
    val errors: List<ErrorRecord> = emptyList(),
)

/** 脱敏后的导出文档（诊断包 diagnostics.json 的根结构） */
@Serializable
data class DiagnosticsBundleDocument(
    val formatVersion: Int = DIAGNOSTICS_FORMAT_VERSION,
    val generatedAtMs: Long,
    val versions: VersionSection,
    val capabilities: Map<String, String>,
    val dbSchema: DbSchemaSection,
    val sync: SyncSummarySection,
    val connection: ConnectionDiagSection? = null,
    val generation: GenerationDiagSection? = null,
    val errors: List<ErrorRecord> = emptyList(),
)
