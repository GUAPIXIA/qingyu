package com.qingyu.companion.phase4

import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalMessageEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.db.LocalMemoryStateEntity
import com.qingyu.companion.local.db.LocalUsageRecordEntity
import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.domain.RoomLocalSyncRepository
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * 阶段 4 S4-05：本地库 **v1→v2 迁移**与**记忆 CAS 写入**的真实 SQLite 验证。
 *
 * 为什么必须在设备上测：迁移与 CAS 都依赖真实 SQLite 的行为
 * （ALTER TABLE 的 DEFAULT、条件 UPDATE 的受影响行数、事务可见性），
 * JVM 替身无法给出同等保证。本地库是用户权威数据，迁移写错即数据损失。
 *
 * 覆盖：
 * 1. v1 库经迁移后**既有业务行存活**且新列取默认值；
 * 2. 迁移只增列、不重建表（journal/head 等表不受影响）；
 * 3. CAS：版本匹配 → 应用；版本不匹配 → 拒绝且磁盘不变；
 * 4. 历史修订号推进使派生记忆过期。
 */
@RunWith(AndroidJUnit4::class)
class MemoryMigrationAndCasInstrumentedTest {

    /**
     * [MigrationTestHelper] 需要导出的 schema（`app/schemas/...`）与 `room-testing` 依赖，
     * 二者都已就绪。
     *
     * **这里没有「缺少依赖就跳过」的兜底**（此前注释曾这样写，但那个 `hasMigrationHelper`
     * 从未存在过）：规则是**立即构造**的，依赖缺失会直接让该测试类失败而不是静默跳过。
     * 条件跳过会把迁移校验变成假守卫——这类「跳过即通过」的坑本项目已经踩过多次。
     */
    @get:Rule
    val helper: MigrationTestHelper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        QingyuLocalDatabase::class.java,
        emptyList(),
        FrameworkSQLiteOpenHelperFactory(),
    )

    private lateinit var database: QingyuLocalDatabase
    private lateinit var store: RoomLocalSyncRepository

    @After
    fun tearDown() {
        runCatching { database.close() }
    }

    private fun openCurrent(name: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getDatabasePath(name).path).also { if (it.exists()) it.delete() }
        database = Room.databaseBuilder(context, QingyuLocalDatabase::class.java, name)
            .addMigrations(*QingyuLocalDatabase.MIGRATIONS)
            .addCallback(QingyuLocalDatabase.FOREIGN_KEYS_CALLBACK)
            .build()
        store = RoomLocalSyncRepository(database, "phase4-memory-cas")
    }

    /** 打开既有库文件（迁移后），并初始化 store 以便复用仓库层读取。 */
    private fun openExisting(name: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        database = Room.databaseBuilder(context, QingyuLocalDatabase::class.java, name)
            .addMigrations(*QingyuLocalDatabase.MIGRATIONS)
            .addCallback(QingyuLocalDatabase.FOREIGN_KEYS_CALLBACK)
            .build()
        store = RoomLocalSyncRepository(database, "phase4-memory-cas")
    }
    // ---------------------------------------------------------------- 迁移

    @Test
    fun migrationFromV1KeepsExistingRowsAndAddsDefaultedColumns() {
        val dbName = "migration-1-2.db"
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getDatabasePath(dbName).path).also { if (it.exists()) it.delete() }

        // 1) 用 v1 schema 建库并写入一行（模拟阶段 3 已存在的用户数据）
        helper.createDatabase(dbName, 1).use { v1 ->
            v1.execSQL(
                "INSERT INTO local_memory_states (id, session_id, summary, covered_through_seq, budget_json, updated_at) " +
                    "VALUES ('m1', 's1', '旧摘要', 7, '{}', 100)",
            )
            v1.execSQL(
                "INSERT INTO local_usage_records (id, session_id, provider, model, prompt_tokens, completion_tokens, created_at) " +
                    "VALUES ('u1', 's1', 'openai', 'gpt-4o-mini', 10, 20, 100)",
            )
        }

        // 2) 跑显式迁移到 v2
        helper.runMigrationsAndValidate(dbName, 2, true, *QingyuLocalDatabase.MIGRATIONS)

        // 3) 断言：旧行存活、旧列值不变、新列取默认值
        openExisting(dbName)
        val state = runBlocking { database.memoryDao().getState("s1") }
        assertNotNull("迁移后旧记忆行必须存活", state)
        assertEquals("旧摘要", state!!.summary)
        assertEquals(7L, state.coveredThroughSeq)
        assertEquals("迁移后新列必须为默认版本 0", 0L, state.memoryVersion)
        assertEquals("", state.currentState)
        assertEquals("[]", state.factsJson)
        assertEquals("[]", state.historyJson)
        assertEquals(0L, state.historyRevision)

        val usage = runBlocking { store.listUsage(10) }
        assertEquals(1, usage.size)
        assertEquals("旧用量行必须存活", 10, usage[0].promptTokens)
        assertEquals("新增列默认 main", "main", usage[0].taskType)
    }

    @Test
    fun migrationFromV2KeepsExistingSessionAndAddsSessionLevelColumns() {
        // v2 → v3（阶段 4 S4-04/S4-06）：补会话级叙事模式/篇幅模式/世界书近因与压缩缓存/
        // 历史压缩摘要。全部是新增列，旧会话行必须原样存活并取默认值。
        val dbName = "migration-2-3.db"
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getDatabasePath(dbName).path).also { if (it.exists()) it.delete() }

        // 1) 用 v2 schema 建库并写入一行会话（模拟阶段 4 中期已存在的用户数据）
        helper.createDatabase(dbName, 2).use { v2 ->
            v2.execSQL(
                "INSERT INTO local_sessions (id, character_id, title, lorebook_ids_json, created_at, updated_at, " +
                    "memory_enabled, memory_mode, auto_memory_interval) " +
                    "VALUES ('s1', 'c1', '深夜的书店', '[]', 100, 100, 1, 'auto', 4)",
            )
        }

        // 2) 跑显式迁移到 v3
        helper.runMigrationsAndValidate(dbName, 3, true, *QingyuLocalDatabase.MIGRATIONS)

        // 3) 断言：旧行存活、旧列值不变、新列取默认值（= 未设置/空窗口/无缓存）
        openExisting(dbName)
        val session = runBlocking { database.sessionDao().getById("s1") }
        assertNotNull("迁移后旧会话行必须存活", session)
        assertEquals("深夜的书店", session!!.title)
        assertEquals("旧列值不得改动（记忆策略）", "auto", session.memoryMode)
        assertEquals(4, session.autoMemoryInterval)
        assertEquals("叙事模式默认未设置", "", session.narrativeMode)
        assertEquals("篇幅模式默认未设置", "", session.responseLengthMode)
        assertEquals("近因窗口默认为空数组", "[]", session.recentTriggeredIdsJson)
        assertEquals("压缩缓存默认为空对象", "{}", session.lorebookCompressionCacheJson)
        assertEquals("压缩摘要默认空", "", session.compressedSummary)
        assertEquals("压缩范围默认空", "", session.compressedRangeJson)
    }

    @Test
    fun migrationFromV1ToV3AppliesBothStepsInOneGo() {
        // 从 v1 直接升到 v3（长期未升级的用户）：两步迁移必须依次生效
        val dbName = "migration-1-3.db"
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getDatabasePath(dbName).path).also { if (it.exists()) it.delete() }

        helper.createDatabase(dbName, 1).use { v1 ->
            v1.execSQL(
                "INSERT INTO local_sessions (id, character_id, title, lorebook_ids_json, created_at, updated_at) " +
                    "VALUES ('s1', 'c1', '旧会话', '[]', 100, 100)",
            )
            v1.execSQL(
                "INSERT INTO local_memory_states (id, session_id, summary, covered_through_seq, budget_json, updated_at) " +
                    "VALUES ('m1', 's1', '旧摘要', 3, '{}', 100)",
            )
        }

        helper.runMigrationsAndValidate(dbName, 3, true, *QingyuLocalDatabase.MIGRATIONS)

        openExisting(dbName)
        val session = runBlocking { database.sessionDao().getById("s1") }
        assertNotNull("v1 会话必须存活", session)
        assertEquals("旧会话", session!!.title)
        // v2 的列（记忆策略）与 v3 的列（叙事模式）都必须已就位
        assertEquals("manual", session.memoryMode)
        assertEquals("", session.narrativeMode)

        val state = runBlocking { database.memoryDao().getState("s1") }
        assertNotNull("v1 记忆行必须存活", state)
        assertEquals("旧摘要", state!!.summary)
        assertEquals(0L, state.memoryVersion)
    }

    @Test
    fun migrationDoesNotRebuildJournalTables() {
        val dbName = "migration-journal.db"
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getDatabasePath(dbName).path).also { if (it.exists()) it.delete() }

        helper.createDatabase(dbName, 1).use { v1 ->
            // 列名以**导出的 v1 schema** 为准（`envelopeJson` 是驼峰，没有 @ColumnInfo 改名）。
            // 裸 SQL 迁移测试不得从 Kotlin 字段名推断列名。
            v1.execSQL(
                "INSERT INTO change_log (dot_device, dot_counter, entity_type, entity_id, envelopeJson, origin, recorded_at) " +
                    "VALUES ('dev-1', '1', 'message', 'm1', '{}', 'local', 100)",
            )
        }
        helper.runMigrationsAndValidate(dbName, 2, true, *QingyuLocalDatabase.MIGRATIONS)

        openExisting(dbName)
        assertEquals("变更日志不得因迁移丢失", 1, runBlocking { store.journalCount("local") })
    }

    // ---------------------------------------------------------------- CAS

    @Test
    fun casAppliesWhenVersionMatches() = runBlocking {
        openCurrent("cas-apply.db")
        store.putMemoryState(
            LocalMemoryStateEntity(id = "m1", sessionId = "s1", summary = "初始", updatedAt = 0),
        )

        val result = store.applyMemoryStateIfVersion(
            sessionId = "s1",
            expectedVersion = 0,
            entity = LocalMemoryStateEntity(
                id = "m1",
                sessionId = "s1",
                summary = "新摘要",
                currentState = "状态",
                factsJson = "[\"f1\"]",
                historyJson = "[]",
                coveredThroughSeq = 9,
                historyRevision = 0,
                updatedAt = 0,
            ),
        )

        assertTrue("版本匹配时必须应用", result.applied)
        assertEquals(1L, result.currentVersion)
        val state = store.getMemoryState("s1")!!
        assertEquals("新摘要", state.summary)
        assertEquals("状态", state.currentState)
        assertEquals("[\"f1\"]", state.factsJson)
        assertEquals(9L, state.coveredThroughSeq)
        assertEquals(1L, state.memoryVersion)
    }

    @Test
    fun casRejectsStaleVersionAndLeavesDiskUnchanged() = runBlocking {
        openCurrent("cas-reject.db")
        store.putMemoryState(
            LocalMemoryStateEntity(id = "m1", sessionId = "s1", summary = "初始", updatedAt = 0),
        )
        // 第一次提交成功 → 版本推进到 1
        store.applyMemoryStateIfVersion(
            sessionId = "s1",
            expectedVersion = 0,
            entity = LocalMemoryStateEntity(id = "m1", sessionId = "s1", summary = "第一版", updatedAt = 0),
        )
        // 模拟：生成期间用户编辑了历史 → 另有并发方把版本推到 2
        store.bumpMemoryHistoryRevision("s1")
        store.applyMemoryStateIfVersion(
            sessionId = "s1",
            expectedVersion = 1,
            entity = LocalMemoryStateEntity(id = "m1", sessionId = "s1", summary = "并发写入", updatedAt = 0),
        )

        // 持有旧期望版本（1）的摘要在此时提交，必须被拒绝
        val stale = store.applyMemoryStateIfVersion(
            sessionId = "s1",
            expectedVersion = 1,
            entity = LocalMemoryStateEntity(id = "m1", sessionId = "s1", summary = "过期摘要", updatedAt = 0),
        )

        assertFalse("过期版本不得应用", stale.applied)
        assertEquals("currentVersion 必须是磁盘上的真实版本", 2L, stale.currentVersion)
        val state = store.getMemoryState("s1")!!
        assertEquals("磁盘内容不得被过期摘要覆盖", "并发写入", state.summary)
        assertEquals(2L, state.memoryVersion)
    }

    @Test
    fun casOnMissingRowRequiresZeroExpectedVersion() = runBlocking {
        openCurrent("cas-missing.db")

        // 期望版本非 0 且无行 → 视为过期，且**不得创建行**
        val stale = store.applyMemoryStateIfVersion(
            sessionId = "s1",
            expectedVersion = 3,
            entity = LocalMemoryStateEntity(id = "m1", sessionId = "s1", summary = "不应写入", updatedAt = 0),
        )
        assertFalse(stale.applied)
        assertFalse(stale.applied)
        assertEquals(null, store.getMemoryState("s1"))

        // 期望版本 0 → 以初始行写入
        val created = store.applyMemoryStateIfVersion(
            sessionId = "s1",
            expectedVersion = 0,
            entity = LocalMemoryStateEntity(id = "m1", sessionId = "s1", summary = "初始", updatedAt = 0),
        )
        assertTrue(created.applied)
        assertEquals(1L, created.currentVersion)
        assertEquals("初始", store.getMemoryState("s1")!!.summary)
    }

    @Test
    fun bumpHistoryRevisionMarksDerivedMemoryStale() = runBlocking {
        openCurrent("cas-revision.db")
        store.putMemoryState(
            LocalMemoryStateEntity(id = "m1", sessionId = "s1", summary = "派生自修订 0", updatedAt = 0),
        )
        assertEquals(0L, store.getMemoryState("s1")!!.historyRevision)

        assertTrue("存在记忆行时必须推进修订号", store.bumpMemoryHistoryRevision("s1"))
        assertEquals(1L, store.getMemoryState("s1")!!.historyRevision)

        // 记忆版本不受修订号影响：两者是独立的失效维度
        assertEquals(0L, store.getMemoryState("s1")!!.memoryVersion)

        // 不存在的会话返回 false（无需失效任何东西）
        assertFalse(store.bumpMemoryHistoryRevision("missing"))
    }

    /**
     * **父行更新不得波及子行**（本轮由端到端验收发现的静默数据丢失）：
     *
     * `local_messages.session_id` 是 `ON DELETE CASCADE`，而外键在本库显式开启。
     * 若会话 upsert 用 `@Insert(REPLACE)`，SQLite 会「先删旧行再插入」，
     * 于是**改一次会话设置就把整段对话删光**。
     *
     * 本用例在真实 SQLite 上锁定 `@Upsert` 行为：更新会话行后消息必须完好。
     */
    @Test
    fun updatingSessionRowKeepsItsMessages() = runBlocking {
        openCurrent("parent-child-session.db")
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "苏晚", createdAt = 0, updatedAt = 0))
        store.putSession(LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0))
        store.appendMessage(
            LocalMessageEntity(
                id = "m1",
                sessionId = "s1",
                characterId = "c1",
                role = "user",
                content = "第一句",
                logicalTime = 1,
                seq = -1L,
                createdAt = 1,
                updatedAt = 1,
            ),
        )
        store.appendMessage(
            LocalMessageEntity(
                id = "m2",
                sessionId = "s1",
                characterId = "c1",
                role = "assistant",
                content = "第二句",
                logicalTime = 2,
                seq = -1L,
                createdAt = 2,
                updatedAt = 2,
            ),
        )
        assertEquals(2, store.listMessages("s1").size)

        // 模拟：用户在快捷设置面板改预设并改名（都会走 putSession 更新同一行）
        store.putSession(store.getSession("s1")!!.copy(presetId = "ps1", title = "改名后"))

        assertEquals("更新会话行不得删除消息", 2, store.listMessages("s1").size)
        assertEquals("改名必须生效", "改名后", store.getSession("s1")!!.title)
        assertEquals("预设绑定必须生效", "ps1", store.getSession("s1")!!.presetId)
    }

    /**
     * 同类问题第二处：`local_sessions.character_id` 是 `SET_NULL`。
     * 若角色 upsert 用 `@Insert(REPLACE)`，「更新角色卡」会把该角色下所有会话的归属置空。
     */
    @Test
    fun updatingCharacterRowKeepsSessionOwnership() = runBlocking {
        openCurrent("parent-child-character.db")
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "苏晚", createdAt = 0, updatedAt = 0))
        store.putSession(LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0))

        store.putCharacter(
            LocalCharacterEntity(id = "c1", name = "苏晚（改名）", createdAt = 0, updatedAt = 5),
        )

        val session = store.getSession("s1")
        assertNotNull("会话不得被删除", session)
        assertEquals("会话归属不得被置空", "c1", session!!.characterId)
        assertEquals("角色改名必须生效", "苏晚（改名）", store.getCharacter("c1")!!.name)
    }

    @Test
    fun usageRecordsCarryTaskTypeSoMemoryUsageIsSeparated() = runBlocking {
        openCurrent("cas-usage.db")
        store.recordUsage(
            LocalUsageRecordEntity(
                id = "u-chat",
                sessionId = "s1",
                provider = "openai",
                model = "gpt-4o-mini",
                promptTokens = 100,
                completionTokens = 50,
                createdAt = 1,
                taskType = "main",
            ),
        )
        store.recordUsage(
            LocalUsageRecordEntity(
                id = "u-memory",
                sessionId = "s1",
                provider = "openai",
                model = "gpt-4o-mini",
                promptTokens = 900,
                completionTokens = 300,
                createdAt = 2,
                taskType = "memory",
            ),
        )

        val rows = store.listUsage(10)
        assertEquals(2, rows.size)
        assertEquals(
            "记忆任务与聊天任务必须可区分",
            setOf("main", "memory"),
            rows.map { it.taskType }.toSet(),
        )
    }
}
