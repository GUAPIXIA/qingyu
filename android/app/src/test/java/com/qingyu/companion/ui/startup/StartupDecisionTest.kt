package com.qingyu.companion.ui.startup

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 阶段 4：启动决策的单测与**完成定义守卫**。
 *
 * 完成定义明确要求「代码与导航中不存在旧伴侣模式回退入口」。此前的启动决策有两套逻辑：
 * 本地优先（`decideStartupStateLocal`）与伴侣模式时代的四态（`decideStartupState`），
 * 而前者**总会**提前返回，后者即便有连接也不可达 —— 也就是说那段代码连同
 * 导航里的 `onNeedsPairing → PAIRING`、`onReadyWithoutActive → CONNECTION_PICKER`
 * 是**永远不会触发的死回退入口**。现已删除，测试随之改为锁定新契约。
 *
 * 除了行为断言，这里还有一条**源码级守卫**：启动分发处不得出现指向配对/连接选择的路由。
 * 纯行为测试无法覆盖「分支存在但不可达」这种情况，而完成定义禁止的正是「入口存在」。
 */
class StartupDecisionTest {

    // ---------- 行为：本地优先决策 ----------

    @Test
    fun `有本地资料 → LocalReady（不需要任何 PC 连接）`() {
        assertEquals(
            StartupState.LocalReady,
            decideStartupStateLocal(LocalStartupSnapshot(hasLocalProfile = true)),
        )
    }

    @Test
    fun `有本地主库 → LocalReady`() {
        assertEquals(
            StartupState.LocalReady,
            decideStartupStateLocal(LocalStartupSnapshot(hasLocalDb = true)),
        )
    }

    @Test
    fun `什么都没有 → NeedsLocalSetup（不是配对页）`() {
        assertEquals(
            StartupState.NeedsLocalSetup,
            decideStartupStateLocal(LocalStartupSnapshot()),
        )
    }

    @Test
    fun `有旧伴侣缓存但无本地资料 → 仍走本地初始化向导`() {
        assertEquals(
            StartupState.NeedsLocalSetup,
            decideStartupStateLocal(LocalStartupSnapshot(hasLegacyCache = true)),
        )
    }

    @Test
    fun `连接数不参与进入主界面的判定`() {
        // 曾经「有连接」是进入主界面的前提；本地优先后它只影响同步中心入口
        assertEquals(
            StartupState.NeedsLocalSetup,
            decideStartupStateLocal(LocalStartupSnapshot(connectionCount = 3)),
        )
        assertEquals(
            StartupState.LocalReady,
            decideStartupStateLocal(LocalStartupSnapshot(hasLocalDb = true, connectionCount = 0)),
        )
    }

    @Test
    fun `有本地资料时决策与连接数无关（防止回退到读连接列表）`() {
        for (count in 0..3) {
            assertEquals(
                "连接数=$count 时仍必须是本地就绪",
                StartupState.LocalReady,
                decideStartupStateLocal(LocalStartupSnapshot(hasLocalProfile = true, connectionCount = count)),
            )
        }
    }

    @Test
    fun `启动状态集合里不存在任何配对相关状态`() {
        // 编译期保证：下面的 when 穷尽 StartupState 且**没有 else 分支**——
        // 一旦有人加回 NeedsPairing / ReadyWithoutActive，这里会直接编译失败。
        fun describe(state: StartupState): String = when (state) {
            StartupState.LoadingLocalState -> "loading"
            StartupState.LocalReady -> "ready"
            StartupState.NeedsLocalSetup -> "setup"
        }
        assertEquals(
            setOf("loading", "ready", "setup"),
            listOf(
                StartupState.LoadingLocalState,
                StartupState.LocalReady,
                StartupState.NeedsLocalSetup,
            ).map { describe(it) }.toSet(),
        )

        // 源码级：状态定义块内不得再出现配对/连接修复成员
        val source = findSourceFile("StartupViewModel.kt", "startup").readText()
        val block = source.substringAfter("sealed interface StartupState").substringBefore("}")
        assertTrue("必须真的定位到 StartupState 定义块", block.contains("LocalReady"))
        for (forbidden in listOf("NeedsPairing", "ReadyWithoutActive", "needsRepair")) {
            assertTrue("启动状态定义里不得再出现 $forbidden", !block.contains(forbidden))
        }
    }

    // ---------- 源码级守卫：启动分发不得指向配对/连接选择 ----------

    @Test
    fun `启动分发处不得出现指向配对或连接选择的路由`() {
        val source = findSourceFile("CompanionNavHost.kt", "navigation").readText()
        val startupBlock = extractStartupComposable(source)
        for (forbidden in listOf("Routes.PAIRING", "Routes.CONNECTION_PICKER", "Routes.CONNECTION_PROFILES")) {
            assertTrue(
                "启动分发（composable(Routes.STARTUP)）内不得出现 $forbidden —— " +
                    "那是旧伴侣模式回退入口，阶段 4 完成定义禁止。",
                !startupBlock.contains(forbidden),
            )
        }
        // 反向确认守卫真的读到了目标代码（否则「找不到就通过」是假守卫）
        assertTrue("守卫必须真的定位到启动分发块", startupBlock.contains("StartupScreen("))
        assertTrue("守卫必须真的读到文件内容", startupBlock.length > 200)
    }

    private fun extractStartupComposable(source: String): String {
        val start = source.indexOf("composable(Routes.STARTUP)")
        assertTrue("未找到 composable(Routes.STARTUP)：守卫失效", start >= 0)
        val nextComposable = source.indexOf("composable(", start + 10)
        return if (nextComposable > start) source.substring(start, nextComposable) else source.substring(start)
    }

    private fun findSourceFile(name: String, packageDir: String = "navigation"): File {
        val candidates = listOf(
            File("src/main/java/com/qingyu/companion/ui/$packageDir/$name"),
            File("app/src/main/java/com/qingyu/companion/ui/$packageDir/$name"),
        )
        return candidates.firstOrNull { it.exists() }
            ?: error("找不到源文件 $name（工作目录=${File(".").absolutePath}）")
    }
}
