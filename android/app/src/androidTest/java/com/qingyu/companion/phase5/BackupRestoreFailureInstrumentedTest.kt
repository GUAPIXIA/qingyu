package com.qingyu.companion.phase5

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.content.backup.BackupOrchestrator
import com.qingyu.companion.content.backup.BackupV3
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalLorebookEntity
import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.local.domain.RoomLocalSyncRepository
import java.io.File
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 阶段 5 §3：Backup V3 的**恢复回滚**与**磁盘写失败**（方案 §S5-08
 * 「先全包校验 + 预览，再 checkpoint 和原子应用」的失败分支）。
 *
 * 为什么只能在设备上跑：这三条性质全部由**真实文件系统 + 真实 SQLite 事务**决定，
 * JVM 替身里 `renameTo`、只读目录、`withTransaction` 的倒带都是被 mock 掉的，
 * 用替身测出来的绿等于没测。
 *
 * 三条失败路径要分开证明，因为它们的**善后义务不同**：
 * 1. 媒体还没落盘就失败（写不进去）→ 库一行都不该变；
 * 2. 事务内部失败（模拟 ENOSPC 在写边界抛出）→ 整笔倒带，先前成功的写入也不能残留；
 * 3. 事务已提交、媒体 move 才失败 → **库已经变了**，此时报「已回滚」是假话。
 *
 * 「磁盘满」用的是**写边界失败**这个等价路径（只读目录 / 注入 IOException），
 * 不是真的把分区写满：GMD 模拟器上填满是几百 MB 的写放大且会污染同一宿主上的其它用例。
 * 这个区别必须写清楚，否则下一个人会以为 ENOSPC 本身被覆盖过了。
 */
@RunWith(AndroidJUnit4::class)
class BackupRestoreFailureInstrumentedTest {

    private lateinit var database: QingyuLocalDatabase
    private lateinit var store: RoomLocalSyncRepository
    private lateinit var mediaRoot: File

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val dbFile = File(context.getDatabasePath(DB_NAME).path)
        if (dbFile.exists()) dbFile.delete()
        database = Room.databaseBuilder(context, QingyuLocalDatabase::class.java, DB_NAME)
            .addCallback(QingyuLocalDatabase.FOREIGN_KEYS_CALLBACK)
            .build()
        store = RoomLocalSyncRepository(database, DEVICE_ID)
        mediaRoot = File(context.cacheDir, "backup-media-${UUID.randomUUID()}").apply { mkdirs() }
    }

    @After
    fun tearDown() {
        runCatching { database.close() }
        runCatching { mediaRoot.deleteRecursively() }
    }

    @Test
    fun mediaThatCannotBeStagedLeavesTheDatabaseCompletelyUntouched() = runBlocking {
        seedLocalCharacter("local-1")
        mediaRoot.mkdirs()
        // 只读目录 = 写边界失败（ENOSPC 的等价路径）：媒体连暂存目录都建不起来
        assertTrue("无法把媒体目录设成只读，用例前提不成立", mediaRoot.setReadOnly())
        val bundle = bundleWith(characterJson("from-backup"), mediaEntry = "avatar.png" to ByteArray(8))
        val outcome = BackupOrchestrator(store, mediaRoot, "test").restore(bundle)

        assertFalse("媒体写失败却报告成功", outcome.ok)
        assertTrue("媒体写失败必须报成已回滚：${outcome.error}", outcome.rolledBack)
        assertEquals(listOf("local-1"), store.listCharacters().map { it.id }.sorted())
    }

    @Test
    fun failureInsideTheTransactionRollsBackWritesThatAlreadySucceeded() = runBlocking {
        seedLocalCharacter("local-1")
        // 恢复顺序是「角色 → 世界书 → …」，所以在 putLorebook 上抛异常可以证明
        // **先前成功的那次 putCharacter 也一起倒带**——这才叫原子应用。
        val bomb = ExplodingStore(store)
        val bundle = bundleWith(characterJson("from-backup"), lorebookJson("lb-9"))
        val outcome = BackupOrchestrator(bomb, mediaRoot, "test").restore(bundle)

        assertTrue("用例前提：必须在写世界书时被拦下", bomb.threwOnLorebook)
        assertFalse(outcome.ok)
        assertTrue("事务内失败必须整体回滚：${outcome.error}", outcome.rolledBack)
        assertTrue("回滚后 counts 必须是空，否则 UI 会报成一个都没改却应用了 N 条", outcome.applied.isEmpty())
        assertEquals(listOf("local-1"), store.listCharacters().map { it.id }.sorted())
        assertTrue(store.listLorebooks().isEmpty())
    }

    @Test
    fun mediaMoveFailureAfterCommitReportsWhatWasActuallyApplied() = runBlocking {
        seedLocalCharacter("local-1")
        // 目标位置预先放一个**非空目录**：POSIX 上 rename 到非空目录会失败，
        // 于是失败点落在事务提交之后——这正是上一版把结果报成「已回滚」的那条路。
        val blocker = File(mediaRoot, "avatar.png").apply { mkdirs() }
        File(blocker, "occupied").writeText("x")

        val bundle = bundleWith(characterJson("from-backup"), mediaEntry = "avatar.png" to ByteArray(8))
        val outcome = BackupOrchestrator(store, mediaRoot, "test").restore(bundle)

        assertFalse("媒体没落位不能算恢复成功", outcome.ok)
        assertFalse(
            "事务已提交却报「已回滚」是假话——库真的被改过了，必须如实上报：" + outcome.error,
            outcome.rolledBack,
        )
        assertNotNull(outcome.error)
        assertTrue("错误文案要指出是媒体落位失败：${outcome.error}", "媒体文件落位失败" in outcome.error!!)
        // 真实状态：角色已经按备份应用了，本地那一行也还在（恢复是合并而不是整库替换）
        assertEquals(listOf("from-backup", "local-1"), store.listCharacters().map { it.id }.sorted())
        assertTrue("已应用的 counts 必须回传给 UI：${outcome.applied}", (outcome.applied["characters"] ?: 0) == 1)
    }

    /**
     * 单条目体积上限要**由上限判定**拒掉，而不是靠堆内存先崩。
     *
     * 这条只能在设备上测：它需要真的解压出 64 MiB+1，而单测的 JVM 堆先来不了这个
     * （阶段 5 报告 §5-P1-d 记的就是这件事：上一版这条断言在 JVM 里被
     * `OutOfMemoryError` 变成「ZIP 解析失败：Java heap space」，测的是堆不是上限）。
     * 高压缩比载荷（全零）让包本身只有几十 KB，压的是解压侧。
     */
    @Test
    fun oversizedSingleEntryIsRejectedByTheLimitNotByTheHeap() {
        val oversized = ByteArray((BackupV3.MAX_SINGLE_ENTRY_BYTES + 1).toInt())
        val entry = BackupV3.Entry(BackupV3.Paths.CHARACTERS + "big.json", oversized)
        val manifest = BackupV3.manifestOf(
            entries = listOf(entry),
            appVersion = "test",
            platform = "android",
            now = 1_700_000_000_000L,
            counts = mapOf("characters" to 1),
        )
        val bytes = BackupV3.build(listOf(entry), manifest)
        val result = BackupV3.inspect(bytes)

        val rejected = requireNotNull(result as? BackupV3.InspectResult.Rejected) {
            "超过单条目上限的包竟然通过了校验：$result"
        }
        val reason = rejected.reason
        assertTrue("上限判定没有生效（$reason）", "单条目过大" in reason)
        assertFalse("是堆崩了不是上限拦的（$reason）", "heap space" in reason)
    }

    // ------------------------------------------------------------ 造包与探针

    private suspend fun seedLocalCharacter(id: String) {
        store.putCharacter(LocalCharacterEntity(id = id, name = "本地角色", createdAt = 1L, updatedAt = 1L))
    }

    private fun characterJson(id: String) =
        BackupV3.Paths.CHARACTERS + "$id.json" to
            """{"id":"$id","name":"备份角色","createdAt":1,"updatedAt":1}"""

    private fun lorebookJson(id: String) =
        BackupV3.Paths.LOREBOOKS + "$id.json" to """{"id":"$id"}"""

    private fun bundleWith(vararg jsonEntries: Pair<String, String>, mediaEntry: Pair<String, ByteArray>? = null): ByteArray {
        val entries = buildList {
            jsonEntries.forEach { (path, json) -> add(BackupV3.Entry(path, json.toByteArray())) }
            mediaEntry?.let { (name, bytes) -> add(BackupV3.Entry(BackupV3.Paths.MEDIA + name, bytes)) }
        }
        val manifest = BackupV3.manifestOf(
            entries = entries,
            appVersion = "test",
            platform = "android",
            now = 1_700_000_000_000L,
            counts = mapOf("characters" to jsonEntries.count { it.first.startsWith(BackupV3.Paths.CHARACTERS) }),
        )
        return BackupV3.build(entries, manifest)
    }

    /** 在写边界模拟磁盘满：世界书这一步直接抛 IOException，事务必须整体倒带。 */
    private class ExplodingStore(private val real: LocalStore) : LocalStore by real {
        var threwOnLorebook = false

        override suspend fun putLorebook(entity: LocalLorebookEntity) {
            threwOnLorebook = true
            throw IOException("No space left on device（用例注入：写世界书时磁盘满）")
        }
    }

    private companion object {
        const val DB_NAME = "phase5-backup-failure-test.db"
        const val DEVICE_ID = "phase5-backup-failure"
    }
}
