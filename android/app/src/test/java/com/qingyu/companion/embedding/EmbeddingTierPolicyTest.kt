package com.qingyu.companion.embedding

import com.qingyu.companion.chatcore.ChatLorebookChannels
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-05 三档分级与**可解释降级**（原文分级：远程 → 设备本地模型 → 关键词/词法降级）。
 * 硬要求两条：界面能读到「为什么走了词法」；任何情况下**不阻断关键词世界书**。
 */
class EmbeddingTierPolicyTest {

    private fun localReady(detail: String = "") =
        ChannelReadiness(ready = true, detail = detail)

    private fun decision(remote: ChannelReadiness, local: ChannelReadiness): TierDecision =
        EmbeddingTierPolicy.decide(EmbeddingEnvironment(remote = remote, local = local))

    // ---------- 三档 ----------

    @Test
    fun remoteConfiguredAndHealthyUsesTierOne() {
        val decision = decision(
            EmbeddingTierPolicy.remoteReady("openai", "text-embedding-3-small"),
            localReady(),
        )
        assertEquals("远程可用时按分级走第 1 档", SemanticTier.REMOTE_EMBEDDING, decision.tier)
        assertEquals(TierReason.REMOTE_READY, decision.reason)
        assertTrue("文案要说明用的是哪个服务（用户排障第一句就是问这个）：${decision.explanation}", decision.explanation.contains("text-embedding-3-small"))
    }

    @Test
    fun remoteFailureFallsBackToLocalModelNotAllTheWayToLexical() {
        val decision = decision(
            EmbeddingTierPolicy.remoteFailed(EmbeddingFailureKind.RATE_LIMITED, "429"),
            localReady("（BGE M3）"),
        )
        assertEquals("远程失败但本地有模型时走第 2 档，不该直接掉到词法", SemanticTier.LOCAL_MODEL, decision.tier)
        assertEquals(TierReason.REMOTE_DEGRADED_TO_LOCAL, decision.reason)
        assertTrue("要说清为什么换档：${decision.explanation}", decision.explanation.contains("远程嵌入服务暂不可用"))
        assertTrue("要说清换到了哪一档：${decision.explanation}", decision.explanation.contains("本地向量模型"))
    }

    @Test
    fun noRemoteButLocalModelUsesTierTwo() {
        val decision = decision(EmbeddingTierPolicy.remoteNotConfigured(), localReady())
        assertEquals("没配远程但本地有模型时走第 2 档", SemanticTier.LOCAL_MODEL, decision.tier)
        assertEquals(TierReason.LOCAL_MODEL_READY, decision.reason)
    }

    // ---------- 为什么走了词法：每种原因都要能读出来 ----------

    private fun assertLexicalExplained(remote: ChannelReadiness, local: ChannelReadiness, expectedReason: TierReason, expectedCause: String) {
        val decision = decision(remote, local)
        assertEquals("双通道都不可用必须降到词法档", SemanticTier.LEXICAL_FALLBACK, decision.tier)
        assertEquals("原因码要能区分（程序按它分支）", expectedReason, decision.reason)
        assertTrue(
            "界面必须能读到「为什么走了词法」，实际：${decision.explanation}",
            decision.explanation.contains("已降级为关键词/词法检索"),
        )
        assertTrue(
            "具体原因要进文案（$expectedCause），实际：${decision.explanation}",
            decision.explanation.contains(expectedCause),
        )
    }

    @Test
    fun lexicalFallbackReasonsAreAllExplainable() {
        assertLexicalExplained(
            EmbeddingTierPolicy.remoteNotConfigured(),
            EmbeddingTierPolicy.local(LocalRuntimeSupportPolicy.evaluate(
                DeviceCapability(listOf("mips"), 34, 4096),
            ), installed = false),
            TierReason.DEVICE_UNSUPPORTED,
            "不在本地向量模型支持列表",
        )
        assertLexicalExplained(
            EmbeddingTierPolicy.remoteNotConfigured(),
            EmbeddingTierPolicy.local(LocalRuntimeSupport.Supported("ok"), installed = false),
            TierReason.MODEL_NOT_INSTALLED,
            "本地向量模型未安装",
        )
        assertLexicalExplained(
            EmbeddingTierPolicy.remoteNotConfigured(),
            EmbeddingTierPolicy.local(LocalRuntimeSupport.Unsupported(
                LocalRuntimeSupport.Unsupported.Reason.MEMORY_BELOW_RECOMMENDED,
                "设备内存 512 MB 低于建议 1024 MB",
            ), installed = true),
            TierReason.RESOURCE_INSUFFICIENT,
            "设备内存 512 MB 低于建议 1024 MB",
        )
        assertLexicalExplained(
            EmbeddingTierPolicy.remoteNotConfigured(),
            EmbeddingTierPolicy.local(LocalRuntimeSupport.Supported("ok"), installed = true, runtimeError = "NNAPI 初始化失败"),
            TierReason.LOCAL_RUNTIME_FAILED,
            "NNAPI 初始化失败",
        )
        assertLexicalExplained(
            EmbeddingTierPolicy.remoteNotConfigured(),
            EmbeddingTierPolicy.local(LocalRuntimeSupport.Unsupported(
                LocalRuntimeSupport.Unsupported.Reason.USER_DISABLED,
                "已在设置中关闭设备端本地向量模型",
            ), installed = true),
            TierReason.LOCAL_DISABLED,
            "已在设置中关闭",
        )
        assertLexicalExplained(
            EmbeddingTierPolicy.remoteFailed(EmbeddingFailureKind.AUTH_FAILED, "401"),
            EmbeddingTierPolicy.local(LocalRuntimeSupport.Supported("ok"), installed = false),
            TierReason.MODEL_NOT_INSTALLED,
            "本地向量模型未安装",
        )
    }

    @Test
    fun remoteFailureStillVisibleInLexicalExplanation() {
        val decision = decision(
            EmbeddingTierPolicy.remoteFailed(EmbeddingFailureKind.NETWORK, "连接被拒"),
            EmbeddingTierPolicy.local(LocalRuntimeSupport.Supported("ok"), installed = false),
        )
        assertTrue(
            "远程失败的事实不能在降级文案里丢掉（用户要修的是网络）：${decision.explanation}",
            decision.explanation.contains("网络不可达"),
        )
        assertTrue("本地缺什么也要一起说：${decision.explanation}", decision.explanation.contains("本地向量模型未安装"))
    }

    // ---------- 硬边界：不阻断关键词世界书 ----------

    @Test
    fun keywordWorldbookIsNeverBlockedInAnyTier() {
        val combos = listOf(
            decision(EmbeddingTierPolicy.remoteReady("ollama", "nomic"), localReady()),
            decision(EmbeddingTierPolicy.remoteNotConfigured(), localReady()),
            decision(EmbeddingTierPolicy.remoteNotConfigured(), EmbeddingTierPolicy.local(LocalRuntimeSupport.Supported("ok"), installed = false)),
            decision(EmbeddingTierPolicy.remoteFailed(EmbeddingFailureKind.TIMEOUT), EmbeddingTierPolicy.local(LocalRuntimeSupport.Supported("ok"), installed = true, runtimeError = "崩了")),
        )
        for (decision in combos) {
            assertFalse(
                "任何档位都不得阻断关键词世界书（总方案 §3.2），实际档位：${decision.tier}",
                decision.keywordWorldbookBlocked,
            )
        }
        assertEquals(
            "词法降级档本身要成立（三档齐全）",
            SemanticTier.LEXICAL_FALLBACK,
            combos.last().tier,
        )
    }

    // ---------- 通道能力接线（ChatLorebookChannels 输入） ----------

    @Test
    fun channelCapabilitiesCarryTierStateIntoLorebookChannels() {
        val vectorTier = decision(EmbeddingTierPolicy.remoteReady("openai", "m"), localReady()).channelCapabilities()
        assertTrue("向量档要向 ChatLorebookChannels 报告向量通道可用", vectorTier.vectorAvailable)
        assertTrue("词法通道自 S6-05 起真实存在（LexicalFallbackChannel）", vectorTier.lexicalAvailable)

        val lexicalTier = decision(
            EmbeddingTierPolicy.remoteNotConfigured(),
            EmbeddingTierPolicy.local(LocalRuntimeSupport.Supported("ok"), installed = false),
        ).channelCapabilities()
        assertFalse("词法档不得谎报向量通道", lexicalTier.vectorAvailable)

        assertTrue(
            "D-9 按 PC 现状：semanticRequired 由通道分流停用（gated），不是关键词近似触发",
            lexicalTier.semanticRequiredGated,
        )
        assertEquals(
            "gated 后 semanticRequired 无向量 = 两端一致停用（不再是 PC_DISABLED 差异）",
            ChatLorebookChannels.Fidelity.SAME,
            ChatLorebookChannels.fidelityOf("semanticRequired", "conditional", keywordChannelPresent = true, capabilities = lexicalTier),
        )
    }
}
