package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 6 S6-01：群聊发言调度的跨语言一致性测试
 * （对齐 fixture `group-scheduling.json`，oracle 为 PC 生产代码消费的
 * `shared/chat-core/groupScheduling.ts`）。
 *
 * 这些语义决定「谁在第几轮发言、自动接力何时结束、消息归属给哪个角色」；
 * 与 PC 不一致就会让同一段群聊在两端得到不同的发言计划（阶段 6 §3 第一条）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatGroupSchedulingGoldenTest {

    private val root = ChatCoreFixtures.root("group-scheduling")

    @Suppress("UNCHECKED_CAST")
    private fun members(): List<ChatGroupScheduling.Member> =
        (ChatCoreFixtures.listOrNull(root, "members") as? List<Map<String, Any?>>).orEmpty().map {
            ChatGroupScheduling.Member(
                id = ChatCoreFixtures.str(it, "id") ?: error("member 缺少 id"),
                name = ChatCoreFixtures.str(it, "name") ?: error("member 缺少 name"),
            )
        }

    private fun roundsOf(map: Map<String, Any?>): List<Long> =
        (ChatCoreFixtures.listOrNull(map, "rounds") as? List<*>).orEmpty().map { (it as Number).toLong() }

    private fun idsOf(map: Map<String, Any?>, key: String): List<String> =
        (ChatCoreFixtures.listOrNull(map, key) as? List<*>).orEmpty().map { it.toString() }

    @Suppress("UNCHECKED_CAST")
    private fun cases(key: String): List<Map<String, Any?>> =
        (ChatCoreFixtures.listOrNull(root, key) as? List<Map<String, Any?>>)
            ?: error("缺少 $key（请先运行 TS 生成器：CHAT_CORE_UPDATE_FIXTURES=1 pnpm exec vitest run shared/__tests__/groupChatCoreGolden.test.ts）")

    @Test
    fun nextRoundMatchesPcMaxPlusOne() {
        for (case in cases("nextRoundCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val expected = (case["expected"] as Number).toLong()
            assertEquals(
                "$label：下一轮编号必须与 PC 的 max(rounds,0)+1 相同，否则两端轮次号分叉",
                expected,
                ChatGroupScheduling.nextGroupRound(roundsOf(input)),
            )
        }
    }

    @Test
    fun mentionDetectionMatchesPcWordBoundarySemantics() {
        val members = members()
        for (case in cases("mentionCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val content = ChatCoreFixtures.str(input, "content") ?: ""
            val memberIds = idsOf(input, "memberIds")
            val expected = idsOf(case, "expected")
            val actual = ChatGroupScheduling.detectMentionedMembers(
                content,
                memberIds.mapNotNull { id -> members.find { it.id == id } },
            )
            assertEquals("$label：@提及集合必须与 PC 相同（D3 词边界、大小写敏感、按成员顺序）", expected, actual)
        }
    }

    @Test
    fun speakerPlanMatchesPcForThreeModes() {
        for (case in cases("speakerPlanCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val expected = ChatCoreFixtures.mapOrNull(case, "expected")!!
            val plan = ChatGroupScheduling.resolveSpeakerPlan(
                chatMode = ChatCoreFixtures.str(input, "chatMode") ?: "",
                memberIds = idsOf(input, "memberIds"),
                currentSpeakerIndex = (input["currentSpeakerIndex"] as Number).toLong(),
                targetCharId = ChatCoreFixtures.str(input, "targetCharId"),
                knownCharacterIds = (ChatCoreFixtures.listOrNull(input, "knownCharacterIds") as? List<*>)
                    ?.map { it.toString() },
            )
            when (val kind = ChatCoreFixtures.str(expected, "kind")) {
                "single" -> {
                    assertTrue("$label：期望 single，实际 $plan", plan is ChatGroupScheduling.SpeakerPlan.Single)
                    plan as ChatGroupScheduling.SpeakerPlan.Single
                    assertEquals("$label：发言者归属必须与 PC 相同", ChatCoreFixtures.str(expected, "speakerId"), plan.speakerId)
                    assertEquals("$label：发言者索引必须与 PC 相同", ChatCoreFixtures.intOrNull(expected, "speakerIndex"), plan.speakerIndex)
                    assertEquals("$label：发言来源（target/round_robin）必须与 PC 相同", ChatCoreFixtures.str(expected, "via"), plan.via)
                }
                "free" -> assertTrue("$label：期望 free，实际 $plan", plan is ChatGroupScheduling.SpeakerPlan.Free)
                "error" -> {
                    assertTrue("$label：期望 error，实际 $plan", plan is ChatGroupScheduling.SpeakerPlan.Error)
                    plan as ChatGroupScheduling.SpeakerPlan.Error
                    assertEquals("$label：错误原因必须与 PC 相同", ChatCoreFixtures.str(expected, "reason"), plan.reason)
                }
                else -> error("$label：未知期望 kind=$kind")
            }
        }
    }

    @Test
    fun pollingContinuePlanMatchesPcChainSemantics() {
        for (case in cases("pollingContinueCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val expected = ChatCoreFixtures.mapOrNull(case, "expected")!!
            @Suppress("UNCHECKED_CAST")
            val messages = (ChatCoreFixtures.listOrNull(input, "messages") as? List<Map<String, Any?>>).orEmpty().map {
                ChatGroupScheduling.MessageRef(
                    characterId = ChatCoreFixtures.str(it, "characterId") ?: "",
                    round = (it["round"] as Number).toLong(),
                )
            }
            val plan = ChatGroupScheduling.planPollingContinue(
                messages = messages,
                memberIds = idsOf(input, "memberIds"),
                maxRounds = (input["maxRounds"] as Number).toLong(),
            )
            val expectContinue = expected["continue"] == true
            if (expectContinue) {
                assertTrue("$label：期望续排，实际 $plan", plan is ChatGroupScheduling.PollingContinuePlan.Continue)
                plan as ChatGroupScheduling.PollingContinuePlan.Continue
                assertEquals("$label：下一发言者必须与 PC 轮转相同", ChatCoreFixtures.str(expected, "nextCharId"), plan.nextCharId)
                assertEquals("$label：下一索引必须与 PC 轮转相同", ChatCoreFixtures.intOrNull(expected, "nextSpeakerIndex"), plan.nextSpeakerIndex)
            } else {
                assertTrue("$label：期望停止，实际 $plan", plan is ChatGroupScheduling.PollingContinuePlan.Stop)
                plan as ChatGroupScheduling.PollingContinuePlan.Stop
                assertEquals("$label：停止原因必须与 PC 相同", ChatCoreFixtures.str(expected, "reason"), plan.reason)
            }
        }
    }

    @Test
    fun pollingIntervalMatchesPcClamp() {
        for (case in cases("pollingIntervalCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val expected = (case["expected"] as Number).toLong()
            val actual = ChatGroupScheduling.resolvePollingIntervalMs(
                (input["speakerInterval"] as? Number)?.toLong(),
            )
            assertEquals("$label：接力间隔必须与 PC 的 max(500, x||2000) 相同", expected, actual)
        }
    }

    @Test
    fun autoMemoryTriggerMatchesPcCursorCounting() {
        for (case in cases("autoMemoryCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val expected = case["expected"] as Boolean
            val actual = ChatGroupScheduling.planAutoMemoryTrigger(
                memoryEnabled = input["memoryEnabled"] as? Boolean,
                memoryMode = ChatCoreFixtures.str(input, "memoryMode"),
                autoMemoryInterval = (input["autoMemoryInterval"] as? Number)?.toLong(),
                memoryLastMessageId = ChatCoreFixtures.str(input, "memoryLastMessageId"),
                messageIds = idsOf(input, "messageIds"),
            )
            assertEquals("$label：自动记忆触发判定必须与 PC 相同", expected, actual)
        }
    }
}
