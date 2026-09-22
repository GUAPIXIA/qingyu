package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 6 S6-01：free 模式多角色拆分与归属的跨语言一致性测试
 * （对齐 fixture `group-free-split.json`，oracle 为 PC 生产代码消费的
 * `shared/chat-core/groupFreeSplit.ts`）。
 *
 * 拆分规则直接决定**消息条数与角色归属**；两端不一致会让同一段群聊在两端
 * 拥有不同的消息序列，影响导出、记忆摘要、上下文与同步。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatGroupFreeSplitGoldenTest {

    private val root = ChatCoreFixtures.root("group-free-split")

    @Suppress("UNCHECKED_CAST")
    private fun members(): List<ChatGroupFreeSplit.Member> =
        (ChatCoreFixtures.listOrNull(root, "members") as? List<Map<String, Any?>>).orEmpty().map {
            ChatGroupFreeSplit.Member(
                id = ChatCoreFixtures.str(it, "id") ?: error("member 缺少 id"),
                name = ChatCoreFixtures.str(it, "name") ?: error("member 缺少 name"),
            )
        }

    @Test
    fun splitAndAttributionMatchPc() {
        val members = members()
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "splitCases") as? List<Map<String, Any?>>)
            ?: error("缺少 splitCases（请先运行 TS 生成器：CHAT_CORE_UPDATE_FIXTURES=1 pnpm exec vitest run shared/__tests__/groupChatCoreGolden.test.ts）")
        for (case in cases) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val expected = ChatCoreFixtures.mapOrNull(case, "expected")!!
            val content = ChatCoreFixtures.str(input, "content") ?: ""
            val memberIds = (ChatCoreFixtures.listOrNull(input, "memberIds") as? List<*>).orEmpty().map { it.toString() }
            val result = ChatGroupFreeSplit.split(
                content = content,
                members = memberIds.mapNotNull { id -> members.find { it.id == id } },
                narrativeMode = ChatCoreFixtures.str(input, "narrativeMode"),
            )
            assertEquals("$label：拆分类别（narrator/segments/fallback）必须与 PC 相同", ChatCoreFixtures.str(expected, "kind"), result.kind)
            @Suppress("UNCHECKED_CAST")
            val expectedMessages = (ChatCoreFixtures.listOrNull(expected, "messages") as? List<Map<String, Any?>>).orEmpty()
            assertEquals(
                "$label：拆分后的消息条数必须与 PC 相同（条数进入导出/记忆/同步）",
                expectedMessages.size,
                result.messages.size,
            )
            for ((index, expectedMessage) in expectedMessages.withIndex()) {
                val actual = result.messages[index]
                assertEquals(
                    "$label：第 ${index + 1} 条的角色归属必须与 PC 相同",
                    ChatCoreFixtures.str(expectedMessage, "characterId"),
                    actual.characterId,
                )
                assertEquals(
                    "$label：第 ${index + 1} 条的正文必须与 PC 相同",
                    ChatCoreFixtures.str(expectedMessage, "content"),
                    actual.content,
                )
            }
        }
    }
}
