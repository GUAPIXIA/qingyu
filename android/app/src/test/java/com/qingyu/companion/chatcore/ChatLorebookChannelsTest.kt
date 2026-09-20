package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 阶段 5 S5-02 / 阶段 6 S6-05 前置：触发通道可用性分类的判定表。
 *
 * 这些断言把「`retrieval` 模式 × 本机通道 → 用户会看到什么」钉死成一张表。
 * 它保护的不是某段实现，而是**口径**：阶段 6 实现向量/词法通道时会翻
 * `VECTOR_AVAILABLE` / `LEXICAL_AVAILABLE`，那时这张表必然变红——
 * 这是有意设计的，逼着改动者同时更新分类表与文档，而不是让「本机静默不支持」
 * 这件事继续没有任何读数。
 *
 * 纯 JVM 用例（不依赖 android.* 与 Room），因为被测对象是纯函数。
 */
class ChatLorebookChannelsTest {

    // ---------- 与 PC 同名的两个判据 ----------

    @Test
    fun keywordChannelMatchesPcRule() {
        // PC `hasKeywordChannel(mode)`：只有 keyword 与 hybrid 走关键词通道
        assertTrue(ChatLorebookChannels.hasKeywordChannel("keyword"))
        assertTrue(ChatLorebookChannels.hasKeywordChannel("hybrid"))
        assertFalse(
            "semanticPreferred 在 PC 上不使用关键词（它走向量→词法），本机用关键词是近似而不是同一条通道",
            ChatLorebookChannels.hasKeywordChannel("semanticPreferred"),
        )
        assertFalse(ChatLorebookChannels.hasKeywordChannel("semanticRequired"))
    }

    @Test
    fun semanticDeadEntryMatchesPcRule() {
        // PC `isSemanticDeadEntry`：只有显式 semanticRequired 且非 always 才停用
        assertTrue(ChatLorebookChannels.isSemanticDeadEntry("semanticRequired", "conditional"))
        assertTrue(ChatLorebookChannels.isSemanticDeadEntry("semanticRequired", null))
        assertFalse(
            "always 条目在 PC 上不受语义通道缺失影响（无条件收集）",
            ChatLorebookChannels.isSemanticDeadEntry("semanticRequired", "always"),
        )
        assertFalse(
            "legacy semantic（→ semanticPreferred）有词法兜底，PC 不停用它",
            ChatLorebookChannels.isSemanticDeadEntry("semanticPreferred", "conditional"),
        )
    }

    // ---------- 判定表 ----------

    @Test
    fun keywordModeIsSameAsPc() {
        assertEquals(
            ChatLorebookChannels.Fidelity.SAME,
            ChatLorebookChannels.fidelityOf("keyword", "conditional", keywordChannelPresent = true),
        )
        assertEquals(
            "keyword 模式没有关键词时与 PC 一样不触发（不构成差异，无需报告）",
            ChatLorebookChannels.Fidelity.SAME,
            ChatLorebookChannels.fidelityOf("keyword", "conditional", keywordChannelPresent = false),
        )
    }

    @Test
    fun hybridWithKeywordsIsSameButHybridWithoutKeywordsCannotTrigger() {
        assertEquals(
            ChatLorebookChannels.Fidelity.SAME,
            ChatLorebookChannels.fidelityOf("hybrid", "conditional", keywordChannelPresent = true),
        )
        assertEquals(
            "hybrid 无关键词时 PC 靠词法兜底，本机一条通道都没有 → 不会触发",
            ChatLorebookChannels.Fidelity.UNAVAILABLE,
            ChatLorebookChannels.fidelityOf("hybrid", "conditional", keywordChannelPresent = false),
        )
    }

    @Test
    fun semanticPreferredIsApproximatedNotUnavailable() {
        assertEquals(
            "本机仍会用关键词触发它，所以是「近似」而不是「不触发」——报成不触发就是假话",
            ChatLorebookChannels.Fidelity.APPROXIMATED,
            ChatLorebookChannels.fidelityOf("semanticPreferred", "conditional", keywordChannelPresent = true),
        )
        assertEquals(
            "没有关键词时它同样近似（本机只是没有可用的命中途径）",
            ChatLorebookChannels.Fidelity.APPROXIMATED,
            ChatLorebookChannels.fidelityOf("semanticPreferred", "conditional", keywordChannelPresent = false),
        )
    }

    @Test
    fun semanticRequiredIsPcDisabledBecausePcDisablesIt() {
        assertEquals(
            "PC 无向量时停用它，本机却按关键词照常触发 → 两端相反，必须单独成档",
            ChatLorebookChannels.Fidelity.PC_DISABLED,
            ChatLorebookChannels.fidelityOf("semanticRequired", "conditional", keywordChannelPresent = true),
        )
        assertEquals(
            "always 条目 PC 不停用，本机按 always 触发 → 一致",
            ChatLorebookChannels.Fidelity.SAME,
            ChatLorebookChannels.fidelityOf("semanticRequired", "always", keywordChannelPresent = false),
        )
    }

    @Test
    fun unknownModeIsNotReportedAsADifference() {
        // canonical 校验只放行四种模式；真出现别的值时不猜含义
        assertEquals(
            ChatLorebookChannels.Fidelity.SAME,
            ChatLorebookChannels.fidelityOf("something-else", "conditional", keywordChannelPresent = true),
        )
    }

    @Test
    fun platformCapabilityConstantsAreTheSingleSwitch() {
        // 这条是给阶段 6 的交接：翻这两个常量会让上面几张表一起变红，
        // 那时必须同时改 ChatLorebookChannels 的分类表、本文档与阶段 5 报告的口径。
        assertFalse("Android 当前没有向量通道（阶段 6 S6-05 才实现）", ChatLorebookChannels.VECTOR_AVAILABLE)
        assertFalse("Android 当前没有词法通道（阶段 6 S6-05 才实现）", ChatLorebookChannels.LEXICAL_AVAILABLE)
    }

    // ---------- 聚合读数 ----------

    private fun entry(id: String, retrieval: String, keywords: List<String>, enabled: Boolean = true) =
        ChatLorebookRuntime.Entry(
            id = id,
            content = "正文-$id",
            keywords = keywords,
            retrieval = retrieval,
            enabled = enabled,
        )

    @Test
    fun analyzeOnlyReportsNoteworthyEntries() {
        val book = ChatLorebookRuntime.Book(
            id = "lb1",
            name = "通道",
            entries = listOf(
                entry("kw", "keyword", listOf("码头")),
                entry("hy", "hybrid", listOf("码头")),
                entry("hy-empty", "hybrid", emptyList()),
                entry("pref", "semanticPreferred", listOf("码头")),
                entry("req", "semanticRequired", listOf("码头")),
            ),
        )
        val report = ChatLorebookChannels.analyze(book)
        assertEquals(
            "只有后三条构成差异，且 key 用运行时同款 bookId:entryId",
            listOf("lb1:hy-empty", "lb1:pref", "lb1:req"),
            report.findings.map { it.key },
        )
        assertEquals(1, report.unavailableCount)
        assertEquals(1, report.approximatedCount)
        assertEquals(1, report.pcDisabledCount)
        assertTrue(report.hasFindings)
    }

    @Test
    fun analyzeSkipsDisabledBooksAndEntries() {
        // 运行时先跳过它们，读数里也不该出现——否则用户会看到「一条根本不会参与触发的条目」的提示
        val disabledBook = ChatLorebookRuntime.Book(
            id = "lb-off",
            name = "停用书",
            enabled = false,
            entries = listOf(entry("req", "semanticRequired", listOf("码头"))),
        )
        val book = ChatLorebookRuntime.Book(
            id = "lb1",
            name = "启用书",
            entries = listOf(
                entry("off", "semanticRequired", listOf("码头"), enabled = false),
                entry("on", "semanticPreferred", listOf("码头")),
            ),
        )
        val report = ChatLorebookChannels.analyze(listOf(disabledBook, book))
        assertEquals(listOf("lb1:on"), report.findings.map { it.key })
    }

    @Test
    fun summaryLineIsAbsentWhenNothingDiffers() {
        val clean = ChatLorebookRuntime.Book(
            id = "lb1",
            name = "干净",
            entries = listOf(entry("a", "keyword", listOf("码头")), entry("b", "hybrid", listOf("码头"))),
        )
        assertNull(
            "没有差异时不能印一句空话（界面据此决定显不显示）",
            ChatLorebookChannels.analyze(clean).summaryLine(),
        )
    }

    @Test
    fun summaryLineNumbersComeFromTheFindings() {
        // 数字必须是数出来的：写死的数字会在有人实现通道之后变成假话
        fun line(u: Int, a: Int, d: Int): String {
            val entries = mutableListOf<ChatLorebookRuntime.Entry>()
            repeat(u) { entries += entry("u$it", "hybrid", emptyList()) }
            repeat(a) { entries += entry("a$it", "semanticPreferred", listOf("k")) }
            repeat(d) { entries += entry("d$it", "semanticRequired", listOf("k")) }
            return ChatLorebookChannels
                .analyze(ChatLorebookRuntime.Book(id = "lb", name = "n", entries = entries))
                .summaryLine()!!
        }
        val line = line(u = 2, a = 3, d = 1)
        assertTrue("不触发的条数要出现在文案里：$line", line.contains("2 条不会触发"))
        assertTrue("近似的条数要出现在文案里：$line", line.contains("3 条改用关键词近似"))
        assertTrue("PC 停用而本机仍触发的条数要单独说：$line", line.contains("1 条在 PC 上会被停用"))
    }
}
