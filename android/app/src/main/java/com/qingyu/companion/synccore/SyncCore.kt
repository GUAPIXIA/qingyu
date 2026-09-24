package com.qingyu.companion.synccore

import com.qingyu.companion.domain.contracts.CanonicalJson
import com.qingyu.companion.local.domain.MigrationIdentity
import com.qingyu.companion.local.domain.sha256Hex

/**
 * 阶段 7 S7-01：Sync Core 纯逻辑（Kotlin 侧）。
 *
 * 与 `shared/sync-core/`（TS）逐语义对齐；同一 golden（
 * `shared/fixtures/cross-platform/sync-core/`）驱动。
 * **禁止**访问网络、磁盘、时钟和随机数——全部经输入传入。
 */
object SyncCore {

    // ---------------------------------------------------------------- 批次相位与排序

    /** 父实体 → 子实体 → 引用更新 → tombstone */
    fun batchPhaseOf(
        deleted: Boolean,
        parentId: String?,
        references: List<String>?,
    ): Int = when {
        deleted -> 3
        parentId != null -> 1
        !references.isNullOrEmpty() -> 2
        else -> 0
    }

    data class BatchItem(
        val phase: Int,
        val entityType: String,
        val entityId: String,
        val parentId: String?,
        val contentHash: String,
        val version: Map<String, String>,
        val deleted: Boolean,
        val schemaVersion: Int,
    )

    fun sortBatch(items: List<BatchItem>): List<BatchItem> =
        items.sortedWith(
            compareBy(
                { it.phase },
                // phase 1：先按 parentId 分组
                { if (it.phase == 1) it.parentId ?: "" else "" },
                { it.entityType },
                { it.entityId },
            ),
        )

    fun batchHash(ordered: List<BatchItem>): String {
        val body = ordered.map {
            mapOf(
                "entityType" to it.entityType,
                "entityId" to it.entityId,
                "contentHash" to it.contentHash,
                "version" to it.version,
                "deleted" to it.deleted,
                "schemaVersion" to it.schemaVersion.toLong(),
            )
        }
        return "sha256:" + sha256Hex(CanonicalJson.encode(body))
    }

    fun receiptHash(
        batchHash: String,
        localKnown: Map<String, String>,
        remoteKnown: Map<String, String>,
        protocolVersion: Int,
    ): String = MigrationIdentity.contentHash(
        mapOf(
            "batchHash" to batchHash,
            "localKnown" to localKnown,
            "remoteKnown" to remoteKnown,
            "protocolVersion" to protocolVersion.toLong(),
        ),
    )

    fun idempotentKey(sessionId: String, batchId: String): String = "$sessionId:$batchId"

    fun splitBatches(
        ordered: List<BatchItem>,
        maxCount: Int = 500,
        maxBytes: Int = 4 * 1024 * 1024,
        sizeOf: (BatchItem) -> Int = { 256 },
    ): List<List<BatchItem>> {
        val batches = mutableListOf<List<BatchItem>>()
        var current = mutableListOf<BatchItem>()
        var bytes = 0
        for (item in ordered) {
            val size = sizeOf(item)
            if (current.isNotEmpty() && (current.size >= maxCount || bytes + size > maxBytes)) {
                batches += current
                current = mutableListOf()
                bytes = 0
            }
            current += item
            bytes += size
        }
        if (current.isNotEmpty()) batches += current
        return batches
    }

    // ---------------------------------------------------------------- 状态机

    data class SessionResult(val next: String, val ok: Boolean, val reason: String? = null)

    private val TRANSITIONS: Map<String, Map<String, String>> = mapOf(
        "idle" to mapOf("start_scan" to "scanning", "fail_non_retryable" to "failed"),
        "scanning" to mapOf(
            "plan_ready" to "plan_ready",
            "cancel" to "cancelling",
            "fail_retryable" to "failed",
            "fail_non_retryable" to "failed",
        ),
        "plan_ready" to mapOf(
            "await_confirmation" to "awaiting_confirmation",
            "cancel" to "cancelling",
            "fail_retryable" to "failed",
            "fail_non_retryable" to "failed",
        ),
        "awaiting_confirmation" to mapOf(
            "user_confirm" to "transferring",
            "cancel" to "cancelling",
            "fail_retryable" to "failed",
            "fail_non_retryable" to "failed",
        ),
        "transferring" to mapOf(
            "validate" to "validating",
            "cancel" to "cancelling",
            "fail_retryable" to "failed",
            "fail_non_retryable" to "failed",
        ),
        "validating" to mapOf(
            "prepare" to "prepared",
            "cancel" to "cancelling",
            "fail_retryable" to "failed",
            "fail_non_retryable" to "failed",
        ),
        "prepared" to mapOf(
            "commit" to "committing",
            "cancel" to "cancelling",
            "fail_retryable" to "failed",
            "fail_non_retryable" to "failed",
        ),
        "committing" to mapOf(
            "apply_local" to "applying_local",
            "fail_retryable" to "failed",
            "fail_non_retryable" to "failed",
        ),
        "applying_local" to mapOf(
            "mark_completed" to "completed",
            "fail_retryable" to "failed",
            "fail_non_retryable" to "failed",
        ),
        "committed" to mapOf(
            "apply_local" to "applying_local",
            "mark_completed" to "completed",
            "fail_retryable" to "failed",
            "fail_non_retryable" to "failed",
        ),
        "completed" to emptyMap(),
        "cancelling" to mapOf("cancel_done" to "cancelled", "fail_non_retryable" to "failed"),
        "cancelled" to emptyMap(),
        "failed" to mapOf("start_scan" to "scanning"),
    )

    fun transitionSession(from: String, event: String): SessionResult {
        val next = TRANSITIONS[from]?.get(event)
            ?: return SessionResult(
                next = from,
                ok = false,
                reason = if (from == "completed" || from == "cancelled") "TERMINAL_LOCKED" else "INVALID_TRANSITION",
            )
        return SessionResult(next = next, ok = true)
    }

    fun isTerminalSession(state: String): Boolean = state == "completed" || state == "cancelled"

    fun isReadOnlyPhase(state: String): Boolean = state == "scanning" || state == "plan_ready"

    // ---------------------------------------------------------------- 冲突建议

    fun suggestConflictResolution(kind: String): String = when (kind) {
        "delete_vs_modify" -> "confirm_delete_vs_modify"
        "dependency" -> "resolve_dependency"
        else -> "manual_merge"
    }

    fun canBatchResolve(kinds: List<String>): Boolean =
        kinds.isNotEmpty() && kinds.all { it == "version_concurrent" }

    // ---------------------------------------------------------------- tombstone

    data class Tombstone(
        val entityType: String,
        val entityId: String,
        val deletedAt: Long,
        val version: Map<String, String>,
    )

    data class DeviceAck(val deviceId: String, val known: Map<String, String>, val retired: Boolean)

    data class TombstoneVerdict(
        val compactible: Boolean,
        val reason: String,
        val pendingDevices: List<String>,
        val ageDays: Int,
    )

    /**
     * 与 TS `canCompactTombstone` 同语义：
     * known 需对 tombstone.version dominates 或 equal（逐分量 >=）。
     * 注意：TS 的 compareVectors(d.known, tombstone.version) 为 dominates/equal 即视为已确认。
     */
    fun canCompactTombstone(
        tombstone: Tombstone,
        devices: List<DeviceAck>,
        retainDays: Int,
        now: Long,
    ): TombstoneVerdict {
        val ageDays = ((now - tombstone.deletedAt) / 86_400_000L).toInt()
        val active = devices.filter { !it.retired }
        val pendingDevices = active.filter { d ->
            // 未确认：known 不支配且不等于 tombstone.version
            !(dominatesOrEqual(d.known, tombstone.version))
        }.map { it.deviceId }

        if (pendingDevices.isNotEmpty()) {
            return TombstoneVerdict(false, "BLOCKED_ACK_INCOMPLETE", pendingDevices, ageDays)
        }
        if (ageDays < retainDays && active.isNotEmpty()) {
            return TombstoneVerdict(false, "BLOCKED_RETAIN_WINDOW", emptyList(), ageDays)
        }
        if (active.isEmpty() && devices.any { it.retired }) {
            return TombstoneVerdict(true, "OK_ALL_DEVICES_RETIRED", emptyList(), ageDays)
        }
        return TombstoneVerdict(true, "OK_ALL_ACKED", emptyList(), ageDays)
    }

    /** [a] 对 [b] 是否 dominates 或 equal（逐设备分量 a >= b，且 a 覆盖 b 的全部键） */
    fun dominatesOrEqual(a: Map<String, String>, b: Map<String, String>): Boolean {
        for ((device, counter) in b) {
            val bound = a[device] ?: return false
            if (compareCounter(bound, counter) < 0) return false
        }
        // a 可以有多余键（dominates）
        return true
    }

    fun compareCounter(left: String, right: String): Int {
        if (left.length != right.length) return if (left.length > right.length) 1 else -1
        return left.compareTo(right)
    }

    // ---------------------------------------------------------------- capability

    data class Capabilities(
        val protocolVersion: Int,
        val features: List<String>,
        val schemaVersions: Map<String, Int>,
    )

    data class Negotiated(
        val protocolVersion: Int,
        val features: List<String>,
        val schemaVersions: Map<String, Int>,
        val unsupportedEntityTypes: List<String>,
    )

    fun negotiateCapabilities(local: Capabilities, remote: Capabilities): Negotiated {
        val protocolVersion = minOf(local.protocolVersion, remote.protocolVersion)
        val localFeatures = local.features.toSet()
        val features = remote.features.filter { it in localFeatures }.sorted()
        val schemaVersions = linkedMapOf<String, Int>()
        val unsupported = mutableListOf<String>()
        val allTypes = (local.schemaVersions.keys + remote.schemaVersions.keys).sorted()
        for (t in allTypes) {
            val lv = local.schemaVersions[t]
            val rv = remote.schemaVersions[t]
            if (lv == null || rv == null) {
                unsupported += t
                continue
            }
            schemaVersions[t] = minOf(lv, rv)
        }
        return Negotiated(protocolVersion, features, schemaVersions, unsupported)
    }

    // ---------------------------------------------------------------- plan

    data class HeadSummary(
        val entityType: String,
        val entityId: String,
        val version: Map<String, String>,
        val contentHash: String,
        val deleted: Boolean,
        val parentId: String?,
        val schemaVersion: Int,
        val updatedAt: Long,
    )

    data class PlanItem(
        val entityType: String,
        val entityId: String,
        val bucket: String,
        val conflictKind: String? = null,
        val unknownSchemaReason: String? = null,
    )

    data class PlanStats(
        val uploadCount: Int,
        val downloadCount: Int,
        val sameCount: Int,
        val conflictCount: Int,
        val unknownSchemaCount: Int,
    )

    /**
     * 与 TS `buildSyncPlan` 同分类规则（只输出 bucket，不含体积估计——体积由调用方注入）。
     */
    fun buildPlanBuckets(
        localHeads: List<HeadSummary>,
        remoteHeads: List<HeadSummary>,
        schemaVersions: Map<String, Int>,
        unsupportedEntityTypes: Set<String>,
    ): Pair<List<PlanItem>, PlanStats> {
        val localById = localHeads.associateBy { it.entityType to it.entityId }
        val remoteById = remoteHeads.associateBy { it.entityType to it.entityId }
        val keys = (localById.keys + remoteById.keys).sortedWith(compareBy({ it.first }, { it.second }))
        val items = mutableListOf<PlanItem>()

        for ((entityType, entityId) in keys) {
            val local = localById[entityType to entityId]
            val remote = remoteById[entityType to entityId]
            val schemaMax = maxOf(local?.schemaVersion ?: 1, remote?.schemaVersion ?: 1)
            val schemaCap = schemaVersions[entityType]

            if (entityType in unsupportedEntityTypes || (schemaCap != null && schemaMax > schemaCap)) {
                items += PlanItem(
                    entityType,
                    entityId,
                    "unknown_schema",
                    unknownSchemaReason = if (entityType in unsupportedEntityTypes) {
                        "ENTITY_TYPE_UNSUPPORTED"
                    } else {
                        "SCHEMA_VERSION_UNSUPPORTED"
                    },
                )
                continue
            }
            if (local != null && remote == null) {
                items += PlanItem(entityType, entityId, "upload")
                continue
            }
            if (local == null && remote != null) {
                items += PlanItem(entityType, entityId, "download")
                continue
            }
            if (local == null || remote == null) continue

            val rel = compareVersions(local.version, remote.version)
            when (rel) {
                "equal" -> items += PlanItem(entityType, entityId, "same")
                "dominates" -> items += PlanItem(entityType, entityId, "upload")
                "dominated" -> items += PlanItem(entityType, entityId, "download")
                else -> {
                    val pseudo = local.contentHash == remote.contentHash && local.deleted == remote.deleted
                    if (pseudo) {
                        items += PlanItem(entityType, entityId, "same")
                    } else {
                        val kind = if (local.deleted != remote.deleted) "delete_vs_modify" else "version_concurrent"
                        items += PlanItem(entityType, entityId, "conflict", conflictKind = kind)
                    }
                }
            }
        }

        val bucketRank = mapOf("upload" to 0, "download" to 1, "same" to 2, "conflict" to 3, "unknown_schema" to 4)
        val sorted = items.sortedWith(
            compareBy(
                { bucketRank[it.bucket] ?: 9 },
                { it.entityType },
                { it.entityId },
            ),
        )
        val stats = PlanStats(
            uploadCount = sorted.count { it.bucket == "upload" },
            downloadCount = sorted.count { it.bucket == "download" },
            sameCount = sorted.count { it.bucket == "same" },
            conflictCount = sorted.count { it.bucket == "conflict" },
            unknownSchemaCount = sorted.count { it.bucket == "unknown_schema" },
        )
        return sorted to stats
    }

    /** compareVectors：equal | dominates | dominated | concurrent */
    fun compareVersions(a: Map<String, String>, b: Map<String, String>): String {
        var aGe = true
        var bGe = true
        for (device in (a.keys + b.keys)) {
            val av = a[device] ?: "0"
            val bv = b[device] ?: "0"
            val cmp = compareCounter(av, bv)
            if (cmp > 0) bGe = false
            if (cmp < 0) aGe = false
        }
        return when {
            aGe && bGe -> "equal"
            aGe -> "dominates"
            bGe -> "dominated"
            else -> "concurrent"
        }
    }

    fun isProtocolCompatible(a: Int, b: Int): Boolean = minOf(a, b) >= 1

    // ---------------------------------------------------------------- genesis / fence

    fun assertSameGenesis(localId: String, remoteId: String): Map<String, Any?> =
        if (localId == remoteId) {
            mapOf("ok" to true)
        } else {
            mapOf(
                "ok" to false,
                "reason" to "GENESIS_MISMATCH",
                "localId" to localId,
                "remoteId" to remoteId,
            )
        }
}
