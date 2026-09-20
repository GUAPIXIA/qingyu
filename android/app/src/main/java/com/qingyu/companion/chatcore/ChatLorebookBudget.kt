package com.qingyu.companion.chatcore

/**
 * 阶段 4 A3b-2（地基）：世界书运行时预算与分配
 * （对齐 `shared/chat-core/lorebook.ts` 的 fit/budget 层，2153 行中的纯函数部分）。
 *
 * 这一层决定「哪些世界书条目最终被注入、以全文还是摘要、以及要不要发起压缩请求」。
 * 它不依赖 IO、不依赖会话状态，因此可以逐字节与 PC 对齐并 fixture 锁定。
 *
 * 分桶瀑布裁剪的语义（PC 原注释保留）：
 * - **always**：硬上限 40%（超限按 order 截断；不参与压缩）
 * - **conditional**：全文按 score 降序填充至「always + conditional 累计 ≤ 90%」
 *   （本轮无 detail 条目触发时不预留额度，conditional 可用满预算）
 * - **detail**：全文填充剩余额度
 * 各段被丢弃的条目先尝试手写 summary 替代（零成本），仍被丢弃的集合按注入位置查压缩缓存，
 * 未命中时发出 compressionRequests 供调用方异步压缩（下一轮生效）。
 *
 * 桶内排序：always 按 order 升序；conditional / detail 按 score 降序、同分按 order 升序。
 */
object ChatLorebookBudget {

    /** 优先级额度（对齐 PC `chatConstants.LOREBOOK_PRIORITY_BUDGET`）。 */
    const val ALWAYS_RATIO = 0.4
    const val ALWAYS_PLUS_CONDITIONAL_RATIO = 0.9

    /** 压缩缓存上限（按最近使用时间 LRU 淘汰）。 */
    const val COMPRESSION_CACHE_MAX_ENTRIES = 10

    /** 压缩目标下限：剩余预算过小时压缩无意义，跳过请求。 */
    const val MIN_COMPRESS_TARGET_TOKENS = 32

    /** 插入位置（对应 `LorebookInsertionV2` 的可辨识联合）。 */
    sealed interface Insertion {
        /** prompt 侧锚点：before_character / after_character / prompt_end */
        data class Prompt(val anchor: String) : Insertion

        /** 对话内按深度注入 */
        data class Chat(val depth: Int, val role: String? = null) : Insertion
    }

    data class Item(
        val content: String,
        val order: Int,
        /** before_char | after_char | at_depth | at_end */
        val position: String,
        val depth: Int? = null,
        /** always | conditional | detail（null 视为 conditional） */
        val priority: String? = null,
        val score: Double? = null,
        val key: String? = null,
        /** 手写摘要（变量替换后；预算紧张时代替全文注入） */
        val summary: String? = null,
        val ignoreBudget: Boolean = false,
        val role: String? = null,
        val insertion: Insertion? = null,
        /** 三通道 RRF 归一化分数（0-1）；评分时优先于语义分数参与 semantic 维度 */
        val fusionScore: Double? = null,
        /** 关键词通道排名（RRF 用） */
        val keywordRank: Int? = null,
        val lexicalRank: Int? = null,
        val lexicalScore: Double? = null,
        val vectorRank: Int? = null,
        val vectorScore: Double? = null,
        val fallbackReason: String? = null,
    )

    fun legacyInsertion(position: String, depth: Int?, role: String?): Insertion = when (position) {
        "before_char" -> Insertion.Prompt("before_character")
        "after_char" -> Insertion.Prompt("after_character")
        "at_depth" -> Insertion.Chat(depth = maxOf(0, depth ?: 0), role = role)
        else -> Insertion.Prompt("prompt_end")
    }

    fun loreItemInsertion(item: Item): Insertion =
        item.insertion ?: legacyInsertion(item.position, item.depth, item.role)

    /**
     * 位置分组键。
     * PC 用 `JSON.stringify(insertion)`；这里只要求**等价分组**（同一插入位置得到同一键），
     * 因此用显式编码而不是依赖 JSON 键序。
     */
    fun placementKey(item: Item): String = when (val insertion = loreItemInsertion(item)) {
        is Insertion.Prompt -> "prompt:${insertion.anchor}"
        is Insertion.Chat -> "chat:${insertion.depth}:${insertion.role ?: ""}"
    }

    /**
     * 单桶内贪心填充：按传入顺序注入（调用方已排序），超出预算的条目丢弃
     * （继续尝试后面更小的条目）。`ignoreBudget` 条目直接保留且不计入用量。
     */
    fun fitGreedy(items: List<Item>, budget: Int, model: String): FitResult {
        val kept = mutableListOf<Item>()
        val dropped = mutableListOf<Item>()
        var used = 0
        for (item in items) {
            if (item.ignoreBudget) {
                kept += item
                continue
            }
            val tokens = ChatTokenCounter.estimateTokens(item.content, model)
            if (used + tokens > budget) {
                dropped += item
                continue
            }
            kept += item
            used += tokens
        }
        return FitResult(kept, dropped, used)
    }

    data class FitResult(val kept: List<Item>, val dropped: List<Item>, val usedTokens: Int)

    /**
     * 相关度优先填充：每个条目按排序依次尝试「全文 → 手写摘要」。
     * 避免低分短全文先占满预算，导致更高分条目的摘要反而无法注入。
     */
    fun fitRankedWithSummaries(items: List<Item>, budget: Int, model: String): FitResult {
        val kept = mutableListOf<Item>()
        val dropped = mutableListOf<Item>()
        var usedTokens = 0
        for (item in items) {
            if (item.ignoreBudget) {
                kept += item
                continue
            }
            val fullTokens = ChatTokenCounter.estimateTokens(item.content, model)
            if (usedTokens + fullTokens <= budget) {
                kept += item
                usedTokens += fullTokens
                continue
            }
            val summary = item.summary?.trim().orEmpty()
            if (summary.isNotEmpty()) {
                val summaryTokens = ChatTokenCounter.estimateTokens(summary, model)
                if (usedTokens + summaryTokens <= budget) {
                    kept += item.copy(content = summary)
                    usedTokens += summaryTokens
                    continue
                }
            }
            dropped += item
        }
        return FitResult(kept, dropped, usedTokens)
    }

    data class CompressionRequest(
        val key: String,
        val entryKeys: List<String>,
        val contents: List<String>,
        val targetTokens: Int,
        val placement: Insertion,
    )

    data class Placement(
        val position: String,
        val depth: Int? = null,
        val insertion: Insertion? = null,
        /** 三通道 RRF 归一化分数（0-1）；评分时优先于语义分数参与 semantic 维度 */
        val fusionScore: Double? = null,
        /** 关键词通道排名（RRF 用） */
        val keywordRank: Int? = null,
        val lexicalRank: Int? = null,
        val lexicalScore: Double? = null,
        val vectorRank: Int? = null,
        val vectorScore: Double? = null,
        val fallbackReason: String? = null,
    )

    data class BudgetResult(
        val kept: List<Item>,
        val droppedItems: List<Item>,
        val compressionCoveredItems: List<Item>,
        val usedTokens: Int,
        val alwaysDropped: Int,
        val conditionalDropped: Int,
        val detailDropped: Int,
        val compressionRequests: List<CompressionRequest> = emptyList(),
        val compressionCacheHitKeys: List<String> = emptyList(),
    )

    /**
     * 分桶瀑布裁剪。
     *
     * `compressionCache` 为「压缩键 → 缓存条目」；Android 侧从会话行读取。
     *
     * **关于 `score` 为 null 的排序**：PC 的比较器 `b.score - a.score` 在任一侧为 `undefined`
     * 时返回 `NaN`，而 ECMAScript 规范把 `NaN` 比较结果视为 **+0（相等）**，
     * 于是这类条目**保持原顺序**；这里按 `0.0` 排序会把它们排到末尾。
     * 生产类型 `ScoredLoreItem.score` 是必填数值，因此该差异不可达；
     * 夹具也刻意不覆盖它（一旦将来 score 变成可选，这里必须同步修改）。
     */
    fun fitByPriority(
        items: List<Item>,
        budget: Int,
        model: String,
        compressionCache: Map<String, CompressionCacheEntry> = emptyMap(),
    ): BudgetResult {
        // 未识别的 priority 值一并落入 conditional（安全默认）
        fun isAlways(item: Item) = item.priority == "always"
        fun isDetail(item: Item) = item.priority == "detail"
        fun isConditional(item: Item) = !isAlways(item) && !isDetail(item)

        val alwaysCap = kotlin.math.floor(budget * ALWAYS_RATIO).toInt()
        val conditionalCumCap = if (items.any { isDetail(it) }) {
            kotlin.math.floor(budget * ALWAYS_PLUS_CONDITIONAL_RATIO).toInt()
        } else {
            budget
        }

        // 1. always：全量注入（order 升序），不参与压缩
        val alwaysResult = fitGreedy(
            items.filter { isAlways(it) }.sortedBy { it.order },
            alwaysCap,
            model,
        )

        // 2. conditional：按相关度逐条尝试全文 → 手写摘要
        val conditionalResult = fitRankedWithSummaries(
            items.filter { isConditional(it) }.sortedWith(compareByDescending<Item> { it.score ?: 0.0 }.thenBy { it.order }),
            maxOf(0, conditionalCumCap - alwaysResult.usedTokens),
            model,
        )

        // 3. detail：使用总预算剩余部分，同样逐条尝试全文 → 手写摘要
        var used = alwaysResult.usedTokens + conditionalResult.usedTokens
        val detailResult = fitRankedWithSummaries(
            items.filter { isDetail(it) }.sortedWith(compareByDescending<Item> { it.score ?: 0.0 }.thenBy { it.order }),
            maxOf(0, budget - used),
            model,
        )
        used += detailResult.usedTokens

        // 4. 按注入位置分组查缓存/请求压缩，绝不跨注入位置合并
        val dropped = conditionalResult.dropped + detailResult.dropped
        val groups = linkedMapOf<String, MutableList<Item>>()
        for (item in dropped) {
            groups.getOrPut(placementKey(item)) { mutableListOf() } += item
        }

        val cacheItems = mutableListOf<Item>()
        val covered = mutableSetOf<Item>()
        val compressionCacheHitKeys = mutableListOf<String>()
        val pendingGroups = mutableListOf<PendingGroup>()

        for (groupItems in groups.values) {
            val key = buildCompressionKey(groupItems)
            val cached = compressionCache[key]
            val remainingBudget = maxOf(0, budget - used)
            val cachedSummary = cached?.summary?.trim().orEmpty()
            if (cachedSummary.isNotEmpty() &&
                ChatTokenCounter.estimateTokens(cachedSummary, model) <= remainingBudget
            ) {
                val first = groupItems[0]
                cacheItems += Item(
                    content = cachedSummary,
                    order = first.order,
                    position = first.position,
                    depth = first.depth,
                    priority = first.priority,
                    insertion = loreItemInsertion(first),
                )
                used += ChatTokenCounter.estimateTokens(cachedSummary, model)
                covered += groupItems
                compressionCacheHitKeys += key
                continue
            }
            pendingGroups += PendingGroup(
                items = groupItems,
                key = key,
                weight = groupItems.sumOf { ChatTokenCounter.estimateTokens(it.content, model) },
            )
        }

        // 将剩余预算按各位置组原始 token 占比分配，保证下一轮所有缓存同时命中也不超总预算
        var allocatable = maxOf(0, budget - used)
        var remainingWeight = pendingGroups.sumOf { it.weight }
        val compressionRequests = mutableListOf<CompressionRequest>()
        for (index in pendingGroups.indices) {
            val group = pendingGroups[index]
            val targetTokens = if (index == pendingGroups.size - 1) {
                allocatable
            } else {
                kotlin.math.floor(allocatable.toDouble() * (group.weight.toDouble() / maxOf(1, remainingWeight))).toInt()
            }
            remainingWeight -= group.weight
            if (targetTokens < MIN_COMPRESS_TARGET_TOKENS) continue
            allocatable -= targetTokens
            val first = group.items[0]
            compressionRequests += CompressionRequest(
                key = group.key,
                entryKeys = group.items.mapNotNull { it.key },
                contents = group.items.map { it.content },
                targetTokens = targetTokens,
                placement = loreItemInsertion(first),
            )
        }

        val remainingDropped = dropped.filter { !covered.contains(it) }

        return BudgetResult(
            kept = alwaysResult.kept + conditionalResult.kept + detailResult.kept + cacheItems,
            droppedItems = remainingDropped,
            compressionCoveredItems = covered.toList(),
            usedTokens = used,
            alwaysDropped = alwaysResult.dropped.size,
            conditionalDropped = remainingDropped.count { isConditional(it) },
            detailDropped = remainingDropped.count { isDetail(it) },
            compressionRequests = compressionRequests.toList(),
            compressionCacheHitKeys = compressionCacheHitKeys.toList(),
        )
    }

    private data class PendingGroup(val items: List<Item>, val key: String, val weight: Int)

    /**
     * 多书预算配额分配：部分书带 tokenBudget、部分不带时，未带书无信号按带书配额的平均值对待。
     * 总配额不超全局预算时足额分配；超出时按配额比例分配，最后一份吃剩余误差。
     * 全部书都不带预算时返回 null（调用方跳过配额步骤）。
     */
    fun allocateGlobalBudgetByBooks(globalBudget: Int, bookBudgets: Map<String, Int>): Map<String, Int>? {
        if (bookBudgets.isEmpty()) return null
        val ownedBudgets = bookBudgets.values.filter { it > 0 }
        // 无预算书按带预算书的平均值对待
        val average = if (ownedBudgets.isNotEmpty()) {
            ownedBudgets.sum().toDouble() / ownedBudgets.size
        } else {
            0.0
        }
        val quotas = linkedMapOf<String, Double>()
        var totalQuota = 0.0
        for ((lbId, budget) in bookBudgets) {
            val quota = if (budget > 0) budget.toDouble() else average
            quotas[lbId] = quota
            totalQuota += quota
        }
        // 配额充裕（含全部预算为 0）：足额分配
        if (totalQuota <= globalBudget) {
            return quotas.mapValues { kotlin.math.floor(it.value).toInt() }.toMap(linkedMapOf())
        }
        // 超出：按比例分配，最后一份吃剩余
        val allocated = linkedMapOf<String, Int>()
        var remaining = globalBudget
        val entries = quotas.entries.toList()
        for (index in entries.indices) {
            val (lbId, quota) = entries[index]
            val share = if (index == entries.size - 1) {
                remaining
            } else {
                maxOf(0, kotlin.math.floor(globalBudget.toDouble() * (quota / totalQuota)).toInt())
            }
            allocated[lbId] = share
            remaining = maxOf(0, remaining - share)
        }
        return allocated
    }

    data class BookEnforcement(
        val items: List<Item>,
        val dropped: Int,
        val droppedItems: List<Item>,
    )

    /**
     * 书级 tokenBudget 裁剪（Risu character_book / 外部格式导入语义）：
     * 每本书注入的 token 总量不超过该书 cap（优先保高分条目，
     * 超限条目先尝试手写 summary 替代，与全局裁剪策略一致）。
     * - cap 未定义的书不受额外限制（仍受全局预算约束）
     * - `ignoreBudget` 条目不占书级预算
     * - 保留原始条目顺序（仅替换/移除，不重排）
     */
    fun enforceBookBudgets(
        items: List<Item>,
        bookCaps: Map<String, Int>,
        lbIdByKey: Map<String, String>,
        model: String,
    ): BookEnforcement {
        val perBook = linkedMapOf<String, MutableList<Item>>()
        for (item in items) {
            val lbId = item.key?.let { lbIdByKey[it] }
            if (lbId == null || item.ignoreBudget || !bookCaps.containsKey(lbId)) continue
            perBook.getOrPut(lbId) { mutableListOf() } += item
        }
        if (perBook.isEmpty()) return BookEnforcement(items, 0, emptyList())

        val replacements = mutableMapOf<Item, Item>()
        val droppedSet = mutableSetOf<Item>()
        for ((lbId, list) in perBook) {
            val cap = bookCaps.getValue(lbId)
            var used = 0
            for (item in list.sortedWith(compareByDescending<Item> { it.score ?: 0.0 }.thenBy { it.order })) {
                val fullTokens = ChatTokenCounter.estimateTokens(item.content, model)
                if (used + fullTokens <= cap) {
                    used += fullTokens
                    continue
                }
                val summary = item.summary?.trim().orEmpty()
                if (summary.isNotEmpty()) {
                    val summaryTokens = ChatTokenCounter.estimateTokens(summary, model)
                    if (used + summaryTokens <= cap) {
                        used += summaryTokens
                        replacements[item] = item.copy(content = summary)
                        continue
                    }
                }
                droppedSet += item
            }
        }
        return BookEnforcement(
            items = items.filter { !droppedSet.contains(it) }.map { replacements[it] ?: it },
            dropped = droppedSet.size,
            droppedItems = droppedSet.toList(),
        )
    }

    /** FNV-1a 32 位字符串哈希（压缩缓存 key 用，无需密码学强度）。与 PC 逐位一致。 */
    fun hashString(text: String): String {
        var h = 0x811c9dc5.toInt()
        for (ch in text) {
            h = h xor ch.code
            h *= 0x01000193
        }
        // JS 是 `(h >>> 0).toString(36)`：转成无符号后取 36 进制（小写）
        return h.toUInt().toString(36)
    }

    /** 压缩缓存 key：条目 key + content hash 排序拼接（条目编辑后 key 变化，缓存天然失效）。 */
    fun buildCompressionKey(items: List<Item>): String =
        items.map { "${it.key ?: ""}:${hashString(it.content)}" }.sorted().joinToString(";")

    data class CompressionCacheEntry(
        val summary: String,
        val createdAt: Long,
        val lastUsedAt: Long? = null,
    )

    /** 写入压缩缓存（按 lastUsedAt/createdAt 淘汰最久未使用条目，保持上限）。 */
    fun upsertCompressionCache(
        cache: Map<String, CompressionCacheEntry>?,
        key: String,
        entry: CompressionCacheEntry,
        maxEntries: Int = COMPRESSION_CACHE_MAX_ENTRIES,
    ): Map<String, CompressionCacheEntry> {
        val next = linkedMapOf<String, CompressionCacheEntry>()
        cache?.let { next.putAll(it) }
        next[key] = entry
        if (next.size > maxEntries) {
            val oldest = next.keys.sortedBy { next[it]?.let { e -> e.lastUsedAt ?: e.createdAt } ?: 0L }
            for (k in oldest.take(next.size - maxEntries)) next.remove(k)
        }
        return next
    }

    /** 刷新已命中压缩缓存的 LRU 时间，不改变摘要内容。 */
    fun touchCompressionCache(
        cache: Map<String, CompressionCacheEntry>?,
        keys: List<String>,
        usedAt: Long,
    ): Map<String, CompressionCacheEntry>? {
        if (cache == null || keys.isEmpty()) return cache
        val hitKeys = keys.toSet()
        var changed = false
        val next = linkedMapOf<String, CompressionCacheEntry>()
        for ((key, entry) in cache) {
            if (hitKeys.contains(key)) {
                next[key] = entry.copy(lastUsedAt = usedAt)
                changed = true
            } else {
                next[key] = entry
            }
        }
        return if (changed) next else cache
    }
}
