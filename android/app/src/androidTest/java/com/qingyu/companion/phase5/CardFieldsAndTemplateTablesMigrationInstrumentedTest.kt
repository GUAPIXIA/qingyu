package com.qingyu.companion.phase5

import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.SimpleSQLiteQuery
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.local.db.QingyuLocalDatabase
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 阶段 5 U-10：本地库 **v3 → v4 迁移**的真实 SQLite 验证。
 *
 * 为什么必须在设备上跑而不是 JVM 替身：本阶段迁移全是 `ALTER TABLE ADD COLUMN` 与
 * `CREATE TABLE/INDEX`，其正确性依赖真实 SQLite 的 DEFAULT 物化行为，以及
 * `MigrationTestHelper` 对**导出 schema 的身份校验**——后者是唯一能抓住
 * 「迁移写了这列，但 Room 实体声明的不是它」这类漂移的手段，
 * 而那种漂移会让 App 在用户设备上启动即崩（Room 报 schema 不匹配）。
 *
 * 覆盖：
 * 1. 迁移后既有业务行**一条不丢**，原有字段值不变；
 * 2. 新增列取「未设置」而不是「用户主动清空」的默认值
 *    （角色卡字段 `''`/`'[]'`、记忆开关 `-1`、快捷回复 `character_id` 为 NULL）；
 * 3. v4 才有的两张同步实体表与全部新索引存在；
 * 4. 迁移后的库能被 v4 实体声明正常打开并读回原行。
 */
@RunWith(AndroidJUnit4::class)
class CardFieldsAndTemplateTablesMigrationInstrumentedTest {

    @get:Rule
    val helper: MigrationTestHelper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        QingyuLocalDatabase::class.java,
        emptyList(),
        FrameworkSQLiteOpenHelperFactory(),
    )

    private fun insertV3Rows(db: SupportSQLiteDatabase) {
        db.execSQL(
            "INSERT INTO local_characters (id, name, description, personality, scenario, " +
                "first_message, example_dialogue_json, extensions_json, created_at, updated_at) " +
                "VALUES ('c-1', '旧角色', '描述', '性格', '场景', '开场', '[]', '{}', 100, 200)",
        )
        db.execSQL(
            "INSERT INTO local_presets (id, name, body_json, is_default, created_at, updated_at) " +
                "VALUES ('p-1', '旧预设', '{\"name\":\"旧预设\"}', 0, 100, 200)",
        )
        db.execSQL(
            "INSERT INTO local_regex_rules (id, name, pattern, replacement, flags, scope, enabled, " +
                "sort_index, created_at, updated_at) " +
                "VALUES ('r-1', '旧规则', 'a+', 'b', 'g', 'output', 1, 0, 100, 200)",
        )
        db.execSQL(
            "INSERT INTO local_quick_reply_sets (id, name, items_json, enabled, sort_index, " +
                "created_at, updated_at) VALUES ('q-1', '全局', '[]', 1, 0, 100, 200)",
        )
        db.execSQL(
            "INSERT INTO local_usage_records (id, provider, model, prompt_tokens, completion_tokens, " +
                "created_at, task_type, input_chars, output_chars) " +
                "VALUES ('u-1', 'mock', 'gpt-x', 10, 20, 100, 'main', 30, 40)",
        )
    }

    /** 取单列结果的文本形式；NULL 明确返回 null（不能退化成空串，否则测不出三态表达）。 */
    private fun scalar(db: SupportSQLiteDatabase, sql: String): String? =
        db.query(SimpleSQLiteQuery(sql)).use { cursor ->
            when {
                !cursor.moveToNext() -> null
                cursor.isNull(0) -> null
                else -> cursor.getString(0)
            }
        }

    @Test
    fun v3ToV4KeepsRowsAndAddsCardFieldsTemplatesAndUsageAxes() {
        val name = "phase5-v3-to-v4"
        helper.createDatabase(name, 3).use { db -> insertV3Rows(db) }

        helper.runMigrationsAndValidate(
            name,
            4,
            true,
            QingyuLocalDatabase.MIGRATION_3_4,
        ).use { db ->
            assertEquals("迁移不得丢行", "1", scalar(db, "SELECT COUNT(*) FROM local_characters"))
            assertEquals("旧角色名字必须原样", "旧角色", scalar(db, "SELECT name FROM local_characters WHERE id='c-1'"))
            assertEquals("旧时间戳不被迁移改写", "200", scalar(db, "SELECT updated_at FROM local_characters WHERE id='c-1'"))

            // 新增列默认值必须表达「未设置」，不能表达「用户主动清空」
            assertEquals("", scalar(db, "SELECT example_dialog FROM local_characters WHERE id='c-1'"))
            assertEquals("[]", scalar(db, "SELECT tags_json FROM local_characters WHERE id='c-1'"))
            assertEquals("", scalar(db, "SELECT card_spec_version FROM local_characters WHERE id='c-1'"))
            assertEquals("-1", scalar(db, "SELECT default_memory_enabled FROM local_characters WHERE id='c-1'"))
            assertEquals("-1", scalar(db, "SELECT default_memory_interval FROM local_characters WHERE id='c-1'"))

            // 预设：默认是「用户预设 + 启用」，内建位不能凭空为真
            assertEquals("0", scalar(db, "SELECT is_builtin FROM local_presets WHERE id='p-1'"))
            assertEquals("1", scalar(db, "SELECT enabled FROM local_presets WHERE id='p-1'"))

            // 正则：stage 默认 text，停止符默认空数组
            assertEquals("text", scalar(db, "SELECT stage FROM local_regex_rules WHERE id='r-1'"))
            assertEquals("[]", scalar(db, "SELECT stop_strings_json FROM local_regex_rules WHERE id='r-1'"))

            // 快捷回复的 character_id 必须是 NULL：NULL 才是「全局集合」的唯一判据，
            // 若默认成 ''，全局集合会在角色级查询里凭空出现
            assertNull(scalar(db, "SELECT character_id FROM local_quick_reply_sets WHERE id='q-1'"))

            // 用量：状态默认 success，date_key 默认空串（聚合时按未知日期处理而不是当天）
            assertEquals("success", scalar(db, "SELECT status FROM local_usage_records WHERE id='u-1'"))
            assertEquals("", scalar(db, "SELECT date_key FROM local_usage_records WHERE id='u-1'"))
            assertNull(scalar(db, "SELECT character_id FROM local_usage_records WHERE id='u-1'"))

            // v4 新增的两张同步实体表（缺表会让写入路径在运行时抛 no such table）
            for (table in listOf("local_lorebook_mapping_templates", "local_usage_clear_markers")) {
                assertEquals(
                    "迁移后应存在表 $table",
                    "1",
                    scalar(db, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='$table'"),
                )
            }
            for (index in listOf(
                "index_local_presets_sort_index",
                "index_local_quick_reply_sets_character_id",
                "index_local_quick_reply_sets_sort_index",
                "index_local_usage_records_character_id",
                "index_local_usage_records_model",
            )) {
                assertEquals(
                    "迁移后应存在索引 $index",
                    "1",
                    scalar(db, "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='$index'"),
                )
            }
        }

        // 迁移后的库必须能被 v4 的实体声明打开并读回原行（Room 的 identity 校验发生在 open 时）
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.databaseBuilder(context, QingyuLocalDatabase::class.java, name)
            .addMigrations(*QingyuLocalDatabase.MIGRATIONS)
            .addCallback(QingyuLocalDatabase.FOREIGN_KEYS_CALLBACK)
            .build()
        try {
            runBlocking {
                val characters = db.characterDao().listAll()
                assertTrue("按 v4 打开后必须还能读到迁移前的角色", characters.any { it.id == "c-1" })
                assertEquals(
                    "迁移后示例对话是「未设置」而不是丢失",
                    "",
                    characters.first { it.id == "c-1" }.exampleDialog,
                )
                assertEquals("新表初始为空", 0, db.lorebookMappingTemplateDao().listAll().size)
            }
        } finally {
            db.close()
        }
    }
}
