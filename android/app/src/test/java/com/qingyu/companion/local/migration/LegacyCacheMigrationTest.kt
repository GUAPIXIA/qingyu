package com.qingyu.companion.local.migration

import android.content.Context
import androidx.room.Room
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.domain.MigrationIdentity
import com.qingyu.companion.local.domain.RoomLocalSyncRepository
import com.qingyu.companion.local.domain.VersionVectorJson
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.util.UUID

/**
 * 阶段 3 S3-02：旧伴侣缓存一次性迁移的真实文件级测试。
 *
 * 覆盖：v1—v7 schema 差异吸收、WAL 未 checkpoint、损坏库、快照只读复制、
 * 三种决策、outbox 三分类、共同 genesis 不产生并发版本。
 *
 * **隔离策略**：每个用例使用独立的旧库/快照文件与独立的新主库文件名
 * （经 [LegacyCacheReader] 的名称注入）。Windows 上 Robolectric 会延迟释放 SQLite
 * 文件句柄，复用同一文件名会让上一用例残留的 v7 库导致「Can't downgrade」。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class LegacyCacheMigrationTest {

    private lateinit var context: Context
    private lateinit var reader: LegacyCacheReader
    private var localDb: QingyuLocalDatabase? = null
    private var legacyDb: SupportSQLiteDatabase? = null
    private val suffix = UUID.randomUUID().toString().take(8)

    private val legacyName get() = "qingyu-companion-cache-$suffix"
    private val snapshotName get() = "qingyu-companion-cache-$suffix.snapshot"
    private val localName get() = "qingyu-local-migration-test-$suffix.db"

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
        reader = LegacyCacheReader(context, legacyDbName = legacyName, snapshotDbName = snapshotName)
    }

    @After
    fun tearDown() {
        runCatching { legacyDb?.close() }
        legacyDb = null
        runCatching { localDb?.close() }
        localDb = null
        runCatching { android.database.sqlite.SQLiteDatabase.releaseMemory() }
    }

    /** 重建旧库（v7 形状，含 cached_sessions/cached_messages/outbox_messages）。 */
    private fun createLegacyDatabase(seed: (SupportSQLiteDatabase) -> Unit): SupportSQLiteDatabase =
        createLegacyDatabase(version = 7, withOutbox = true, withGenerationColumns = true, seed = seed)

    /**
     * 重建指定版本形状的旧库（S3-01 要求为旧缓存 v1—v7 建立兼容测试）。
     * 老版本没有 `outbox_messages`，也没有 v7 新增的收尾状态列 —— 读取器必须靠列探测吸收差异。
     */
    private fun createLegacyDatabase(
        version: Int,
        withOutbox: Boolean,
        withGenerationColumns: Boolean,
        seed: (SupportSQLiteDatabase) -> Unit,
    ): SupportSQLiteDatabase {
        runCatching { legacyDb?.close() }
        legacyDb = null
        val configuration = SupportSQLiteOpenHelper.Configuration.builder(context)
            .name(legacyName)
            .callback(object : SupportSQLiteOpenHelper.Callback(version) {
                override fun onCreate(db: SupportSQLiteDatabase) {
                    db.execSQL(
                        "CREATE TABLE cached_sessions (id TEXT PRIMARY KEY NOT NULL, characterId TEXT NOT NULL, " +
                            "characterName TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL, " +
                            "updatedAt INTEGER NOT NULL, messageCount INTEGER NOT NULL, lastMessage TEXT NOT NULL)",
                    )
                    val generationColumns = if (withGenerationColumns) {
                        ", generationNotice TEXT, generationError TEXT, contentRenderMode TEXT"
                    } else {
                        ""
                    }
                    db.execSQL(
                        "CREATE TABLE cached_messages (id TEXT PRIMARY KEY NOT NULL, sessionId TEXT NOT NULL, " +
                            "characterId TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, images TEXT NOT NULL, " +
                            "timestamp INTEGER NOT NULL, translation TEXT, swipes TEXT, swipeIndex INTEGER, " +
                            "replyToId TEXT, usage TEXT$generationColumns)",
                    )
                    if (withOutbox) {
                        db.execSQL(
                            "CREATE TABLE outbox_messages (requestId TEXT PRIMARY KEY NOT NULL, sessionId TEXT NOT NULL, " +
                                "content TEXT NOT NULL, imagesJson TEXT NOT NULL, replyToId TEXT, createdAt INTEGER NOT NULL, " +
                                "retryCount INTEGER NOT NULL, state TEXT NOT NULL, error TEXT, deviceId TEXT NOT NULL, " +
                                "characterId TEXT, updatedAt INTEGER NOT NULL, nextAttemptAt INTEGER, " +
                                "remoteUserMessageId TEXT, taskId TEXT, lastErrorCode TEXT, lastErrorMessage TEXT)",
                        )
                    }
                }

                override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
            })
            .build()
        val db = FrameworkSQLiteOpenHelperFactory().create(configuration).writableDatabase
        seed(db)
        legacyDb = db
        return db
    }

    private fun newLocalStore(): RoomLocalSyncRepository {
        val database = Room.databaseBuilder(context, QingyuLocalDatabase::class.java, localName)
            .allowMainThreadQueries()
            .addCallback(QingyuLocalDatabase.FOREIGN_KEYS_CALLBACK)
            .build()
        localDb = database
        return RoomLocalSyncRepository(database, "android-device-a")
    }

    /** 旧库 -> 只读快照 -> 导入；返回导入结果。 */
    private suspend fun importIntoLocal(
        reader: LegacyCacheReader,
        store: RoomLocalSyncRepository,
        genesisManifest: Map<Pair<String, String>, String> = emptyMap(),
    ): LegacyImportResult {
        reader.snapshotLegacyCache()
        val snapshot = reader.openSnapshot()
        assertNotNull("快照必须可打开", snapshot)
        snapshot!!
        return try {
            store.initDeviceState()
            LegacyCacheImporter(reader).importInto(snapshot, store, genesisManifest)
        } finally {
            runCatching { snapshot.close() }
        }
    }

    @Test
    fun `reader absorbs schema differences across legacy v1 to v7`() {
        // v1 形状：没有 outbox_messages，也没有 v7 新增的收尾状态列
        createLegacyDatabase(version = 1, withOutbox = false, withGenerationColumns = false) { db ->
            db.execSQL("INSERT INTO cached_sessions VALUES ('s-old','char-old','老角色','老会话',10,20,1,'你好')")
            db.execSQL(
                "INSERT INTO cached_messages VALUES ('m-old','s-old','char-old','user','你好','[]',10,NULL,NULL,NULL,NULL,NULL)",
            )
        }
        val reader = LegacyCacheReader(context, legacyDbName = legacyName, snapshotDbName = snapshotName)
        reader.snapshotLegacyCache()
        val db = reader.openSnapshot()
        assertNotNull("v1 形状的旧库快照必须可打开", db)
        db!!

        assertEquals(1, reader.readVersion(db))
        // 缺 outbox 表：不得抛异常，草稿/对账计数为 0
        val scan = reader.scan(db)
        assertEquals(1, scan.schemaVersion)
        assertEquals(1, scan.sessionCount)
        assertEquals(1, scan.messageCount)
        assertEquals(0, scan.outboxUnsentCount)
        assertEquals(0, scan.outboxConfirmedCount)
        assertTrue(scan.hasAnyData)

        // 导入仍需成功（列探测吸收差异）
        val store = newLocalStore()
        val result = runBlocking {
            store.initDeviceState()
            LegacyCacheImporter(reader).importInto(db, store)
        }
        db.close()
        assertEquals(1, result.importedSessions)
        assertEquals(1, result.importedMessages)
        assertEquals(0, result.outboxDrafts)

        // 原始旧库文件未被改写
        assertTrue(reader.legacyDatabaseExists())
    }

    @Test
    fun `snapshot copies legacy database and wal without rewriting`() {
        val db = createLegacyDatabase { }
        val reader = LegacyCacheReader(context, legacyDbName = legacyName, snapshotDbName = snapshotName)
        assertTrue(reader.legacyDatabaseExists())

        val legacyFile = context.getDatabasePath(legacyName)
        val beforeLegacyBytes = legacyFile.readBytes()

        val snapshot = reader.snapshotLegacyCache()
        assertTrue(snapshot.created)
        assertTrue(snapshot.copiedFiles.contains(snapshotName))
        assertTrue(reader.snapshotExists())

        // 快照已自包含（副本 WAL 被 checkpoint 合并后删除）
        assertFalse(File(snapshotFile().path + "-wal").exists())

        // 旧库内容逐字节未变（只读，不原地升级）
        assertTrue(beforeLegacyBytes.contentEquals(legacyFile.readBytes()))

        db.close()
        legacyDb = null
    }

    @Test
    fun `scan reports counts and warnings for projected cache`() {
        val db = createLegacyDatabase { it.seedSample() }
        val reader = LegacyCacheReader(context, legacyDbName = legacyName, snapshotDbName = snapshotName)
        val scan = reader.scan(db)

        assertEquals(7, scan.schemaVersion)
        assertTrue(scan.hasAnyData)
        assertEquals(2, scan.characterCount)
        assertEquals(2, scan.sessionCount)
        assertEquals(3, scan.messageCount)
        assertEquals(1, scan.outboxUnsentCount)
        assertEquals(1, scan.outboxConfirmedCount)

        val importer = LegacyCacheImporter(reader)
        val warnings = importer.evaluate(scan)
        assertTrue(warnings.any { it.entityType == "cache" })
        assertTrue(warnings.any { it.entityType == "outbox" })
    }

    @Test
    fun `snapshot import preserves ids and marks provenance`() = runBlocking {
        createLegacyDatabase { it.seedSample() }

        val reader = LegacyCacheReader(context, legacyDbName = legacyName, snapshotDbName = snapshotName)
        val store = newLocalStore()
        val result = importIntoLocal(reader, store)

        assertEquals("legacy_companion_cache", result.importedFrom)
        assertEquals(2, result.importedCharacters)
        assertEquals(2, result.importedSessions)
        assertEquals(3, result.importedMessages)
        // outbox：1 条未确认 -> 草稿；1 条已确认 -> 对账
        assertEquals(1, result.outboxDrafts)
        assertEquals(1, result.outboxReconciled)

        val character = store.getCharacter("char-1")
        assertNotNull(character)
        assertEquals("旧角色一", character!!.name)
        assertEquals("legacy_companion_cache", character.importedFrom)

        val messages = store.listMessages("sess-1")
        assertEquals(2, messages.size)
        assertEquals(listOf(0L, 1L), messages.map { it.seq })
        assertEquals("legacy_companion_cache", messages.first().importedFrom)

        // 每个导入实体都留下 journal；离线独有内容走 local dot
        assertTrue(store.journalChangeCount() >= 7)
        assertTrue(result.warnings.any { it.entityType == "outbox" && it.message.contains("草稿") })
    }

    @Test
    fun `same id and same hash inherits genesis without new concurrent version`() = runBlocking {
        createLegacyDatabase { it.seedSample() }

        val reader = LegacyCacheReader(context, legacyDbName = legacyName, snapshotDbName = snapshotName)
        val store = newLocalStore()

        // 构造与导入时一致的角色/会话 payload 哈希，模拟从 PC 拿到的 migration genesis manifest
        val characterHash = MigrationIdentity.contentHash(
            LegacyCacheImporter.characterPayload(
                com.qingyu.companion.local.db.LocalCharacterEntity(
                    id = "char-1",
                    name = "旧角色一",
                    importedFrom = "legacy_companion_cache",
                    createdAt = 0,
                    updatedAt = 0,
                ),
            ),
        )
        val sessionHash = MigrationIdentity.contentHash(
            LegacyCacheImporter.sessionPayload(
                // createdAt/updatedAt 必须与 `seedSample()` 里那一行**完全一致**
                // （'sess-1','char-1','旧角色一','会话一',1000,2000,…）：
                // 会话 payload 按契约是要带 createdAt/updatedAt 的，填 0 就等于拿一份
                // 真实导入永远不会产出的数据去预测哈希，genesis 自然继承不上。
                com.qingyu.companion.local.db.LocalSessionEntity(
                    id = "sess-1",
                    characterId = "char-1",
                    title = "会话一",
                    importedFrom = "legacy_companion_cache",
                    createdAt = 1000,
                    updatedAt = 2000,
                ),
            ),
        )
        val manifest = mapOf(
            ("character" to "char-1") to characterHash,
            ("session" to "sess-1") to sessionHash,
        )

        importIntoLocal(reader, store, manifest)

        // 同源投影 -> origin = migration，不生成本机并发 dot
        val charHead = store.getHead("character", "char-1")!!
        assertTrue(
            "同源投影不应带本机 counter",
            VersionVectorJson.decode(charHead.versionJson).isEmpty(),
        )
        // 离线独有内容（char-2 不在 manifest）仍走本机 dot
        assertTrue(store.journalCount("local") >= 1)
        assertTrue(store.journalCount("migration") >= 2)
    }

    @Test
    fun `failed import can be rolled back without destructive fallback`() = runBlocking {
        createLegacyDatabase { it.seedSample() }

        val reader = LegacyCacheReader(context, legacyDbName = legacyName, snapshotDbName = snapshotName)
        val store = newLocalStore()
        importIntoLocal(reader, store)

        // 旧库始终可读、结构未被改写（无 destructive fallback）
        assertTrue(reader.legacyDatabaseExists())
        val snapshotDb = reader.openSnapshot()!!
        assertFalse(reader.isCorrupted(snapshotDb))
        assertEquals(7, reader.readVersion(snapshotDb))
        snapshotDb.close()

        assertTrue(store.listCharacters().isNotEmpty())

        // 模拟 LocalSetupViewModel 的回滚路径：逐条删除已导入实体并写 tombstone
        store.listCharacters().forEach { store.deleteCharacter(it.id) }
        store.listSessions().forEach { store.deleteSession(it.id) }
        assertEquals(0, store.listCharacters().size)
        assertEquals(0, store.listSessions().size)
        assertTrue(store.isTombstoned("character", "char-1"))
        // 回滚不清 change_log，也不删旧缓存快照
        assertTrue(store.journalChangeCount() > 0)
        assertTrue(reader.snapshotExists())
    }

    @Test
    fun `corrupted legacy database is detected and does not crash the reader`() {
        val file = context.getDatabasePath(legacyName)
        file.parentFile?.mkdirs()
        file.writeBytes("this is not a sqlite database".toByteArray())

        val reader = LegacyCacheReader(context, legacyDbName = legacyName, snapshotDbName = snapshotName)
        val db = reader.openSnapshot()
        if (db != null) {
            // 打开失败或被判定为损坏，两条路径都不得抛异常
            assertTrue(reader.isCorrupted(db))
            db.close()
        }
        assertTrue(reader.legacyDatabaseExists())
    }

    @Test
    fun `three choices produce distinct plans`() {
        val importer = LegacyCacheImporter()
        val scan = LegacyCacheScan(
            schemaVersion = 7,
            hasAnyData = true,
            characterCount = 4,
            sessionCount = 2,
            messageCount = 9,
            outboxUnsentCount = 3,
            outboxConfirmedCount = 1,
        )
        val imported = importer.plan(scan, LegacyImportChoice.ImportAsLocalCopy)
        assertEquals(4, imported.importedCharacters)
        assertEquals(3, imported.outboxDrafts)
        assertEquals(1, imported.outboxReconciled)

        val skipped = importer.plan(scan, LegacyImportChoice.BackupAndSkip)
        assertEquals(0, skipped.importedCharacters)
        assertEquals(0, skipped.importedMessages)

        val aborted = importer.plan(scan, LegacyImportChoice.AbortUpgrade)
        assertEquals(0, aborted.importedCharacters)
        assertEquals(0, aborted.importedMessages)
    }

    private fun snapshotFile(): File = context.getDatabasePath(snapshotName)

    private fun SupportSQLiteDatabase.seedSample() {
        execSQL("INSERT INTO cached_sessions VALUES ('sess-1','char-1','旧角色一','会话一',1000,2000,2,'你好')")
        execSQL("INSERT INTO cached_sessions VALUES ('sess-2','char-2','旧角色二','会话二',1000,1500,1,'在吗')")
        execSQL("INSERT INTO cached_messages VALUES ('msg-1','sess-1','char-1','user','你好','[]',1000,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)")
        execSQL("INSERT INTO cached_messages VALUES ('msg-2','sess-1','char-1','assistant','你也好','[]',1100,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)")
        execSQL("INSERT INTO cached_messages VALUES ('msg-3','sess-2','char-2','user','在吗','[]',1200,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)")
        // 未确认发送：保留为本地草稿
        execSQL(
            "INSERT INTO outbox_messages VALUES ('req-1','sess-1','草稿内容','[]',NULL,1300,1,'queued',NULL,'pc-a','char-1',1300,NULL,NULL,NULL,NULL,NULL)",
        )
        // 已由 PC 确认：与 PC 对账后转为正式消息（completed + remoteUserMessageId）
        execSQL(
            "INSERT INTO outbox_messages VALUES ('req-2','sess-2','已确认内容','[]',NULL,1400,0,'completed',NULL,'pc-a','char-2',1400,NULL,'remote-msg-9',NULL,NULL,NULL)",
        )
    }

}
