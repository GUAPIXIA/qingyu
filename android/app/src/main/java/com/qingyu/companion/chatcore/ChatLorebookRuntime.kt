package com.qingyu.companion.chatcore

/**
 * 阶段 4 A3b-2：世界书运行时（触发管线 + 预算 + 分发）
 * （对齐 `shared/chat-core/lorebook.ts` 的 `executeLorebookRuntime`）。
 *
 * ## 与 PC 的关系
 * 这是让世界书在 Android 上**真正生效**的入口。此前检索/渲染/预算/评分四层都已移植，
 * 但没有这一层把它们串起来，因此用户绑定了世界书却一条都不注入。
 *
 * ## 本轮覆盖的路径（与 PC 逐字段一致）
 * 条目收集 → 资格过滤（启停 / 生成类型 / 角色过滤）→ 按条目有效扫描深度取扫描文本
 * → always / sticky / 关键词匹配 → 二级关键词（四种 selectiveLogic）→ 概率 → 递归
 * → 全局内容去重 → 关键词通道 RRF → 统一评分 → 书级 cap → 分桶瀑布 → 按位置分发。
 *
 * ## 明确未覆盖（需后续补；调用方不得假设它们已生效）
 * 1. **向量/语义通道**：Android 无 embeddings，`semanticEnabled` 恒为 false；
 *    PC 的向量候选与 `vector_miss_lexical_fallback` 分支不参与。
 * 2. **词法（BM25）通道**：`ChatLorebookRetrieval` 已移植但本轮未接入触发管线，
 *    因此 RRF 只由关键词通道贡献。纯语义/词法条目在本实现下不会触发。
 * 3. **时效状态**（sticky / cooldown / delay）：未实现，因此这三类条目按普通关键词条目处理，
 *    `timedEffects` 不回传。
 * 4. **包含组仲裁**（inclusion group）：未实现，同组条目会全部触发而不是按权重择一。
 * 5. **诊断与影子快照**（`LoreTriggerDetail` / `scoredEntrySnapshots`）：未生成。
 * 6. **异步压缩请求**：预算层会给出 `compressionRequests` 并原样回传，但本层不代为压缩；
 *    压缩缓存命中注入的路径已生效。
 *
 * 以上 6 条都是**行为差异**而非崩溃风险；接入 `ChatContextBuilder` 时必须把 1–4 的
 * 语义差异写进报告，避免让人以为 Android 已与 PC 等价。
 */
object ChatLorebookRuntime {

    /** 语义死条目的判定所需：只支持语义通道却没有任何可用通道。 */
    private const val MAX_RECURSIVE_DEPTH_DEFAULT = 5

    /** 默认扫描深度（对齐 PC `chatConstants.DEFAULT_LOREBOOK_SCAN_DEPTH`）。 */
    const val DEFAULT_SCAN_DEPTH = 10

    /**
     * 解析激活世界书的扫描深度：存在显式配置时允许**低于**默认值。
     *
     * 历史修复（H-16）：早期实现把默认值当作 reduce 初值，等价于 `max(配置, 默认)`，
     * 用户把深度调小（如 2/4）会被静默抬回 10，导致条目过度触发。
     * 因此必须先收集配置值、全部为空时才回退默认。
     */
    fun resolveScanDepth(depths: List<Int?>, fallback: Int = DEFAULT_SCAN_DEPTH): Int {
        val valid = depths.filterNotNull().filter { it >= 0 }
        return if (valid.isNotEmpty()) valid.max() else fallback
    }

    data class Entry(
        val id: String,
        val content: String,
        val keywords: List<String> = emptyList(),
        val secondaryKeywords: List<String> = emptyList(),
        val selectiveLogic: String? = null,
        val useRegex: Boolean = false,
        val regexFlags: String? = null,
        val caseSensitive: Boolean = false,
        val matchWholeWords: Boolean = true,
        val enabled: Boolean = true,
        /** before_char | after_char | at_depth | at_end */
        val position: String = "before_char",
        val depth: Int? = null,
        val role: String? = null,
        /** always | conditional | detail */
        val priority: String? = null,
        val order: Int = 0,
        val summary: String? = null,
        val ignoreBudget: Boolean = false,
        /** 0–100，缺省 100（必然通过） */
        val probability: Double? = null,
        val preventRecursion: Boolean = false,
        val excludeRecursion: Boolean = false,
        /** 条目级扫描深度；缺省回退书级 */
        val scanDepth: Int? = null,
        val generationTriggers: List<String>? = null,
        val characterFilter: CharacterFilter? = null,
        val summaryEnabled: Boolean = true,
        /**
         * canonical 插入位置。提供时**优先于** `position/depth/role` 推导——
         * 渲染层据此分桶（before/after_character、示例、作者注释等锚点只能由它表达）。
         */
        val insertion: ChatLorebookBudget.Insertion? = null,
        /**
         * canonical v2 `activation.retrieval`（PC `loreEntryRetrievalMode` 的同名概念）：
         * `keyword` | `hybrid` | `semanticPreferred` | `semanticRequired`。
         *
         * **本字段目前不参与触发分流**：运行时的通道选择仍只有关键词一条路，
         * 由 `ChatLorebookChannels` 记录「模式要求什么通道 / 本机有什么通道」的差异。
         * 带上它的意义是让这件事**可被说出**——此前 `ChatLorebookCompile` 的注释声称
         * 把 `retrieval` 映成 `matchMode`，实际却从未读过这个字段，于是
         * 「PC 走词法兜底、本机一条通道都没有」的条目既不会触发也没有任何读数。
         * 阶段 6 S6-05 实现向量/词法通道后，本字段才会成为真正的分流依据。
         */
        val retrieval: String = "keyword",
    ) {
        fun toScoringEntry(): ChatLorebookScoring.Entry = ChatLorebookScoring.Entry(
            content = content,
            keywords = keywords,
            secondaryKeywords = secondaryKeywords,
            selectiveLogic = selectiveLogic,
            useRegex = useRegex,
            regexFlags = regexFlags,
            caseSensitive = caseSensitive,
            matchWholeWords = matchWholeWords,
            enabled = enabled,
        )
    }

    data class CharacterFilter(
        val names: List<String> = emptyList(),
        val tags: List<String> = emptyList(),
        val exclude: Boolean = false,
    )

    data class Book(
        val id: String,
        val name: String,
        val entries: List<Entry> = emptyList(),
        val enabled: Boolean = true,
        val scanDepth: Int? = null,
        val tokenBudget: Int? = null,
        /** PC 默认递归扫描（`recursiveScanning !== false`） */
        val recursiveScanning: Boolean = true,
    )

    data class DepthItem(val content: String, val order: Int, val depth: Int, val role: String?)

    data class Result(
        /** 角色定义前（常驻 → 条件 → 细节的顺序由预算层保证） */
        val beforeChar: List<String>,
        val afterChar: List<String>,
        val atEnd: List<String>,
        val atDepth: List<DepthItem>,
        /** 实际触发的条目数（合并去重后、裁剪前） */
        val triggeredCount: Int,
        /** 因预算不足被丢弃的条目数（内容去重跳过的不计入） */
        val droppedCount: Int,
        val alwaysDropped: Int = 0,
        val conditionalDropped: Int = 0,
        val detailDropped: Int = 0,
        /** 书级预算丢弃数：PC 语义为「0 则缺省」（其余三个丢弃计数则如实为 0） */
        val bookBudgetDropped: Int? = null,
        /** 本轮触发（去重后）的条目 key，供调用方更新会话 recency 窗口 */
        val triggeredEntryKeys: List<String> = emptyList(),
        val compressionRequests: List<ChatLorebookBudget.CompressionRequest> = emptyList(),
        val compressionCacheHitKeys: List<String> = emptyList(),
        /**
         * 预算裁剪后最终保留的条目（含插入位置）。
         *
         * 调用方需要它来走**统一渲染器**：PC 的 `contextBuilder` 并不直接使用
         * `beforeChar/afterChar/atEnd/atDepth`，而是把这些条目交给
         * `renderLorebookItems` 得到 `renderPlan`（含 before/after_character、
         * prompt_end、chat depth、示例与作者注释各桶），再落位到消息数组。
         * 因此这里必须透出 kept，否则两端的落位语义会不一致。
         */
        val kept: List<ChatLorebookBudget.Item> = emptyList(),
    )

    data class Input(
        val lorebooks: List<Book>,
        val scanText: String,
        /** 逐条消息文本（窗口按扫描深度切片）；为 null 时退化为只用 scanText */
        val scanMessages: List<String>? = null,
        val userName: String = "",
        val charName: String = "",
        val characterNames: List<String> = emptyList(),
        val characterTags: List<String> = emptyList(),
        val generationType: String = "normal",
        val messageCount: Int? = null,
        val budget: Int,
        val model: String,
        val maxRecursiveDepth: Int = MAX_RECURSIVE_DEPTH_DEFAULT,
        val entityVocabulary: List<String> = emptyList(),
        val recentTriggeredIds: List<List<String>>? = null,
        val compressionCache: Map<String, ChatLorebookBudget.CompressionCacheEntry> = emptyMap(),
        /** Android 无 embeddings：恒为 false */
        val semanticEnabled: Boolean = false,
        /** 可注入随机源（概率判定）；缺省直接用 `Math.random` 等价物 */
        val random: () -> Double = { Math.random() },
    )

    fun execute(input: Input): Result {
        val cleanScanText = ChatLorebookScoring.stripMarkdownNoise(input.scanText)
        val cleanScanMessages = input.scanMessages?.map { ChatLorebookScoring.stripMarkdownNoise(it) }

        val triggerable = mutableListOf<TriggerableEntry>()
        val entriesByKey = linkedMapOf<String, ChatLorebookScoring.Entry>()
        val lbIdByKey = linkedMapOf<String, String>()
        val bookBudgets = linkedMapOf<String, Int>()
        val contextNames = normalizedSet(input.characterNames.ifEmpty { listOf(input.charName) })
        val contextTags = normalizedSet(input.characterTags)

        for (book in input.lorebooks) {
            if (!book.enabled) continue
            val bookScanDepth = book.scanDepth?.takeIf { it >= 0 }?.let { kotlin.math.floor(it.toDouble()).toInt() }
            for (entry in book.entries) {
                if (!entry.enabled) continue
                val key = "${book.id}:${entry.id}"
                entriesByKey[key] = entry.toScoringEntry()
                lbIdByKey[key] = book.id
                triggerable += TriggerableEntry(book.id, book.name, entry, bookScanDepth, book.recursiveScanning)
                // 书级 tokenBudget（导入的外部格式自带）在书第一次出现时登记即可
            }
            book.tokenBudget?.takeIf { it > 0 }?.let { bookBudgets[book.id] = kotlin.math.floor(it.toDouble()).toInt() }
        }

        val triggeredIds = mutableSetOf<String>()
        val failedProbabilityChecks = mutableSetOf<String>()
        val triggeredItems = mutableListOf<ChatLorebookBudget.Item>()
        val keywordSignalByKey = linkedMapOf<String, Pair<Double, Int>>()
        var recursionText = ""

        var depth = 0
        while (depth < input.maxRecursiveDepth) {
            val candidates = mutableListOf<Candidate>()
            for (item in triggerable) {
                val key = "${item.bookId}:${item.entry.id}"
                if (triggeredIds.contains(key) || failedProbabilityChecks.contains(key)) continue
                if (contextBlockReason(item.entry, input.generationType, contextNames, contextTags) != null) continue
                // 时效状态未实现：delay / cooldown / excludeRecursion / delayUntilRecursion 均不生效
                val baseText = scanTextFor(item.entry, item.bookScanDepth, cleanScanText, cleanScanMessages)
                val scanAtDepth = if (recursionText.isNotEmpty()) "$baseText $recursionText".trim() else baseText
                val scanAtDepthLower = scanAtDepth.lowercase()
                val entryKeywords = item.entry.keywords
                val keywordChannelPresent = entryKeywords.any { it.isNotBlank() }

                val primaryMatches = if (keywordChannelPresent) {
                    entryKeywords.filter { keyword ->
                        keyword.isNotEmpty() &&
                            ChatLorebookScoring.entryKeywordMatch(
                                item.entry.toScoringEntry(),
                                keyword,
                                scanAtDepth,
                                scanAtDepthLower,
                            )
                    }
                } else {
                    emptyList()
                }
                val keywordMatched = primaryMatches.isNotEmpty()
                var activationScore = primaryMatches.size.toDouble()
                val matched = item.entry.priority == "always" || keywordMatched
                if (!matched) continue

                // ST constant：always 不参与二级关键词过滤
                if (item.entry.priority != "always" &&
                    !ChatLorebookScoring.entrySecondaryMatch(item.entry.toScoringEntry(), scanAtDepth, scanAtDepthLower)
                ) {
                    continue
                }
                if (keywordMatched) {
                    val previous = keywordSignalByKey[key]
                    if (previous == null || activationScore > previous.first) {
                        keywordSignalByKey[key] = activationScore to item.entry.order
                    }
                }
                candidates += Candidate(item, key, activationScore)
            }

            // 包含组仲裁未实现：候选原样通过（同组条目会全部触发）
            var appendedRecursion = false
            for (candidate in candidates) {
                val entry = candidate.triggerable.entry
                val key = candidate.key
                val probability = (entry.probability ?: 100.0).coerceIn(0.0, 100.0)
                if (probability < 100.0 && input.random() * 100 >= probability) {
                    failedProbabilityChecks += key
                    continue
                }
                triggeredIds += key

                val content = transformEntryText(entry.content, input.userName, input.charName)
                val summary = entry.summary?.trim()?.takeIf { it.isNotEmpty() }
                    ?.let { transformEntryText(it, input.userName, input.charName) }
                triggeredItems += ChatLorebookBudget.Item(
                    content = content,
                    order = entry.order,
                    position = entry.position,
                    depth = if (entry.position == "at_depth") (entry.depth ?: 0) else null,
                    role = if (entry.position == "at_depth") entry.role else null,
                    priority = entry.priority,
                    key = key,
                    summary = summary,
                    ignoreBudget = entry.ignoreBudget,
                    insertion = entry.insertion,
                )

                if (candidate.triggerable.recursiveScanning && !entry.preventRecursion) {
                    recursionText = if (recursionText.isEmpty()) content else "$recursionText $content"
                    appendedRecursion = true
                }
            }
            if (!appendedRecursion) break
            depth++
        }

        // 全局内容去重：先到先得（与 PC 同序）
        val seen = mutableSetOf<String>()
        val deduped = mutableListOf<ChatLorebookBudget.Item>()
        for (item in triggeredItems) {
            if (seen.contains(item.content)) continue
            seen += item.content
            deduped += item
        }

        // 关键词通道 RRF（向量/词法通道本轮不接入，故只有关键词通道贡献）
        val triggeredKeys = deduped.mapNotNull { it.key }.toSet()
        val keywordChannel = keywordSignalByKey.entries
            .filter { triggeredKeys.contains(it.key) }
            .sortedWith(compareByDescending<Map.Entry<String, Pair<Double, Int>>> { it.value.first }.thenBy { it.value.second })
            .map { it.key to it.value.first }
        // PC 用 keyword/vector/lexical 三通道；Android 本轮只接入关键词通道
        // （向量无 embeddings、词法未接线），因此这里是单通道融合——语义上等价于
        // PC 在另外两通道为空时的结果。
        val fused = ChatLorebookRetrieval.reciprocalRankFusion(
            mapOf(
                "keyword" to keywordChannel.map { (key, score) -> ChatLorebookRetrieval.RankedHit(key, score) },
            ),
        )
        val fusionScoreByKey = fused.associate { it.key to it.normalizedScore }
        val keywordRankByKey = keywordChannel.mapIndexed { index, (key, _) -> key to index + 1 }.toMap()
        val fusedItems = deduped.map { item ->
            val key = item.key
            if (key == null) {
                item
            } else {
                item.copy(
                    fusionScore = fusionScoreByKey[key],
                    keywordRank = keywordRankByKey[key],
                )
            }
        }

        // 统一评分
        val recentText = if (recursionText.isNotEmpty()) "$cleanScanText $recursionText" else cleanScanText
        val scanTextLower = recentText.lowercase()
        val semanticScoreByContent = mutableMapOf<String, Double>()
        for (item in fusedItems) {
            val score = item.score
            if (score != null && score.isFinite()) {
                val previous = semanticScoreByContent[item.content]
                if (previous == null || score > previous) semanticScoreByContent[item.content] = score
            }
        }
        val scored = ChatLorebookScoring.scoreItems(
            fusedItems,
            ChatLorebookScoring.ScoreContext(
                scanText = recentText,
                scanTextLower = scanTextLower,
                dialogueText = cleanScanText,
                dialogueTextLower = cleanScanText.lowercase(),
                entriesByKey = entriesByKey,
                semanticScoreByContent = semanticScoreByContent,
                recentEntities = ChatLorebookScoring.extractEntities(
                    scanTextLower = scanTextLower,
                    charName = input.charName,
                    entityVocabulary = input.entityVocabulary,
                    lorebooks = input.lorebooks.map { it.enabled to it.entries.map { entry -> entry.toScoringEntry() } },
                ),
                recentTriggered = (input.recentTriggeredIds ?: emptyList())
                    .takeLast(ChatLorebookScoring.RECENCY_WINDOW)
                    .flatten()
                    .toSet(),
            ),
        ).map { it.toBudgetItem() }

        // 书级 cap：cap = min(书级预算, 全局配额按书级预算比例的份额)
        val allocatedQuotas = ChatLorebookBudget.allocateGlobalBudgetByBooks(input.budget, bookBudgets)
        val bookCaps = linkedMapOf<String, Int>()
        if (allocatedQuotas != null) {
            for ((lbId, bookBudget) in bookBudgets) {
                val quota = allocatedQuotas[lbId] ?: bookBudget
                bookCaps[lbId] = minOf(bookBudget, quota)
            }
        }
        val bookFitted = ChatLorebookBudget.enforceBookBudgets(scored, bookCaps, lbIdByKey, input.model)

        // 分桶瀑布裁剪
        val fitted = ChatLorebookBudget.fitByPriority(
            bookFitted.items,
            input.budget,
            input.model,
            input.compressionCache,
        )

        val result = distribute(fitted.kept)
        // PC 语义：triggeredCount / triggeredEntryKeys 都在**预算裁剪之前**（去重后），
        // 供调用方更新会话 recency 窗口；droppedCount 是各类丢弃数之和。
        return result.copy(
            triggeredCount = deduped.size,
            droppedCount = fitted.alwaysDropped + fitted.conditionalDropped +
                fitted.detailDropped + bookFitted.dropped,
            alwaysDropped = fitted.alwaysDropped,
            conditionalDropped = fitted.conditionalDropped,
            detailDropped = fitted.detailDropped,
            bookBudgetDropped = bookFitted.dropped.takeIf { it > 0 },
            triggeredEntryKeys = deduped.mapNotNull { it.key },
            compressionRequests = fitted.compressionRequests,
            compressionCacheHitKeys = fitted.compressionCacheHitKeys,
            kept = fitted.kept,
        )
    }

    private data class TriggerableEntry(
        val bookId: String,
        val bookName: String,
        val entry: Entry,
        val bookScanDepth: Int?,
        val recursiveScanning: Boolean,
    )

    private data class Candidate(val triggerable: TriggerableEntry, val key: String, val activationScore: Double)

    private fun normalizedSet(values: List<String>): Set<String> =
        values.mapNotNull { it.trim().lowercase().takeIf { trimmed -> trimmed.isNotEmpty() } }.toSet()

    /**
     * 条目有效扫描文本：
     * - 无逐条消息时用 `fallback`（整体扫描文本）；
     * - 有逐条消息但**未配置扫描深度**时也用 `fallback`（扫描全部对话）；
     * - 配置了深度时只取最近 N 条；N = 0 则为空串（该条目只能靠 always/概率触发）。
     */
    private fun scanTextFor(entry: Entry, bookScanDepth: Int?, fallback: String, messages: List<String>?): String {
        if (messages == null) return fallback
        val configuredDepth = entry.scanDepth ?: bookScanDepth
        if (configuredDepth == null) return fallback
        val depth = maxOf(0, kotlin.math.floor(configuredDepth.toDouble()).toInt())
        return if (depth == 0) "" else messages.takeLast(depth).joinToString(" ")
    }

    /** 资格过滤原因（本轮只判定生成类型与角色过滤）。 */
    private fun contextBlockReason(
        entry: Entry,
        generationType: String,
        characterNames: Set<String>,
        characterTags: Set<String>,
    ): String? {
        val triggers = entry.generationTriggers
        if (!triggers.isNullOrEmpty() && !triggers.contains(generationType)) return "generation_filter"
        val filter = entry.characterFilter
        if (filter == null) return null
        if (!contextAllowed(entry, generationType, characterNames, characterTags)) return "character_filter"
        return null
    }

    private fun contextAllowed(
        entry: Entry,
        generationType: String,
        characterNames: Set<String>,
        characterTags: Set<String>,
    ): Boolean {
        val triggers = entry.generationTriggers
        if (!triggers.isNullOrEmpty() && !triggers.contains(generationType)) return false
        val filter = entry.characterFilter ?: return true
        val nameMatched = filter.names.any { characterNames.contains(it.trim().lowercase()) }
        val tagMatched = filter.tags.any { characterTags.contains(it.trim().lowercase()) }
        if (filter.exclude) return !nameMatched && !tagMatched
        if (filter.names.isNotEmpty() && !nameMatched) return false
        if (filter.tags.isNotEmpty() && !tagMatched) return false
        return true
    }

    /** 条目正文的变量替换（与渲染层同口径，只替换用户名与角色名）。 */
    private fun transformEntryText(text: String, userName: String, charName: String): String =
        ChatVariables.replaceVariables(text, userName, charName)

    /** 按插入位置分发（filter 保序）。 */
    private fun distribute(items: List<ChatLorebookBudget.Item>): Result {
        val beforeChar = mutableListOf<String>()
        val afterChar = mutableListOf<String>()
        val atEnd = mutableListOf<String>()
        val atDepth = mutableListOf<DepthItem>()
        for (item in items) {
            when (item.position) {
                "before_char" -> beforeChar += item.content
                "after_char" -> afterChar += item.content
                "at_depth" -> atDepth += DepthItem(
                    content = item.content,
                    order = item.order,
                    depth = item.depth ?: 0,
                    role = item.role,
                )
                else -> atEnd += item.content
            }
        }
        return Result(
            beforeChar = beforeChar,
            afterChar = afterChar,
            atEnd = atEnd,
            atDepth = atDepth,
            triggeredCount = items.size,
            droppedCount = 0,
        )
    }
}
