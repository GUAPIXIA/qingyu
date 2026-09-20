package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-02：「**超出上下文前必须在本地阻断或降级，不能只依赖供应商报错**」。
 *
 * 为什么这条容易被漏掉：历史消息由 `cropHistory` 按预算裁剪，看起来「已经处理了超限」。
 * 但**非历史部分**（预设 / 系统提示 / 世界书 / 用户人设）本身就可能超出输入上限——
 * 那种情况裁历史救不回来，程序会把超限请求照发，最后把供应商的原始报错抛给用户，
 * 而编译期与常规门禁都不会报错。
 *
 * 本测试锁定「检测」这一半：装配结果必须报出超限量，且未超限时为 0
 * （后者很关键——否则每轮对话都会被误阻断，比漏报更糟）。
 * 「阻断」那一半在 `LocalChatGenerationUseCase`，由 `LocalGenerationOverflowGuardTest` 覆盖。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatContextOverflowDetectionTest {

    private fun build(
        presetSystem: String = "你是助手。",
        description: String = "旧书店的店主。",
        maxContext: Int = 8192,
    ): ChatContextBuilder.BuildResult = ChatContextBuilder.buildContextMessagesFromData(
        ChatContextBuilder.BuildData(
            character = ChatContextBuilder.CharacterSnapshot(name = "苏晚", description = description),
            preset = ChatContextBuilder.PresetSnapshot(systemPrompt = presetSystem),
            chat = ChatContextBuilder.ChatSnapshot(
                messages = listOf(
                    ChatContextBuilder.MessageSnapshot(id = "m1", role = "user", content = "夜安。", timestamp = 1),
                ),
                sessions = listOf(ChatContextBuilder.SessionSnapshot(id = "s1", characterId = "c1")),
                currentSessionId = "s1",
            ),
            settings = ChatContextBuilder.SettingsSnapshot(userName = "旅人", activeModel = "gpt-4o-mini"),
            profile = ChatContextBuilder.ProfileSnapshot(
                provider = "openai",
                model = "gpt-4o-mini",
                maxContext = maxContext,
            ),
        ),
    )

    @Test
    fun normalContextHasNoOverflow() {
        val built = build()
        assertEquals("未超限时不得报出溢出，否则每轮都会被误阻断", 0, built.overflowTokens)
        assertTrue("用量必须如实上报", built.lastContextUsage.used > 0)
    }

    @Test
    fun oversizedPresetIsDetectedAsOverflow() {
        // 预设本身远超输入上限：这是「历史裁剪救不回来」的典型场景
        val built = build(presetSystem = "很长的预设。".repeat(4000), maxContext = 2048)
        assertTrue(
            "非历史部分超限必须被检测出来（否则会照发超限请求、把供应商报错抛给用户）",
            built.overflowTokens > 0,
        )
    }

    @Test
    fun overflowAmountGrowsWithContent() {
        // 溢出不变量：内容越长溢出越多（杜绝「永远返回 0」或「永远返回同一个数」）
        val small = build(presetSystem = "预设。".repeat(500), maxContext = 2048).overflowTokens
        val large = build(presetSystem = "预设。".repeat(2000), maxContext = 2048).overflowTokens
        assertTrue("越大越溢出：small=$small large=$large", large > small)
        assertTrue("两次都必须超限（该输入本身就超）", small > 0)
    }

    @Test
    fun overflowShrinksWhenContextLimitGrows() {
        val template = "预设内容。".repeat(800)
        val tight = build(presetSystem = template, maxContext = 2048).overflowTokens
        val loose = build(presetSystem = template, maxContext = 32768).overflowTokens
        assertTrue("上限越大溢出越小：tight=$tight loose=$loose", loose < tight)
        assertEquals("上限足够大时必须为 0", 0, loose)
    }

    @Test
    fun overflowDoesNotDependOnHistoryLengthOnly() {
        // 明确「非历史部分」也能触发：历史只有一条，仍然溢出
        val built = build(presetSystem = "预设。".repeat(3000), maxContext = 2048)
        assertTrue(built.overflowTokens > 0)
    }
}
