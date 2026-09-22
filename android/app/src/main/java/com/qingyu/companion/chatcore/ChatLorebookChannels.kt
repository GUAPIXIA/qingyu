package com.qingyu.companion.chatcore

/**
 * 阶段 5 S5-02 收口 / 阶段 6 S6-05 前置：**触发通道可用性**的单一口径。
 *
 * ## 为什么需要这个文件
 *
 * 由 `retrieval` 决定的「这条条目在本机到底能不能触发」，此前**没有任何一处回答**：
 * `ChatLorebookCompile` 的注释声称把 `retrieval` 映成 `matchMode`，代码却从未读过该字段，
 * 运行时因此对所有模式一视同仁地只用关键词通道。于是三种真实差异全部无声：
 *
 * | `retrieval` | PC（无 embeddings 时） | Android 现状 | 用户看到什么 |
 * |---|---|---|---|
 * | `keyword` | 关键词通道 | 关键词通道 | 一致 |
 * | `hybrid`（有关键词） | 关键词通道（另有词法） | 关键词通道 | 一致（见下方平台级缺口） |
 * | `hybrid`（无关键词） | **词法兜底** | 无任何可用通道 → 不触发 | 比 PC 少注入，且不给理由 |
 * | `semanticPreferred` | 向量 → **词法兜底** | 关键词近似 | 机制不同，命中集合不同 |
 * | `semanticRequired` | **停用该条目**并 warn-once | 关键词照常触发 | 两端语义相反 |
 *
 * 其中 `semanticPreferred` 与「无关键词的 `hybrid`」是**真实导入路径**会产出的：
 * SillyTavern 的 `vectorized: true` 无 key 条目经
 * `LorebookNativeV1`（`matchMode = "semantic"`）→ `LorebookNativeMigration`
 * 落成 `semanticPreferred`（`LorebookNativeMigration.retrievalFromLegacy`）。
 *
 * ## 这个文件是什么、不是什么
 *
 * 它**不是行为开关**：本轮不改任何触发结果（所以跨语言 golden 不受影响）。
 * 它是**读数**——把「模式要求什么通道、本机有什么通道」这件事说出口，
 * 供导入结果提示与阶段 6 S6-05（远程/本地 embedding + 词法降级）消费。
 *
 * ## 平台级缺口（比逐条分类更大，必须一起读）
 *
 * 本机既没有向量通道也没有词法通道，而 PC 的 `hybrid` 条目**恒**可走词法
 * （`isLexicalEligibleMode`）。因此即使是被判为 `SAME` 的 `hybrid` 条目，
 * PC 仍可能靠词法单独召回、本机不能——本机的结果是 PC 的**子集**。
 * 这一条不逐条判定（无法在不实现词法通道的前提下知道会不会命中），
 * 只在此声明口径，避免把 `SAME` 读成「与 PC 逐条等价」。
 *
 * ## 不要把这些结论塞进兼容性报告
 *
 * `LorebookCompatibilityReport` 与 PC **逐字节相同**
 * （`LorebookCrossLanguageGoldenTest` 直接比 `report.toJsonMap()`），
 * 往里加一条 issue 会让跨端 golden 变红。所以这里的分类是 Android 侧的**独立读数**，
 * 走界面提示而不是那份报告。
 */
object ChatLorebookChannels {

    /**
     * 本机是否具备向量（embeddings）触发通道。
     *
     * 阶段 6 S6-05 实现后改这里；改完 `ChatLorebookChannelsTest` 会按新口径变红，
     * 逼着同时更新分类表与本文档——这是有意的（同 D-8 那条「将来谁改上限就变红」）。
     */
    const val VECTOR_AVAILABLE: Boolean = false

    /**
     * 本机是否具备词法（BM25）触发通道。
     *
     * 阶段 6 S6-05 实现后改这里。见类注释「平台级缺口」。
     */
    const val LEXICAL_AVAILABLE: Boolean = false

    /**
     * S6-05 接缝（阶段 5 §2.21 预留的「通道能力输入」）：嵌入层注入的**动态**通道能力，
     * 供运行时在 [VECTOR_AVAILABLE]/[LEXICAL_AVAILABLE] 编译期常量之外接收真实能力读数。
     *
     * - `vectorAvailable`：向量触发通道当前是否可用（设备能力/模型包就绪）；
     * - `lexicalAvailable`：词法（BM25 `unicode-bigram-v1`）兜底通道是否可用；
     * - `semanticRequiredGated`：`semanticRequired` 条目**按 PC 现状（D-9 未翻转）**在
     *   无向量通道时停用并 warn-once，而不是阶段 5 快照里的「关键词照常触发」。
     */
    data class ChannelCapabilities(
        val vectorAvailable: Boolean = false,
        val lexicalAvailable: Boolean = false,
        val semanticRequiredGated: Boolean = false,
    )

    /** 条目在本机相对 PC 的触发保真度。 */
    enum class Fidelity {
        /** 与 PC 使用同一通道（`hybrid` 仍受类注释的平台级缺口影响）。 */
        SAME,

        /** 能触发，但用的不是 PC 的通道，命中集合与 PC 不同。 */
        APPROXIMATED,

        /** PC 会触发（词法/向量），本机没有任何可用通道 → 不会触发。 */
        UNAVAILABLE,

        /** PC 会**停用**该条目，本机却仍按关键词触发 → 两端行为相反。 */
        PC_DISABLED,
    }

    /**
     * PC `hasKeywordChannel`：只有 `keyword` 与 `hybrid` 使用关键词通道；
     * `semanticPreferred` / `semanticRequired` 在 PC 上**不使用关键词**。
     *
     * 本机目前对所有模式都用关键词，所以这个函数描述的是 **PC 的口径**，
     * 用来判断「本机用关键词算不算按 PC 的规矩办事」。
     */
    fun hasKeywordChannel(retrieval: String): Boolean = retrieval == "keyword" || retrieval == "hybrid"

    /** PC `isSemanticDeadEntry`：仅显式 `semanticRequired`（且非 always）在无向量时停用。 */
    fun isSemanticDeadEntry(retrieval: String, priority: String?): Boolean =
        priority != "always" && retrieval == "semanticRequired"

    /**
     * 逐条分类。
     *
     * `keywordChannelPresent` = 条目是否写了非空关键词，与运行时的判据
     * （`entryKeywords.any { it.isNotBlank() }`）同口径——用同一把尺子，
     * 否则读数会和实际触发与否对不上。
     */
    fun fidelityOf(retrieval: String, priority: String?, keywordChannelPresent: Boolean): Fidelity {
        if (isSemanticDeadEntry(retrieval, priority) && !VECTOR_AVAILABLE) return Fidelity.PC_DISABLED
        return when (retrieval) {
            "keyword" -> Fidelity.SAME
            "hybrid" ->
                if (keywordChannelPresent || LEXICAL_AVAILABLE) Fidelity.SAME else Fidelity.UNAVAILABLE
            "semanticPreferred" ->
                if (VECTOR_AVAILABLE || LEXICAL_AVAILABLE) Fidelity.SAME else Fidelity.APPROXIMATED
            "semanticRequired" ->
                // `always` 条目在两端都是无条件收集，通道缺失不影响它；
                // 只有「需要靠向量命中才能触发」的那些才落进 PC 的停用分支。
                if (VECTOR_AVAILABLE || priority == "always") Fidelity.SAME else Fidelity.UNAVAILABLE
            // canonical 校验只放行四种模式；真出现别的值时按「不改变现状」处理，
            // 不用一个猜出来的模式去声称差异。
            else -> Fidelity.SAME
        }
    }

    /** 一条值得说出口的差异。 */
    data class Finding(
        /** `bookId:entryId`，与运行时 `triggeredEntryKeys` 同一形状，便于对着日志排查。 */
        val key: String,
        val retrieval: String,
        val fidelity: Fidelity,
    )

    /** 一本书（或一次导入结果）的通道差异读数。 */
    data class Report(val findings: List<Finding>) {
        val approximatedCount: Int get() = findings.count { it.fidelity == Fidelity.APPROXIMATED }
        val unavailableCount: Int get() = findings.count { it.fidelity == Fidelity.UNAVAILABLE }
        val pcDisabledCount: Int get() = findings.count { it.fidelity == Fidelity.PC_DISABLED }

        /** 没有差异时不产生文案（界面据此决定要不要显示这一行）。 */
        val hasFindings: Boolean get() = findings.isNotEmpty()

        /**
         * 面向用户的一句中文。数字全部由 `findings` 数出来，
         * 不写死——写死的数字会在有人实现通道之后变成假话。
         */
        fun summaryLine(): String? {
            if (findings.isEmpty()) return null
            val parts = mutableListOf<String>()
            if (approximatedCount > 0) {
                parts += "$approximatedCount 条改用关键词近似（原文要求语义检索）"
            }
            if (unavailableCount > 0) {
                parts += "$unavailableCount 条不会触发（原文要求语义/词法检索，本机暂无该通道）"
            }
            if (pcDisabledCount > 0) {
                parts += "$pcDisabledCount 条在 PC 上会被停用，本机仍按关键词触发"
            }
            return "检索通道差异：" + parts.joinToString("；") + "。"
        }
    }

    fun analyze(book: ChatLorebookRuntime.Book): Report = analyze(listOf(book))

    /**
     * 只统计**会被实际考虑**的条目：跳过停用的书与停用的条目
     * （运行时同样先跳过它们，否则读数里会出现根本不会参与触发的条目）。
     */
    fun analyze(books: List<ChatLorebookRuntime.Book>): Report {
        val findings = mutableListOf<Finding>()
        for (book in books) {
            if (!book.enabled) continue
            for (entry in book.entries) {
                if (!entry.enabled) continue
                val fidelity = fidelityOf(
                    retrieval = entry.retrieval,
                    priority = entry.priority,
                    keywordChannelPresent = entry.keywords.any { it.isNotBlank() },
                )
                if (fidelity == Fidelity.SAME) continue
                findings += Finding("${book.id}:${entry.id}", entry.retrieval, fidelity)
            }
        }
        return Report(findings)
    }

    // ================================================================
    // 阶段 6 S6-05 追加：判定表的**通道能力输入版**（`embedding` 包接入点）
    //
    // 上面的 [fidelityOf]/[analyze] 以编译期常量为开关，描述的是「通道还没接线」
    // 的阶段 5 快照。S6-05 起通道可用性是**运行期事实**（远程配置了没有、本地模型
    // 装了没有、设备支不支持），所以下面这组重载把 [ChannelCapabilities] 作为输入，
    // 分类表语义完全同构。两份判定的一致性由 `EmbeddingChannelCapabilitiesTest`
    // 在 [compiledInCapabilities] 口径下逐行钉死——谁改了一边，另一边必须同步。
    // ================================================================

    /** 编译期常量口径的能力输入（阶段 5 快照的等价物，两份判定表的一致性基线）。 */
    fun compiledInCapabilities(): ChannelCapabilities = ChannelCapabilities(
        vectorAvailable = VECTOR_AVAILABLE,
        lexicalAvailable = LEXICAL_AVAILABLE,
        semanticRequiredGated = false,
    )

    /** 判定表（能力输入版）。 */
    fun fidelityOf(
        retrieval: String,
        priority: String?,
        keywordChannelPresent: Boolean,
        capabilities: ChannelCapabilities,
    ): Fidelity {
        if (isSemanticDeadEntry(retrieval, priority) && !capabilities.vectorAvailable) {
            // D-9（**按 PC 现状实现，决策仍开放**）：S6-05 分流生效（gated）后本机与 PC
            // 一样停用该条目 → 不再构成差异；gated=false 保持阶段 5 快照：PC 停用、
            // 本机仍按关键词触发 → PC_DISABLED。不自行翻转，翻转需契约签字。
            return if (capabilities.semanticRequiredGated) Fidelity.SAME else Fidelity.PC_DISABLED
        }
        return when (retrieval) {
            "keyword" -> Fidelity.SAME
            "hybrid" ->
                if (keywordChannelPresent || capabilities.lexicalAvailable) Fidelity.SAME else Fidelity.UNAVAILABLE
            "semanticPreferred" ->
                if (capabilities.vectorAvailable || capabilities.lexicalAvailable) Fidelity.SAME else Fidelity.APPROXIMATED
            "semanticRequired" ->
                if (capabilities.vectorAvailable || priority == "always") Fidelity.SAME else Fidelity.UNAVAILABLE
            else -> Fidelity.SAME
        }
    }

    /** 聚合读数（能力输入版）：跳过停用书/停用条目的口径与 [analyze] 一致。 */
    fun analyze(books: List<ChatLorebookRuntime.Book>, capabilities: ChannelCapabilities): Report {
        val findings = mutableListOf<Finding>()
        for (book in books) {
            if (!book.enabled) continue
            for (entry in book.entries) {
                if (!entry.enabled) continue
                val fidelity = fidelityOf(
                    retrieval = entry.retrieval,
                    priority = entry.priority,
                    keywordChannelPresent = entry.keywords.any { it.isNotBlank() },
                    capabilities = capabilities,
                )
                if (fidelity == Fidelity.SAME) continue
                findings += Finding("${book.id}:${entry.id}", entry.retrieval, fidelity)
            }
        }
        return Report(findings)
    }
}
