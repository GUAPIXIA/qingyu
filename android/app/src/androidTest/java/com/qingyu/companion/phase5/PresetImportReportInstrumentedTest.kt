package com.qingyu.companion.phase5

import android.net.Uri
import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.content.PresetCodec
import com.qingyu.companion.data.ContentDraftStore
import com.qingyu.companion.data.DraftWrite
import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.domain.EntityTypes
import com.qingyu.companion.local.domain.RoomLocalSyncRepository
import com.qingyu.companion.ui.content.PickedDocument
import com.qingyu.companion.ui.presets.PresetEditorViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 阶段 5 §2「所有导入显示成功、跳过、近似映射、失败和未知字段保留」的**预设入口设备侧**。
 *
 * 为什么单测不够：`PresetImportReportTest` 钉的是编解码层的两个纯读数；真正要证明的是
 * 「一份角色卡从预设入口进来，**库里不会多出那一条空壳预设**，而 journal 里也不会多那一行」——
 * 那要过真实 Room 仓储与同步记账才成立（替身 `FakeLocalStore` 的 journal 是内存实现，
 * 少挂一处记账它照样绿）。
 *
 * 草稿区给内存实现：进程级单例的 DataStore 会让同一次 instrumentation 里的其它用例
 * 互相看到 `preset#new` 草稿，判定就受执行顺序影响。
 */
@RunWith(AndroidJUnit4::class)
class PresetImportReportInstrumentedTest {

    private class MemoryDrafts : ContentDraftStore {
        private val rows = HashMap<String, String>()
        private fun key(kind: String, entityId: String) = "$kind#$entityId"
        override suspend fun put(kind: String, entityId: String, json: String): DraftWrite {
            rows[key(kind, entityId)] = json
            return DraftWrite.ACCEPTED
        }
        override suspend fun get(kind: String, entityId: String): String? = rows[key(kind, entityId)]
        override suspend fun clear(kind: String, entityId: String) {
            rows.remove(key(kind, entityId))
        }
    }

    private fun document(name: String, json: String) =
        PickedDocument(Uri.parse("content://qingyu.test/$name"), name, json.toByteArray())

    private suspend fun awaitReport(vm: PresetEditorViewModel): PresetEditorViewModel.ImportReport {
        // 轮询而不是写死时长：判定窗口写死是本阶段此前出现过的非确定性红的原因之一。
        repeat(200) {
            val state = vm.list.value
            state.importReport?.let { if (!state.busy) return it }
            delay(100L)
        }
        throw AssertionError("导入报告 20 s 内没有出来，最后状态：${vm.list.value}")
    }

    private suspend fun journalOf(store: RoomLocalSyncRepository) = store.changesAfter(0L, 5_000)

    @Test
    fun foreignFilesAreSkippedInsteadOfBecomingAnEmptyShellPreset() = runBlocking(Dispatchers.Main) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context, QingyuLocalDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        val store = RoomLocalSyncRepository(db, "preset-import-skip")
        val vm = PresetEditorViewModel(store, MemoryDrafts())

        vm.importPresets(
            listOf(
                document(
                    "角色卡.json",
                    """{"spec":"chara_card_v2","spec_version":"2.0","name":"卡名",""" +
                        """"description":"角色的描述","first_mes":"你好"}""",
                ),
                document(
                    "世界书.json",
                    """{"name":"书","entries":[{"id":"e1","comment":"c","keys":["k"],"content":"文"}],"scan_depth":4}""",
                ),
                document("打包预设数组.json", """[{"name":"一","systemPrompt":"x"},{"name":"二"}]"""),
            ),
        )
        val report = awaitReport(vm)

        assertEquals("三个外来文件都不该被导入：${report.imported}", 0, report.imported)
        assertEquals("三类都要在「跳过」里现身：${report.skipped}", 3, report.skipped.size)
        listOf("角色卡.json", "世界书.json", "打包预设数组.json").forEach { name ->
            assertTrue("$name 没进跳过清单：${report.skipped}", report.skipped.any { it.startsWith(name) })
        }
        assertEquals("空壳预设一条都不能落库", 0, store.countPresets(builtin = false, query = ""))
        // 这一句才是「没写进去」的硬证据：journal 里连 `preset` 类型的行都不许有。
        assertEquals(
            "跳过不该留下同步变更",
            0,
            journalOf(store).count { it.entityType == EntityTypes.PRESET },
        )
    }

    @Test
    fun clampedPresetImportsOnceAndSaysWhichNumbersItChanged() = runBlocking(Dispatchers.Main) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context, QingyuLocalDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        val store = RoomLocalSyncRepository(db, "preset-import-clamp")
        val vm = PresetEditorViewModel(store, MemoryDrafts())

        vm.importPresets(
            listOf(
                document(
                    "越界预设.json",
                    """{"name":"越界预设","systemPrompt":"正文","max_context":-5,"temperature":11,""" +
                        """"top_p":3,"responseLengthHint":"very_long","unknownField":1}""",
                ),
            ),
        )
        val report = awaitReport(vm)

        assertEquals(1, report.imported)
        assertEquals("跳过清单该是空的：${report.skipped}", emptyList<String>(), report.skipped)
        // 四处近似，一条不多一条不少：越界的三个数 + 一个非法枚举。
        // 「没填的键用默认值」不许混进来报，否则这份报告就不可信了。
        assertEquals("近似清单：${report.approximated}", 4, report.approximated.size)
        listOf("maxContext", "temperature", "topP", "responseLengthHint").forEach { key ->
            assertTrue("$key 该被报出来：${report.approximated}", report.approximated.any { it.contains(key) })
        }
        assertEquals(listOf("unknownField"), report.unsupported["越界预设"])

        val row = store.searchPresets(builtin = false, query = "", limit = 10, offset = 0).single()
        val body = PresetCodec.bodyOf(row.bodyJson)
        // 报告说的与库里存的必须是同一件事
        assertEquals(2.0, (body["temperature"] as Number).toDouble(), 0.0)
        assertEquals(0.0, (body["maxContext"] as Number).toDouble(), 0.0)
        assertEquals(1.0, (body["topP"] as Number).toDouble(), 0.0)
        assertEquals("auto", body["responseLengthHint"])
        assertEquals(
            "一次导入 = 这一行的一条变更（dot 是设备全局计数，不能拿去等值比较）",
            1,
            journalOf(store).count {
                it.entityType == EntityTypes.PRESET && it.entityId == row.id
            },
        )
    }
}
