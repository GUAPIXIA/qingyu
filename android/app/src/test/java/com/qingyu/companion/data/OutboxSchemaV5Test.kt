package com.qingyu.companion.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * F-03/F-05 Outbox schema v5 迁移的 JVM 侧一致性测试（无 instrumentation 的替代验证）：
 * - 4.json/5.json 存在、版本正确、随仓库保留（方案 §16.3 回滚要求）；
 * - 5.json outbox_messages 列集合与 OutboxMessage 实体逐字段一致（含默认值）；
 * - v4 列在 v5 中不变形（affinity/notNull 不变）；
 * - MIGRATION_4_5 的 ALTER SQL 与 5.json 逐字段核对（列名/affinity/NOT NULL/默认值），
 *   且只扩列、不 DROP/DELETE、不触碰 cached_* —— outbox 存活保证的 SQL 级断言。
 *
 * 仪器迁移测试（MigrationTestHelper 真库 4→5）列入未尽事项，见阶段 F 文档。
 */
class OutboxSchemaV5Test {

    private val json = Json { ignoreUnknownKeys = true }

    /** 单测工作目录是 android/app，兼容从仓库根跑的情况 */
    private fun schemasDir(): File =
        listOf("schemas", "app/schemas", "../app/schemas")
            .map { File(it, "com.qingyu.companion.data.CacheDatabase") }
            .firstOrNull { it.isDirectory }
            ?: throw AssertionError("找不到 Room schemas 目录（android/app/schemas）")

    private fun schemaDb(version: Int): JsonObject {
        val f = File(schemasDir(), "$version.json")
        assertTrue("缺少 schema 文件 $version.json（${f.absolutePath}）", f.isFile)
        return json.parseToJsonElement(f.readText()).jsonObject["database"]!!.jsonObject
    }

    private fun JsonObject.version(): Int = this["version"]!!.jsonPrimitive.content.toInt()

    private fun JsonObject.identityHash(): String = this["identityHash"]!!.jsonPrimitive.content

    private fun JsonObject.table(name: String): JsonObject =
        this["entities"]!!.jsonArray.map { it.jsonObject }
            .firstOrNull { it["tableName"]!!.jsonPrimitive.content == name }
            ?: throw AssertionError("schema 中缺少表 $name")

    /** 列名 -> (affinity, notNull, defaultValue 原文[含 SQL 引号]，键缺失视为 null） */
    private fun JsonObject.columns(): Map<String, Triple<String, Boolean, String?>> =
        this["fields"]!!.jsonArray.associate { f ->
            val o = f.jsonObject
            val name = o["columnName"]!!.jsonPrimitive.content
            val affinity = o["affinity"]!!.jsonPrimitive.content
            val notNull = o["notNull"]!!.jsonPrimitive.content.toBoolean()
            val dv = o["defaultValue"]
            val dvStr = if (dv == null || dv is JsonNull) null else dv.jsonPrimitive.content
            name to Triple(affinity, notNull, dvStr)
        }

    private fun JsonObject.primaryKeyColumns(): Set<String> =
        this["primaryKey"]!!.jsonObject["columnNames"]!!.jsonArray
            .map { it.jsonPrimitive.content }.toSet()

    /** v5 outbox_messages 期望列：与 OutboxMessage 实体（v5）一一对应 */
    private val expectedV5 = linkedMapOf(
        "requestId" to Triple("TEXT", true, null as String?),
        "sessionId" to Triple("TEXT", true, null),
        "content" to Triple("TEXT", true, null),
        "imagesJson" to Triple("TEXT", true, null),
        "replyToId" to Triple("TEXT", false, null),
        "createdAt" to Triple("INTEGER", true, null),
        "retryCount" to Triple("INTEGER", true, null),
        "state" to Triple("TEXT", true, null),
        "error" to Triple("TEXT", false, null),
        "deviceId" to Triple("TEXT", true, "'legacy'"),
        "characterId" to Triple("TEXT", false, null),
        "updatedAt" to Triple("INTEGER", true, "0"),
        "nextAttemptAt" to Triple("INTEGER", false, null),
        "remoteUserMessageId" to Triple("TEXT", false, null),
        "taskId" to Triple("TEXT", false, null),
        "lastErrorCode" to Triple("TEXT", false, null),
        "lastErrorMessage" to Triple("TEXT", false, null),
    )

    /** v4 outbox_messages 原有列（4.json 实测，迁移不得改动） */
    private val v4Columns = setOf(
        "requestId", "sessionId", "content", "imagesJson", "replyToId",
        "createdAt", "retryCount", "state", "error",
    )

    @Test
    fun `schema JSON 存在且版本与 identityHash 正确`() {
        val v4 = schemaDb(4)
        val v5 = schemaDb(5)
        assertEquals(4, v4.version())
        assertEquals(5, v5.version())
        assertTrue("identityHash 不能为空", v4.identityHash().isNotBlank())
        assertTrue("identityHash 不能为空", v5.identityHash().isNotBlank())
        assertNotEquals("版本变更必须产生新 identityHash", v4.identityHash(), v5.identityHash())
        // 三张表齐备
        listOf("cached_sessions", "cached_messages", "outbox_messages").forEach { t ->
            assertNotNull("v5 缺表 $t", v5.entitiesOrThrow().firstOrNull { it["tableName"]!!.jsonPrimitive.content == t })
        }
    }

    private fun JsonObject.entitiesOrThrow(): List<JsonObject> = this["entities"]!!.jsonArray.map { it.jsonObject }

    @Test
    fun `5_json outbox_messages 与实体逐字段一致`() {
        val v5 = schemaDb(5).table("outbox_messages").columns()
        assertEquals(
            "列集合不一致：多了 ${v5.keys - expectedV5.keys}，少了 ${expectedV5.keys - v5.keys}",
            expectedV5.keys, v5.keys,
        )
        expectedV5.forEach { (name, exp) ->
            assertEquals("$name affinity", exp.first, v5.getValue(name).first)
            assertEquals("$name notNull", exp.second, v5.getValue(name).second)
            assertEquals("$name defaultValue", exp.third, v5.getValue(name).third)
        }
        // 主键仍是 requestId（无自增）
        assertEquals(setOf("requestId"), schemaDb(5).table("outbox_messages").primaryKeyColumns())
    }

    @Test
    fun `4_json 与 5_json 的 v4 列不变形（迁移不改老列）`() {
        val v4 = schemaDb(4).table("outbox_messages").columns()
        assertEquals("4.json outbox 列集合应为 v4 原状", v4Columns, v4.keys)
        val v5 = schemaDb(5).table("outbox_messages").columns()
        v4.forEach { (name, col) ->
            assertEquals("老列 $name affinity 被改动", col.first, v5.getValue(name).first)
            assertEquals("老列 $name notNull 被改动", col.second, v5.getValue(name).second)
            assertEquals("老列 $name defaultValue 被改动", col.third, v5.getValue(name).third)
        }
    }

    @Test
    fun `新列默认值——现有调用方构造路径不写新列`() {
        // 与 OnlineChatRepository / OutboxTest 相同的最小构造（8 参，未传新列）
        val legacy = OutboxMessage(
            "req-legacy", "s1", "hello", "[]", null,
            System.currentTimeMillis(), 0, "queued",
        )
        assertEquals("legacy", legacy.deviceId)
        assertNull(legacy.characterId)
        assertEquals(0L, legacy.updatedAt)
        assertNull(legacy.nextAttemptAt)
        assertNull(legacy.remoteUserMessageId)
        assertNull(legacy.taskId)
        assertNull(legacy.lastErrorCode)
        assertNull(legacy.lastErrorMessage)
        // 显式指定新列（F-04 接线后的 PC 绑定行）不受影响
        val bound = legacy.copy(deviceId = "pc-1", updatedAt = 42L, taskId = "task-9")
        assertEquals("pc-1", bound.deviceId)
        assertEquals(42L, bound.updatedAt)
        assertEquals("task-9", bound.taskId)
    }

    private fun assertNull(v: Any?) = assertTrue("期望 null", v == null)

    @Test
    fun `MIGRATION_4_5 SQL 与 5_json 逐字段一致且仅扩列`() {
        val sqls = CacheDatabase.MIGRATION_4_5_STATEMENTS
        val v4Cols = schemaDb(4).table("outbox_messages").columns().keys
        val v5Cols = schemaDb(5).table("outbox_messages").columns()
        val regex = Regex(
            "^ALTER TABLE (\\w+) ADD COLUMN (\\w+) (\\w+)( NOT NULL)?(?: DEFAULT (.+?))?$"
        )

        val added = LinkedHashMap<String, Triple<String, Boolean, String?>>() // 列名 -> affinity/notNull/default
        for (sql in sqls) {
            val m = regex.matchEntire(sql.trim())
                ?: throw AssertionError("无法解析迁移语句（必须是 ALTER TABLE ... ADD COLUMN 形式）: $sql")
            val (table, col, type, notNull, default) = m.destructured
            assertEquals("迁移只允许操作 outbox_messages", "outbox_messages", table)
            assertFalse("重复添加列 $col", added.containsKey(col))
            added[col] = Triple(type, notNull.isNotBlank(), default.ifBlank { null })
        }

        // 迁移新增列 == 5.json 相对 4.json 的全部新列（不漏不多）
        val expectedAdded = v5Cols.keys - v4Cols
        assertEquals(
            "迁移新增列与 schema 差集不一致：多了 ${added.keys - expectedAdded}，少了 ${expectedAdded - added.keys}",
            expectedAdded, added.keys,
        )

        // 每条 ALTER 与 5.json 逐字段核对
        added.forEach { (col, sqlCol) ->
            val (affinity, notNull, def) = v5Cols.getValue(col)
            assertEquals("$col SQL 类型 affinity", affinity, sqlCol.first)
            assertEquals("$col SQL NOT NULL", notNull, sqlCol.second)
            // 默认值归一化：去掉 SQL 引号（'legacy' vs "legacy"）
            assertEquals(
                "$col 默认值",
                def?.trim('\''),
                sqlCol.third?.trim('\''),
            )
            // SQLite 约束：ADD COLUMN 的 NOT NULL 列必须带 DEFAULT（否则存量行无法回填）
            if (sqlCol.second) assertNotNull("$col 为 NOT NULL，ALTER 必须带 DEFAULT", sqlCol.third)
        }
    }

    @Test
    fun `迁移策略——outbox 存活（无清库语句且版本路径正确）`() {
        val sqls = CacheDatabase.MIGRATION_4_5_STATEMENTS
        sqls.forEach { sql ->
            val upper = sql.uppercase()
            assertFalse("迁移禁止 DROP: $sql", upper.contains("DROP"))
            assertFalse("迁移禁止 DELETE/清库: $sql", upper.contains("DELETE"))
            assertFalse("迁移不得触碰缓存表: $sql", upper.contains("CACHED_"))
        }
        assertEquals(4, CacheDatabase.MIGRATION_4_5.startVersion)
        assertEquals(5, CacheDatabase.MIGRATION_4_5.endVersion)
        // cached_sessions/cached_messages 在 4→5 结构未变，schema 层面确认一致（迁移无需处理）
        listOf("cached_sessions", "cached_messages").forEach { t ->
            assertEquals(
                "$t 在 v4/v5 应完全一致",
                schemaDb(4).table(t).columns(),
                schemaDb(5).table(t).columns(),
            )
        }
    }
}
