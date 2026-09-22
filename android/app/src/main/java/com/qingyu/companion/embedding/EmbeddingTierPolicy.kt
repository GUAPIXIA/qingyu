package com.qingyu.companion.embedding

import com.qingyu.companion.chatcore.ChatLorebookChannels

/**
 * 阶段 6 S6-05 的**三档分级与可解释降级**（原文「分级实现：远程 → 设备本地模型 →
 * 资源不足时关键词/词法降级」的判定层）。
 *
 * 三档：
 * 1. [SemanticTier.REMOTE_EMBEDDING]：远程 OpenAI-compatible / Ollama 嵌入；
 * 2. [SemanticTier.LOCAL_MODEL]：支持设备上的本地移动端模型；
 * 3. [SemanticTier.LEXICAL_FALLBACK]：关键词/词法降级（BM25 词法通道 + 既有关键词通道）。
 *
 * 可解释是硬要求：界面必须能读到「为什么走了词法」——[TierDecision.explanation]
 * 与 [TierDecision.reason] 一个给人看、一个给程序分支，缺一档都不算做完。
 * 不阻断关键词是硬边界（总方案 §3.2）：**任何**判定结果都不得让关键词世界书失效，
 * [TierDecision.keywordWorldbookBlocked] 恒为 false，由测试钉死。
 */

enum class SemanticTier {
    /** 第 1 档：远程 OpenAI-compatible / Ollama。 */
    REMOTE_EMBEDDING,

    /** 第 2 档：支持设备上的本地移动端模型。 */
    LOCAL_MODEL,

    /** 第 3 档：关键词/词法降级。 */
    LEXICAL_FALLBACK,
}

/** 为什么落在这一档（程序分支用；界面文案以 [TierDecision.explanation] 为准）。 */
enum class TierReason {
    REMOTE_READY,
    LOCAL_MODEL_READY,
    REMOTE_DEGRADED_TO_LOCAL,
    NOT_CONFIGURED,
    REMOTE_FAILED,
    DEVICE_UNSUPPORTED,
    MODEL_NOT_INSTALLED,
    RESOURCE_INSUFFICIENT,
    LOCAL_RUNTIME_FAILED,
    LOCAL_DISABLED,
}

/** 单条通道的就绪读数。 */
data class ChannelReadiness(
    val ready: Boolean,
    /** 不可用时的档位原因。 */
    val reason: TierReason? = null,
    /** 面向用户的一句话（服务名/模型名/内存数字等具体信息）。 */
    val detail: String = "",
)

/** 两档向量通道的环境读数（由接线层从设置/设备/安装状态汇总）。 */
data class EmbeddingEnvironment(
    val remote: ChannelReadiness,
    val local: ChannelReadiness,
)

/** 三档判定结果。 */
data class TierDecision(
    val tier: SemanticTier,
    val reason: TierReason,
    /** 界面直接可读：为什么是这一档（「为什么走了词法」就看这句）。 */
    val explanation: String,
) {
    /** 向量通道（远程或本地）此刻是否可用。 */
    val vectorChannelAvailable: Boolean
        get() = tier == SemanticTier.REMOTE_EMBEDDING || tier == SemanticTier.LOCAL_MODEL

    /** 是否已降级到关键词/词法档。 */
    val lexicalFallback: Boolean
        get() = tier == SemanticTier.LEXICAL_FALLBACK

    /**
     * 关键词世界书是否被阻断——**恒为 false**。
     * 语义能力的任何状态（没配置、设备不支持、资源不足、请求失败）都只影响语义通道，
     * 不影响关键词/正则触发（总方案 §3.2「不阻断关键词世界书」）。
     */
    val keywordWorldbookBlocked: Boolean
        get() = false

    /**
     * 接入 [ChatLorebookChannels] 的通道能力输入（阶段 5 §2.21 留的接缝）：
     * - 词法通道自 S6-05 起真实存在（[LexicalFallbackChannel]，BM25 `unicode-bigram-v1`）；
     * - `semanticRequiredGated = true`：**按 PC 现状**（D-9）无向量时停用该条目并 warn-once，
     *   而不是阶段 5 快照里的「关键词照常触发」。
     */
    fun channelCapabilities(): ChatLorebookChannels.ChannelCapabilities =
        ChatLorebookChannels.ChannelCapabilities(
            vectorAvailable = vectorChannelAvailable,
            lexicalAvailable = true,
            semanticRequiredGated = true,
        )
}

object EmbeddingTierPolicy {

    // ------------------------------------------------------------ 环境读数构造（接线层用）

    fun remoteReady(provider: String, model: String): ChannelReadiness =
        ChannelReadiness(ready = true, detail = "（$provider/$model）")

    fun remoteNotConfigured(): ChannelReadiness =
        ChannelReadiness(ready = false, reason = TierReason.NOT_CONFIGURED, detail = "未配置远程嵌入服务")

    fun remoteFailed(kind: EmbeddingFailureKind, detail: String = ""): ChannelReadiness =
        ChannelReadiness(
            ready = false,
            reason = TierReason.REMOTE_FAILED,
            detail = if (detail.isEmpty()) kind.label else "${kind.label}（$detail）",
        )

    /**
     * 本地档读数：设备支持 → 装没装 → 运行时能不能起来。
     * 三者任一不满足都是不可用，但**原因不同、文案不同**（不能都叫「不支持」）。
     */
    fun local(
        support: LocalRuntimeSupport,
        installed: Boolean,
        runtimeError: String? = null,
    ): ChannelReadiness {
        if (support is LocalRuntimeSupport.Unsupported) {
            val reason = when (support.reason) {
                LocalRuntimeSupport.Unsupported.Reason.USER_DISABLED -> TierReason.LOCAL_DISABLED
                LocalRuntimeSupport.Unsupported.Reason.MEMORY_BELOW_RECOMMENDED -> TierReason.RESOURCE_INSUFFICIENT
                LocalRuntimeSupport.Unsupported.Reason.ABI_UNSUPPORTED,
                LocalRuntimeSupport.Unsupported.Reason.API_TOO_LOW,
                -> TierReason.DEVICE_UNSUPPORTED
            }
            return ChannelReadiness(ready = false, reason = reason, detail = support.explanation)
        }
        if (!installed) {
            return ChannelReadiness(
                ready = false,
                reason = TierReason.MODEL_NOT_INSTALLED,
                detail = "本地向量模型未安装",
            )
        }
        if (runtimeError != null) {
            return ChannelReadiness(
                ready = false,
                reason = TierReason.LOCAL_RUNTIME_FAILED,
                detail = "本地向量运行时加载失败（$runtimeError）",
            )
        }
        val note = (support as? LocalRuntimeSupport.Supported)?.note.orEmpty()
        return ChannelReadiness(ready = true, detail = if (note.isEmpty()) "" else "（$note）")
    }

    // ------------------------------------------------------------ 三档判定

    /**
     * 分级顺序与原文一致：远程 → 设备本地模型 → 关键词/词法降级。
     * 远程失败但本地可用时**不直接掉到词法**（第 2 档就是为此存在的）。
     */
    fun decide(environment: EmbeddingEnvironment): TierDecision {
        if (environment.remote.ready) {
            return TierDecision(
                tier = SemanticTier.REMOTE_EMBEDDING,
                reason = TierReason.REMOTE_READY,
                explanation = "语义检索使用远程嵌入服务${environment.remote.detail}。",
            )
        }
        if (environment.local.ready) {
            val degraded = environment.remote.reason == TierReason.REMOTE_FAILED
            return TierDecision(
                tier = SemanticTier.LOCAL_MODEL,
                reason = if (degraded) TierReason.REMOTE_DEGRADED_TO_LOCAL else TierReason.LOCAL_MODEL_READY,
                explanation = if (degraded) {
                    "远程嵌入服务暂不可用（${environment.remote.detail}），已切换到设备本地向量模型${environment.local.detail}。"
                } else {
                    "语义检索使用设备本地向量模型${environment.local.detail}。"
                },
            )
        }
        val reason = environment.local.reason
            ?: environment.remote.reason
            ?: TierReason.NOT_CONFIGURED
        val cause = buildList {
            add("本地：${environment.local.detail.ifEmpty { "无可用的本地向量模型" }}")
            add("远程：${environment.remote.detail.ifEmpty { "未配置远程嵌入服务" }}")
        }.joinToString("；")
        return TierDecision(
            tier = SemanticTier.LEXICAL_FALLBACK,
            reason = reason,
            explanation = "已降级为关键词/词法检索（$cause）——语义通道缺失只影响语义触发，关键词世界书不受影响。",
        )
    }
}
