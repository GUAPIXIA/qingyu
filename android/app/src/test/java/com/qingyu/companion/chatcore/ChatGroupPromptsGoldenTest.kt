package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 6 S6-01(c)：群提示词段的跨语言一致性测试
 * （对齐 fixture `group-prompts.json`，oracle 为 PC 生产代码消费的
 * `shared/groupChatPrompt.ts` 与 `shared/narrativeMode.ts`）。
 *
 * 这些字符串决定「群里有谁、谁被点名、谁在发言、叙事视角是什么」——
 * 逐字不一致会让同一会话两端得到不同发言行为。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatGroupPromptsGoldenTest {

    private val root = ChatCoreFixtures.root("group-prompts")

    @Suppress("UNCHECKED_CAST")
    private fun cases(key: String): List<Map<String, Any?>> =
        (ChatCoreFixtures.listOrNull(root, key) as? List<Map<String, Any?>>)
            ?: error("缺少 $key（请先运行 TS 生成器：CHAT_CORE_UPDATE_FIXTURES=1 pnpm exec vitest run shared/__tests__/groupChatCoreGolden.test.ts）")

    @Test
    fun defaultOmniscientRulesMatchPcByteForByte() {
        assertEquals(
            "全局叙事默认规则必须与 PC 逐字一致（用户可编辑默认模板的基准文本）",
            ChatCoreFixtures.str(root, "defaultOmniscientRules"),
            ChatNarrativeMode.DEFAULT_OMNISCIENT_NARRATIVE_RULES,
        )
    }

    @Test
    fun turnRulesMatchPcForThreeModes() {
        for (case in cases("turnRulesCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            assertEquals(
                "$label：【对话规则】段必须与 PC 逐字一致",
                ChatCoreFixtures.str(case, "expected"),
                ChatGroupPrompts.buildGroupTurnRulesPrompt(ChatCoreFixtures.str(input, "chatMode") ?: ""),
            )
        }
    }

    @Test
    fun rosterIntroMatchesPc() {
        for (case in cases("rosterCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            @Suppress("UNCHECKED_CAST")
            val memberMaps = (ChatCoreFixtures.listOrNull(input, "members") as? List<Map<String, Any?>>).orEmpty()
            val members = memberMaps.map {
                ChatGroupPrompts.RosterMember(
                    name = ChatCoreFixtures.str(it, "name") ?: "",
                    description = ChatCoreFixtures.str(it, "description"),
                )
            }
            assertEquals(
                "$label：成员概览段必须与 PC 逐字一致（含 80 字截断与用户在场声明）",
                ChatCoreFixtures.str(case, "expected"),
                ChatGroupPrompts.buildGroupRosterIntro(
                    groupName = ChatCoreFixtures.str(input, "groupName") ?: "",
                    members = members,
                    userName = ChatCoreFixtures.str(input, "userName") ?: "",
                ),
            )
        }
    }

    @Test
    fun singleChatNarrativePromptMatchesPc() {
        for (case in cases("singleNarrativeCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            assertEquals(
                "$label：单聊叙事约束必须与 PC 逐字一致",
                ChatCoreFixtures.str(case, "expected"),
                ChatNarrativeMode.buildNarrativeModePrompt(
                    mode = ChatCoreFixtures.str(input, "mode") ?: "",
                    userName = ChatCoreFixtures.str(input, "userName") ?: "",
                    characterName = ChatCoreFixtures.str(input, "characterName") ?: "",
                ),
            )
        }
    }

    @Test
    fun groupNarrativePromptMatchesPc() {
        for (case in cases("groupNarrativeCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            assertEquals(
                "$label：群聊叙事约束必须与 PC 逐字一致（视角/焦点/三模式边界）",
                ChatCoreFixtures.str(case, "expected"),
                ChatNarrativeMode.buildGroupNarrativeModePrompt(
                    mode = ChatCoreFixtures.str(input, "mode") ?: "",
                    userName = ChatCoreFixtures.str(input, "userName") ?: "",
                    focusName = ChatCoreFixtures.str(input, "focusName") ?: "",
                    chatMode = ChatCoreFixtures.str(input, "chatMode") ?: "",
                    omniscientRules = ChatCoreFixtures.str(input, "omniscientRules"),
                ),
            )
        }
    }
}
