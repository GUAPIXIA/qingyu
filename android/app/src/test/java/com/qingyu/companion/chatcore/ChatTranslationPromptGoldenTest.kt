package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-04：消息翻译提示词的跨语言一致性测试
 * （对齐 fixture `translation-prompt.json`，oracle 为 PC 的 `shared/translationPrompt.ts`）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatTranslationPromptGoldenTest {

    private val root = ChatCoreFixtures.root("translation-prompt")

    @Test
    fun promptMatchesPc() {
        val constants = ChatCoreFixtures.mapOrNull(root, "constants")!!
        assertEquals(
            "DEFAULT_TARGET_LANG",
            ChatCoreFixtures.str(constants, "defaultTargetLang"),
            ChatTranslationPrompt.DEFAULT_TARGET_LANG,
        )

        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "promptCases") as? List<Map<String, Any?>>)
            ?: error("缺少 promptCases")
        for (case in cases) {
            val targetLang = ChatCoreFixtures.str(case, "targetLang") ?: ""
            assertEquals(
                "buildMessageTranslationSystemPrompt(${targetLang.ifEmpty { "<空>" }})",
                ChatCoreFixtures.str(case, "prompt"),
                ChatTranslationPrompt.buildMessageTranslationSystemPrompt(targetLang),
            )
        }
    }

    @Test
    fun targetLangResolutionMatchesJsTruthiness() {
        // PC 是 `configured || '中文'`：只有空串回退；空白串是 JS 真值，必须原样保留
        assertEquals("中文", ChatTranslationPrompt.resolveTargetLang(null))
        assertEquals("中文", ChatTranslationPrompt.resolveTargetLang(""))
        assertEquals("   ", ChatTranslationPrompt.resolveTargetLang("   "))
        assertEquals("English", ChatTranslationPrompt.resolveTargetLang("English"))
        // 也不做 trim（PC 不会改用户配置）
        assertEquals(" 日本语 ", ChatTranslationPrompt.resolveTargetLang(" 日本语 "))
    }

    @Test
    fun wrapperStrippingOnlyRemovesOuterShell() {
        // 要求「只输出译文」，但模型偶尔仍包一层代码块或引号
        assertEquals("你好", ChatTranslationPrompt.stripTranslationWrapper("你好"))
        assertEquals("你好", ChatTranslationPrompt.stripTranslationWrapper("  你好  "))
        assertEquals("你好", ChatTranslationPrompt.stripTranslationWrapper("\"你好\""))
        assertEquals("你好", ChatTranslationPrompt.stripTranslationWrapper("```\n你好\n```"))
        assertEquals("你好", ChatTranslationPrompt.stripTranslationWrapper("```markdown\n你好\n```"))
        // 正文内部的引号与反引号不得被吃掉
        assertEquals("他说\"你好\"", ChatTranslationPrompt.stripTranslationWrapper("他说\"你好\""))
        assertEquals("`code` here", ChatTranslationPrompt.stripTranslationWrapper("`code` here"))
        // 空输入保持空（调用方据此判定失败）
        assertEquals("", ChatTranslationPrompt.stripTranslationWrapper("   "))
    }

    @Test
    fun samplingParamsMatchPc() {
        assertEquals(0.3, ChatTranslationPrompt.TEMPERATURE, 1e-9)
        assertEquals(0.9, ChatTranslationPrompt.TOP_P, 1e-9)
        assertTrue("提示词必须要求保留 Markdown/HTML", 
            ChatTranslationPrompt.buildMessageTranslationSystemPrompt("中文").contains("Markdown"))
    }
}
