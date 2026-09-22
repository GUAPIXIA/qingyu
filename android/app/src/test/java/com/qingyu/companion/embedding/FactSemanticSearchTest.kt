package com.qingyu.companion.embedding

import com.qingyu.companion.chatcore.ChatEmbeddingPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `semantic.factSearch` 与世界书语义检索**同口径**：同一失效键、同一阈值、同一命中映射、
 * 同一三档降级；不可用时**回退全量注入**并给出可解释原因（矩阵备注「不可用时关键词降级」）。
 */
class FactSemanticSearchTest {

    private val config = ChatEmbeddingPolicy.Config(provider = "ollama", model = "nomic", baseUrl = "http://x")
    private val decisionVector = TierDecision(SemanticTier.LOCAL_MODEL, TierReason.LOCAL_MODEL_READY, "语义检索使用设备本地向量模型。")
    private val decisionLexical = TierDecision(SemanticTier.LEXICAL_FALLBACK, TierReason.MODEL_NOT_INSTALLED, "已降级为关键词/词法检索（本地：本地向量模型未安装）。")

    private val facts = listOf("左手腕有旧伤", "深夜的书店店主", "旅人进店避雨")

    private fun keys(revision: String) = facts.map { SemanticIndexPolicy.key("openai:m", revision) }

    private fun index(revision: String = "r1"): FactSemanticSearch.FactVectorIndex =
        FactSemanticSearch.FactVectorIndex(
            facts = facts,
            vectors = listOf(listOf(1.0, 0.0), listOf(0.6, 0.8), listOf(0.0, 1.0)),
            keys = keys(revision),
        )

    @Test
    fun vectorHitsUseTheSameThresholdAndHitMappingAsLorebook() {
        val result = FactSemanticSearch.search(
            query = "手腕",
            queryVector = listOf(1.0, 0.0),
            index = index(),
            currentKeys = keys("r1"),
            decision = decisionVector,
            config = config,
            requestedThreshold = 0.5,
            maxResults = 2,
        )
        assertEquals("向量通道命中", FactSemanticSearch.Channel.VECTOR, result.channel)
        assertTrue("命中至少一条", result.hits.isNotEmpty())
        val first = result.hits.first()
        assertEquals("命中 id 是字符串下标、映射回事实原文（ChatEmbeddingPolicy.mapFactSearchHits 同口径）", "左手腕有旧伤", first.text)
        assertTrue("命中要带真实相似度（调试面板展示）", first.score > 0.5)
        assertTrue("最多 maxResults 条", result.hits.size <= 2)
        assertTrue("解释里要有阈值读数：${result.explanation}", result.explanation.contains("阈值"))
    }

    @Test
    fun lexicalTierFallsBackToFullInjectionWithExplanation() {
        val result = FactSemanticSearch.search(
            query = "手腕",
            queryVector = listOf(1.0, 0.0),
            index = index(),
            currentKeys = keys("r1"),
            decision = decisionLexical,
            config = config,
        )
        assertEquals("无向量通道必须回退全量注入（PC 同款），而不是返回空事实", FactSemanticSearch.Channel.FULL_INJECTION_FALLBACK, result.channel)
        assertTrue("事实一条不丢", result.hits.isEmpty())
        assertTrue(
            "回退必须可解释（界面能读到为什么）：${result.explanation}",
            result.explanation.contains("降级") && result.explanation.contains("本地向量模型未安装"),
        )
    }

    @Test
    fun invalidatedOrMissingIndexFallsBackInsteadOfUsingStaleVectors() {
        val staleRevision = FactSemanticSearch.search(
            query = "手腕",
            queryVector = listOf(1.0, 0.0),
            index = index(),
            currentKeys = keys("r1-edited"), // 实体修订变化 → 失效键不一致
            decision = decisionVector,
            config = config,
        )
        assertEquals(
            "失效键不一致必须回退全量注入并等重建（拿旧向量检索就是错命中）",
            FactSemanticSearch.Channel.FULL_INJECTION_FALLBACK,
            staleRevision.channel,
        )
        assertTrue("原因要提到索引失效：${staleRevision.explanation}", staleRevision.explanation.contains("失效"))

        val modelChanged = FactSemanticSearch.search(
            query = "手腕",
            queryVector = listOf(1.0, 0.0),
            index = index(),
            currentKeys = keys("r1").map { it.copy(modelFingerprint = "openai:other") },
            decision = decisionVector,
            config = config,
        )
        assertEquals("换模型（失效键模型指纹变化）同样必须回退", FactSemanticSearch.Channel.FULL_INJECTION_FALLBACK, modelChanged.channel)

        val noIndex = FactSemanticSearch.search(
            query = "手腕",
            queryVector = listOf(1.0, 0.0),
            index = null,
            currentKeys = null,
            decision = decisionVector,
            config = config,
        )
        assertEquals("没有索引走同一回退口径", FactSemanticSearch.Channel.FULL_INJECTION_FALLBACK, noIndex.channel)
        assertTrue("要说明索引可重建：${noIndex.explanation}", noIndex.explanation.contains("重建"))
    }

    @Test
    fun queryFailureAndBlankQueryNeverDropFacts() {
        val noQueryVector = FactSemanticSearch.search(
            query = "手腕",
            queryVector = null,
            index = index(),
            currentKeys = keys("r1"),
            decision = decisionVector,
            config = config,
        )
        assertEquals("查询向量化失败必须回退全量注入（事实不能因此丢）", FactSemanticSearch.Channel.FULL_INJECTION_FALLBACK, noQueryVector.channel)
        assertTrue("要说清事实没丢：${noQueryVector.explanation}", noQueryVector.explanation.contains("不影响已保存的事实"))

        val blank = FactSemanticSearch.search(
            query = "   ",
            queryVector = listOf(1.0, 0.0),
            index = index(),
            currentKeys = keys("r1"),
            decision = decisionVector,
            config = config,
        )
        assertEquals("空查询不检索但也不吞事实", FactSemanticSearch.Channel.FULL_INJECTION_FALLBACK, blank.channel)
    }
}
