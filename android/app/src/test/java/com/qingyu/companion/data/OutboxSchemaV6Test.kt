package com.qingyu.companion.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * F-02 Room v6 迁移的 JVM 侧一致性测试（无 instrumentation 的替代验证）：
 * - 6.json 存在、版本正确、随仓库保留；
 * - 6.json task_cursors 与 TaskCursorEntity 逐字段一致（复合主键 deviceId+taskId）；
 * - MIGRATION_5_6 的 CREATE TABLE SQL 与 6.json createSql 逐字段一致；
 * - v5→v6 仅新增 task_cursors，outbox/cached_* 完全不变形（outbox 存活保证）。
 */
class OutboxSchemaV6Test {

    private val json = Json { ignoreUnknownKeys = true }

    private fun schemasDir(): File = File("schemas", "com.qingyu.companion.data.CacheDatabase")
        .takeIf { it.isDirectory }
        ?: listOf("app/schemas", "../app/schemas")
            .map { File(it, "com.qingyu.companion.data.CacheDatabase") }
            .firstOrNull { it.isDirectory }
            ?: throw AssertionError("找不到 Room schemas 目录（android/app/schemas）")

    private fun schemaDb(version: Int): Map<String, JsonObject> {
        val f = File(schemasDir(), "$version.json")
        assertTrue("缺少 schema 文件 $version.json（${f.absolutePath}）", f.isFile)
        val db = json.parseToJsonElement(f.readText()).jsonObject["database"]!!.jsonObject
        assertEquals(version, db["version"]!!.jsonPrimitive.content.toInt())
        return db["entities"]!!.jsonArray.map { it.jsonObject }
            .associateBy { it["tableName"]!!.jsonPrimitive.content }
    }

    private fun JsonObject.columns(): Map<String, Pair<String, Boolean>> =
        this["fields"]!!.jsonArray.associate { f ->
            val o = f.jsonObject
            o["columnName"]!!.jsonPrimitive.content to Pair(
                o["affinity"]!!.jsonPrimitive.content,
                o["notNull"]!!.jsonPrimitive.content.toBoolean(),
            )
        }

    private fun JsonObject.primaryKeyColumns(): Set<String> =
        this["primaryKey"]!!.jsonObject["columnNames"]!!.jsonArray
            .map { it.jsonPrimitive.content }.toSet()

    private fun JsonObject.createSql(): String = this["createSql"]!!.jsonPrimitive.content

    @Test
    fun `6_json 存在且 task_cursors 与实体逐字段一致`() {
        val v6 = schemaDb(6)
        val v5 = schemaDb(5)
        assertNotEquals(v5.size, 0)
        // 新表存在，字段与 TaskCursorEntity 一致
        val cursors = v6["task_cursors"] ?: throw AssertionError("v6 缺表 task_cursors")
        assertEquals(
            mapOf(
                "deviceId" to Pair("TEXT", true),
                "taskId" to Pair("TEXT", true),
                "sessionId" to Pair("TEXT", true),
                "lastSequence" to Pair("INTEGER", true),
                "updatedAt" to Pair("INTEGER", true),
            ),
            cursors.columns(),
        )
        // 复合主键 (deviceId, taskId)：cursor 绑定 PC，切 PC 不共享
        assertEquals(setOf("deviceId", "taskId"), cursors.primaryKeyColumns())
        assertEquals(emptyList<kotlinx.serialization.json.JsonObject>(), cursors["indices"]!!.jsonArray.map { it.jsonObject })
    }

    @Test
    fun `v5 到 v6 仅新增 task_cursors-其余表不变形`() {
        val v5 = schemaDb(5)
        val v6 = schemaDb(6)
        assertEquals(
            "v6 相对 v5 只允许新增 task_cursors",
            setOf("task_cursors"),
            v6.keys - v5.keys,
        )
        // outbox 与 cached_* 表逐列不变形
        listOf("cached_sessions", "cached_messages", "outbox_messages").forEach { t ->
            assertEquals("$t 在 v5/v6 应完全一致", v5.getValue(t).columns(), v6.getValue(t)!!.columns())
            assertEquals("$t 主键不变", v5.getValue(t).primaryKeyColumns(), v6.getValue(t)!!.primaryKeyColumns())
        }
    }

    @Test
    fun `MIGRATION_5_6 SQL 与 6_json createSql 逐字段一致且仅操作 task_cursors`() {
        val v6 = schemaDb(6)
        val expected = v6.getValue("task_cursors").createSql()
            .replace("\${TABLE_NAME}", "task_cursors")
        val sqls = CacheDatabase.MIGRATION_5_6_STATEMENTS
        assertEquals("迁移只包含一条 CREATE TABLE", 1, sqls.size)
        val sql = sqls.single().trim()
        assertTrue("必须是 CREATE TABLE 语句", sql.uppercase().startsWith("CREATE TABLE"))
        assertFalse("禁止 DROP/DELETE", sql.uppercase().contains("DROP") || sql.uppercase().contains("DELETE"))
        assertFalse("不得触碰缓存表/outbox", sql.uppercase().contains("CACHED_") || sql.uppercase().contains("OUTBOX"))
        // 规范化空白与反引号后与 Room 生成的 createSql 逐字段比对
        val normalized = { s: String ->
            s.replace(Regex("\\s+"), " ").replace("( ", "(").replace(" )", ")").replace("`", "").trim()
        }
        assertEquals(normalized(expected), normalized(sql))
        // 复合主键必须在 SQL 中体现
        assertTrue(sql.contains("PRIMARY KEY(deviceId, taskId)"))
        // v5→v6 版本区间
        assertEquals(5, CacheDatabase.MIGRATION_5_6.startVersion)
        assertEquals(6, CacheDatabase.MIGRATION_5_6.endVersion)
    }
}
