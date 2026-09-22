package com.qingyu.companion.phase6

import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.domain.RoomLocalSyncRepository
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * 阶段 6 S6-01：本地库 **v4→v5 迁移**的真实 SQLite 验证。
 *
 * 为什么必须在设备上测（同 `MemoryMigrationAndCasInstrumentedTest` 的理由）：
 * 迁移依赖真实 SQLite 的 `ALTER TABLE ... DEFAULT` 语义与 Room 的表结构校验
 * （新表 DDL 与 `@Entity` 生成语句逐字对齐，否则打开库直接抛 IllegalStateException）。
 * 本地库是用户权威数据，迁移写错即数据损失。
 *
 * 覆盖：
 * 1. v4 既有群行/消息行存活，群调度参数取 PC 新建群缺省、身份三键为 NULL（= 不下发）；
 * 2. 新表 `local_group_messages` 经 Room validate（DDL 对齐）后可正常读写并记 journal；
 * 3. 迁移不重建任何既有表（journal/head 不受影响）。
 */
@RunWith(AndroidJUnit4::class)
class GroupChatSchemaMigrationInstrumentedTest {

    @get:Rule
    val helper: MigrationTestHelper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        QingyuLocalDatabase::class.java,
        emptyList(),
        FrameworkSQLiteOpenHelperFactory(),
    )

    private lateinit var database: QingyuLocalDatabase

    @After
    fun tearDown() {
        runCatching { database.close() }
    }

    private fun openExisting(name: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        database = Room.databaseBuilder(context, QingyuLocalDatabase::class.java, name)
            .addMigrations(*QingyuLocalDatabase.MIGRATIONS)
            .addCallback(QingyuLocalDatabase.FOREIGN_KEYS_CALLBACK)
            .build()
    }

    @Test
    fun migrationFromV4KeepsRowsAndDefaultsGroupSchedulingColumns() {
        val dbName = "migration-4-5.db"
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getDatabasePath(dbName).path).also { if (it.exists()) it.delete() }

        // 1) v4 schema 建库并写入既有用户数据（阶段 5 时点的群/会话/消息）
        helper.createDatabase(dbName, 4).use { v4 ->
            v4.execSQL(
                "INSERT INTO local_groups (id, name, mode, character_ids_json, memory_enabled, created_at, updated_at) " +
                    "VALUES ('g1', '旧群', 'sequential', '[\"c1\",\"c2\"]', 0, 100, 100)",
            )
            v4.execSQL(
                "INSERT INTO local_sessions (id, group_id, title, lorebook_ids_json, memory_enabled, memory_mode, " +
                    "auto_memory_interval, narrative_mode, response_length_mode, recent_triggered_ids_json, " +
                    "lorebook_compression_cache_json, compressed_summary, compressed_range_json, created_at, updated_at) " +
                    "VALUES ('gs1', 'g1', '旧会话', '[]', 0, 'manual', 10, '', '', '[]', '{}', '', '', 100, 100)",
            )
            v4.execSQL(
                "INSERT INTO local_messages (id, session_id, character_id, role, content, images_json, " +
                    "logical_time, seq, created_at, updated_at) " +
                    "VALUES ('m1', 'gs1', '__user__', 'user', '旧消息', '[]', 100, 0, 100, 100)",
            )
            v4.execSQL(
                "INSERT INTO change_log (dot_device, dot_counter, entity_type, entity_id, envelopeJson, origin, recorded_at) " +
                    "VALUES ('dev-a', '1', 'group', 'g1', '{}', 'local', 100)",
            )
        }

        // 2) 跑显式迁移到 v5（Room 同时按 5.json 校验全部表结构）
        helper.runMigrationsAndValidate(dbName, 5, true, *QingyuLocalDatabase.MIGRATIONS)

        // 3) 断言：旧行存活、旧列不变、新列取缺省
        openExisting(dbName)
        val store = RoomLocalSyncRepository(database, "phase6-migration")
        val group = runBlocking { database.groupDao().getById("g1") }!!
        assertEquals("旧群行必须存活", "旧群", group.name)
        assertEquals("旧成员顺序必须保留", "[\"c1\",\"c2\"]", group.characterIdsJson)
        assertEquals("迁移后 chat_mode 取 PC 新建群缺省 polling", "polling", group.chatMode)
        assertEquals(false, group.autoMode)
        assertEquals(1, group.maxRounds)
        assertEquals(2000, group.speakerInterval)
        assertEquals(0, group.currentSpeakerIndex)
        assertNull("preset_id 未设置必须是 null（不是空串冒充）", group.presetId)
        assertEquals("", group.systemPrompt)
        assertEquals("[]", group.lorebookIdsJson)
        assertEquals("", group.defaultNarrativeMode)

        val message = runBlocking { database.messageDao().getById("m1") }!!
        assertEquals("旧消息行必须存活", "旧消息", message.content)
        assertNull("身份三键迁移后必须为 NULL（= 未设置 = payload 不下发）", message.speakerKind)
        assertNull(message.generationKind)
        assertNull(message.narrativeMode)

        val session = runBlocking { database.sessionDao().getById("gs1") }!!
        assertEquals("会话归属必须保留", "g1", session.groupId)
        assertEquals("方向开关迁移后缺省关闭", false, session.dialogueDirectionsEnabled)

        val journal = runBlocking { store.journalChangeCount() }
        assertTrue("既有 change_log 必须存活（迁移不重建表）", journal >= 1)
    }

    @Test
    fun migratedDatabaseAcceptsGroupMessagesAndJournalsThem() {
        // 新表 DDL 与 @Entity 生成语句逐字对齐的验证就在 Room 打开库的那一刻：
        // 不对齐会直接抛 IllegalStateException，这个用例根本跑不起来。
        val dbName = "migration-4-5-writes.db"
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getDatabasePath(dbName).path).also { if (it.exists()) it.delete() }

        helper.createDatabase(dbName, 4).use { v4 ->
            v4.execSQL(
                "INSERT INTO local_groups (id, name, mode, character_ids_json, memory_enabled, created_at, updated_at) " +
                    "VALUES ('g1', '旧群', 'manual', '[]', 0, 100, 100)",
            )
        }
        helper.runMigrationsAndValidate(dbName, 5, true, *QingyuLocalDatabase.MIGRATIONS)
        openExisting(dbName)
        val store = RoomLocalSyncRepository(database, "phase6-migration")

        runBlocking {
            store.putSession(
                com.qingyu.companion.local.db.LocalSessionEntity(
                    id = "gs1", groupId = "g1", title = "s", createdAt = 0, updatedAt = 0,
                ),
            )
            store.appendGroupMessage(
                com.qingyu.companion.local.db.LocalGroupMessageEntity(
                    id = "gm1", sessionId = "gs1", groupId = "g1", characterId = "__user__",
                    content = "迁移后的第一条群消息", round = 1, seq = -1,
                    logicalTime = 100, createdAt = 0, updatedAt = 0,
                ),
            )
            store.appendGroupMessage(
                com.qingyu.companion.local.db.LocalGroupMessageEntity(
                    id = "gm2", sessionId = "gs1", groupId = "g1", characterId = "char-a",
                    content = "（小A）收到", round = 1, seq = -1,
                    logicalTime = 200, createdAt = 0, updatedAt = 0,
                ),
            )
            val rows = store.listGroupMessages("gs1")
            assertEquals("迁移后的库必须能正常读写群消息", 2, rows.size)
            assertEquals("seq 单调递增", listOf(0L, 1L), rows.map { it.seq })
            assertTrue("群消息必须记 journal", store.getHead("message", "gm2") != null)
        }
    }
}
