package com.qingyu.companion.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * S6 Room v7 迁移的 JVM 侧一致性测试（无 instrumentation 的替代验证）：
 * - 7.json 存在、版本正确、随仓库保留；
 * - cached_messages 新增 generationNotice/generationError/contentRenderMode 三列（可空）；
 * - MIGRATION_6_7 的 ALTER SQL 与 7.json 列逐字段一致；
 * - v6→v7 仅动 cached_messages，outbox_messages / task_cursors 不变形（发件箱存活保证）。
 */
class OutboxSchemaV7Test {

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
    fun `7_json 存在且 cached_messages 新增三列可空`() {
        val v7 = schemaDb(7)
        val messages = v7["cached_messages"] ?: throw AssertionError("v7 缺表 cached_messages")
        val columns = messages.columns()
        assertEquals(Pair("TEXT", false), columns["generationNotice"])
        assertEquals(Pair("TEXT", false), columns["generationError"])
        assertEquals(Pair("TEXT", false), columns["contentRenderMode"])
    }

    @Test
    fun `v6 到 v7 仅 cached_messages 扩列-其余表不变形`() {
        val v6 = schemaDb(6)
        val v7 = schemaDb(7)
        assertEquals("v7 相对 v6 不应增删表", v6.keys, v7.keys)
        // outbox 与 task_cursors 逐列不变形（发件箱/任务游标必须存活）
        listOf("cached_sessions", "outbox_messages", "task_cursors").forEach { t ->
            assertEquals("$t 在 v6/v7 应完全一致", v6.getValue(t).columns(), v7.getValue(t)!!.columns())
            assertEquals("$t 主键不变", v6.getValue(t).primaryKeyColumns(), v7.getValue(t)!!.primaryKeyColumns())
        }
        // cached_messages 只允许新增这三列
        val added = v7.getValue("cached_messages").columns().keys -
            v6.getValue("cached_messages").columns().keys
        assertEquals(
            setOf("generationNotice", "generationError", "contentRenderMode"),
            added,
        )
        assertNotNull(v7.getValue("cached_messages").createSql())
    }

    @Test
    fun `MIGRATION_6_7 SQL 与 7_json 列逐字段一致且仅操作 cached_messages`() {
        val v7 = schemaDb(7)
        val columns = v7.getValue("cached_messages").columns()
        val sqls = CacheDatabase.MIGRATION_6_7_STATEMENTS
        assertEquals("迁移为三条 ADD COLUMN", 3, sqls.size)
        sqls.forEach { sql ->
            assertTrue("必须是 ALTER TABLE ADD COLUMN", sql.uppercase().startsWith("ALTER TABLE"))
            assertFalse("禁止 DROP/DELETE", sql.uppercase().contains("DROP") || sql.uppercase().contains("DELETE"))
            assertTrue("只允许操作 cached_messages", sql.contains("cached_messages"))
            assertFalse("不得触碰 outbox/task_cursors", sql.uppercase().contains("OUTBOX") || sql.uppercase().contains("TASK_CURSORS"))
            val column = Regex("ADD COLUMN\\s+(\\w+)", RegexOption.IGNORE_CASE).find(sql)!!.groupValues[1]
            assertTrue("SQL 列 $column 必须在 7.json 中", columns.containsKey(column))
            // 新增列必须可空（旧行回填 NULL）
            assertEquals(false, columns.getValue(column).second)
        }
        assertEquals(6, CacheDatabase.MIGRATION_6_7.startVersion)
        assertEquals(7, CacheDatabase.MIGRATION_6_7.endVersion)
    }
}
