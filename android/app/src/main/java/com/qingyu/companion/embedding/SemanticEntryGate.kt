package com.qingyu.companion.embedding

import com.qingyu.companion.chatcore.ChatLorebookChannels

/**
 * 阶段 6 S6-05：**按 `retrieval` 模式分流触发通道**——
 * 阶段 5 §2.21 留下的那句「本字段目前不参与触发分流」由这里兑现。
 *
 * 口径逐条取自 PC `shared/chat-core/lorebook.ts`（同名函数保持同名，便于对着查）：
 * - `hasKeywordChannel`：keyword / hybrid 有关键词通道；
 * - `isLexicalEligibleMode`：hybrid 恒可走词法；semanticPreferred 在**无向量命中**时词法兜底；
 * - `isSemanticDeadEntry` + `warnSemanticDeadEntries`：**semanticRequired 在无向量时整条停用
 *   并按条目 warn-once**（sticky/always 不受影响）；
 * - `loreEntryMissReason`：全通道未命中的可解释原因码（`semantic_miss` /
 *   `semantic_unavailable` / `primary_miss` / `retrieval_miss`），与 PC 同名同值。
 *
 * ## D-9（仍待契约签字）：`semanticRequired` 两端行为相反——本实现**按 PC 现状**
 *
 * PC 无向量时**停用**该条目并 warn-once；阶段 5 时的 Android 按关键词照常触发（两端相反）。
 * 本文件按 D-9 的处置要求「**按 PC 现状实现、登记决策仍开放**」：
 * 无向量 → 停用 + warn-once（与 PC 一致，用户在两端看到同一结果）。
 * 不自行翻转——若产品最终裁决为「保留关键词近似」，改的是 [decide] 的停用分支，
 * 并同步 [ChatLorebookChannels.ChannelCapabilities.semanticRequiredGated] 与本注释。
 */
object SemanticEntryGate {

    /** PC `LoreTriggerReason` 同名原因码。 */
    const val REASON_SEMANTIC_MISS = "semantic_miss"
    const val REASON_SEMANTIC_UNAVAILABLE = "semantic_unavailable"
    const val REASON_PRIMARY_MISS = "primary_miss"
    const val REASON_RETRIEVAL_MISS = "retrieval_miss"

    /** 一条条目在当前档位下的通道计划。 */
    data class EntryChannelPlan(
        /** `priority == "always"`：两端都无条件收集，通道不参与。 */
        val collectedUnconditionally: Boolean,
        val useKeyword: Boolean,
        val useLexical: Boolean,
        val useVector: Boolean,
        /** 停用（semanticRequired 且无向量，PC 现状）：不触发、不进候选。 */
        val disabled: Boolean,
        /** 全通道未命中时的原因码（PC `loreEntryMissReason`）。 */
        val missReason: String,
        /** 停用时给用户的解释（与 PC warn-once 文案同口径）。 */
        val explanation: String?,
        /** 是否需要 warn-once（由 [SemanticDeadWarnLog] 去重）。 */
        val warnSemanticDead: Boolean,
    )

    /**
     * 分流判定。[keywordChannelPresent] 与运行时的判据同口径
     * （`entryKeywords.any { it.isNotBlank() }`），只影响 hybrid 的原因码。
     */
    fun decide(
        retrieval: String,
        priority: String?,
        keywordChannelPresent: Boolean,
        decision: TierDecision,
        contentPreview: String? = null,
    ): EntryChannelPlan {
        val embeddingsAvailable = decision.vectorChannelAvailable
        val always = priority == "always"

        if (always) {
            return EntryChannelPlan(
                collectedUnconditionally = true,
                useKeyword = false,
                useLexical = false,
                useVector = false,
                disabled = false,
                // always 条目不走通道，也不会「未命中」——原因码保持 PC 的兜底值
                missReason = REASON_PRIMARY_MISS,
                explanation = null,
                warnSemanticDead = false,
            )
        }

        if (ChatLorebookChannels.isSemanticDeadEntry(retrieval, priority) && !embeddingsAvailable) {
            // D-9：按 PC 现状**停用**（不是关键词近似触发），warn-once 由调用方经 SemanticDeadWarnLog 去重
            return EntryChannelPlan(
                collectedUnconditionally = false,
                useKeyword = false,
                useLexical = false,
                useVector = false,
                disabled = true,
                missReason = REASON_SEMANTIC_UNAVAILABLE,
                explanation = semanticDeadWarnText(retrieval, contentPreview),
                warnSemanticDead = true,
            )
        }

        val useKeyword = ChatLorebookChannels.hasKeywordChannel(retrieval)
        val useVector = when (retrieval) {
            "hybrid", "semanticPreferred", "semanticRequired" -> embeddingsAvailable
            else -> false
        }
        val useLexical = when (retrieval) {
            // PC isLexicalEligibleMode：hybrid 恒可；semanticPreferred 在无向量命中时兜底
            // （通道层面两者都参与，向量命中后词法是否让位是运行时的 vector_miss_lexical_fallback 细节）
            "hybrid", "semanticPreferred" -> true
            else -> false
        }
        return EntryChannelPlan(
            collectedUnconditionally = false,
            useKeyword = useKeyword,
            useLexical = useLexical,
            useVector = useVector,
            disabled = false,
            missReason = loreEntryMissReason(retrieval, keywordChannelPresent, embeddingsAvailable),
            explanation = null,
            warnSemanticDead = false,
        )
    }

    /** PC `loreEntryMissReason`：全通道未命中时的可解释原因码。 */
    fun loreEntryMissReason(
        retrieval: String,
        keywordChannelPresent: Boolean,
        embeddingsAvailable: Boolean,
    ): String = when {
        // semanticRequired（非 always）：有向量时是「向量未命中」，无向量时是「语义通道不可用」
        retrieval == "semanticRequired" ->
            if (embeddingsAvailable) REASON_SEMANTIC_MISS else REASON_SEMANTIC_UNAVAILABLE
        retrieval == "keyword" -> REASON_PRIMARY_MISS
        retrieval == "hybrid" ->
            if (keywordChannelPresent) REASON_PRIMARY_MISS else REASON_RETRIEVAL_MISS
        // semanticPreferred：无向量时词法兜底仍未召回 → retrieval_miss（PC 同款）
        retrieval == "semanticPreferred" ->
            if (embeddingsAvailable) REASON_SEMANTIC_MISS else REASON_RETRIEVAL_MISS
        // canonical 校验只放行四种模式；未知模式不猜含义，走 PC 的兜底分支
        else -> if (embeddingsAvailable) REASON_SEMANTIC_MISS else REASON_RETRIEVAL_MISS
    }

    /**
     * PC `warnSemanticDeadEntries` 的文案（同口径，便于两端日志对照）。
     * [contentPreview] 为正文前 24 字符（空白折叠），null 时省略预览段。
     */
    fun semanticDeadWarnText(retrieval: String, contentPreview: String?): String {
        val preview = contentPreview
            ?.replace(Regex("\\s+"), " ")
            ?.let { "「$it…」" }
            .orEmpty()
        return "条目${preview}要求向量语义触发（retrieval=$retrieval），但 embeddings 未启用或未配置，" +
            "该条目已停用。可启用 embeddings，或改用 semanticPreferred / hybrid 以启用本地词法兜底"
    }
}

/**
 * 语义死条目的 **warn-once** 记录（PC `semanticDeadWarnedKeys` 同款：按条目键去重、
 * 容量 [maxKeys]、满了淘汰最旧的）。线程安全由调用方保证（触发管线单线程）。
 */
class SemanticDeadWarnLog(private val maxKeys: Int = 500) {
    private val warned = LinkedHashSet<String>()

    /** 该条目键是否**这次**需要告警（每键一次；容量满时淘汰最旧的键）。 */
    fun shouldWarn(key: String): Boolean {
        if (warned.contains(key)) return false
        if (warned.size >= maxKeys) {
            val oldest = warned.first()
            warned.remove(oldest)
        }
        warned.add(key)
        return true
    }

    val size: Int get() = warned.size

    fun alreadyWarned(key: String): Boolean = warned.contains(key)
}
