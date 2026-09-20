package com.qingyu.companion.content

import com.qingyu.companion.model.QuickReply
import com.qingyu.companion.model.QuickReplyAction
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 5 S5-06：快捷回复条目编解码。
 *
 * 重点验证**键名保真**：条目数组整体就是 `quick-replies-root` 实体的同步 payload，
 * 一个键改名就会让两端算出不同的 contentHash。
 *
 * 用 Robolectric 跑：`QuickReplyCodec` 与用例都直接吃 `org.json`，而它是 Android 框架类——
 * 纯 JVM 下拿到的是「not mocked」桩。桩会连 `put`/`length` 都抛异常，
 * 让「键集合是否与 PC 一致」这类断言根本执行不到。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class QuickReplyCodecTest {

    @Test
    fun usesTheSameKeyNamesAsPc() {
        val json = QuickReplyCodec.encode(
            listOf(
                QuickReply(
                    id = "qr-1", label = "打招呼", content = "你好", action = QuickReplyAction.text,
                    sendWithAI = true, order = 3, enabled = true,
                ),
            ),
        )
        val obj = JSONArray(json).getJSONObject(0)
        val keys = obj.keys().asSequence().toSet()
        assertEquals(
            setOf("id", "label", "content", "action", "sendWithAI", "order", "enabled"),
            keys,
            "键集合必须与 PC `QuickReply` 一致（注意 sendWithAI 是大写 I）",
        )
    }

    @Test
    fun optionalKeysAreOmittedWhenAbsent() {
        val json = QuickReplyCodec.encode(
            listOf(
                QuickReply("qr-2", "生图", "", QuickReplyAction.command, true, 0, true, command = "/imagine 猫"),
            ),
        )
        val obj = JSONArray(json).getJSONObject(0)
        assertTrue(obj.has("command"))
        assertTrue(!obj.has("presetId"), "空的 presetId 不该占一个键")
    }

    @Test
    fun roundTripsWithoutLosingItemsOrUnknownKeys() {
        val original = listOf(
            QuickReply("a", "甲", "内容甲", QuickReplyAction.text, true, 0, true),
            QuickReply("b", "乙", "", QuickReplyAction.preset, false, 1, false, presetId = "p9"),
        )
        val decoded = QuickReplyCodec.decode(QuickReplyCodec.encode(original))
        assertEquals(original.map { it.id }, decoded.items.map { it.id })
        assertEquals(original.map { it.action }, decoded.items.map { it.action })
        assertEquals(listOf(true, false), decoded.items.map { it.sendWithAI })
        assertEquals(listOf(true, false), decoded.items.map { it.enabled })
        assertEquals("p9", decoded.items[1].presetId)
    }

    @Test
    fun preservesUnknownPcFieldsAcrossAnEdit() {
        // PC 的 hotkey 在 Android 暂无对应交互，但导入→编辑→导出必须原样带回
        val withHotkey = """[{"id":"a","label":"甲","content":"","action":"text","sendWithAI":true,"order":0,"enabled":true,"hotkey":5}]"""
        val decoded = QuickReplyCodec.decode(withHotkey)
        assertEquals(mapOf("hotkey" to 5L), decoded.unknownByKey["a"]?.mapValues { it.value })
        val reEncoded = QuickReplyCodec.encode(decoded.items, decoded.unknownByKey)
        assertEquals(5, JSONArray(reEncoded).getJSONObject(0).getInt("hotkey"))
    }

    @Test
    fun malformedInputDegradesToEmptyRatherThanThrowing() {
        assertTrue(QuickReplyCodec.decodeItems(null).isEmpty())
        assertTrue(QuickReplyCodec.decodeItems("").isEmpty())
        assertTrue(QuickReplyCodec.decodeItems("not json").isEmpty())
        // 三个引号内紧跟 `}` 再收尾会和终止符连成四个引号，这里用普通转义字符串
        assertTrue(QuickReplyCodec.decodeItems("{ \"id\": \"a\" }").isEmpty(), "不是数组就该判为无条目")
        // 单条缺 id 只跳过该条，不该让整库读不出来
        assertEquals(1, QuickReplyCodec.decodeItems("""[{"label":"无 id"},{"id":"b","label":"乙"}]""").size)
    }

    @Test
    fun unknownActionTypesAreReportedNotSilentlyRewritten() {
        val raw = JSONObject("{ \"action\": \"presets\" }").get("action")
        assertTrue(QuickReplyCodec.isUnknownAction(raw), "拼错的 preset 必须被标为未知")
        assertEquals(QuickReplyAction.text, QuickReplyCodec.actionOf(raw), "回退动作仍是 text，由 UI 负责提示")
        assertTrue(!QuickReplyCodec.isUnknownAction("command"))
        assertTrue(!QuickReplyCodec.isUnknownAction(null), "缺省 action 不算脏值")
    }

    @Test
    fun orderFallsBackToPositionWhenMissing() {
        val items = QuickReplyCodec.decodeItems(
            """[{"id":"a","label":"甲"},{"id":"b","label":"乙"}]""",
            fallbackOrderBase = 10,
        )
        assertEquals(listOf(10, 11), items.map { it.order }, "缺 order 时按位置补，保证列表顺序稳定")
    }
}
