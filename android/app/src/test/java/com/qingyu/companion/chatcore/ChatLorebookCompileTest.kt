package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 A3b-2：canonical v2 世界书文档 → 运行时输入的编译测试
 * （对齐 PC `shared/lorebook/runtime/compile.ts` 的 `compileEntry`）。
 *
 * 为什么这一步必须单独测：本地库里的世界书是 **canonical v2 文档**，而运行时读的是
 * 已编译的条目形状。若这层缺失或字段名对不上，运行时会拿到**空条目列表**——
 * 表现为「用户绑定了世界书却一条都不注入」，且**不抛任何异常**。
 * 这类「静默空转」只有靠断言编译结果非空 + 关键字段逐条核对才能发现。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatLorebookCompileTest {

    private fun canonicalDoc(entries: String, defaults: String = """{"scanDepth":4,"recursiveScanning":true}"""): String =
        """
        {
          "schema": "qingyu_lorebook",
          "schemaVersion": 2,
          "id": "lb1",
          "revision": 1,
          "name": "城市设定",
          "description": "",
          "enabled": true,
          "defaults": $defaults,
          "entries": [$entries],
          "createdAt": 0,
          "updatedAt": 0
        }
        """.trimIndent()

    private fun entryJson(
        id: String = "e1",
        content: String = "码头在雨里。",
        mode: String = "conditional",
        budgetTier: String = "standard",
        primaryKeys: String = """["码头"]""",
        aliases: String = """["渡口"]""",
        insertion: String = """{"kind":"prompt","anchor":"before_character"}""",
        schedulingExtra: String = "",
    ): String = """
        {
          "id": "$id",
          "enabled": true,
          "content": "$content",
          "activation": {
            "mode": "$mode",
            "budgetTier": "$budgetTier",
            "primaryKeys": $primaryKeys,
            "secondaryKeys": ["雨"],
            "aliases": $aliases,
            "keyLogic": "any",
            "secondaryLogic": "and_any",
            "caseSensitive": true,
            "wholeWords": false,
            "regex": { "enabled": true, "flags": "i" },
            "retrieval": "hybrid"
          },
          "insertion": $insertion,
          "scheduling": {
            "order": 7,
            "probability": 60,
            "scanDepth": 3,
            "recursion": { "exclude": true, "prevent": true, "minDepth": 0 },
            "groups": [],
            "groupScoring": false,
            "ignoreBudget": true
            $schedulingExtra
          }
        }
    """.trimIndent()

    @Test
    fun compilesEveryFieldPcReads() {
        val book = ChatLorebookCompile.compile(canonicalDoc(entryJson()), "lb1", "城市设定")
        assertNotNull("文档必须能编译", book)
        assertEquals("scanDepth 取自 defaults", 4, book!!.scanDepth)
        assertTrue("recursiveScanning 取自 defaults", book.recursiveScanning)
        assertEquals("条目不得为空（否则运行时静默空转）", 1, book.entries.size)

        val entry = book.entries[0]
        assertEquals("e1", entry.id)
        assertEquals("码头在雨里。", entry.content)
        // aliases 与 primaryKeys 同权参与触发
        assertEquals(listOf("码头", "渡口"), entry.keywords)
        assertEquals(listOf("雨"), entry.secondaryKeywords)
        assertEquals("and_any", entry.selectiveLogic)
        assertTrue("regex.enabled → useRegex", entry.useRegex)
        assertEquals("i", entry.regexFlags)
        assertTrue("caseSensitive 透传", entry.caseSensitive)
        assertTrue("wholeWords=false 透传", !entry.matchWholeWords)
        assertEquals("order 取自 scheduling", 7, entry.order)
        assertEquals("probability 取自 scheduling", 60.0, entry.probability!!, 1e-9)
        assertEquals("scanDepth 取自 scheduling", 3, entry.scanDepth)
        assertTrue("recursion.prevent", entry.preventRecursion)
        assertTrue("recursion.exclude", entry.excludeRecursion)
        assertTrue("ignoreBudget", entry.ignoreBudget)
        assertEquals("before_character 锚点", "before_char", entry.position)
        assertEquals(
            "insertion 必须透传（渲染层据此分桶）",
            ChatLorebookBudget.Insertion.Prompt("before_character"),
            entry.insertion,
        )
    }

    @Test
    fun modeAndBudgetTierMapToPriority() {
        // constant → always；supplemental → detail；否则 conditional
        fun priorityOf(mode: String, tier: String): String? =
            ChatLorebookCompile.compile(canonicalDoc(entryJson(mode = mode, budgetTier = tier)), "lb1", "书")
                ?.entries?.first()?.priority

        assertEquals("always", priorityOf("constant", "standard"))
        assertEquals("always", priorityOf("constant", "supplemental"))
        assertEquals("detail", priorityOf("conditional", "supplemental"))
        assertEquals("conditional", priorityOf("conditional", "standard"))
        assertEquals("conditional", priorityOf("conditional", "protected"))
    }

    @Test
    fun chatInsertionYieldsDepthAndRole() {
        val book = ChatLorebookCompile.compile(
            canonicalDoc(entryJson(insertion = """{"kind":"chat","depth":2,"role":"system"}""")),
            "lb1",
            "书",
        )
        val entry = book!!.entries.first()
        assertEquals("at_depth", entry.position)
        assertEquals(2, entry.depth)
        assertEquals("system", entry.role)
    }

    @Test
    fun outletAndCustomFallBackToPromptEnd() {
        // outlet/custom 没有原生槽位：按 PC 的回退语义落到 prompt_end
        for (insertion in listOf("""{"kind":"outlet","name":"x"}""", """{"kind":"custom","source":"s","value":1}""")) {
            val entry = ChatLorebookCompile.compile(canonicalDoc(entryJson(insertion = insertion)), "lb1", "书")
                ?.entries?.first()
            assertEquals(
                "insertion=$insertion 必须回退 prompt_end",
                ChatLorebookBudget.Insertion.Prompt("prompt_end"),
                entry?.insertion,
            )
        }
    }

    @Test
    fun malformedDocumentYieldsNullOrEmptyEntriesInsteadOfCrash() {
        assertNull("非 JSON 必须返回 null", ChatLorebookCompile.compile("not-json", "lb1", "书"))
        assertNull("空串必须返回 null", ChatLorebookCompile.compile("", "lb1", "书"))
        // 合法 JSON 但无 entries：书仍可用（0 条目），不得抛异常
        val book = ChatLorebookCompile.compile("""{"schemaVersion":2}""", "lb1", "书")
        assertNotNull(book)
        assertTrue(book!!.entries.isEmpty())
    }

    @Test
    fun compiledBookActuallyTriggersThroughTheRuntime() {
        // 端到端：canonical 文档 → 编译 → 运行时 → 触发出内容
        // （这条链条上任何一环字段对不上，这里都会是空结果）
        val book = ChatLorebookCompile.compile(canonicalDoc(entryJson()), "lb1", "城市设定")!!
        val result = ChatLorebookRuntime.execute(
            ChatLorebookRuntime.Input(
                lorebooks = listOf(book),
                // 扫描文本必须同时满足二级关键词（该条目 secondaryKeys=["雨"] + and_any），
                // 否则运行时**正确地**拒绝它——这不是 bug，是输入没满足触发条件
                scanText = "他们站在码头边，雨还在下。",
                budget = 500,
                model = "gpt-4o-mini",
                charName = "苏晚",
                // 该条目 probability=60：必须注入确定性随机源，否则用例会在 40% 的概率下随机失败
                random = { 0.0 },
            ),
        )
        assertEquals("编译后的书必须能真正触发", listOf("lb1:e1"), result.triggeredEntryKeys)
        assertTrue("内容必须进入 beforeChar", result.beforeChar.any { it.contains("码头在雨里") })
    }
}
