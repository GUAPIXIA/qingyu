package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 6 S6-01：派生记忆失效决策的跨语言一致性测试
 * （对齐 fixture `memory-invalidation.json`，oracle 为 PC 生产代码消费的
 * `shared/chat-core/derivedMemory.ts`）。
 *
 * 编辑/删除/清空消息后保留还是全量清零派生记忆，直接决定群记忆 CAS 的
 * 版本推进；两端不一致会让一端保留旧摘要而另一端重建。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatMemoryInvalidationGoldenTest {

    private val root = ChatCoreFixtures.root("memory-invalidation")

    private fun longOrNull(map: Map<String, Any?>, key: String): Long? = (map[key] as? Number)?.toLong()

    private fun snapshotOf(map: Map<String, Any?>): ChatMemoryInvalidation.Snapshot =
        ChatMemoryInvalidation.Snapshot(
            memory = ChatCoreFixtures.str(map, "memory"),
            memoryCurrentState = ChatCoreFixtures.str(map, "memoryCurrentState"),
            memoryFacts = ChatCoreFixtures.listOrNull(map, "memoryFacts"),
            memoryFactHistory = ChatCoreFixtures.listOrNull(map, "memoryFactHistory"),
            factsVectors = ChatCoreFixtures.listOrNull(map, "factsVectors"),
            memoryLastMessageId = ChatCoreFixtures.str(map, "memoryLastMessageId"),
            memoryVersion = longOrNull(map, "memoryVersion"),
            compressedSummary = ChatCoreFixtures.str(map, "compressedSummary"),
            memoryFactParseFailureCount = longOrNull(map, "memoryFactParseFailureCount"),
            memoryFactRetryAfterVersion = longOrNull(map, "memoryFactRetryAfterVersion"),
        )

    @Test
    fun invalidationDecisionMatchesPcCheckpointSemantics() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "invalidationCases") as? List<Map<String, Any?>>)
            ?: error("缺少 invalidationCases（请先运行 TS 生成器：CHAT_CORE_UPDATE_FIXTURES=1 pnpm exec vitest run shared/__tests__/groupChatCoreGolden.test.ts）")
        for (case in cases) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val expected = ChatCoreFixtures.mapOrNull(case, "expected")!!
            val session = ChatCoreFixtures.mapOrNull(input, "session")!!
            val messageIds = (ChatCoreFixtures.listOrNull(input, "messageIds") as? List<*>).orEmpty().map { it.toString() }
            val decision = ChatMemoryInvalidation.plan(
                variant = ChatCoreFixtures.str(input, "variant") ?: "",
                session = snapshotOf(session),
                messageIds = messageIds,
                changedMessageId = ChatCoreFixtures.str(input, "changedMessageId"),
            )
            when (ChatCoreFixtures.str(expected, "action")) {
                "keep" -> assertTrue(
                    "$label：期望保留派生记忆，实际 $decision",
                    decision is ChatMemoryInvalidation.Decision.Keep,
                )
                "invalidate" -> {
                    assertTrue("$label：期望全量失效，实际 $decision", decision is ChatMemoryInvalidation.Decision.Invalidate)
                    decision as ChatMemoryInvalidation.Decision.Invalidate
                    assertEquals(
                        "$label：失效必须携带旧 memoryVersion 作为 CAS 期望版本",
                        longOrNull(expected, "expectedVersion"),
                        decision.expectedVersion,
                    )
                    @Suppress("UNCHECKED_CAST")
                    val expectedPatch = ChatCoreFixtures.mapOrNull(expected, "patch")!!
                    assertEquals(
                        "$label：全量失效必须键名不多不少（多了是新漂移，少了是登记过期）",
                        expectedPatch.keys,
                        decision.patch.keys,
                    )
                    for ((key, value) in expectedPatch) {
                        assertEquals("$label：失效字段 $key 必须与 PC 一致", value, decision.patch[key])
                    }
                }
                else -> error("$label：未知期望 action")
            }
        }
    }

    @Test
    fun resetPatchIsAFixedPointOfPcFieldSet() {
        // 13 键缺一不可：PC 的全量失效 patch 是固定字段集合
        val keys = ChatMemoryInvalidation.resetPatch().keys
        assertEquals(
            "全量失效字段集合必须与 PC 13 键一致",
            setOf(
                "memory", "memoryCurrentState", "memoryFacts", "memoryFactHistory",
                "memoryFactParseFailureCount", "memoryFactRetryAfterVersion", "factsVectors",
                "memoryUpdatedAt", "memoryLastMessageId", "memoryVersion", "factsVectorVersion",
                "compressedSummary", "compressedRange",
            ),
            keys,
        )
    }
}
