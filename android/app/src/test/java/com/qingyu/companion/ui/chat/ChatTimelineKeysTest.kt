package com.qingyu.companion.ui.chat

import com.qingyu.companion.model.Message
import com.qingyu.companion.model.PendingMessage
import com.qingyu.companion.model.Role
import com.qingyu.companion.model.TimelineItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 阶段 4 S4-06：**流式草稿不导致整表重组**的机制守卫。
 *
 * 该要求靠两件事共同保证，本测试逐条锁定：
 * 1. 生成中的草稿是**独立 item**，key 与任何消息都不同 → 更新草稿不触碰消息条目；
 * 2. 消息条目 key **稳定且与内容无关**（用会话+消息 id，而非下标）
 *    → 中间插入新消息时其后的 key 不平移，Compose 不会把它们当作新条目重建。
 *
 * 第 2 条一旦退化成下标，用户看到的是整表闪动与滚动位置跳动，而编译期与常规门禁都不报错；
 * 因此除了纯函数断言，这里还有一条**源码级守卫**：列表必须用 [ChatTimelineKeys]，
 * 不允许在 ChatScreen 里重新内联一套 key 计算（那正是它会漂移的地方）。
 *
 * ## 覆盖边界（不要过度信任）
 * 本测试验证的是**机制**：key 的稳定性与草稿的独立性。
 * 「实际重组次数」需要 Compose UI 测试基建（`ui-test-junit4`）并在生产 UI 内埋计数钩子，
 * 目前**未做**——这一点在实施报告中如实标注，而不是用静态守卫冒充运行时测量。
 */
class ChatTimelineKeysTest {

    private fun message(id: String, content: String, sessionId: String = "s1"): TimelineItem.Entry =
        TimelineItem.Entry(
            Message(
                id = id,
                sessionId = sessionId,
                characterId = "c1",
                role = Role.assistant,
                content = content,
                timestamp = 1,
            ),
        )

    @Test
    fun entryKeyIsStableAndContentIndependent() {
        // 内容变化（流式追加、编辑）不得改变 key：否则该条目会被重建
        val before = ChatTimelineKeys.of(message("m1", "夜安"))
        val after = ChatTimelineKeys.of(message("m1", "夜安。雨还在下。"))
        assertEquals("同一条消息的内容变化不得改变 key", before, after)
        assertTrue("key 必须包含消息 id", before.contains("m1"))
    }

    @Test
    fun entryKeysDoNotShiftWhenNewerMessageIsInserted() {
        // 这是「不复用下标」的核心证据：在前面插入新消息，旧消息的 key 必须原样不变。
        // 若用下标，插入后所有 key 都会平移，导致其后全部条目被重建。
        val older = listOf(message("m1", "一"), message("m2", "二"))
        val keysBefore = older.map { ChatTimelineKeys.of(it) }

        val newer = (listOf(message("m0", "零")) + older).map { ChatTimelineKeys.of(it) }

        assertEquals(
            "插入新消息后，旧消息 key 必须保持不变（插入位置之前的顺序无关）",
            keysBefore,
            newer.drop(1),
        )
    }

    @Test
    fun entryKeyDistinguishesSessions() {
        // 分叉/切换会话时 message.id 可能重复；仅用 id 会撞 key，导致列表错乱
        assertNotEquals(
            "不同会话的相同 message.id 必须得到不同 key",
            ChatTimelineKeys.of(message("m1", "同", sessionId = "s1")),
            ChatTimelineKeys.of(message("m1", "同", sessionId = "s2")),
        )
    }

    @Test
    fun streamingDraftKeyIsDistinctFromEveryMessageKey() {
        val draft = ChatTimelineKeys.STREAMING_DRAFT
        val items = listOf(
            TimelineItem.DateHeader(label = "08-14"),
            message("m1", "一"),
            TimelineItem.PendingEntry(
                PendingMessage(requestId = "r1", content = "待发", timestamp = 1, failed = false),
            ),
        )
        for (item in items) {
            assertNotEquals(
                "草稿 key 必须与任何时间线条目都不同（否则会互相顶替）",
                draft,
                ChatTimelineKeys.of(item),
            )
        }
    }

    @Test
    fun pendingAndDateAndEntryKeysAreNamespaced() {
        // 三类条目必须落在不同的 key 空间，避免「日期头与消息撞 key」这类隐蔽冲突
        val entry = ChatTimelineKeys.of(message("08-14", "内容"))
        val header = ChatTimelineKeys.of(TimelineItem.DateHeader(label = "08-14"))
        val pending = ChatTimelineKeys.of(
            TimelineItem.PendingEntry(
                PendingMessage(requestId = "08-14", content = "待发", timestamp = 1, failed = false),
            ),
        )
        assertEquals(3, setOf(entry, header, pending).size)
        assertTrue(header.startsWith("date:"))
        assertTrue(pending.startsWith("pending:"))
    }

    @Test
    fun chatScreenUsesTheSharedKeyFunction() {
        // 源码级守卫：列表 key 必须来自 ChatTimelineKeys，不允许在 ChatScreen 里重新内联计算
        val source = findChatScreen().readText()
        assertTrue(
            "草稿必须是独立 item 且使用共享常量",
            source.contains("item(key = ChatTimelineKeys.STREAMING_DRAFT)"),
        )
        assertTrue(
            "时间线必须使用共享的 key 函数",
            source.contains("key = { item -> ChatTimelineKeys.of(item) }"),
        )
        val inlineWhen = Regex("key\\s*=\\s*\\{\\s*item\\s*->\\s*when\\s*\\(").containsMatchIn(source)
        assertTrue("不得在 ChatScreen 内重新内联一套 key 计算（那是会漂移的地方）", !inlineWhen)
    }

    private fun findChatScreen(): File {
        val candidates = listOf(
            File("src/main/java/com/qingyu/companion/ui/chat/ChatScreen.kt"),
            File("app/src/main/java/com/qingyu/companion/ui/chat/ChatScreen.kt"),
        )
        return candidates.firstOrNull { it.exists() }
            ?: error("找不到 ChatScreen.kt（工作目录=${File(".").absolutePath}）")
    }
}
