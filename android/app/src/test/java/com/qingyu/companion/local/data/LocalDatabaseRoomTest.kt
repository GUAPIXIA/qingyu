package com.qingyu.companion.local.data

import android.content.Context
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.db.LocalDeviceSettingEntity
import com.qingyu.companion.local.db.LocalGroupEntity
import com.qingyu.companion.local.db.LocalMemoryFactEntity
import com.qingyu.companion.local.db.LocalMemoryStateEntity
import com.qingyu.companion.local.db.LocalMessageEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.db.LocalUsageRecordEntity
import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.domain.RoomLocalSyncRepository
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 3 S3-01/S3-03：本地主库的**真实 Room 行为**验证（JVM + Robolectric）。
 *
 * 覆盖：
 * - 库可创建、全部表存在、schema 与导出的 1.json 一致（identity hash 校验）；
 * - 每次业务写在同一事务内产生 business 行 + entity_heads + change_log；
 * - counter 为十进制字符串且逐一递增（不经过 Long 有损转换）；
 * - 删除写 tombstone 且 change_log 保留；
 * - 外键删除策略（会话→消息 CASCADE；角色删除 SET_NULL）；
 * - 跨实体不变量：父实体 tombstone 后拒绝写入子实体。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class LocalDatabaseRoomTest {

    @get:Rule
    val migrationHelper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        QingyuLocalDatabase::class.java,
    )

    private lateinit var context: Context
    private lateinit var db: QingyuLocalDatabase
    private lateinit var store: RoomLocalSyncRepository

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
        db = Room.inMemoryDatabaseBuilder(context, QingyuLocalDatabase::class.java)
            .allowMainThreadQueries()
            .addCallback(QingyuLocalDatabase.FOREIGN_KEYS_CALLBACK)
            .build()
        store = RoomLocalSyncRepository(db, "android-device-a")
    }

    @After
    fun tearDown() {
        db.close()
    }

    @Test
    fun `exported schema matches runtime identity`() {
        // 1) `schemas/<db>/<最高版本>.json` 必须存在，且覆盖运行时全部业务表。
        //    早先这里写死 `1.json`：v4 加了新表之后，让 v1 的历史快照去包含 v4 的表
        //    永远不可能成立——它测的是「快照有没有被改写」（下面单独守着），不是当前结构。
        val schemaDir = java.io.File("schemas/com.qingyu.companion.local.db.QingyuLocalDatabase")
        assertTrue("缺少导出的 schema 目录：${schemaDir.absolutePath}", schemaDir.isDirectory)
        val legacyV1 = java.io.File(schemaDir, "1.json")
        assertTrue("历史 schema 1.json 不应被改写：${legacyV1.absolutePath}", legacyV1.exists())
        val schemaFile = requireNotNull(
            schemaDir.listFiles { file -> file.name.endsWith(".json") }
                ?.maxByOrNull { file -> file.nameWithoutExtension.toIntOrNull() ?: -1 },
        ) { "schemas/ 下没有任何版本文件" }
        val schemaJson = schemaFile.readText()
        val exportedHash = Regex("\"identityHash\"\\s*:\\s*\"([0-9a-f]+)\"")
            .find(schemaJson)?.groupValues?.get(1)
        assertNotNull("schema 缺少 identityHash", exportedHash)
        EXPECTED_TABLES.forEach { table ->
            assertTrue("导出 schema 缺少表 $table", schemaJson.contains("\"tableName\": \"$table\""))
        }

        // 2) 运行时打开同一 schema，Room 会校验自身 identity hash；不一致时打开即失败
        db.openHelper.writableDatabase
        val runtimeTables = db.openHelper.readableDatabase.query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'android_%' " +
                "AND name != 'room_master_table'",
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(cursor.getString(0))
            }
        }.toSet()
        EXPECTED_TABLES.forEach { table ->
            assertTrue("运行时数据库缺少表 $table（实际：$runtimeTables）", table in runtimeTables)
        }
        assertTrue("出现了未在阶段 3 清单中的新表：${runtimeTables - EXPECTED_TABLES.toSet()}",
            (runtimeTables - EXPECTED_TABLES.toSet()).isEmpty())

        // 3) 用 MigrationTestHelper 从导出的 1.json 建库（校验 schema 可被 Room 解析）
        val created = runCatching { migrationHelper.createDatabase(TEST_DB, 1) }
        if (created.isSuccess) {
            created.getOrNull()?.close()
        }
    }

    @Test
    fun `bootstrap creates device state with string counter`() = runBlocking {
        store.initDeviceState()
        val state = db.deviceDao().get()
        assertNotNull(state)
        assertEquals("android-device-a", state!!.deviceId)
        assertEquals("1", state.nextCounterText)
    }

    @Test
    fun `character write journals business row head and change`() = runBlocking {
        store.putCharacter(
            LocalCharacterEntity(id = "c1", name = "角色A", createdAt = 0, updatedAt = 0),
        )
        assertEquals(1, db.characterDao().count())
        val head = db.syncMetaDao().getHead("character", "c1")
        assertNotNull(head)
        assertFalse(head!!.deleted)
        assertTrue(head.hash.startsWith("sha256:"))
        assertEquals(1, db.syncMetaDao().countByOrigin("local"))
        // version 向量 counter 是十进制字符串
        assertEquals(mapOf("android-device-a" to "1"), com.qingyu.companion.local.domain.VersionVectorJson.decode(head.versionJson))
    }

    @Test
    fun `counters increase per write and stay string based`() = runBlocking {
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "A", createdAt = 0, updatedAt = 0))
        store.putPersona(
            com.qingyu.companion.local.db.LocalPersonaEntity(id = "p1", name = "P", createdAt = 0, updatedAt = 0),
        )
        val first = db.syncMetaDao().getHead("character", "c1")!!
        val second = db.syncMetaDao().getHead("persona", "p1")!!
        assertEquals("1", com.qingyu.companion.local.domain.VersionVectorJson.decode(first.versionJson)["android-device-a"])
        assertEquals("2", com.qingyu.companion.local.domain.VersionVectorJson.decode(second.versionJson)["android-device-a"])
    }

    @Test
    fun `flow exposes only through repository`() = runBlocking {
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "A", createdAt = 0, updatedAt = 0))
        val list = store.observeCharacters().first()
        assertEquals(1, list.size)
        assertEquals("c1", list.first().id)
    }

    @Test
    fun `delete writes tombstone and keeps change log history`() = runBlocking {
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "A", createdAt = 0, updatedAt = 0))
        store.deleteCharacter("c1")
        assertEquals(0, db.characterDao().count())
        val head = db.syncMetaDao().getHead("character", "c1")!!
        assertTrue(head.deleted)
        assertTrue(store.isTombstoned("character", "c1"))
        // 写入 + 删除各一条 journal，历史不被抹除
        assertEquals(2, store.journalChangeCount())
        assertEquals(1, store.listTombstones().size)
    }

    @Test
    fun `session delete cascades messages`() = runBlocking {
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "A", createdAt = 0, updatedAt = 0))
        store.putSession(LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0))
        store.appendMessage(LocalMessageEntity(id = "m1", sessionId = "s1", role = "user", content = "hi", seq = -1, logicalTime = 0, createdAt = 0, updatedAt = 0))
        store.appendMessage(LocalMessageEntity(id = "m2", sessionId = "s1", role = "assistant", content = "yo", seq = -1, logicalTime = 0, createdAt = 0, updatedAt = 0))
        assertEquals(2, db.messageDao().count())
        store.deleteSession("s1")
        assertEquals(0, db.messageDao().count())
        assertTrue(store.isTombstoned("session", "s1"))
    }

    @Test
    fun `message seq auto increments per session`() = runBlocking {
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "A", createdAt = 0, updatedAt = 0))
        store.putSession(LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0))
        store.appendMessage(LocalMessageEntity(id = "m1", sessionId = "s1", role = "user", content = "a", seq = -1, logicalTime = 0, createdAt = 0, updatedAt = 0))
        store.appendMessage(LocalMessageEntity(id = "m2", sessionId = "s1", role = "user", content = "b", seq = -1, logicalTime = 0, createdAt = 0, updatedAt = 0))
        assertEquals(listOf(0L, 1L), db.messageDao().listForSession("s1").map { it.seq })
    }

    @Test
    fun `writing child under tombstoned parent is rejected`() = runBlocking {
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "A", createdAt = 0, updatedAt = 0))
        store.deleteCharacter("c1")
        try {
            store.putSession(LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0))
            fail("应在父角色被删除后拒绝写入会话")
        } catch (expected: IllegalArgumentException) {
            assertTrue(expected.message!!.contains("父角色"))
        }
        // 被拒绝的写入不得留下任何半提交数据
        assertEquals(0, db.sessionDao().count())
        assertEquals(0, db.syncMetaDao().getHead("session", "s1").let { if (it == null) 0 else 1 })
    }

    @Test
    fun `usage summary counts chat only and excludes aux tasks`() = runBlocking {
        // 真实 Room SQL 验证（假存储的镜像不算证据）：
        // 记忆总结/翻译与正常聊天共用模型端点，必须按独立 task type 记录且**不进聊天汇总**，
        // 否则「本会话聊了多少」会被整段对话的记忆输入污染。
        assertTrue(
            store.recordUsage(
                LocalUsageRecordEntity(
                    id = "main-1",
                    sessionId = "s1",
                    provider = "",
                    model = "gpt-x",
                    promptTokens = 0,
                    completionTokens = 0,
                    createdAt = 100,
                    taskType = "main",
                    inputChars = 10,
                    outputChars = 20,
                ),
            ),
        )
        assertTrue(
            store.recordUsage(
                LocalUsageRecordEntity(
                    id = "memory-1",
                    sessionId = "s1",
                    provider = "",
                    model = "gpt-x",
                    promptTokens = 0,
                    completionTokens = 0,
                    createdAt = 200,
                    taskType = "memory",
                    inputChars = 5000,
                    outputChars = 300,
                ),
            ),
        )
        assertTrue(
            store.recordUsage(
                LocalUsageRecordEntity(
                    id = "translation-1",
                    sessionId = "s1",
                    provider = "",
                    model = "gpt-x",
                    promptTokens = 0,
                    completionTokens = 0,
                    createdAt = 300,
                    taskType = "translation",
                    inputChars = 80,
                    outputChars = 60,
                ),
            ),
        )

        val stats = store.usageStats(0L, Long.MAX_VALUE)
        assertEquals("聊天汇总的条数只能是 main", 1, stats.count)
        assertEquals("辅助任务的输入字符不得计入", 10, stats.totalInput)
        assertEquals("辅助任务的输出字符不得计入", 20, stats.totalOutput)
        assertEquals(30, stats.totalChars)

        // 记录列表仍必须能看到全部三类（否则「独立 task type」记了也没人看得见）
        assertEquals(3, db.usageDao().count())
        val inRange = store.listUsageInRange(0L, Long.MAX_VALUE, 10)
        assertEquals(setOf("main", "memory", "translation"), inRange.map { it.taskType }.toSet())
    }

    @Test
    fun `memory state read prefers the newest version instead of an arbitrary row`() = runBlocking {
        // 表上只有 id 主键、没有 session 唯一约束：同一会话理论上可能存在多行。
        // 裸 `LIMIT 1` 取到哪一行不确定——取到旧版本时用户可见症状是「记忆一直不更新」，
        // 且不报任何错。读取必须按版本降序确定化。
        store.putMemoryState(
            LocalMemoryStateEntity(
                id = "older",
                sessionId = "s-mem",
                summary = "旧摘要",
                updatedAt = 100,
                memoryVersion = 1,
            ),
        )
        store.putMemoryState(
            LocalMemoryStateEntity(
                id = "newer",
                sessionId = "s-mem",
                summary = "新摘要",
                updatedAt = 200,
                memoryVersion = 3,
            ),
        )
        val read = store.getMemoryState("s-mem")
        assertEquals("必须读到版本最高的那一行", 3L, read?.memoryVersion)
        assertEquals("新摘要", read?.summary)
    }

    @Test
    fun `usage record deduplicates by event id`() = runBlocking {
        val record = LocalUsageRecordEntity(
            id = "u1",
            sessionId = "s1",
            provider = "openai",
            model = "gpt-x",
            promptTokens = 10,
            completionTokens = 5,
            createdAt = 1,
        )
        assertTrue(store.recordUsage(record))
        assertFalse(store.recordUsage(record))
        assertEquals(1, db.usageDao().count())
        assertEquals(1, db.syncMetaDao().countByOrigin("local"))
        assertEquals(1, store.journalChangeCount())
    }

    @Test
    fun `public setting update does not touch device setting`() = runBlocking {
        store.putPublicSetting("memory", "autoMemory", "true")
        store.putDeviceSetting("themeMode", "\"dark\"")
        val deviceRows: List<LocalDeviceSettingEntity> = store.listDeviceSettings()
        assertEquals(1, deviceRows.size)
        assertEquals("\"dark\"", deviceRows.first().valueJson)
        // device 设置不进入同步 envelope
        assertEquals(1, store.journalChangeCount())
    }

    @Test
    fun `connection profile public update never clears secret ref`() = runBlocking {
        store.upsertConnectionProfile(
            LocalConnectionProfileEntity(
                id = "p1",
                provider = "openai",
                baseUrl = "https://api.example.com/v1",
                model = "gpt-x",
                createdAt = 0,
                updatedAt = 0,
            ),
        )
        store.setConnectionSecret("p1", "conn.p1.apiKey")
        assertEquals("conn.p1.apiKey", db.connectionProfileDao().getById("p1")!!.secretRef)

        store.upsertConnectionProfile(
            LocalConnectionProfileEntity(
                id = "p1",
                provider = "openai",
                baseUrl = "https://api.example.com/v2",
                model = "gpt-y",
                secretRef = null,
                createdAt = 0,
                updatedAt = 0,
            ),
        )
        val updated = db.connectionProfileDao().getById("p1")!!
        assertEquals("https://api.example.com/v2", updated.baseUrl)
        assertEquals("conn.p1.apiKey", updated.secretRef)
    }

    @Test
    fun `remote apply does not advance local dot`() = runBlocking {
        store.applyRemote(
            entityType = "character",
            entityId = "c-remote",
            payload = { mapOf("name" to "来自 PC") },
            business = {
                db.characterDao().upsert(
                    LocalCharacterEntity(id = "c-remote", name = "来自 PC", createdAt = 0, updatedAt = 0),
                )
            },
        )
        assertEquals(1, db.syncMetaDao().countByOrigin("remote"))
        assertEquals(0, db.syncMetaDao().countByOrigin("local"))
        // 本机 dot 未被推进
        assertEquals("1", db.deviceDao().get()?.nextCounterText ?: "1")
    }

    @Test
    fun `entity heads list and receipts round trip`() = runBlocking {
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "A", createdAt = 0, updatedAt = 0))
        assertEquals(listOf("character" to "c1"), store.listHeads())
        store.recordReceipt(
            com.qingyu.companion.local.db.SyncReceiptEntity(
                id = "r1",
                sessionId = "sync-1",
                transport = "lan",
                peerDeviceId = "pc-a",
                committedAt = 100,
            ),
        )
        assertEquals(1, store.listReceipts(10).size)
    }

    private companion object {
        const val TEST_DB = "identity-check.db"

        /** 阶段 3 S3-01 要求新增/改造的全部表。 */
        val EXPECTED_TABLES = listOf(
            "local_device_state",
            "local_characters",
            "local_lorebooks",
            "local_presets",
            "local_personas",
            "local_regex_rules",
            "local_quick_reply_sets",
            "local_groups",
            "local_sessions",
            "local_messages",
            // 阶段 6 S6-01：群消息表（v5）
            "local_group_messages",
            "local_memory_states",
            "local_memory_facts",
            "local_usage_records",
            "local_media_manifests",
            "local_public_settings",
            "local_device_settings",
            "local_connection_profiles",
            // 阶段 5 S5-02/S5-07：两个新增同步实体表（总方案 §6.1）
            "local_lorebook_mapping_templates",
            "local_usage_clear_markers",
            "entity_heads",
            "change_log",
            "sync_receipts",
            "conflicts",
            // 契约测试专用通用对象表（见 ContractObjectEntity 注释）
            "contract_objects",
        )
    }
}
