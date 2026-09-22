package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 6 S6-01(c)：群上下文确定性文本块的跨语言一致性测试
 * （对齐 fixture `group-context-blocks.json`，oracle 为
 * `shared/chat-core/groupContextBlocks.ts`）。
 *
 * 成员卡/用户人设/历史归属标注/后历史指令决定同一段群聊在两端拼出的 prompt
 * 是否逐字相同；变量替换的 charName 口径（目标名 vs 成员名 vs 发言者名）也在本 fixture 钉死。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatGroupContextBlocksGoldenTest {

    private val root = ChatCoreFixtures.root("group-context-blocks")

    @Suppress("UNCHECKED_CAST")
    private fun cases(key: String): List<Map<String, Any?>> =
        (ChatCoreFixtures.listOrNull(root, key) as? List<Map<String, Any?>>)
            ?: error("缺少 $key（请先运行 TS 生成器：CHAT_CORE_UPDATE_FIXTURES=1 pnpm exec vitest run shared/__tests__/groupChatCoreGolden.test.ts）")

    @Suppress("UNCHECKED_CAST")
    private fun members(): List<ChatGroupContextBlocks.Member> =
        (ChatCoreFixtures.listOrNull(root, "members") as? List<Map<String, Any?>>).orEmpty().map {
            ChatGroupContextBlocks.Member(
                id = ChatCoreFixtures.str(it, "id") ?: error("member 缺少 id"),
                name = ChatCoreFixtures.str(it, "name") ?: error("member 缺少 name"),
                description = ChatCoreFixtures.str(it, "description"),
                personality = ChatCoreFixtures.str(it, "personality"),
                scenario = ChatCoreFixtures.str(it, "scenario"),
                systemPrompt = ChatCoreFixtures.str(it, "systemPrompt"),
                exampleDialog = ChatCoreFixtures.str(it, "exampleDialog"),
                postHistoryInstructions = ChatCoreFixtures.str(it, "postHistoryInstructions"),
            )
        }

    private fun ids(map: Map<String, Any?>, key: String): List<String> =
        (ChatCoreFixtures.listOrNull(map, key) as? List<*>).orEmpty().map { it.toString() }

    private fun cardsOptions(map: Map<String, Any?>): ChatGroupContextBlocks.MemberCardsOptions =
        ChatGroupContextBlocks.MemberCardsOptions(
            userName = ChatCoreFixtures.str(map, "userName") ?: "",
            shouldSendScenario = map["shouldSendScenario"] as? Boolean ?: true,
            lorebookBefore = ChatCoreFixtures.str(map, "lorebookBefore") ?: "",
            lorebookAfter = ChatCoreFixtures.str(map, "lorebookAfter") ?: "",
            exampleBefore = ids(map, "exampleBefore"),
            exampleAfter = ids(map, "exampleAfter"),
        )

    @Test
    fun charNameForVarsMatchesPc() {
        val members = members()
        for (case in cases("charNameForVarsCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val resolved = ids(input, "memberIds").mapNotNull { id -> members.firstOrNull { it.id == id } }
            assertEquals(
                "$label：变量替换 charName 口径必须与 PC 相同",
                ChatCoreFixtures.str(case, "expected"),
                ChatGroupContextBlocks.resolveCharNameForVars(ChatCoreFixtures.str(input, "targetName"), resolved),
            )
        }
    }

    @Test
    fun scenarioGateMatchesPc() {
        for (case in cases("shouldSendScenarioCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            assertEquals(
                "$label：scenarioInjectionMode 门控必须与 PC 相同",
                case["expected"] as Boolean,
                ChatGroupContextBlocks.resolveShouldSendScenario(
                    ChatCoreFixtures.str(input, "mode"),
                    ChatCoreFixtures.intOrNull(input, "userMessageCount") ?: 0,
                ),
            )
        }
    }

    @Test
    fun freeMemberCardsMatchPc() {
        val members = members()
        for (case in cases("freeMemberCardCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val resolved = ids(input, "memberIds").mapNotNull { id -> members.firstOrNull { it.id == id } }
            assertEquals(
                "$label：free 多成员卡块必须与 PC 逐字一致",
                ChatCoreFixtures.str(case, "expected"),
                ChatGroupContextBlocks.buildFreeMemberCards(resolved, cardsOptions(ChatCoreFixtures.mapOrNull(input, "opts")!!)),
            )
        }
    }

    @Test
    fun targetMemberCardMatchesPc() {
        val members = members()
        for (case in cases("targetMemberCardCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val target = members.firstOrNull { it.id == ChatCoreFixtures.str(input, "targetId") }
                ?: error("$label：目标成员不存在")
            assertEquals(
                "$label：发言人聚焦卡块必须与 PC 逐字一致",
                ChatCoreFixtures.str(case, "expected"),
                ChatGroupContextBlocks.buildTargetMemberCard(target, cardsOptions(ChatCoreFixtures.mapOrNull(input, "opts")!!)),
            )
        }
    }

    @Test
    fun userPersonaBlockMatchesPc() {
        for (case in cases("userPersonaCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val injectionMap = ChatCoreFixtures.mapOrNull(input, "injection")
            val injection = injectionMap?.let {
                ChatGroupContextBlocks.PersonaInjection(
                    enabled = ChatCoreFixtures.boolOrNull(it, "enabled") ?: true,
                    position = ChatCoreFixtures.str(it, "position") ?: "system",
                    includeDescription = ChatCoreFixtures.boolOrNull(it, "includeDescription"),
                    includePersona = ChatCoreFixtures.boolOrNull(it, "includePersona"),
                )
            }
            assertEquals(
                "$label：用户人设正文必须与 PC 逐字一致（include 缺省视为 true）",
                ChatCoreFixtures.str(case, "expected"),
                ChatGroupContextBlocks.buildUserPersona(
                    userName = ChatCoreFixtures.str(input, "userName") ?: "",
                    userDescription = ChatCoreFixtures.str(input, "userDescription"),
                    userPersona = ChatCoreFixtures.str(input, "userPersona"),
                    charNameForVars = ChatCoreFixtures.str(input, "charNameForVars") ?: "",
                    injection = injection,
                ),
            )
        }
    }

    @Test
    fun historyAttributionMatchesPc() {
        val members = members()
        for (case in cases("historyCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            @Suppress("UNCHECKED_CAST")
            val messageMaps = (ChatCoreFixtures.listOrNull(input, "messages") as? List<Map<String, Any?>>).orEmpty()
            val messages = messageMaps.map {
                ChatGroupContextBlocks.HistoryMessage(
                    characterId = ChatCoreFixtures.str(it, "characterId") ?: "",
                    content = ChatCoreFixtures.str(it, "content") ?: "",
                    images = ids(it, "images"),
                )
            }
            val resolved = ids(input, "memberIds").mapNotNull { id -> members.firstOrNull { it.id == id } }
            @Suppress("UNCHECKED_CAST")
            val expectedEntries = (ChatCoreFixtures.listOrNull(case, "expected") as? List<Map<String, Any?>>).orEmpty()
            val actual = ChatGroupContextBlocks.mapHistoryMessages(
                messages = messages,
                members = resolved,
                userName = ChatCoreFixtures.str(input, "userName") ?: "",
                charNameForVars = ChatCoreFixtures.str(input, "charNameForVars") ?: "",
            )
            assertEquals(
                "$label：历史归属标注条数必须与 PC 相同",
                expectedEntries.size,
                actual.size,
            )
            for ((index, expectedEntry) in expectedEntries.withIndex()) {
                assertEquals(
                    "$label：第 ${index + 1} 条 role 必须与 PC 相同",
                    ChatCoreFixtures.str(expectedEntry, "role"),
                    actual[index].role,
                )
                assertEquals(
                    "$label：第 ${index + 1} 条正文（含前缀与变量替换）必须与 PC 逐字一致",
                    ChatCoreFixtures.str(expectedEntry, "content"),
                    actual[index].content,
                )
                val expectedImages = ids(expectedEntry, "images")
                val actualImages = actual[index].images.orEmpty()
                assertEquals("$label：第 ${index + 1} 条图片必须与 PC 相同", expectedImages, actualImages)
            }
        }
    }

    @Test
    fun postHistoryInstructionsMatchPc() {
        val members = members()
        for (case in cases("postHistoryCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val resolved = ids(input, "memberIds").mapNotNull { id -> members.firstOrNull { it.id == id } }
            val target = ChatCoreFixtures.str(input, "target")?.let { targetId ->
                members.firstOrNull { it.id == targetId }
            }
            assertEquals(
                "$label：后历史指令拼接必须与 PC 逐字一致（free 全成员/聚焦仅目标）",
                ChatCoreFixtures.str(case, "expected"),
                ChatGroupContextBlocks.buildPostHistoryInstructions(
                    chatMode = ChatCoreFixtures.str(input, "chatMode") ?: "",
                    members = resolved,
                    target = target,
                    userName = ChatCoreFixtures.str(input, "userName") ?: "",
                    charNameForVars = ChatCoreFixtures.str(input, "charNameForVars") ?: "",
                ),
            )
        }
    }
}
