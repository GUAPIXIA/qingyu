package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-04：消息候选语义的跨语言一致性测试
 * （对齐 fixture `swipe-candidates.json`，oracle 为 PC 生产代码消费的
 * `shared/chat-core/swipeCandidates.ts`）。
 *
 * 这条语义的价值在于**消息数量**：把「重生成」实现成「新建消息」会让候选数、
 * 导出内容、分页与上下文预算全部与 PC 不同。Android 此前正是如此，本轮修正。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatSwipeCandidatesGoldenTest {

    private val root = ChatCoreFixtures.root("swipe-candidates")

    private fun targetOf(map: Map<String, Any?>): ChatSwipeCandidates.Target =
        ChatSwipeCandidates.Target(
            content = ChatCoreFixtures.str(map, "content") ?: "",
            swipes = (ChatCoreFixtures.listOrNull(map, "swipes") as? List<*>)?.map { it.toString() },
            swipeIndex = ChatCoreFixtures.intOrNull(map, "swipeIndex"),
        )

    private fun assertUpdate(label: String, expected: Map<String, Any?>, actual: ChatSwipeCandidates.Update) {
        assertEquals("$label.content", ChatCoreFixtures.str(expected, "content"), actual.content)
        assertEquals("$label.swipeIndex", ChatCoreFixtures.intOrNull(expected, "swipeIndex"), actual.swipeIndex)
        val expectedSwipes = (ChatCoreFixtures.listOrNull(expected, "swipes") as? List<*>)?.map { it.toString() }
        assertEquals("$label.swipes", expectedSwipes, actual.swipes)
    }

    @Test
    fun regenerateAppendsCandidateToSameMessage() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "regenerateCases") as? List<Map<String, Any?>>)
            ?: error("缺少 regenerateCases")
        for (case in cases) {
            val target = targetOf(ChatCoreFixtures.mapOrNull(case, "target")!!)
            val newContent = ChatCoreFixtures.str(case, "newContent") ?: ""
            assertUpdate(
                "appendRegeneratedCandidate(${target.content})",
                ChatCoreFixtures.mapOrNull(case, "result")!!,
                ChatSwipeCandidates.appendRegeneratedCandidate(target, newContent),
            )
        }
    }

    @Test
    fun rotateCyclesThroughExistingCandidates() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "rotateCases") as? List<Map<String, Any?>>)
            ?: error("缺少 rotateCases")
        for (case in cases) {
            val target = targetOf(ChatCoreFixtures.mapOrNull(case, "target")!!)
            val direction = ChatCoreFixtures.intOrNull(case, "direction") ?: 0
            assertUpdate(
                "rotateSwipe(${target.swipes}, dir=$direction)",
                ChatCoreFixtures.mapOrNull(case, "result")!!,
                ChatSwipeCandidates.rotateSwipe(target, direction),
            )
        }
    }

    @Test
    fun candidatePositionMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "positionCases") as? List<Map<String, Any?>>)
            ?: error("缺少 positionCases")
        for (case in cases) {
            val target = targetOf(ChatCoreFixtures.mapOrNull(case, "target")!!)
            val expected = ChatCoreFixtures.mapOrNull(case, "position")!!
            val (index, count) = ChatSwipeCandidates.candidatePosition(target)
            assertEquals("index(${target.swipes})", ChatCoreFixtures.intOrNull(expected, "index"), index)
            assertEquals("count(${target.swipes})", ChatCoreFixtures.intOrNull(expected, "count"), count)
        }
    }

    @Test
    fun regenerateNeverChangesMessageIdentity() {
        // 语义核心：重生成只产生 content/swipes/swipeIndex 的变化，
        // 调用方必须在**同一条消息**上应用，而不是新建消息
        val target = ChatSwipeCandidates.Target(content = "初版。", swipes = null, swipeIndex = null)
        val first = ChatSwipeCandidates.appendRegeneratedCandidate(target, "第二版。")
        assertEquals(listOf("初版。", "第二版。"), first.swipes)
        assertEquals(1, first.swipeIndex)
        assertEquals("第二版。", first.content)

        // 再次重生成：基于上一次的结果继续追加，而不是重置
        val second = ChatSwipeCandidates.appendRegeneratedCandidate(
            ChatSwipeCandidates.Target(first.content, first.swipes, first.swipeIndex),
            "第三版。",
        )
        assertEquals(listOf("初版。", "第二版。", "第三版。"), second.swipes)
        assertEquals(2, second.swipeIndex)
    }

    @Test
    fun singleCandidateRotationIsANoOp() {
        // 只有一个候选时「切换」必须原样返回（否则界面会显示空白）
        val single = ChatSwipeCandidates.Target(content = "唯一。")
        for (direction in listOf(-1, 0, 1, 7)) {
            val update = ChatSwipeCandidates.rotateSwipe(single, direction)
            assertEquals("dir=$direction 不得改变内容", "唯一。", update.content)
            assertEquals("dir=$direction 不得改变索引", 0, update.swipeIndex)
        }
    }

    @Test
    fun negativeDirectionWrapsCorrectly() {
        // Kotlin 的 % 对负数返回负值，必须显式取正（这是移植时最易错的一处）
        val target = ChatSwipeCandidates.Target("甲", listOf("甲", "乙", "丙"), 0)
        val backward = ChatSwipeCandidates.rotateSwipe(target, -1)
        assertEquals("负方向必须环绕到最后一个候选", "丙", backward.content)
        assertEquals(2, backward.swipeIndex)
        assertTrue("索引必须落在合法范围内", backward.swipeIndex in 0..2)
    }
}
