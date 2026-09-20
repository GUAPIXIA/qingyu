package com.qingyu.companion.content

import com.qingyu.companion.model.QuickReply
import com.qingyu.companion.model.QuickReplyAction
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * 阶段 5 S5-06：快捷回复解析与命令可用性判定。
 *
 * 解析用例直接取自 PC `src/commands/__tests__/parser.test.ts` 的输入——
 * 两端必须对同一串输入解析出同一个命令名与参数，否则同步过来的快捷回复
 * 会在另一端执行到别的动作上。
 */
class QuickReplyPolicyTest {

    @Test
    fun parsesTheSameWayPcDoes() {
        val simple = QuickReplyPolicy.parseCommand("/continue 请继续 后面的故事")
        assertNotNull(simple)
        assertEquals("continue", simple.name)
        assertEquals(listOf("请继续", "后面的故事"), simple.args)

        val collapsed = QuickReplyPolicy.parseCommand("/continue   多   个    空格")
        assertNotNull(collapsed)
        assertEquals(listOf("多", "个", "空格"), collapsed.args, "连续空白应折叠成一个分隔符")

        val quoted = QuickReplyPolicy.parseCommand("/preset \"我的 预设\"")
        assertNotNull(quoted)
        assertEquals("preset", quoted.name)
        assertEquals(listOf("我的 预设"), quoted.args, "引号内的空白不该被切开")

        val singleQuoted = QuickReplyPolicy.parseCommand("/character 'Alice Smith' extra")
        assertNotNull(singleQuoted)
        assertEquals(listOf("Alice Smith", "extra"), singleQuoted.args)
    }

    @Test
    fun nameIsLowerCasedAndNonCommandsReturnNull() {
        assertEquals("swipe", QuickReplyPolicy.parseCommand("/SWIPE")?.name, "命令名应统一小写")
        assertNull(QuickReplyPolicy.parseCommand("普通文本"))
        assertNull(QuickReplyPolicy.parseCommand("/"), "只有斜杠没有命令名")
        assertNull(QuickReplyPolicy.parseCommand("  /  "))
        assertEquals("/swipe 左", requireNotNull(QuickReplyPolicy.parseCommand("/swipe 左")).raw, "raw 应是去首尾空白后的原串")
    }

    @Test
    fun onlyAndroidSupportedCommandsAreSelectable() {
        val selectable = QuickReplyPolicy.selectableCommands
        assertTrue("continue" in selectable && "regenerate" in selectable && "swipe" in selectable)
        // 生图与规划器面板在移动端属于后续阶段，不该出现在可选项里
        assertTrue("imagine" !in selectable, "/imagine 依赖本机 ComfyUI/SD，不属于当前 Android 能力")
        assertTrue("plan" !in selectable)
        assertEquals(selectable, selectable.sorted(), "列表要稳定有序，否则每次打开编辑器顺序都变")
    }

    @Test
    fun platformOnlyCommandsCarryADisplayableReasonNotSilentNoop() {
        val imagine = QuickReplyPolicy.decideCommand("/imagine 一只猫")
        assertEquals(QuickReplyPolicy.CommandSupport.PLATFORM_ONLY, imagine.support)
        assertTrue(imagine.reason.isNotBlank(), "禁用必须给原因")
        assertNotNull(imagine.scheduledFor, "要说明这个能力被排在哪一阶段")

        val unknown = QuickReplyPolicy.decideCommand("/definitely-not-a-command")
        assertEquals(QuickReplyPolicy.CommandSupport.UNKNOWN, unknown.support)
    }

    @Test
    fun textAndPresetActionsResolveToConcreteBehaviours() {
        val text = QuickReplyPolicy.resolve(reply(action = QuickReplyAction.text, content = "你好", sendWithAI = true))
        assertEquals(QuickReplyPolicy.Action.InsertText("你好", true), text)

        val preset = QuickReplyPolicy.resolve(reply(action = QuickReplyAction.preset, presetId = "p1"))
        assertEquals(QuickReplyPolicy.Action.SwitchPreset("p1"), preset)

        // 目标是切预设却没给 ID：这是数据问题，必须说明而不是静默什么都不做
        val broken = QuickReplyPolicy.resolve(reply(action = QuickReplyAction.preset, presetId = null))
        assertIsDisabled(broken, "预设")
    }

    @Test
    fun disabledAndUnsupportedCommandsSurfaceAsDisabledWithText() {
        val stopped = reply(action = QuickReplyAction.text, content = "你好", enabled = false)
        assertIsDisabled(QuickReplyPolicy.resolve(stopped), "停用")

        val unsupported = QuickReplyPolicy.resolve(reply(action = QuickReplyAction.command, command = "/imagine 猫"))
        assertIsDisabled(unsupported, "ComfyUI")

        val globallyOff = QuickReplyPolicy.resolve(
            reply(action = QuickReplyAction.command, command = "/continue"),
            commandEnabled = false,
        )
        assertIsDisabled(globallyOff, "关闭")
    }

    @Test
    fun supportedCommandProducesRunnableActionWithParsedArgs() {
        val action = QuickReplyPolicy.resolve(reply(action = QuickReplyAction.command, command = "/swipe 左"))
        val run = action as? QuickReplyPolicy.Action.RunCommand
        assertNotNull(run, "已支持命令应给出可执行动作，实际：$action")
        assertEquals("swipe", run.parsed.name)
        assertEquals(listOf("左"), run.parsed.args)
    }

    // ------------------------------------------------------------ 构造工具

    private fun reply(
        action: QuickReplyAction,
        content: String = "",
        command: String? = null,
        presetId: String? = null,
        enabled: Boolean = true,
        sendWithAI: Boolean = true,
    ) = QuickReply(
        id = "qr-1",
        label = "测试",
        content = content,
        action = action,
        sendWithAI = sendWithAI,
        order = 0,
        enabled = enabled,
        presetId = presetId,
        command = command,
    )

    private fun assertIsDisabled(action: QuickReplyPolicy.Action, contains: String) {
        val disabled = action as? QuickReplyPolicy.Action.Disabled
        assertNotNull(disabled, "应为禁用态，实际：$action")
        assertTrue(
            disabled.reason.contains(contains, ignoreCase = true),
            "禁用原因应包含「$contains」，实际：${disabled.reason}",
        )
    }
}
