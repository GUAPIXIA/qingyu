package com.qingyu.companion.phase5

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.local.domain.EntityTypes
import com.qingyu.companion.local.domain.RoomLocalSyncRepository
import com.qingyu.companion.data.AppContainer
import com.qingyu.companion.local.db.QingyuLocalDatabase
import androidx.room.Room
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 分隔实验：S5-01 的「保存=一次业务变更」到底是 App 的问题，还是 Compose 测试宿主的问题。
 *
 * 走查用例（`ContentUiWalkthroughInstrumentedTest`）里，`createComposeRule` 下
 * `viewModelScope` 的协程始终跑不完：列表一直停在骨架屏、点「保存」10 秒后库里仍然没有那一行。
 * 同一时间从测试线程直接 `runBlocking { store.putCharacter(...) }` 是成功的，
 * 所以嫌疑落在「ViewModel 的 Main 调度」与「Compose 测试框架的帧时钟/主线程占用」之间。
 *
 * 这条用例把 Compose 拿掉：在**真实主线程**上（`runBlocking(Dispatchers.Main)`，
 * 与 `viewModelScope` 同一个 dispatcher）驱动同一个 `CharacterEditorViewModel`，
 * 用同一个真实 Room 仓储。两种结果都有意义：
 * - 通过 → 走查用例的红灯是测试宿主造成的，不是产品缺陷；
 * - 失败 → 主线程 + Room 这条链在真机上也会卡，那是 P0，必须当场修。
 */
@RunWith(AndroidJUnit4::class)
class CharacterEditorMainDispatcherProbeTest {

    @Test
    fun editorViewModelPersistsWhenDrivenOnTheMainThread() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context, QingyuLocalDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        val store = RoomLocalSyncRepository(db, "main-dispatcher-probe")
        val mediaRoot = File(context.cacheDir, "probe-media").apply { mkdirs() }
        val name = "主线程探针角色"
        // 与 viewModelScope 同一个 dispatcher：Main.immediate 的父集
        runBlocking(Dispatchers.Main) {
            val vm = com.qingyu.companion.ui.characters.CharacterEditorViewModel(store, mediaRoot, InMemoryDraftStore())
            vm.startCreate()
            vm.edit { it.copy(name = name) }
            vm.save()
            // save() 里是 launch 而非 await：给主线程队列一次把协程跑完的机会
            repeat(40) {
                kotlinx.coroutines.delay(50L)
                if (store.listCharacters().any { row -> row.name == name }) return@repeat
            }
            val row = store.listCharacters().firstOrNull { it.name == name }
            assertNotNull(
                "在主线程上保存后仍然查不到这一行，说明卡点在产品链路而不是 Compose 测试宿主",
                row,
            )
            val head = store.getHead(EntityTypes.CHARACTER, row!!.id)
            assertNotNull("保存必须记账", head)
        // 「一次保存 = 一次业务变更」的正确口径是**这一行**的变更条数。
        // 版本向量里那个数不能拿去等值比较：dot 是**设备全局**计数，同进程里前面的类
        // 先写过任何实体，这里的数就不是 1（今天两条用例连跑时「谁后跑谁 2」正是这个混用，
        // 而 journal 里这一行其实只有一条）。
            assertEquals(
                "首次保存应只给这一行留一条 journal",
                1,
                store.changesAfter(0L, 5_000).count { it.entityId == row!!.id },
            )
            assertEquals(
                "列表查询必须能检索到它（分页与搜索在数据库层）",
                1,
                store.searchCharacters(name, "updated", 200, 0).count { it.id == row.id },
            )
        }
        db.close()
    }

    /**
     * 同一个实验，但仓储换成 **AppContainer 交出去的那个实例**。
     *
     * 上面那条用的是手搭的 `RoomLocalSyncRepository(inMemory DB, id)`，
     * 而走查用例用的是 `AppContainer(context).localSyncRepository`。这一步把两者对齐：
     * - 这条红、上面那条绿 → 卡点在容器交出的仓储上（真实文件库、容器自己的 scope、
     *   迁移身份引导等），那是**产品侧**问题，必须查；
     * - 这条也绿 → 卡点确定在 Compose 宿主里，与产品无关。
     */
    @Test
    fun theContainerProvidedRepositoryPersistsOnTheMainThreadToo() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
        val container = com.qingyu.companion.data.AppContainer(context)
        val store = container.localSyncRepository
        val name = "容器仓储探针 ${System.currentTimeMillis()}"
        runBlocking(Dispatchers.Main) {
            val vm = com.qingyu.companion.ui.characters.CharacterEditorViewModel(
                store = store,
                mediaRoot = File(context.filesDir, "media"),
                drafts = InMemoryDraftStore(),
            )
            vm.startCreate()
            vm.edit { it.copy(name = name) }
            vm.save()
            repeat(40) {
                kotlinx.coroutines.delay(50L)
                if (store.listCharacters().any { row -> row.name == name }) return@repeat
            }
            val row = store.listCharacters().firstOrNull { it.name == name }
            assertNotNull("容器交出的仓储在主线程上保存不落地：卡点在产品侧，不在 Compose 宿主", row)
            val head = store.getHead(EntityTypes.CHARACTER, requireNotNull(row).id)
            assertNotNull("保存没留 entity_heads", head)
        // 「一次保存 = 一次业务变更」的正确口径是**这一行**的变更条数。
        // 版本向量里那个数不能拿去等值比较：dot 是**设备全局**计数，同进程里前面的类
        // 先写过任何实体，这里的数就不是 1（今天两条用例连跑时「谁后跑谁 2」正是这个混用，
        // 而 journal 里这一行其实只有一条）。
            assertEquals(
                "这次保存应只给这一行留一条 journal",
                1,
                store.changesAfter(0L, 5_000).count { it.entityId == requireNotNull(row).id },
            )
        }
    }
}

/**
 * 探针只关心「ViewModel 的写有没有落到 Room / journal」，草稿区给它一个内存实现就行。
 *
 * 不用 [com.qingyu.companion.data.PreferencesContentDraftStore]：那是进程级单例的 DataStore，
 * 两个用例（以及同一次 instrumentation 里的其它用例）会互相看到对方的 `character#new` 草稿，
 * 探针的断言就会受执行顺序影响。
 */
private class InMemoryDraftStore : com.qingyu.companion.data.ContentDraftStore {
    private val rows = HashMap<String, String>()

    private fun key(kind: String, entityId: String) = "$kind#$entityId"

    override suspend fun put(kind: String, entityId: String, json: String): com.qingyu.companion.data.DraftWrite {
        rows[key(kind, entityId)] = json
        return com.qingyu.companion.data.DraftWrite.ACCEPTED
    }

    override suspend fun get(kind: String, entityId: String): String? = rows[key(kind, entityId)]

    override suspend fun clear(kind: String, entityId: String) {
        rows.remove(key(kind, entityId))
    }
}
