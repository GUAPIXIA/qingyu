package com.qingyu.companion.domain.contracts

import android.content.Context
import androidx.room.Room
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.domain.MigrationIdentity
import com.qingyu.companion.local.domain.PayloadTooLargeException
import com.qingyu.companion.local.domain.RoomLocalSyncRepository
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * 阶段 3 S3-03：跨语言 repository 契约套件（Kotlin 侧）。
 *
 * 读同一份 `shared/contracts/fixtures/repository/behavior-table.json`，
 * 对 Room 实现与内存实现分别执行；任何失败都说明「Room 实现与 PC 文件实现语义漂移」。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class RepositoryContractSuiteTest {

    private var database: QingyuLocalDatabase? = null

    @Before
    fun setUp() {
        val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
        database = Room.inMemoryDatabaseBuilder(context, QingyuLocalDatabase::class.java)
            .allowMainThreadQueries()
            .addCallback(QingyuLocalDatabase.FOREIGN_KEYS_CALLBACK)
            .build()
    }

    @After
    fun tearDown() {
        database?.close()
    }

    private fun behaviorTableJson(): String {
        val candidates = listOf(
            File("../shared/contracts/fixtures/repository/behavior-table.json"),
            File("shared/contracts/fixtures/repository/behavior-table.json"),
            File("../../shared/contracts/fixtures/repository/behavior-table.json"),
        )
        val file = candidates.firstOrNull { it.exists() }
            ?: error("找不到 behavior-table.json，尝试过：${candidates.map { it.absolutePath }}")
        return file.readText()
    }

    @Test
    fun `behavior table parses into expected case count`() {
        val cases = MiniJson.parseBehaviorTable(behaviorTableJson())
        assertTrue("behavior-table 用例数应大于 0", cases.isNotEmpty())
        assertTrue(
            "behavior-table 用例 id 必须唯一",
            cases.map { it.id }.toSet().size == cases.size,
        )
    }

    @Test
    fun `room local store satisfies shared repository contract`() {
        val cases = MiniJson.parseBehaviorTable(behaviorTableJson())
        val store = RoomLocalSyncRepository(database!!, "android-contract")
        val failures = RepositoryContractRunner.run(
            cases = cases,
            adapter = RoomContractAdapter(store),
            hashOf = { payload -> MigrationIdentity.contentHash(payload) },
        )
        assertTrue(
            "Room 实现未满足共享 repository 契约：\n" +
                failures.joinToString("\n") { "  [${it.caseId}] step ${it.stepIndex} ${it.op}: ${it.message}" },
            failures.isEmpty(),
        )
    }

    @Test
    fun `in memory store satisfies shared repository contract`() {
        val cases = MiniJson.parseBehaviorTable(behaviorTableJson())
        val failures = RepositoryContractRunner.run(
            cases = cases,
            adapter = FakeContractAdapter(),
            hashOf = { payload -> MigrationIdentity.contentHash(payload) },
        )
        assertTrue(
            "内存实现未满足共享 repository 契约：\n" +
                failures.joinToString("\n") { "  [${it.caseId}] step ${it.stepIndex} ${it.op}: ${it.message}" },
            failures.isEmpty(),
        )
    }

    @Test
    fun `invalid entity id is rejected by shared validator`() {
        assertTrue(!MigrationIdentity.isValidEntityId("../../evil"))
        assertTrue(!MigrationIdentity.isValidEntityId("a/b"))
        assertTrue(!MigrationIdentity.isValidEntityId("a\\b"))
        assertTrue(!MigrationIdentity.isValidEntityId(""))
        assertTrue(MigrationIdentity.isValidEntityId("01KZ3W8Q7Y6V5T4S3R2Q1P0N9M"))
    }

    @Test
    fun `payload above two mebibytes is rejected while boundary passes`() {
        // 边界内：接近 2 MiB 的文本 payload 正常通过
        val nearLimit = "x".repeat(MigrationIdentity.MAX_PAYLOAD_BYTES - 1024)
        val accepted = MigrationIdentity.requirePayloadWithinLimit(mapOf("content" to nearLimit))
        assertTrue(accepted.isNotEmpty())

        // 超限：必须抛异常，不得静默截断
        val tooLarge = "x".repeat(MigrationIdentity.MAX_PAYLOAD_BYTES + 1024)
        val rejected = runCatching {
            MigrationIdentity.requirePayloadWithinLimit(mapOf("content" to tooLarge))
        }
        assertTrue("超过 2 MiB 的 payload 必须被拒绝", rejected.isFailure)
        assertTrue(rejected.exceptionOrNull() is PayloadTooLargeException)
        assertEquals(
            MigrationIdentity.MAX_PAYLOAD_BYTES,
            (rejected.exceptionOrNull() as PayloadTooLargeException).limitBytes,
        )
    }

    @Test
    fun `oversized payload does not leave half committed rows`() {
        val store = RoomLocalSyncRepository(database!!, "android-contract")
        val tooLarge = "x".repeat(MigrationIdentity.MAX_PAYLOAD_BYTES + 4096)
        // 必须是**合法 JSON 对象**里塞超大正文：坏正文会被写入端的格式校验直接拒掉，
        // 那样本用例测的就成了「能不能解析 JSON」，而不是方案 §6.2 的 2 MiB payload 上限
        // 与事务原子性。两者都要守，但守的是各自那道门。
        val oversizedCanonical =
            """{"schema":"qingyu_lorebook","schemaVersion":2,"revision":1,"id":"lb-huge",""" +
                """"name":"超大","description":"$tooLarge","enabled":true,"entries":[]}"""
        val rejected = runBlocking {
            runCatching {
                store.putLorebook(
                    com.qingyu.companion.local.db.LocalLorebookEntity(
                        id = "lb-huge",
                        name = "超大",
                        canonicalJson = oversizedCanonical,
                        createdAt = 0,
                        updatedAt = 0,
                    ),
                )
            }
        }
        assertTrue(rejected.isFailure)
        // 事务回滚：不得留下业务行、head 或 journal
        assertTrue(runBlocking { store.listLorebooks() }.isEmpty())
        assertTrue(runBlocking { store.getHead("lorebook", "lb-huge") } == null)
        assertEquals(0, runBlocking { store.journalChangeCount() })
    }
}
