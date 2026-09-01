package com.qingyu.companion.ui.layout

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 真机窗口 Insets 回归契约。
 *
 * 自定义顶栏必须自行避开状态栏；edge-to-edge 窗口中的聊天输入区必须
 * 明确消费 IME inset。adjustResize 保留用于旧系统正确分发键盘 Insets。
 */
class WindowInsetsContractTest {

    private val mainDir: File by lazy {
        val cwd = File(requireNotNull(System.getProperty("user.dir")))
        sequenceOf(File(cwd, "app/src/main"), File(cwd, "src/main"))
            .firstOrNull(File::isDirectory)
            ?: error("Cannot locate app/src/main from ${cwd.absolutePath}")
    }

    @Test
    fun `activity explicitly uses adjustResize for IME`() {
        val manifest = File(mainDir, "AndroidManifest.xml").readText()

        assertTrue(
            "MainActivity must declare adjustResize so the window has a single IME avoidance owner",
            Regex("""android:name="\.MainActivity"[\s\S]*?android:windowSoftInputMode="adjustResize"""")
                .containsMatchIn(manifest),
        )
    }

    @Test
    fun `chat footer consumes IME inset in edge to edge window`() {
        val chatScreen = File(
            mainDir,
            "java/com/qingyu/companion/ui/chat/ChatScreen.kt",
        ).readText()

        assertTrue(
            "Chat footer must consume IME insets because enableEdgeToEdge keeps the window full size",
            chatScreen.contains(".imePadding()"),
        )
    }

    @Test
    fun `custom top bars reserve the status bar safe area`() {
        val appTopBar = File(
            mainDir,
            "java/com/qingyu/companion/ui/components/AppScaffold.kt",
        ).readText()
        val sessions = File(
            mainDir,
            "java/com/qingyu/companion/ui/sessions/SessionsScreen.kt",
        ).readText()

        assertTrue(appTopBar.contains(".statusBarsPadding()"))
        assertTrue(sessions.contains(".statusBarsPadding()"))
    }
}
