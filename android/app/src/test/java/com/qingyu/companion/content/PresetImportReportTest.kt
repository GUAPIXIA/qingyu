package com.qingyu.companion.content

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * 阶段 5 §2「所有导入显示成功、跳过、近似映射、失败和未知字段保留报告」的预设侧。
 *
 * 这里钉的两个读数都**不进同步 payload**（只决定「说不说」，不改「导成什么」），
 * 所以跨端 golden（`ContentIoGoldenTest`）覆盖不到它们，必须自己钉：
 * 近似清单一旦与 `normalize` 的钳位规则走偏，界面上就是在报一套没发生过的改动。
 */
class PresetImportReportTest {

    /** 走 `normalize` 的原生键；`input` 覆盖默认脚手架，所以 id/name 只在缺省时补。 */
    private fun notesOf(input: Map<String, Any?>): List<String> {
        val effective = LinkedHashMap<String, Any?>(mapOf("id" to "p1", "name" to "n"))
        effective.putAll(input)
        return PresetCodec.approximateNotes(effective, PresetCodec.normalize(effective))
    }

    // ------------------------------------------------------------ 近似映射

    @Test
    fun reportsClampRoundAndNonNumericFallbackButStaysSilentOnInPlaceValues() {
        val clamped = notesOf(mapOf("temperature" to 11))
        assertEquals(1, clamped.size, "温度 11 被钳成 2 必须说出来：$clamped")
        assertTrue(clamped[0].contains("temperature") && clamped[0].contains("2"), clamped.toString())

        val rounded = notesOf(mapOf("maxContext" to 1500.4))
        assertEquals(1, rounded.size, "非整数的上下文预算被取整必须说出来：$rounded")
        assertTrue(rounded[0].contains("取整"), rounded.toString())

        val nonNumeric = notesOf(mapOf("topP" to "abc"))
        assertEquals(1, nonNumeric.size, "读不出数值的 topP 会静默回落成 0.95：$nonNumeric")
        assertTrue(nonNumeric[0].contains("回落"), nonNumeric.toString())

        // 没有改动用户填的东西就不许开口：误报会让人不信这份报告。
        assertEquals(emptyList(), notesOf(mapOf("temperature" to 1.2, "maxContext" to 4096)))
    }

    @Test
    fun missingAndExplicitlyNullKeysAreNotApproximations() {
        // 「用户没填」与「填了被改」必须分得开，否则每一篇用默认值的预设都带一串假告警。
        assertEquals(
            emptyList(),
            PresetCodec.approximateNotes(
                mapOf("id" to "p", "name" to "n"),
                PresetCodec.normalize(mapOf("id" to "p", "name" to "n")),
            ),
        )
        assertEquals(
            emptyList(),
            notesOf(mapOf("temperature" to null)),
            "显式 null 表示没设置，不是设置成了 0",
        )
    }

    @Test
    fun reportsTruncationAndRejectedEnums() {
        val longName = "名".repeat(PresetCodec.MAX_NAME_LENGTH + 7)
        val nameNotes = notesOf(mapOf("name" to longName))
        assertEquals(1, nameNotes.size, "超长名称被截断必须说出来：$nameNotes")
        assertTrue(nameNotes[0].contains("name"), nameNotes.toString())

        val modeNotes = notesOf(mapOf("exampleDialogMode" to "sometimes"))
        assertEquals(1, modeNotes.size, "非法枚举会被整个丢掉，不说就是「我填的东西没了」：$modeNotes")
        assertTrue(modeNotes[0].contains("exampleDialogMode"), modeNotes.toString())

        val promptNotes = notesOf(mapOf("systemPrompt" to 123))
        assertEquals(1, promptNotes.size, "非文本正文会被当成空内容导入：$promptNotes")

        // 合法值不动声色：只在真被改动时开口。
        assertEquals(emptyList(), notesOf(mapOf("exampleDialogMode" to "always", "name" to "正常名称")))
    }

    @Test
    fun approximationsComeFromImportedSnakeCaseAliases() {
        // 酒馆式 `max_context` 先被映射成 `maxContext` 再钳位。
        // 近似清单若只认 camelCase，蛇形导入就越界得最狠、报得最少。
        val result = PresetCodec.normalizeImported(
            mapOf("name" to "蛇形", "max_context" to -5, "top_p" to 3),
            id = "p1",
            fallbackName = "蛇形",
        )
        assertEquals(2, result.approximated.size, result.approximated.toString())
        assertTrue(result.approximated.any { it.contains("maxContext") }, result.approximated.toString())
        assertTrue(result.approximated.any { it.contains("topP") }, result.approximated.toString())
    }

    @Test
    fun approximationNotesNeverChangeTheNormalizedPayload() {
        val result = PresetCodec.normalizeImported(
            mapOf("name" to "n", "temperature" to 11),
            id = "p1",
            fallbackName = "n",
        )
        assertEquals(1, result.approximated.size, result.approximated.toString())
        assertEquals(2.0, (result.body["temperature"] as Number).toDouble(), 0.0)
        assertFalse(
            result.body.keys.any { "approxim" in it.lowercase() },
            "近似清单绝不能混进同步 payload：${result.body.keys}",
        )
        // 报告不产生第二次改动：把归一化结果再归一化一次，必须一字不变。
        assertEquals(result.body, PresetCodec.normalize(result.body))
    }

    // ------------------------------------------------------------ 跳过

    @Test
    fun routesForeignFileShapesToTheRightPageInsteadOfImportingThem() {
        assertEquals(
            "是角色卡（spec=chara_card_v2），请到角色页导入",
            PresetCodec.foreignShapeNote(mapOf("spec" to "chara_card_v2", "name" to "卡")),
        )
        assertEquals(
            "是角色卡（data.first_mes），请到角色页导入",
            PresetCodec.foreignShapeNote(mapOf("name" to "卡", "data" to mapOf("first_mes" to "hi"))),
        )
        assertNotNull(
            PresetCodec.foreignShapeNote(mapOf("name" to "书", "entries" to listOf(mapOf("keys" to "k")))),
            "世界书文件带 entries 数组，不能当成预设",
        )
        assertNull(
            PresetCodec.foreignShapeNote(mapOf("id" to "p1", "name" to "预设", "systemPrompt" to "x")),
            "合法预设不许被守卫拦下",
        )
    }

    /**
     * 守卫存在的理由，用一次真实导入钉住：角色卡顶层恰好也有 `name`，
     * 而预设正文只有 id/name 必填——不加守卫就会静默产出一条**空壳预设**。
     *
     * 空壳不等于全空：卡的 `description` 会落进预设的描述（两边同名同类型），
     * 于是列表里看着像一篇有内容的东西，而真正决定行为的提示词正文一格都没有。
     * 这正是「跳过错开」要比「导入成功」优先的原因。
     */
    @Test
    fun unguardedImportOfACardFileWouldSilentlyYieldAnEmptyPreset() {
        val card = mapOf(
            "spec" to "chara_card_v2",
            "spec_version" to "2.0",
            "name" to "卡名",
            "description" to "角色的描述",
            "first_mes" to "开场白",
        )
        assertNotNull(PresetCodec.foreignShapeNote(card), "这个形状必须被跳过")

        val shell = PresetCodec.normalizeImported(card, id = "p1", fallbackName = "卡名").body
        assertEquals("卡名", shell["name"], "名字会带过来，所以列表里看着像成功了")
        assertEquals("角色的描述", shell["description"], "卡的描述串到了预设描述上：不是空的，但也不是预设的内容")
        assertEquals("", shell["systemPrompt"], "真正决定行为的提示词正文一格都没带过来")
        assertEquals("", shell["jailbreak"])
        assertEquals(0.8, (shell["temperature"] as Number).toDouble(), 0.0)
    }
}
