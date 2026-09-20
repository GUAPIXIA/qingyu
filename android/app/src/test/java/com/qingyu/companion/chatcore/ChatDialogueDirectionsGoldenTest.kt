package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 A5：对话「下一步方向」的跨语言一致性测试
 * （对齐 fixture `dialogue-directions.json`，oracle 为 PC 的 `shared/dialogueDirections.ts`）。
 *
 * 校验策略是「全有或全无」：只渲染 2 个方向会让用户以为第 3 个不存在，
 * 而不是知道生成失败了。因此任一校验不通过必须整组作废——本文件逐个锁定这些条件。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatDialogueDirectionsGoldenTest {

    private val root = ChatCoreFixtures.root("dialogue-directions")

    private fun directionOf(map: Map<String, Any?>): ChatDialogueDirections.Direction =
        ChatDialogueDirections.Direction(
            id = ChatCoreFixtures.str(map, "id") ?: "",
            label = ChatCoreFixtures.str(map, "label") ?: "",
            content = ChatCoreFixtures.str(map, "content") ?: "",
            tendency = ChatCoreFixtures.str(map, "tendency") ?: "",
        )

    private fun assertDirections(label: String, expected: List<Any?>, actual: List<ChatDialogueDirections.Direction>) {
        assertEquals("$label 数量", expected.size, actual.size)
        expected.forEachIndexed { index, raw ->
            @Suppress("UNCHECKED_CAST")
            val map = raw as Map<String, Any?>
            assertEquals("$label[$index].id", ChatCoreFixtures.str(map, "id"), actual[index].id)
            assertEquals("$label[$index].label", ChatCoreFixtures.str(map, "label"), actual[index].label)
            assertEquals("$label[$index].content", ChatCoreFixtures.str(map, "content"), actual[index].content)
            assertEquals("$label[$index].tendency", ChatCoreFixtures.str(map, "tendency"), actual[index].tendency)
        }
    }

    @Test
    fun constantsMatchPc() {
        val constants = ChatCoreFixtures.mapOrNull(root, "constants")!!
        val tendencies = (ChatCoreFixtures.listOrNull(constants, "tendencies") as? List<*>)?.map { it.toString() }
        assertEquals(ChatDialogueDirections.TENDENCIES, tendencies)
        val limits = ChatCoreFixtures.mapOrNull(constants, "limits")!!
        assertEquals(ChatDialogueDirections.COUNT, ChatCoreFixtures.intOrNull(limits, "count"))
        assertEquals(ChatDialogueDirections.LABEL_MIN_CHARS, ChatCoreFixtures.intOrNull(limits, "labelMinChars"))
        assertEquals(ChatDialogueDirections.LABEL_MAX_CHARS, ChatCoreFixtures.intOrNull(limits, "labelMaxChars"))
        assertEquals(ChatDialogueDirections.CONTENT_MIN_CHARS, ChatCoreFixtures.intOrNull(limits, "contentMinChars"))
        assertEquals(ChatDialogueDirections.CONTENT_MAX_CHARS, ChatCoreFixtures.intOrNull(limits, "contentMaxChars"))
        assertEquals(
            ChatDialogueDirections.TEMPERATURE,
            (ChatCoreFixtures.mapOrNull(root, "constants")!!["temperature"] as Number).toDouble(),
            1e-9,
        )
        assertEquals(ChatDialogueDirections.TAG, ChatCoreFixtures.str(constants, "tag"))
    }

    @Test
    fun enabledResolutionMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "enabledCases") as? List<Map<String, Any?>>)
            ?: error("缺少 enabledCases")
        for (case in cases) {
            val dialogue = ChatCoreFixtures.boolOrNull(case, "dialogueDirectionsEnabled")
            val gameMaster = ChatCoreFixtures.boolOrNull(case, "gameMasterMode")
            assertEquals(
                "resolveEnabled(dialogue=$dialogue, gameMaster=$gameMaster)",
                ChatCoreFixtures.boolOrNull(case, "enabled"),
                ChatDialogueDirections.resolveEnabled(dialogue, gameMaster),
            )
        }
    }

    @Test
    fun payloadAndParseMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val payloadCases = (ChatCoreFixtures.listOrNull(root, "payloadCases") as? List<Map<String, Any?>>)
            ?: error("缺少 payloadCases")
        for (case in payloadCases) {
            val raw = ChatCoreFixtures.str(case, "raw") ?: ""
            assertEquals(
                "extractPayload(${raw.take(30)})",
                ChatCoreFixtures.str(case, "payload") ?: "",
                ChatDialogueDirections.extractPayload(raw),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val parseCases = (ChatCoreFixtures.listOrNull(root, "parseCases") as? List<Map<String, Any?>>)
            ?: error("缺少 parseCases")
        for (case in parseCases) {
            val raw = ChatCoreFixtures.str(case, "raw") ?: ""
            val expected = ChatCoreFixtures.listOrNull(case, "directions") ?: emptyList()
            assertDirections(
                "parse(${raw.take(28)})",
                expected,
                ChatDialogueDirections.parse(raw),
            )
        }
    }

    @Test
    fun similarityMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "similarityCases") as? List<Map<String, Any?>>)
            ?: error("缺少 similarityCases")
        for (case in cases) {
            val directions = ((ChatCoreFixtures.listOrNull(case, "directions") as? List<Map<String, Any?>>)
                ?: emptyList()).map { directionOf(it) }
            assertEquals(
                "hasSimilar(${directions.map { it.label }})",
                ChatCoreFixtures.boolOrNull(case, "similar"),
                ChatDialogueDirections.hasSimilar(directions),
            )
        }
    }

    @Test
    fun promptsMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "promptCases") as? List<Map<String, Any?>>)
            ?: error("缺少 promptCases")
        for (case in cases) {
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val generationInput = ChatDialogueDirections.GenerationInput(
                userName = ChatCoreFixtures.str(input, "userName") ?: "",
                charName = ChatCoreFixtures.str(input, "charName") ?: "",
                characterDescription = ChatCoreFixtures.str(input, "characterDescription") ?: "",
                narrativeMode = ChatCoreFixtures.str(input, "narrativeMode") ?: "immersive",
                recentMessages = ((ChatCoreFixtures.listOrNull(input, "recentMessages") as? List<Map<String, Any?>>)
                    ?: emptyList()).map {
                    ChatDialogueDirections.SpeakerMessage(
                        ChatCoreFixtures.str(it, "speaker") ?: "",
                        ChatCoreFixtures.str(it, "content") ?: "",
                    )
                },
                latestReply = ChatCoreFixtures.str(input, "latestReply") ?: "",
                worldState = ChatCoreFixtures.str(input, "worldState"),
            )
            val mode = ChatCoreFixtures.str(input, "narrativeMode")
            assertEquals(
                "systemPrompt($mode)",
                ChatCoreFixtures.str(case, "systemPrompt"),
                ChatDialogueDirections.buildSystemPrompt(generationInput),
            )
            assertEquals(
                "userPrompt($mode)",
                ChatCoreFixtures.str(case, "userPrompt"),
                ChatDialogueDirections.buildUserPrompt(generationInput),
            )
        }
    }

    @Test
    fun partialGroupsAreRejectedRatherThanPartiallyRendered() {
        // 只回 2 个方向必须整组作废（不能让用户以为第 3 个方向不存在）
        val two = """<directions>[
          {"id":"safe","label":"稳妥地接过茶","content":"我接过茶杯，轻声道谢，顺势问起雨势。","tendency":"safe"},
          {"id":"explore","label":"打量四周书架","content":"我慢慢环视四周的书架，留意旧书脊。","tendency":"explore"}
        ]</directions>"""
        val parsed = ChatDialogueDirections.parse(two)
        assertTrue("数量不足时必须整组作废", parsed.isEmpty())

        // 解释性内容同样整组作废
        val explanatory = """<directions>[
          {"id":"safe","label":"稳妥地接过茶","content":"我接过茶杯，轻声道谢，顺势问起雨势。","tendency":"safe"},
          {"id":"explore","label":"打量四周书架","content":"我慢慢环视四周的书架，留意旧书脊。","tendency":"explore"},
          {"id":"risky","label":"直接问出心事","content":"以下是三个方向的说明，请选择其中一个。","tendency":"risky"}
        ]</directions>"""
        assertTrue("含解释性内容时必须整组作废", ChatDialogueDirections.parse(explanatory).isEmpty())

        // 输出顺序固定为 safe → explore → risky（与模型给出的顺序无关）
        val shuffled = """<directions>[
          {"id":"risky","label":"直接问出心事","content":"我放下茶杯，问出那个一直没敢问的问题。","tendency":"risky"},
          {"id":"safe","label":"稳妥地接过茶","content":"我接过茶杯，轻声道谢，顺势问起雨势。","tendency":"safe"},
          {"id":"explore","label":"打量四周书架","content":"我慢慢环视四周的书架，留意旧书脊。","tendency":"explore"}
        ]</directions>"""
        val ordered = ChatDialogueDirections.parse(shuffled)
        assertEquals(listOf("safe", "explore", "risky"), ordered.map { it.tendency })
        assertFalse(ordered.isEmpty())
    }
}
