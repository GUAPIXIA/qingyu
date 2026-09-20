package com.qingyu.companion.phase5

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.content.lorebook.CanonicalLorebook
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalLorebookEntity
import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.domain.CharacterSortColumn
import com.qingyu.companion.local.domain.MigrationIdentity
import com.qingyu.companion.local.domain.PayloadTooLargeException
import com.qingyu.companion.local.domain.RoomLocalSyncRepository
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 阶段 5 §3 的压力矩阵：「500 角色、100 世界书 / 每书 5k 条、1k 预设等压力数据下列表可用」。
 *
 * ## 为什么必须在设备上跑
 * 这一格要证明的是**真实 SQLite 的查询形状**在压力数据下仍然成立：
 * `LIMIT`/`OFFSET` 有没有真的把行数压住、`LIKE` 有没有把不匹配的行挡在数据库外、
 * 一列几 MB 的 `canonical_json` 会不会把列表页拖死。JVM 替身（in-memory Room 或
 * `FakeLocalStore`）没有查询规划器也没有真实页缓存，量出来的耗时是替身的脾气。
 *
 * ## 「可用」在这里被翻译成三类可判定的断言，而不是「感觉不卡」
 * 1. **机制**：分页与搜索必须在数据库层完成（§2 的硬要求）——
 *    500 行库里取一页必须**只回一页**，总数由 `COUNT` 单独给，翻页不重叠；
 * 2. **不失真**：压力数据不能改变语义——5k 条的世界书存进去要原样读回 5k 条，
 *    列表页取 id 的路径不能被大列拖住；
 * 3. **有界**：墙钟上限取**远宽于实测**的值，只用来抓「数量级跑偏」
 *    （索引没建、把 100 本书的 JSON 全解析一遍这类），不用来卡性能小数点。
 *    实测数字由 `println` 落到报告的 XML system-out，报告引实测而不是引阈值。
 */
@RunWith(AndroidJUnit4::class)
class ContentLoadMatrixInstrumentedTest {

    private lateinit var database: QingyuLocalDatabase
    private lateinit var store: RoomLocalSyncRepository

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getDatabasePath(DB_NAME).path).also { if (it.exists()) it.delete() }
        database = Room.databaseBuilder(context, QingyuLocalDatabase::class.java, DB_NAME)
            .addCallback(QingyuLocalDatabase.FOREIGN_KEYS_CALLBACK)
            .build()
        store = RoomLocalSyncRepository(database, DEVICE_ID)
    }

    @After
    fun tearDown() {
        runCatching { database.close() }
    }

    @Test
    fun characterListStaysPagedAndSearchedInTheDatabaseAtFiveHundred() {
        val seedStart = System.nanoTime()
        repeat(CHARACTERS) { index ->
            runBlocking {
                store.putCharacter(
                    LocalCharacterEntity(
                        id = "c-%04d".format(index),
                        name = if (index % 25 == 0) "角色-7 特别条目 $index" else "角色 $index",
                        description = "描述 $index",
                        createdAt = 1L + index,
                        // updatedAt 必须逐行不同：排序列全是同一个值时 LIMIT/OFFSET 的
                        // 行序是不确定的，翻页重叠断言就会变成掷骰子。
                        updatedAt = 1L + index,
                    ),
                )
            }
        }
        val seedMillis = elapsedSince(seedStart)

        val pageStart = System.nanoTime()
        val page = runBlocking { store.searchCharacters("", CharacterSortColumn.UPDATED, PAGE_SIZE, 0) }
        val pageMillis = elapsedSince(pageStart)
        assertEquals("列表必须分页取，不能整库拉回内存", PAGE_SIZE, page.size)
        assertEquals("总数由 COUNT 给，与分页同口径", CHARACTERS, runBlocking { store.countCharacters("") })

        val searchStart = System.nanoTime()
        val hits = runBlocking { store.searchCharacters("角色-7", CharacterSortColumn.UPDATED, PAGE_SIZE, 0) }
        val searchMillis = elapsedSince(searchStart)
        val expectedHits = (0 until CHARACTERS).count { it % 25 == 0 }
        assertEquals("搜索必须把不匹配的行挡在数据库外", expectedHits, hits.size)
        assertTrue("命中里混进了不含关键词的行", hits.all { "角色-7" in it.name || "角色-7" in it.description })
        assertEquals("COUNT 与 LIMIT 两条查询的过滤口径必须一致", expectedHits, runBlocking { store.countCharacters("角色-7") })

        val first = runBlocking { store.searchCharacters("", CharacterSortColumn.UPDATED, PAGE_SIZE, 0) }.map { it.id }
        val second = runBlocking { store.searchCharacters("", CharacterSortColumn.UPDATED, PAGE_SIZE, PAGE_SIZE) }.map { it.id }
        assertEquals("翻页重叠（排序不稳定或 OFFSET 没生效）", 0, first.intersect(second.toSet()).size)
        assertEquals("翻页漏行", PAGE_SIZE, second.size)

        println(
            "LOAD 角色：seed $CHARACTERS 条=${seedMillis}ms；首页=${pageMillis}ms；搜索=${searchMillis}ms；" +
                "上限=${LIST_BUDGET_MS}ms",
        )
        assertTrue("列表查询超出预算（${pageMillis}ms）", pageMillis < LIST_BUDGET_MS)
        assertTrue("搜索查询超出预算（${searchMillis}ms）", searchMillis < LIST_BUDGET_MS)
    }

    /**
     * 方案 §3 的「每书 5k 条」在今天的同步契约下**存不进去**，这条用例把它钉成断言。
     *
     * 实测（API 34 GMD，2026-09-19）：5,000 条的 canonical 文档 = **2,467,984 字节**，
     * 而单条 payload 上限是 **2,097,152 字节**（`shared/syncBaseline/index.ts#MigrationIdentity.MAX_PAYLOAD_BYTES`
     * 与 `electron/domain/bootstrapScanners.ts#DEFAULT_MigrationIdentity.MAX_PAYLOAD_BYTES` 同值，
     * **两端共用**，不是 Android 自己加的），所以 `putLorebook` 在记账阶段就被
     * [com.qingyu.companion.local.domain.PayloadTooLargeException] 拒掉。
     * 折算下来一本书的条目数上限约 **4,245 条**（按每条 ~494 字节）。
     *
     * 于是阶段 5 §3 与同步契约互相矛盾：要么世界书大页走 blob 传输（异常文案自己说的
     * 「必须走 blob 传输」，那是阶段 6/8 的跨端改动），要么把压力口径改成「每书 ≤ 契约上限」。
     * 两条都不是本阶段能单方面决定的（改上限会同时改两端的哈希边界与 relay 的接受范围），
     * 已立案 **D-8**。
     *
     * 这条用例因此**不是**「测不过就放宽」：它断言的是当前真实行为与真实字节数，
     * 并且一旦有人偷偷抬高上限或补上 blob 路径，它会立刻变红，逼着那次改动同时更新
     * §3 的口径与 D-8 的结论。
     */
    @Test
    fun lorebookAtPlanScaleIsRefusedByTheSharedPayloadCap() {
        val oversized = lorebookWithEntries(0, ENTRIES_PER_BOOK).toJson()
        assertTrue(
            "5k 条样本本身就应该超过 2 MiB（实测 ${oversized.length} 字节）",
            oversized.length > MigrationIdentity.MAX_PAYLOAD_BYTES,
        )
        val error = runCatching {
            runBlocking {
                store.putLorebook(
                    LocalLorebookEntity(
                        id = "lb-oversize",
                        name = "超上限世界书",
                        canonicalJson = oversized,
                        createdAt = 1L,
                        updatedAt = 1L,
                    ),
                )
            }
        }.exceptionOrNull()
        assertNotNull("超过同步契约上限的世界书必须被拒，不能静默截断或整本丢弃", error)
        val tooLarge = error as? PayloadTooLargeException
        assertNotNull("拒绝原因必须是 payload 上限判定，实际：${error?.message}", tooLarge)
        assertEquals("上限值必须就是同步契约里的常量", MigrationIdentity.MAX_PAYLOAD_BYTES, tooLarge!!.limitBytes)
        assertTrue(
            "报出的实际字节数要与真实文档一致（实测 ${oversized.length}，异常报 ${tooLarge.actualBytes}）",
            tooLarge.actualBytes > MigrationIdentity.MAX_PAYLOAD_BYTES,
        )
        assertTrue("超过上限的书不能留下半个影子", runBlocking { store.getLorebook("lb-oversize") } == null)
        println("LOAD 世界书 5k 条：payload=${oversized.length} 字节 > 上限 $MigrationIdentity.MAX_PAYLOAD_BYTES 字节，按契约拒绝（D-8）")
    }

    /**
     * 在契约允许的规模上证明「列表可用」：100 本同库，其中 5 本压到上限附近。
     *
     * 为什么不是 100 × 5k：见上面那条——5k 根本存不进去。为什么也不是 100 × 3.5k：
     * 那是 ~173 MB 的 JSON，写进库还要再进一遍 change_log payload，合计 ~350 MB 设备写入，
     * 测的是模拟器磁盘而不是 App 的列表行为。这里取「多本 + 少量巨型」的真实形状：
     * 95 本常规书 + 5 本 ~3.5k 条（≈ 1.73 MB，离上限留 ~15% 余量），
     * 合计 100 本、约 1.9 万条目，列表与读回路径都在压力数据上走。
     */
    @Test
    fun oneHundredLorebooksWithLargeOnesStillListAndReadLosslessly() {
        var totalEntries = 0
        var totalChars = 0
        val seedStart = System.nanoTime()
        repeat(LOREBOOKS) { index ->
            val entries = if (index < LARGE_LOREBOOKS) LARGE_ENTRIES_PER_BOOK else SMALL_ENTRIES_PER_BOOK
            val json = lorebookWithEntries(index, entries).toJson()
            totalEntries += entries
            totalChars += json.length
            runBlocking {
                store.putLorebook(
                    LocalLorebookEntity(
                        id = "lb-%03d".format(index),
                        name = "世界书 $index",
                        canonicalJson = json,
                        createdAt = 1L,
                        updatedAt = 1L,
                    ),
                )
            }
        }
        val seedMillis = elapsedSince(seedStart)

        val listStart = System.nanoTime()
        val ids = runBlocking { store.listLorebookIds() }
        val listMillis = elapsedSince(listStart)
        assertEquals("$LOREBOOKS 本书必须全部可列出", LOREBOOKS, ids.size)

        val readStart = System.nanoTime()
        val row = runBlocking { store.getLorebook("lb-004") }
        assertNotNull("巨型世界书必须能按 id 取回", row)
        val parsed = CanonicalLorebook.fromJson(row!!.canonicalJson)
        val readMillis = elapsedSince(readStart)
        assertEquals(
            "巨型世界书的 $LARGE_ENTRIES_PER_BOOK 条必须原样读回，一条不丢",
            LARGE_ENTRIES_PER_BOOK,
            parsed?.entries?.size,
        )
        assertEquals("书名不能被压力数据改写", "世界书 4", parsed?.name)

        println(
            "LOAD 世界书：$LOREBOOKS 本（$LARGE_LOREBOOKS 本 × $LARGE_ENTRIES_PER_BOOK 条）" +
                "= $totalEntries 条目 / ${totalChars / 1024} KiB JSON；seed=${seedMillis}ms；" +
                "列 id=${listMillis}ms；取巨型本+解析=${readMillis}ms；上限=${LOREBOOK_BUDGET_MS}ms",
        )
        assertTrue("世界书列表超出预算（${listMillis}ms）", listMillis < LOREBOOK_BUDGET_MS)
        assertTrue("巨型世界书读取+解析超出预算（${readMillis}ms）", readMillis < LOREBOOK_BUDGET_MS)
    }

    @Test
    fun presetSectionsStayUsableAtOneThousand() {
        repeat(PRESETS) { index ->
            runBlocking {
                store.putPreset(
                    LocalPresetEntity(
                        id = "p-%04d".format(index),
                        name = "预设 $index",
                        bodyJson = """{"name":"预设 $index","temperature":0.8}""",
                        isBuiltin = index % 2 == 0,
                        createdAt = 1L,
                        updatedAt = 1L,
                    ),
                )
            }
        }
        val start = System.nanoTime()
        val builtin = runBlocking { store.listPresetSection(builtin = true) }
        val user = runBlocking { store.listPresetSection(builtin = false) }
        val millis = elapsedSince(start)

        assertEquals("内建分区条数", PRESETS / 2, builtin.size)
        assertEquals("用户分区条数", PRESETS / 2, user.size)
        assertEquals("两区合计必须等于总量（分区口径漏了行）", PRESETS, runBlocking { store.listPresets() }.size)
        println("LOAD 预设：$PRESETS 条，分区取数=${millis}ms，上限=${LIST_BUDGET_MS}ms")
        assertTrue("预设分区查询超出预算（${millis}ms）", millis < LIST_BUDGET_MS)
    }

    /** 造一本有 `count` 条目的 canonical v2 世界书（内容短，压的是**条目数**而不是文本长度）。 */
    private fun lorebookWithEntries(index: Int, count: Int): CanonicalLorebook {
        val entries = (0 until count).map { entry ->
            linkedMapOf<String, Any?>(
                "id" to "lb-%03d-e%05d".format(index, entry),
                "enabled" to true,
                "content" to "条目正文 $entry",
                "activation" to linkedMapOf(
                    "mode" to "conditional",
                    "primaryKeys" to listOf("关键词$entry"),
                ),
            )
        }
        return requireNotNull(
            CanonicalLorebook.fromMap(
                linkedMapOf<String, Any?>(
                    "id" to "lb-%03d".format(index),
                    "name" to "世界书 $index",
                    "entries" to entries,
                ),
            ),
        ) { "造不出 5k 条的世界书，用例前提不成立" }
    }

    private fun elapsedSince(nanoStart: Long): Long = (System.nanoTime() - nanoStart) / 1_000_000

    private companion object {
        const val DB_NAME = "phase5-load-matrix-test.db"
        const val DEVICE_ID = "phase5-load-matrix"
        const val CHARACTERS = 500
        const val LOREBOOKS = 100
        const val PRESETS = 1_000

        /** 与 `CharacterEditorViewModel.PAGE_SIZE` 同值：这里必须测 UI 真正用的那一页。 */
        const val PAGE_SIZE = 200

        /** 宽到只抓数量级跑偏；实测值见 println 输出与阶段报告 §3。 */
        const val LIST_BUDGET_MS = 4_000L
        const val LOREBOOK_BUDGET_MS = 4_000L

        /** 方案 §3 的原始口径（存不进去，见 `lorebookAtPlanScaleIsRefusedByTheSharedPayloadCap`）。 */
        const val ENTRIES_PER_BOOK = 5_000

        /** 契约允许范围内的最大档：~3.5k 条 ≈ 1.73 MB，离 2 MiB 上限留 ~15% 余量。 */
        const val LARGE_ENTRIES_PER_BOOK = 3_500
        const val LARGE_LOREBOOKS = 5
        const val SMALL_ENTRIES_PER_BOOK = 100
    }
}
