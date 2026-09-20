package com.qingyu.companion.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.qingyu.companion.local.domain.MigrationIdentity
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 5 §2 草稿区的容量判定（U-11）。
 *
 * 为什么上限本身要测：Preferences DataStore 把整份偏好全量驻留内存，
 * 并且**每次写都整文件重写**。没有上限时，一本接近 2 MiB 的世界书草稿会把
 * 「每 300 ms 一次」的自动保存变成持续的大块重写，多条草稿累加后文件再也降不下来。
 *
 * 三条关键语义：
 * - 拒绝**不淘汰**：丢用户没保存的东西比拒绝写入严重得多；
 * - 拒绝要能被调用方区分（单条太大 vs 总量已满），因为界面说的话不一样；
 * - 上限取的就是同步契约的单条 payload 上限，**不另发明一个数**（[capMatchesTheSyncPayloadContract]）。
 *
 * 这里不驱动 `viewModelScope`，所以 Robolectric 安全（那条限制见
 * `CharacterEditorSaveIdempotenceInstrumentedTest` 的注释）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ContentDraftStoreTest {

    private val context: Context = ApplicationProvider.getApplicationContext()

    private fun store(): ContentDraftStore = PreferencesContentDraftStore(
        // 每个用例换一份 Context 会把 DataStore 的单例文件也换掉？不会——delegate 按 Context 缓存，
        // 因此这里用同一个 context、靠唯一 kind + 收尾 clear 来隔离。
        context,
    )

    private val usedKinds = mutableListOf<String>()

    private fun kind(name: String): String = "test-$name".also { usedKinds += it }

    @After
    fun tearDown() = runBlocking {
        val s = store()
        usedKinds.forEach { k ->
            slitKeys.forEach { s.clear(k, it) }
        }
        usedKinds.clear()
    }

    @Test
    fun oversizedDraftIsRefusedAndLeavesExistingOnesAlone() = runBlocking {
        val s = store()
        val k = kind("single")
        assertEquals(DraftWrite.ACCEPTED, s.put(k, "a", "小草稿"))

        val tooBig = "x".repeat(ContentDraftStore.MAX_DRAFT_BYTES + 1)
        assertEquals(
            "超过单条上限的草稿必须被拒",
            DraftWrite.TOO_LARGE,
            s.put(k, "b", tooBig),
        )
        assertNull("被拒的草稿不该留下任何痕迹", s.get(k, "b"))
        assertEquals("已有的小草稿不能被这次拒绝波及", "小草稿", s.get(k, "a"))
    }

    @Test
    fun fullBudgetRefusesNewDraftsAndClearingFreesRoom() = runBlocking {
        val s = store()
        val k = kind("budget")
        val each = "y".repeat(ONE_MIB)
        // 条数从常量算：上限被谁改动时这条用例仍然在测「刚好填满」，而不是测一个写死的 4
        val fitByBudget = (ContentDraftStore.MAX_DRAFT_TOTAL_BYTES / ONE_MIB).toInt()
        (1..fitByBudget).forEach { index ->
            assertEquals(
                "第 $index 条满额草稿应能落下（总量还没到上限）",
                DraftWrite.ACCEPTED,
                s.put(k, "c$index", each),
            )
        }
        assertEquals(
            "总量已满时新草稿只能被拒（不淘汰旧的）",
            DraftWrite.OVER_BUDGET,
            s.put(k, "b", "z"),
        )
        assertEquals("旧的必须还在", each, s.get(k, "c1"))

        s.clear(k, "c1")
        assertEquals("清掉一条之后就该腾出空间", DraftWrite.ACCEPTED, s.put(k, "b", "z"))
        assertNull(s.get(k, "c1"))
    }

    /** 上限取同步契约那个数：另立一个数字就会有两套「多大算太大」。 */
    @Test
    fun capMatchesTheSyncPayloadContract() {
        assertEquals(MigrationIdentity.MAX_PAYLOAD_BYTES, ContentDraftStore.MAX_DRAFT_BYTES)
        assertEquals(4L * ContentDraftStore.MAX_DRAFT_BYTES, ContentDraftStore.MAX_DRAFT_TOTAL_BYTES)
    }

    private companion object {
        const val ONE_MIB = 1024 * 1024
    }

    /** tearDown 要清的键集合：c1..cN 由用例自己按预算算出来，这里按上限预留。 */
    private val slitKeys = listOf("a", "b") + (1..32).map { "c$it" }
}
