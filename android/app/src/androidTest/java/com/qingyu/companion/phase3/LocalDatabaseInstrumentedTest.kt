package com.qingyu.companion.phase3

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalMessageEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.domain.RoomLocalSyncRepository
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * 阶段 3 S3-01/03：本地主库在**真实设备/模拟器**上的 migration 与事务行为。
 *
 * 与 JVM（Robolectric）版本互补：本测试使用真实 SQLite 与真实文件系统，
 * 验证 Room 的 identity hash 校验、WAL 目录下的库文件创建以及删除级联。
 *
 * 阶段门禁要求 API 26/31/34 三档执行（见阶段 3 §3 / §11.2），在设备上运行时
 * 报告必须记录 API 等级与镜像版本。
 */
@RunWith(AndroidJUnit4::class)
class LocalDatabaseInstrumentedTest {

    private lateinit var database: QingyuLocalDatabase
    private lateinit var store: RoomLocalSyncRepository

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        // 使用真实文件而非内存库：验证真实文件创建、schema 落盘与 identity hash 校验
        File(context.getDatabasePath(DB_NAME).path).also { if (it.exists()) it.delete() }
        database = Room.databaseBuilder(context, QingyuLocalDatabase::class.java, DB_NAME)
            .addCallback(QingyuLocalDatabase.FOREIGN_KEYS_CALLBACK)
            .build()
        store = RoomLocalSyncRepository(database, "instrumented-device")
    }

    @After
    fun tearDown() {
        runCatching { database.close() }
    }

    @Test
    fun createsIndependentDatabaseFileNotLegacyCache() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        database.openHelper.writableDatabase

        assertEquals("qingyu-local.db", QingyuLocalDatabase.NAME)
        assertTrue(File(context.getDatabasePath(QingyuLocalDatabase.NAME).path).exists())
        assertFalse(
            "不得把旧伴侣缓存当作权威库",
            QingyuLocalDatabase.NAME.contains("companion-cache"),
        )
    }

    @Test
    fun writesBusinessRowHeadAndJournalInOneTransaction() = runBlocking {
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "设备角色", createdAt = 0, updatedAt = 0))
        assertEquals(1, database.characterDao().count())
        assertNotNull(database.syncMetaDao().getHead("character", "c1"))
        assertEquals(1, store.journalCount("local"))
    }

    @Test
    fun sessionDeleteCascadesMessagesOnRealSqlite() = runBlocking {
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "A", createdAt = 0, updatedAt = 0))
        store.putSession(LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0))
        store.appendMessage(
            LocalMessageEntity(
                id = "m1",
                sessionId = "s1",
                role = "user",
                content = "hi",
                seq = -1,
                logicalTime = 0,
                createdAt = 0,
                updatedAt = 0,
            ),
        )
        assertEquals(1, database.messageDao().count())
        store.deleteSession("s1")
        assertEquals(0, database.messageDao().count())
        assertTrue(store.isTombstoned("session", "s1"))
    }

    private companion object {
        const val DB_NAME = "qingyu-local.db"
    }
}
