package com.qingyu.companion.phase5

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.data.ContentDraftStore
import com.qingyu.companion.data.DraftWrite
import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.domain.EntityTypes
import com.qingyu.companion.local.domain.RoomLocalSyncRepository
import com.qingyu.companion.ui.characters.CharacterEditorViewModel
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 「一次保存 = 一次业务变更」在**连点两次保存**时也必须成立（方案 §2）。
 *
 * 这条是在 Android 12 上跑红的：走查用例明明只触发了一次 `OnClick` 语义动作，
 * 角色的版本向量却推到了 `"2"`。机制是编辑器在「新建」状态下保存成功之后
 * **仍停在未落库状态**（`characterId` 还是 null），于是第二次提交没有被 `dirty` 判定挡住，
 * 而是被 §2.12 为「草稿恢复后保存」加的 `force` 又落了一次。
 * 真实用户双击保存是常态，那不该变成两条同步变更。
 *
 * 放在 androidTest 而不是 JVM 单测：本用例必须驱动 `viewModelScope`，
 * 而 Robolectric 下测试线程**就是**主线程，`runBlocking(Dispatchers.Main)` + `delay`
 * 会自锁（实测挂住不动）。设备上的主 looper 独立运行，这条链才跑得动
 * （与 `CharacterEditorMainDispatcherProbeTest` 同一前提）。
 */
@RunWith(AndroidJUnit4::class)
class CharacterEditorSaveIdempotenceInstrumentedTest {

    private class MemoryDrafts : ContentDraftStore {
        private val rows = HashMap<String, String>()
        override suspend fun put(kind: String, entityId: String, json: String): DraftWrite {
            rows["$kind#$entityId"] = json
            return DraftWrite.ACCEPTED
        }
        override suspend fun get(kind: String, entityId: String): String? = rows["$kind#$entityId"]
        override suspend fun clear(kind: String, entityId: String) { rows.remove("$kind#$entityId") }
    }

    @Test
    fun savingTwiceWithoutNewEditsProducesOneJournaledChange() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context, QingyuLocalDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        val store = RoomLocalSyncRepository(db, "save-idempotence")
        val mediaRoot = File(context.cacheDir, "save-idempotence-media").apply { mkdirs() }
        try {
            runBlocking(Dispatchers.Main) {
                val vm = CharacterEditorViewModel(store, mediaRoot, MemoryDrafts())
                vm.startCreate()
                delay(SETTLE_MS)
                vm.edit { it.copy(name = "连点保存的角色") }
                delay(SETTLE_MS)

                vm.save()
                val id = waitUntil("第一次保存没落库") { store.listCharacters().firstOrNull()?.id }
                assertNotNull("保存后库里没有这一行", id)
                // 必须等这次保存**真正结束**（busy 落下、characterId 升上去）再点第二次。
                // 原先这里只有一句固定 `delay(SETTLE_MS)`：满载的全量套件里 500 ms 不够，
                // 第二次提交就撞进了「第一次还在飞」的窗口，于是这条用例时红时绿
                // （API 34 全量跑红过一次，单跑 1/1、复跑 58/58 全绿）。
                awaitSettled(vm)

                // 第二次点保存：内容一个字都没改，所以按 §2 它必须什么都不产生
                vm.save()
                delay(SETTLE_MS)

                assertEquals("两次点保存只该有一条变更", 1, store.journalChangeCount())
                assertEquals("只该多出一个 head", 1, store.headCount())
                val head = store.getHead(EntityTypes.CHARACTER, requireNotNull(id))
                assertNotNull("保存没记账", head)
                assertEquals(
                    "版本向量必须停在 1：重复提交不该推第二格",
                    "1",
                    JSONObject(requireNotNull(head).versionJson).optString(store.deviceId()),
                )
            }
        } finally {
            db.close()
        }
    }

    @Test
    fun savingAgainWhileTheFirstSaveIsStillInFlightProducesOneJournaledChange() {
        // 上一条**刻意避开**的时序在这里正面覆盖：不等第一次结束就再点一次保存。
        // 真实触发路径：用户连点按钮，或离开确认里的「保存并离开」与在途保存撞车。
        // `isNewRow` 取的是调用这一刻的 `characterId`（在成功回调里才升上去），
        // 所以没有 `busy` 闸时第二次提交会拿着 `isNewRow = true` 再 force 落一次。
        //
        // 断言口径与上一条一致（journal 条数与 head 数），只是把「第二次保存」提前到
        // 第一次 `save()` 刚返回、还在飞的时刻——不依赖任何 sleep。
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context, QingyuLocalDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        val store = RoomLocalSyncRepository(db, "save-in-flight")
        val mediaRoot = File(context.cacheDir, "save-in-flight-media").apply { mkdirs() }
        try {
            runBlocking(Dispatchers.Main) {
                val vm = CharacterEditorViewModel(store, mediaRoot, MemoryDrafts())
                vm.startCreate()
                delay(SETTLE_MS)
                vm.edit { it.copy(name = "撞车保存的角色") }
                delay(SETTLE_MS)

                vm.save()
                // 此刻第一次提交仍在飞（busy 已同步置起）：第二次必须被挡住。
                // 这条同时钉住 `viewModelScope`（Main.immediate）在调用线程上**同步**跑到首个挂起点的假设——
                // 若哪天不成立了，第二次会真的落库，这条立刻红。
                vm.save()

                waitUntil("第一次保存没落库") { store.listCharacters().firstOrNull()?.id }
                awaitSettled(vm)

                assertEquals("在途撞车时重复提交只该有一条变更", 1, store.journalChangeCount())
                assertEquals("只该多出一个 head", 1, store.headCount())
            }
        } finally {
            db.close()
        }
    }

    /** 等编辑器离开「正在保存」状态：不再用固定 sleep 假装第一次保存已经结束。 */
    private suspend fun awaitSettled(vm: CharacterEditorViewModel) {
        waitUntil("第一次保存没有结束（busy 一直没落下）") {
            if (!vm.editor.value.busy) Unit else null
        }
    }

    private suspend fun <T> waitUntil(message: String, probe: suspend () -> T?): T {
        var attempts = 0
        while (attempts++ < 40) {
            probe()?.let { return it }
            delay(50L)
        }
        throw AssertionError("$message（等待 2000 ms 后仍没有值）")
    }

    private companion object {
        const val SETTLE_MS = 500L
    }
}
