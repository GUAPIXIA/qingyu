package com.qingyu.companion.embedding

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-05 按 `retrieval` 分流触发通道 + **D-9 的落地口径**。
 *
 * D-9（**仍待契约签字，登记于交付报告**）：`semanticRequired` 两端行为相反
 * ——PC 无向量时**停用**条目并 warn-once，阶段 5 的 Android 按关键词照常触发。
 * 本文件钉死的是「**按 PC 现状**」这一侧：无向量 → 停用 + warn-once。
 * 若最终裁决翻转（保留关键词近似），应改 `SemanticEntryGate.decide` 的停用分支
 * 并同步 `ChatLorebookChannels.ChannelCapabilities.semanticRequiredGated`，届时本文件会变红。
 */
class SemanticEntryGateTest {

    private val vectorTier = TierDecision(
        tier = SemanticTier.REMOTE_EMBEDDING,
        reason = TierReason.REMOTE_READY,
        explanation = "语义检索使用远程嵌入服务。",
    )

    private val lexicalTier = TierDecision(
        tier = SemanticTier.LEXICAL_FALLBACK,
        reason = TierReason.NOT_CONFIGURED,
        explanation = "已降级为关键词/词法检索。",
    )

    // ---------- D-9：semanticRequired 按 PC 现状 ----------

    @Test
    fun semanticRequiredWithoutVectorIsDisabledLikePcNotKeywordTriggered() {
        val plan = SemanticEntryGate.decide("semanticRequired", "conditional", keywordChannelPresent = true, decision = lexicalTier)
        assertTrue("D-9 按 PC 现状：无向量时 semanticRequired 整条停用（PC 同款），而不是关键词近似触发", plan.disabled)
        assertTrue("停用必须 warn-once（PC warnSemanticDeadEntries 同款），否则用户不知道条目为什么消失了", plan.warnSemanticDead)
        assertEquals("原因码与 PC 同名同值", SemanticEntryGate.REASON_SEMANTIC_UNAVAILABLE, plan.missReason)
        assertFalse("停用条目不能走关键词通道（那正是 D-9 说的两端相反）", plan.useKeyword)
        assertTrue(
            "停用要说清出路（改用 semanticPreferred / hybrid 或启用 embeddings）：${plan.explanation}",
            plan.explanation.orEmpty().contains("已停用") && plan.explanation.orEmpty().contains("semanticPreferred"),
        )
    }

    @Test
    fun semanticRequiredWithVectorUsesVectorChannel() {
        val plan = SemanticEntryGate.decide("semanticRequired", "conditional", keywordChannelPresent = true, decision = vectorTier)
        assertFalse("有向量时 semanticRequired 正常参与，不该被停用", plan.disabled)
        assertTrue("有向量时走向量通道", plan.useVector)
        assertFalse("semanticRequired 不用词法（PC isLexicalEligibleMode）", plan.useLexical)
        assertFalse("semanticRequired 不用关键词（PC hasKeywordChannel）", plan.useKeyword)
    }

    @Test
    fun alwaysEntriesAreNeverAffectedBySemanticAvailability() {
        for (tier in listOf(vectorTier, lexicalTier)) {
            val plan = SemanticEntryGate.decide("semanticRequired", "always", keywordChannelPresent = false, decision = tier)
            assertFalse("always 条目两端都无条件收集，语义通道缺失不得停用它", plan.disabled)
            assertTrue("always 条目是无条件收集，不走通道打分", plan.collectedUnconditionally)
            assertFalse("不需要死条目告警（PC 对 sticky/always 不告警）", plan.warnSemanticDead)
        }
    }

    // ---------- 不阻断关键词世界书 ----------

    @Test
    fun keywordAndHybridEntriesAreNeverDisabledInAnyTier() {
        for (tier in listOf(vectorTier, lexicalTier)) {
            for (retrieval in listOf("keyword", "hybrid", "semanticPreferred")) {
                val plan = SemanticEntryGate.decide(retrieval, "conditional", keywordChannelPresent = true, decision = tier)
                assertFalse("$retrieval 条目在任何档位都不得被停用（关键词世界书不阻断）", plan.disabled)
            }
            val keywordPlan = SemanticEntryGate.decide("keyword", "conditional", keywordChannelPresent = true, decision = tier)
            assertTrue("keyword 条目永远保留关键词通道", keywordPlan.useKeyword)
        }
    }

    // ---------- 通道分流表（PC 同名判据） ----------

    @Test
    fun channelRoutingMatchesPcModeSemantics() {
        val hybridNoKeyword = SemanticEntryGate.decide("hybrid", "conditional", keywordChannelPresent = false, decision = lexicalTier)
        assertTrue("hybrid 恒可走词法（PC isLexicalEligibleMode），这是阶段 5 平台级缺口的收口", hybridNoKeyword.useLexical)
        assertTrue(
            "关键词通道是模式级归属（PC hasKeywordChannel）：hybrid 拥有该通道，条目写没写关键词是 keywordChannelPresent 的读数",
            hybridNoKeyword.useKeyword,
        )
        assertEquals(
            "hybrid 无关键词时命中不了记 retrieval_miss（PC 同款）",
            SemanticEntryGate.REASON_RETRIEVAL_MISS,
            hybridNoKeyword.missReason,
        )

        val preferred = SemanticEntryGate.decide("semanticPreferred", "conditional", keywordChannelPresent = true, decision = lexicalTier)
        assertTrue("semanticPreferred 无向量时由词法兜底", preferred.useLexical)
        assertTrue("semanticPreferred 没有向量命中时才轮到词法，通道层面两者都备着", SemanticEntryGate.decide("semanticPreferred", "conditional", true, vectorTier).useVector)
        assertFalse("semanticPreferred 不用关键词（PC hasKeywordChannel=false，用关键词是阶段 5 的近似）", preferred.useKeyword)
    }

    @Test
    fun missReasonsMatchPcLoreEntryMissReason() {
        assertEquals(
            "keyword 未命中记 primary_miss",
            SemanticEntryGate.REASON_PRIMARY_MISS,
            SemanticEntryGate.loreEntryMissReason("keyword", keywordChannelPresent = false, embeddingsAvailable = false),
        )
        assertEquals(
            "hybrid 有关键词未命中记 primary_miss",
            SemanticEntryGate.REASON_PRIMARY_MISS,
            SemanticEntryGate.loreEntryMissReason("hybrid", keywordChannelPresent = true, embeddingsAvailable = false),
        )
        assertEquals(
            "hybrid 无关键词、词法也没召回记 retrieval_miss",
            SemanticEntryGate.REASON_RETRIEVAL_MISS,
            SemanticEntryGate.loreEntryMissReason("hybrid", keywordChannelPresent = false, embeddingsAvailable = false),
        )
        assertEquals(
            "semanticPreferred 无向量时词法也没召回记 retrieval_miss",
            SemanticEntryGate.REASON_RETRIEVAL_MISS,
            SemanticEntryGate.loreEntryMissReason("semanticPreferred", keywordChannelPresent = false, embeddingsAvailable = false),
        )
        assertEquals(
            "semanticPreferred 有向量未命中记 semantic_miss",
            SemanticEntryGate.REASON_SEMANTIC_MISS,
            SemanticEntryGate.loreEntryMissReason("semanticPreferred", keywordChannelPresent = false, embeddingsAvailable = true),
        )
        assertEquals(
            "semanticRequired 无向量记 semantic_unavailable（是通道不可用，不是没命中）",
            SemanticEntryGate.REASON_SEMANTIC_UNAVAILABLE,
            SemanticEntryGate.loreEntryMissReason("semanticRequired", keywordChannelPresent = true, embeddingsAvailable = false),
        )
    }

    // ---------- warn-once ----------

    @Test
    fun semanticDeadWarningFiresOncePerEntryAndEvictsOldestAtCapacity() {
        val log = SemanticDeadWarnLog(maxKeys = 2)
        assertTrue("第一次见必须告警", log.shouldWarn("lb:e1"))
        assertFalse("同一第二次不重复告警（warn-once），否则每轮生成都刷屏", log.shouldWarn("lb:e1"))
        assertTrue("别的条目照常告警", log.shouldWarn("lb:e2"))

        assertTrue("容量满后新键仍要能告警", log.shouldWarn("lb:e3"))
        assertFalse("淘汰的是最旧的键，最近的不能再告警", log.alreadyWarned("lb:e1"))
        assertTrue("最近告警过的键保留", log.alreadyWarned("lb:e3"))
        assertTrue("被淘汰的键再次出现可以重新告警（容量上限就是为此存在）", log.shouldWarn("lb:e1"))
    }
}
