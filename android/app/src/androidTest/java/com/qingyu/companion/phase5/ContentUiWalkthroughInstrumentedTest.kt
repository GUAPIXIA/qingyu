package com.qingyu.companion.phase5

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.data.AppContainer
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.local.domain.EntityTypes
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.ui.characters.CharacterManagerScreen
import com.qingyu.companion.ui.content.ContentHubScreen
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 阶段 5 §11.1：**内容管理交互层的实机走查**。
 *
 * ## 为什么这一组比再加十条纯函数 golden 更缺
 * 阶段 5 的验收语是「**用户可以**只用 Android 建立和维护完整聊天资产」。
 * 在这一组之前所有证据都停在数据层：payload 与 PC 逐字节一致、导入导出语义一致、
 * 迁移在真机不丢数据——但 Compose 层**一条测试都没有**（整个 `androidTest` 里原先
 * 没有一处 `createComposeRule`），「八条入口全部可达」的既有证据只有
 * 「路由常量存在 + 能编译」。这一组把真实容器、真实 Room、真实 change journal 与真实点击连起来。
 *
 * ## 盯的是四条「只有交互层才连得起来」的性质
 * 1. **一次保存 = 一次业务变更**（§2）：点保存恰好把版本向量推一格、journal 记一条；
 * 2. **草稿不外泄**（§2：自动保存只准写草稿区）：改了不保存，库里查不到、journal 一行不多；
 * 3. **删除先显示影响、确认后才动数据**，且删除落 tombstone 而不是无痕 DELETE
 *    （否则别家设备的副本下一轮又把它带回来）；
 * 4. §2 的「搜索在数据库层执行」是**从输入框打进去**的——仓储层单测里没有输入框。
 *
 * ## 这个类目前只有中心页一条：另外三条卡在宿主上
 * 需要数据加载的三条（新建→保存→记账、搜索滤行、删除影响确认）在 Compose 宿主里跑不通：
 * 页面停在骨架屏、点保存后库里 15 秒仍没有那一行。已**用实验**排除掉的解释有：
 * finder 走错树（`useUnmergedTree`）、`performScrollTo` 打不中、主线程队列没排空
 * （`runOnMainSync` + 真实 sleep）、只等帧不等协程（`waitUntil` 直接轮询数据库）、
 * 以及「是 `createComposeRule` 的测试帧时钟」——换成
 * `createAndroidComposeRule<ComponentActivity>()`（真实 Activity + 真实 Choreographer）症状一模一样。
 * 反过来，同一个 `CharacterEditorViewModel` 在 `runBlocking(Dispatchers.Main)` 上驱动
 * **AppContainer 交出的那个仓储**（真实文件库）一切正常：保存落库、`entity_heads`
 * 版本向量恰好推到 `"1"`（`CharacterEditorMainDispatcherProbeTest`，2/2 通过）。
 * 所以卡点在「组合出来的这棵树有没有把输入接到 ViewModel 上」，不在产品链路。
 *
 * **这不等于那三条走查做完了**：探针证明的是「仓储+记账+分页在设备主线程上正确」，
 * 不是「用户在屏幕上点得通」。下一步切入点：先断言「输入后草稿 `dirty` 让保存按钮
 * 从 disabled 变 enabled」，把「点击没落」与「协程没跑」再切一刀。
 * 期间顺手抓到一个真实缺陷（骨架屏最短展示混用墙上时间与帧时钟，见阶段报告 §2.11）——
 * 那一条是按代码判定的，**它不是上面三条红的原因**：修完之后症状一模一样。
 *
 * ## 这仍是模拟器
 * GMD 走查不等于物理真机。§11.1 的两个要求不能互相顶替：
 * Android 8/12/14 真机矩阵仍未跑，API 31 档因宿主 install 超时未跑成（见 §3）。
 */
@RunWith(AndroidJUnit4::class)
class ContentUiWalkthroughInstrumentedTest {

    @get:Rule
    val compose = createComposeRule()

    private lateinit var container: AppContainer
    private lateinit var store: LocalStore

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
        // 真实容器：Room / DataStore / Keystore 全按 App 启动那条路走。
        // 换替身就等于把这组用例降级成又一层数据层测试。
        container = AppContainer(context)
        store = container.localSyncRepository
        // 草稿区是进程级单例（DataStore），而角色编辑器的「新建」共用 "new" 这一把键。
        // 上一条用例留下的未保存草稿会被这一条恢复出来，于是 performTextInput 变成**追加**，
        // 「name 等于我打进去的那个字符串」就必然红。用例之间清干净才是各测各的。
        runBlocking { resetCharacterDrafts() }
    }

    @After
    fun tearDown() = runBlocking { resetCharacterDrafts() }

    private suspend fun resetCharacterDrafts() {
        container.contentDraftStore.clear(EntityTypes.CHARACTER, "new")
    }

    private fun showManager() {
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides container) {
                CharacterManagerScreen(onBack = {})
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun everyContentEntryOnTheHubIsReachable() {
        val opened = linkedSetOf<String>()
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides container) {
                ContentHubScreen(
                    onBack = {},
                    onOpenCharacters = { opened += "characters" },
                    onOpenRegex = { opened += "regex" },
                    onOpenLorebooks = { opened += "lorebooks" },
                    onOpenPresets = { opened += "presets" },
                    onOpenPersonas = { opened += "personas" },
                    onOpenQuickReplies = { opened += "quickReplies" },
                    onOpenUsageInsights = { opened += "usage" },
                    onOpenBackup = { opened += "backup" },
                )
            }
        }
        compose.waitForIdle()

        // 标题取自 ContentHubScreen 的 HubRow；少一个或点不动都算「入口不可达」
        listOf(
            "角色" to "characters",
            "正则规则" to "regex",
            "世界书" to "lorebooks",
            "预设" to "presets",
            "人设" to "personas",
            "快捷回复" to "quickReplies",
            "用量分析" to "usage",
            "备份与恢复" to "backup",
        ).forEach { (title, key) ->
            compose.onNode(hasText(title)).scrollIntoView().performClick()
            compose.waitForIdle()
            assertTrue("点击「$title」没有触发导航回调", opened.contains(key))
        }
        assertEquals("八条入口必须全部可达", 8, opened.size)
    }

    /**
     * 对照组：同样的输入，但用 `performSemanticsAction(OnClick)` 绕开触摸命中测试。
     *
     * 为什么用它代表「保存这条链走通了」是够格的、又为什么它不等于手指点按钮：
     * - 够格：输入是真实键入（见 `saveIsDisabledUntilTheDraftActuallyChanges`：
     *   输入前 `保存` 带 Disabled，输入后消失，证明文字进了草稿），
     *   触发的是同一个 OnClick 语义动作，之后断言的是数据库与 journal 的真实状态；
     *   产品侧要证明的「一次保存 = 一次业务变更」由此成立。
     * - 不够格：它绕过了命中测试。本轮实测过真触摸那条路：节点确认在根视口内
     *   （量过 boundsInRoot），注入点击后既没有 busy 指示也没有 head 增量，
     *   即处理函数根本没被调用；而尝试收键盘时 GLOBAL_ACTION_BACK 直接结束了宿主
     *   Activity（说明当时并没有键盘挡在上面）。同一宿主里中心页八行的真实点击是好的，
     *   所以这是「这一个节点在本测试宿主的触摸注入下点不动」，机制未查明。
     *   手指点按钮这件事仍要靠物理真机走查收口（阶段报告 §5 的未完成项）。
     */
    @Test
    fun saveViaSemanticsActionProducesOneJournaledChange() {
        val name = "语义动作保存 ${System.currentTimeMillis()}"
        val headsBefore = runBlocking { store.headCount() }
        showManager()
        compose.onNodeWithText("新建角色", useUnmergedTree = true).performClick()
        compose.waitForIdle()
        compose.onAllNodes(hasSetTextAction()).onFirst().performTextInput(name)
        compose.waitForIdle()
        compose.onNodeWithText("保存").performSemanticsAction(SemanticsActions.OnClick)

        assertTrue(
            "绕开命中测试仍然没写入，说明问题不在软键盘遮挡",
            compose.waitUntilOrNull(20_000L) { runBlocking { store.listCharacters().any { it.name == name } } },
        )
        val row = requireNotNull(runBlocking { store.listCharacters().firstOrNull { it.name == name } })
        val head = requireNotNull(runBlocking { store.getHead(EntityTypes.CHARACTER, row.id) }) { "保存没记账" }
        // 「一次保存 = 一次业务变更」的正确口径是**这一行**的变更条数。
        // 版本向量里那个数不能拿去等值比较：dot 是**设备全局**计数，同进程里前面的类
        // 先写过任何实体，这里的数就不是 1（今天两条用例连跑时「谁后跑谁 2」正是这个混用，
        // 而 journal 里这一行其实只有一条）。
        assertEquals(
            "这一行必须恰好产生一条 journal",
            1,
            runBlocking { store.changesAfter(0L, 5_000).count { it.entityId == row.id } },
        )
        assertTrue(
            "版本向量里必须有本设备的 dot：" + JSONObject(head.versionJson).toString(),
            JSONObject(head.versionJson).optString(store.deviceId()).isNotEmpty(),
        )
        assertEquals("只应多出一个 head", headsBefore + 1, runBlocking { store.headCount() })
    }

    /**
     * §2「只有保存才产生一次业务变更」的可判定形式：**草稿不脏就不许保存**。
     *
     * 这条既是需求本身（新建后什么都不改就点保存，不该往库里写一行、也不该记账），
     * 也是把走查那三条卡住的原因切开的探针：
     * - 输入前 `保存` 带 Disabled、输入后消失 → 输入真的到达了 ViewModel，
     *   那么「保存后库里没有那一行」只剩「点击没落」或「协程没跑」两种解释；
     * - 输入后仍然 Disabled → 我的输入根本没进草稿，问题在定位方式，不在 App。
     */
    @Test
    fun saveIsDisabledUntilTheDraftActuallyChanges() {
        val headsBefore = runBlocking { store.headCount() }
        showManager()
        compose.onNodeWithText("新建角色", useUnmergedTree = true).performClick()
        compose.waitForIdle()

        val save = compose.onNodeWithText("保存")
        assertTrue(
            "刚新建、什么都没改时保存不该可点（否则一次误触就会写一条业务变更）。当前语义：${save.semanticKeys()}",
            save.isDisabled(),
        )

        val name = "脏草稿探针 ${System.currentTimeMillis()}"
        val editableCount = compose.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().size
        assertTrue("编辑页至少应有一个可输入节点，实际 $editableCount", editableCount > 0)
        compose.onAllNodes(hasSetTextAction()).onFirst().performTextInput(name)
        compose.waitForIdle()

        assertFalse(
            "输入角色名之后保存仍不可点：说明输入没有进到草稿，" +
                "可输入节点数=$editableCount，当前语义：${save.semanticKeys()}。" +
                "库里也不该有这一行：${runBlocking { store.listCharacters().count { it.name == name } }}",
            save.isDisabled(),
        )
        // 可点 ≠ 已点：到这一步仍然不该有任何业务写
        assertEquals("未点保存之前不该多出 head", headsBefore, runBlocking { store.headCount() })
    }

    // ------------------------------------------------------------ 定位与诊断辅助

    /** 节点当前是否处于 disabled（Compose 用 `Disabled` 语义键表达）。 */
    private fun SemanticsNodeInteraction.isDisabled(): Boolean =
        fetchSemanticsNode().config.contains(SemanticsProperties.Disabled)

    /**
     * 带判据的等待：把「等到了没有」作为布尔交回去，而不是让 waitUntil 抛一个只有「超时」的异常。
     *
     * 每轮先 waitForIdle 再判条件，等于给主线程与组合各一次机会；
     * 失败消息需要「点没到 / 协程没跑完」这种区分，所以不能只靠异常。
     */
    private fun ComposeTestRule.waitUntilOrNull(timeoutMillis: Long, condition: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMillis
        while (System.currentTimeMillis() < deadline) {
            waitForIdle()
            if (condition()) return true
            Thread.sleep(50L)
        }
        waitForIdle()
        return condition()
    }

    /** Material3 的 `CircularProgressIndicator` 会带 `ProgressBarRangeInfo` 语义。 */
    private fun hasProgressIndicator(): SemanticsMatcher =
        SemanticsMatcher("ProgressBarRangeInfo") { it.config.contains(SemanticsProperties.ProgressBarRangeInfo) }

    /** 失败时把节点的关键语义打出来，省得再猜「找到的是按钮还是那截文字」。 */
    private fun SemanticsNodeInteraction.semanticKeys(): String {
        val node = fetchSemanticsNode()
        val text = node.config.getOrNull(SemanticsProperties.Text)?.joinToString("/") ?: "-"
        val role = node.config.getOrNull(SemanticsProperties.Role)?.toString() ?: "-"
        val clickable = node.config.contains(SemanticsActions.OnClick)
        return "text=$text role=$role disabled=${node.config.contains(SemanticsProperties.Disabled)} onClick=$clickable"
    }


    /** 长表单与可滚动中心页里的目标要先滚进视口；对已可见节点是安全的空操作。 */
    private fun SemanticsNodeInteraction.scrollIntoView(): SemanticsNodeInteraction = apply { performScrollTo() }
}
