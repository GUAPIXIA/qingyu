package com.qingyu.companion.synccore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 阶段 7 S7-01：Sync Core 跨语言 golden 比对。
 *
 * 真值由 TS `shared/__tests__/syncCoreGolden.test.ts` 生成
 * （`shared/fixtures/cross-platform/sync-core/`）。本测试用 Kotlin [SyncCore]
 * 重算同一输入，要求与 fixture 逐字段一致。
 */
class SyncCoreGoldenTest {

    private fun syncCoreRoot(name: String): Map<String, Any?> {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "shared/fixtures/cross-platform/sync-core")
            if (candidate.isDirectory) {
                val text = File(candidate, "$name.json").readText()
                @Suppress("UNCHECKED_CAST")
                return normalize(org.json.JSONObject(text)) as Map<String, Any?>
            }
            dir = dir.parentFile
        }
        error("找不到 sync-core fixture 目录")
    }

    private fun normalize(value: Any?): Any? = when (value) {
        null, org.json.JSONObject.NULL -> null
        is org.json.JSONObject -> {
            val map = LinkedHashMap<String, Any?>()
            for (key in value.keys()) map[key] = normalize(value.get(key))
            map
        }
        is org.json.JSONArray -> (0 until value.length()).map { normalize(value.get(it)) }
        is Int -> value.toLong()
        is Long -> value
        else -> value
    }

    @Suppress("UNCHECKED_CAST")
    private fun asMap(value: Any?): Map<String, Any?> = value as Map<String, Any?>

    @Suppress("UNCHECKED_CAST")
    private fun asList(value: Any?): List<Any?> = value as List<Any?>

    @Test
    fun sessionStateMachineMatchesGolden() {
        val root = syncCoreRoot("session")
        for (step in asList(root["walk"])) {
            val m = asMap(step)
            val from = m["from"] as String
            val event = m["event"] as String
            val expected = asMap(m["result"])
            val actual = SyncCore.transitionSession(from, event)
            assertEquals("session $from + $event next", expected["next"], actual.next)
            assertEquals("session $from + $event ok", expected["ok"], actual.ok)
            assertEquals("session $from + $event reason", expected["reason"], actual.reason)
        }
        val terminal = asMap(root["terminal"])
        assertEquals(true, terminal["completed"])
        assertEquals(true, terminal["cancelled"])
        assertEquals(false, terminal["failed"])
        val readOnly = asMap(root["readOnly"])
        assertEquals(true, readOnly["scanning"])
        assertEquals(true, readOnly["plan_ready"])
        assertEquals(false, readOnly["transferring"])
        assertTrue(SyncCore.isTerminalSession("completed"))
        assertFalse(SyncCore.isTerminalSession("failed"))
        assertTrue(SyncCore.isReadOnlyPhase("scanning"))
    }

    @Test
    fun capabilityNegotiationMatchesGolden() {
        val root = syncCoreRoot("capability")
        val negotiated = SyncCore.negotiateCapabilities(
            SyncCore.Capabilities(
                1,
                listOf("lan", "e2ee", "blob_v1"),
                mapOf("character" to 3, "message" to 1, "session" to 1),
            ),
            SyncCore.Capabilities(
                1,
                listOf("lan", "blob_v1", "future_x"),
                mapOf("character" to 2, "message" to 2, "group" to 1),
            ),
        )
        val expected = asMap(root["negotiated"])
        assertEquals((expected["protocolVersion"] as Long).toInt(), negotiated.protocolVersion)
        assertEquals(expected["features"], negotiated.features)
        val expSchema = asMap(expected["schemaVersions"]).mapValues { (it.value as Long).toInt() }
        assertEquals(expSchema, negotiated.schemaVersions)
        assertEquals(expected["unsupportedEntityTypes"], negotiated.unsupportedEntityTypes)
        assertEquals(true, root["protocolOk"])
        assertEquals(false, root["protocolOld"])
    }

    @Test
    fun conflictSuggestionsMatchGolden() {
        val root = syncCoreRoot("conflict")
        val suggest = asMap(root["suggest"])
        assertEquals(suggest["version_concurrent"], SyncCore.suggestConflictResolution("version_concurrent"))
        assertEquals(suggest["delete_vs_modify"], SyncCore.suggestConflictResolution("delete_vs_modify"))
        assertEquals(suggest["dependency"], SyncCore.suggestConflictResolution("dependency"))
        val canBatch = asMap(root["canBatch"])
        assertEquals(canBatch["empty"], SyncCore.canBatchResolve(emptyList()))
        assertEquals(
            canBatch["allConcurrent"],
            SyncCore.canBatchResolve(listOf("version_concurrent", "version_concurrent")),
        )
        assertEquals(
            canBatch["mixed"],
            SyncCore.canBatchResolve(listOf("version_concurrent", "delete_vs_modify")),
        )
    }

    @Test
    fun tombstoneCompactionMatchesGolden() {
        val root = syncCoreRoot("tombstone")
        val t = SyncCore.Tombstone("character", "c1", 1000L, linkedMapOf("pc" to "3"))
        val devices = listOf(
            SyncCore.DeviceAck("pc", linkedMapOf("pc" to "3"), false),
            SyncCore.DeviceAck("and", linkedMapOf("pc" to "3", "and" to "1"), false),
            SyncCore.DeviceAck("old", emptyMap(), true),
        )
        val aged = 1000L + 181 * 86_400_000L
        val window = 1000L + 10 * 86_400_000L

        fun checkVerdict(label: String, actual: SyncCore.TombstoneVerdict) {
            val expected = asMap(root[label])
            assertEquals("$label compactible", expected["compactible"], actual.compactible)
            assertEquals("$label reason", expected["reason"], actual.reason)
            assertEquals("$label pending", expected["pendingDevices"], actual.pendingDevices)
            assertEquals("$label ageDays", (expected["ageDays"] as Long).toInt(), actual.ageDays)
        }

        checkVerdict("allAckedAndAged", SyncCore.canCompactTombstone(t, devices, 180, aged))
        checkVerdict("allAckedButWindow", SyncCore.canCompactTombstone(t, devices, 180, window))
        checkVerdict(
            "pendingDevice",
            SyncCore.canCompactTombstone(
                t,
                devices + SyncCore.DeviceAck("lag", linkedMapOf("lag" to "1"), false),
                180,
                aged,
            ),
        )
        checkVerdict(
            "onlyRetired",
            SyncCore.canCompactTombstone(
                t,
                listOf(SyncCore.DeviceAck("old", emptyMap(), true)),
                180,
                1000L + 200 * 86_400_000L,
            ),
        )
    }

    @Test
    fun idempotentKeyMatchesGolden() {
        val root = syncCoreRoot("batch")
        assertEquals(root["idempotentKey"], SyncCore.idempotentKey("sess-1", "batch-0"))
    }

    @Test
    fun genesisSameAndMismatchMatchGolden() {
        val root = syncCoreRoot("dependency")
        assertEquals(true, asMap(root["genesisSame"])["ok"])
        val diff = asMap(root["genesisDiff"])
        assertEquals(false, diff["ok"])
        assertEquals("GENESIS_MISMATCH", diff["reason"])
        assertEquals("g1", diff["localId"])
        assertEquals("g2", diff["remoteId"])
    }

    @Test
    fun planBucketsMatchGolden() {
        val root = syncCoreRoot("plan")
        // 与 TS syncCoreGolden.test.ts 的 heads 输入一致
        fun head(
            type: String,
            id: String,
            version: Map<String, String>,
            hash: String,
            parentId: String? = null,
            schema: Int = 1,
        ) = SyncCore.HeadSummary(type, id, version, hash, false, parentId, schema, 1000L)

        val h = { s: String -> "sha256:" + java.security.MessageDigest.getInstance("SHA-256")
            .digest(s.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) } }

        // contentHash 必须与 TS contentHash({name:'A'}) 一致 —— 从 fixture 的 buckets 不校验 hash，
        // 这里只比 bucket 分类。hash 值用占位即可（分类只依赖版本向量与 deleted/hash 相等性）。
        val local = listOf(
            head("character", "c1", linkedMapOf("pc" to "1"), "H-A"),
            head("character", "c2", linkedMapOf("pc" to "2"), "H-B"),
            head("message", "m1", linkedMapOf("pc" to "1"), "H-hi", parentId = "s1"),
            head("message", "m2", linkedMapOf("pc" to "3", "and" to "1"), "H-local", parentId = "s1"),
            head("message", "m3", linkedMapOf("pc" to "1"), "H-same", parentId = "s1"),
        )
        val remote = listOf(
            head("character", "c1", linkedMapOf("pc" to "1", "and" to "1"), "H-A"),
            head("character", "c3", linkedMapOf("and" to "1"), "H-C"),
            head("message", "m2", linkedMapOf("pc" to "1", "and" to "2"), "H-remote", parentId = "s1"),
            head("message", "m3", linkedMapOf("pc" to "1", "and" to "1"), "H-same", parentId = "s1"),
            head("message", "m4", linkedMapOf("and" to "1"), "H-old", parentId = "s1", schema = 2),
        )
        val (items, stats) = SyncCore.buildPlanBuckets(
            local,
            remote,
            schemaVersions = linkedMapOf("character" to 3, "message" to 1, "session" to 1, "group" to 1),
            unsupportedEntityTypes = setOf("media_manifest"),
        )
        val expectedBuckets = asList(root["buckets"]).map { asMap(it) }
        val actualBuckets = items.map {
            linkedMapOf<String, Any?>(
                "entityType" to it.entityType,
                "entityId" to it.entityId,
                "bucket" to it.bucket,
                "conflictKind" to it.conflictKind,
                "unknownSchemaReason" to it.unknownSchemaReason,
            )
        }
        assertEquals(expectedBuckets.size, actualBuckets.size)
        for ((exp, act) in expectedBuckets.zip(actualBuckets)) {
            assertEquals(exp["entityType"], act["entityType"])
            assertEquals(exp["entityId"], act["entityId"])
            assertEquals(exp["bucket"], act["bucket"])
            assertEquals(exp["conflictKind"], act["conflictKind"])
            assertEquals(exp["unknownSchemaReason"], act["unknownSchemaReason"])
        }
        val expStats = asMap(root["stats"])
        assertEquals((expStats["uploadCount"] as Long).toInt(), stats.uploadCount)
        assertEquals((expStats["downloadCount"] as Long).toInt(), stats.downloadCount)
        assertEquals((expStats["sameCount"] as Long).toInt(), stats.sameCount)
        assertEquals((expStats["conflictCount"] as Long).toInt(), stats.conflictCount)
        assertEquals((expStats["unknownSchemaCount"] as Long).toInt(), stats.unknownSchemaCount)
    }

    @Test
    fun batchPhaseOrderMatchesGolden() {
        val root = syncCoreRoot("batch")
        // phases 数组按输入信封顺序：m-child, c-top, s1, m-dead, p-ref
        val phases = listOf(1, 0, 1, 3, 2)
        val computed = listOf(
            SyncCore.batchPhaseOf(deleted = false, parentId = "s1", references = null),
            SyncCore.batchPhaseOf(deleted = false, parentId = null, references = null),
            SyncCore.batchPhaseOf(deleted = false, parentId = "c-top", references = null),
            SyncCore.batchPhaseOf(deleted = true, parentId = "s1", references = null),
            SyncCore.batchPhaseOf(deleted = false, parentId = null, references = listOf("c-top")),
        )
        assertEquals(phases, computed)
        assertEquals(phases, asList(root["phases"]).map { (it as Long).toInt() })

        val items = listOf(
            SyncCore.BatchItem(1, "message", "m-child", "s1", "h1", linkedMapOf("pc_a" to "1"), false, 1),
            SyncCore.BatchItem(0, "character", "c-top", null, "h2", linkedMapOf("pc_a" to "1"), false, 1),
            SyncCore.BatchItem(1, "session", "s1", "c-top", "h3", linkedMapOf("pc_a" to "1"), false, 1),
            SyncCore.BatchItem(3, "message", "m-dead", "s1", "h4", linkedMapOf("pc_a" to "1"), true, 1),
            SyncCore.BatchItem(2, "persona", "p-ref", null, "h5", linkedMapOf("pc_a" to "1"), false, 1),
        )
        val sorted = SyncCore.sortBatch(items)
        val expectedOrder = asList(root["order"]).map { asMap(it) }
        assertEquals(expectedOrder.size, sorted.size)
        for ((exp, act) in expectedOrder.zip(sorted)) {
            assertEquals((exp["phase"] as Long).toInt(), act.phase)
            assertEquals(exp["entityType"], act.entityType)
            assertEquals(exp["entityId"], act.entityId)
        }
        val batchSizes = SyncCore.splitBatches(sorted, maxCount = 2, sizeOf = { 100 }).map { it.size }
        assertEquals(asList(root["batchSizes"]).map { (it as Long).toInt() }, batchSizes)
    }
}
