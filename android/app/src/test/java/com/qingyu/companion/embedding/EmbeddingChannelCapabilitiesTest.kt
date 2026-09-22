package com.qingyu.companion.embedding

import com.qingyu.companion.chatcore.ChatLorebookChannels
import com.qingyu.companion.chatcore.ChatLorebookRuntime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `ChatLorebookChannels` 两份判定表的**一致性闸**：
 * 新的能力输入版（S6-05 接线用）与编译期常量版（阶段 5 快照）在 `compiledInCapabilities`
 * 口径下必须逐行一致；S6-05 真实口径（词法可用 + semanticRequired 按 PC 停用）下的
 * 预期变化也被钉死——两份表谁改一边都会在这里变红。
 */
class EmbeddingChannelCapabilitiesTest {

    private val retrievals = listOf("keyword", "hybrid", "semanticPreferred", "semanticRequired", "unknown-mode")
    private val priorities = listOf(null, "always", "conditional")

    @Test
    fun capabilityInputTableMatchesCompiledInTableUnderCompiledInCapabilities() {
        val capabilities = ChatLorebookChannels.compiledInCapabilities()
        for (retrieval in retrievals) {
            for (priority in priorities) {
                for (keywordPresent in listOf(true, false)) {
                    val legacy = ChatLorebookChannels.fidelityOf(retrieval, priority, keywordPresent)
                    val parameterized = ChatLorebookChannels.fidelityOf(retrieval, priority, keywordPresent, capabilities)
                    assertEquals(
                        "能力输入版在编译期口径下必须与阶段 5 判定表逐行一致（两份表漂移会让导入提示说假话）：\n" +
                            "retrieval=$retrieval priority=$priority keyword=$keywordPresent",
                        legacy,
                        parameterized,
                    )
                }
            }
        }
    }

    private fun entry(id: String, retrieval: String, keywords: List<String>) =
        ChatLorebookRuntime.Entry(id = id, content = "正文-$id", keywords = keywords, retrieval = retrieval)

    @Test
    fun analyzeWithCompiledInCapabilitiesMatchesLegacyAnalyze() {
        val book = ChatLorebookRuntime.Book(
            id = "lb1",
            name = "对照",
            entries = listOf(
                entry("kw", "keyword", listOf("码头")),
                entry("hy-empty", "hybrid", emptyList()),
                entry("pref", "semanticPreferred", listOf("码头")),
                entry("req", "semanticRequired", listOf("码头")),
            ),
        )
        val legacy = ChatLorebookChannels.analyze(book)
        val parameterized = ChatLorebookChannels.analyze(listOf(book), ChatLorebookChannels.compiledInCapabilities())
        assertEquals(
            "聚合读数也必须两版一致（导入通道提示只有一份真相）",
            legacy.findings.map { it.key to it.fidelity },
            parameterized.findings.map { it.key to it.fidelity },
        )
    }

    @Test
    fun s605CapabilitiesCloseThePlatformGapAndAdoptPcSemanticRequiredBehavior() {
        // S6-05 落地后的真实口径：词法通道可用、semanticRequired 按 PC 现状停用（D-9）
        val s605 = ChatLorebookChannels.ChannelCapabilities(
            vectorAvailable = false,
            lexicalAvailable = true,
            semanticRequiredGated = true,
        )
        assertEquals(
            "词法通道接线后 hybrid 无关键词条目不再『不会触发』（阶段 5 平台级缺口收口）",
            ChatLorebookChannels.Fidelity.SAME,
            ChatLorebookChannels.fidelityOf("hybrid", "conditional", keywordChannelPresent = false, capabilities = s605),
        )
        assertEquals(
            "semanticPreferred 有了词法兜底不再是『关键词近似』",
            ChatLorebookChannels.Fidelity.SAME,
            ChatLorebookChannels.fidelityOf("semanticPreferred", "conditional", keywordChannelPresent = false, capabilities = s605),
        )
        assertEquals(
            "D-9 按 PC 现状：两端都停用 semanticRequired → 不再构成 PC_DISABLED 差异",
            ChatLorebookChannels.Fidelity.SAME,
            ChatLorebookChannels.fidelityOf("semanticRequired", "conditional", keywordChannelPresent = true, capabilities = s605),
        )

        val vectorOn = s605.copy(vectorAvailable = true)
        val book = ChatLorebookRuntime.Book(
            id = "lb1",
            name = "全通道",
            entries = listOf(
                entry("kw", "keyword", emptyList()),
                entry("hy", "hybrid", emptyList()),
                entry("pref", "semanticPreferred", emptyList()),
                entry("req", "semanticRequired", emptyList()),
            ),
        )
        val report = ChatLorebookChannels.analyze(listOf(book), vectorOn)
        assertEquals(
            "三通道齐备时不该再有通道差异提示（无差异不出文案的口径不变）",
            emptyList<ChatLorebookChannels.Finding>(),
            report.findings,
        )
        assertTrue("没有差异就没有那行提示", report.summaryLine() == null)
    }
}
