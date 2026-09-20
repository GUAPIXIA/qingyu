package com.qingyu.companion.chatcore

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-04：会话导出的跨语言一致性测试
 * （对齐 fixture `session-export.json`，oracle 为 PC 生产代码消费的
 * `shared/chat-core/sessionExport.ts`）。
 *
 * 导出是用户会带走、离线查看的产物：结构或转义与 PC 不同，
 * 同一段对话在两端就会得到两个不同的文件。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatSessionExportGoldenTest {

    private val root = ChatCoreFixtures.root("session-export")

    /** 与 fixture 一致的确定性时间渲染。 */
    private val fixedTime = ChatSessionExport.TimeFormatter { timestamp -> "T$timestamp" }

    private fun messagesOf(list: List<Any?>): List<ChatSessionExport.ExportMessage> = list.map { raw ->
        @Suppress("UNCHECKED_CAST")
        val map = raw as Map<String, Any?>
        ChatSessionExport.ExportMessage(
            role = ChatCoreFixtures.str(map, "role") ?: "",
            content = ChatCoreFixtures.str(map, "content") ?: "",
            timestamp = (map["timestamp"] as? Number)?.toLong() ?: 0L,
            images = (ChatCoreFixtures.listOrNull(map, "images") as? List<*>)?.map { it.toString() },
        )
    }

    @Test
    fun escapeMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "escapeCases") as? List<Map<String, Any?>>)
            ?: error("缺少 escapeCases")
        for (case in cases) {
            val text = ChatCoreFixtures.str(case, "text") ?: ""
            assertEquals(
                "escapeMarkdownContent(${text.take(20)})",
                ChatCoreFixtures.str(case, "escaped"),
                ChatSessionExport.escapeMarkdownContent(text),
            )
        }
    }

    @Test
    fun roleLabelsMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "roleLabelCases") as? List<Map<String, Any?>>)
            ?: error("缺少 roleLabelCases")
        for (case in cases) {
            val role = ChatCoreFixtures.str(case, "role") ?: ""
            assertEquals("exportRoleLabel($role)", ChatCoreFixtures.str(case, "label"), ChatSessionExport.exportRoleLabel(role))
        }
    }

    @Test
    fun markdownMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "markdownCases") as? List<Map<String, Any?>>)
            ?: error("缺少 markdownCases")
        for (case in cases) {
            val caseIndex = ChatCoreFixtures.intOrNull(case, "caseIndex")
            val messages = messagesOf((ChatCoreFixtures.listOrNull(case, "messages") as? List<Any?>) ?: emptyList())
            assertEquals(
                "exportSessionMarkdown#case$caseIndex",
                ChatCoreFixtures.str(case, "markdown"),
                ChatSessionExport.exportSessionMarkdown(messages, fixedTime),
            )
        }
    }

    @Test
    fun jsonMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "jsonCases") as? List<Map<String, Any?>>)
            ?: error("缺少 jsonCases")
        for (case in cases) {
            val caseIndex = ChatCoreFixtures.intOrNull(case, "caseIndex")
            val messages = messagesOf((ChatCoreFixtures.listOrNull(case, "messages") as? List<Any?>) ?: emptyList())
            val objects = messages.map { ChatSessionExport.toJsonMap(it) }
            assertEquals(
                "exportSessionJson#case$caseIndex",
                ChatCoreFixtures.str(case, "json"),
                ChatSessionExport.exportSessionJson(objects),
            )
        }
    }

    @Test
    fun defaultTimeFormatterFollowsZhCnShape() {
        // 默认渲染不参与跨语言逐字节比较（依赖各端 ICU），但要固定其形状与补零规则
        val formatter = ChatSessionExport.DEFAULT_TIME_FORMATTER
        val calendar = java.util.Calendar.getInstance().apply {
            set(2026, java.util.Calendar.SEPTEMBER, 6, 9, 5, 3)
            set(java.util.Calendar.MILLISECOND, 0)
        }
        assertEquals("2026/9/6 09:05:03", formatter.format(calendar.timeInMillis))
    }

    @Test
    fun jsonEscapesControlCharactersAndKeepsUnicode() {
        // 正文含换行与引号时，JSON 必须转义而不是破坏结构
        val object0 = ChatSessionExport.toJsonMap(
            ChatSessionExport.ExportMessage(
                role = "user",
                content = "第一行\n第二行 \"引号\" 与 \\反斜杠",
                timestamp = 1,
            ),
        )
        val json = ChatSessionExport.exportSessionJson(listOf(object0))
        val parsed = JSONArray(json)
        assertEquals(1, parsed.length())
        assertEquals("第一行\n第二行 \"引号\" 与 \\反斜杠", parsed.getJSONObject(0).getString("content"))
        // 中文与 emoji 不得被转成 \uXXXX（否则与 PC 输出不一致）
        val unicode = ChatSessionExport.toJsonMap(
            ChatSessionExport.ExportMessage(role = "assistant", content = "中文😀", timestamp = 2),
        )
        val unicodeJson = ChatSessionExport.exportSessionJson(listOf(unicode))
        assertEquals(true, unicodeJson.contains("中文😀"))
        assertEquals("中文😀", JSONArray(unicodeJson).getJSONObject(0).getString("content"))
    }

    @Test
    fun jsonObjectKeepsStableKeyOrder() {
        val obj: Map<String, Any?> = ChatSessionExport.toJsonMap(
            ChatSessionExport.ExportMessage(role = "user", content = "x", timestamp = 7, images = listOf("a")),
            extra = mapOf("id" to "m1"),
        )
        assertEquals(listOf("id", "role", "content", "images", "timestamp"), obj.keys.toList())
    }
}
