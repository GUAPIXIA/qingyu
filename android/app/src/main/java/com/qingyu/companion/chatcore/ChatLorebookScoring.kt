package com.qingyu.companion.chatcore

/**
 * 阶段 4 A3b-2：世界书触发匹配与统一评分
 * （对齐 `shared/chat-core/lorebook.ts` 的关键词匹配 / 语义近似 / 实体增强 / 统一评分层）。
 *
 * 这一层把「候选条目」变成「带分数的条目」，交给 [ChatLorebookBudget] 分桶裁剪。
 * 统一评分 = w_keyword×keywordHits + w_semantic×semanticScore + w_entity×entityBoost + w_recency×recencyBoost。
 *
 * 关键词匹配的边界语义刻意与 PC 一致（避免误触发）：
 * - 纯 ASCII 关键词：词边界匹配（`cat` 不应命中 `category`）
 * - 含 CJK 且长度 ≥ 2：子串匹配（中文多字词误报率低，维持召回）
 * - CJK 单字：命中处前后必须是标点/空白/文本边界
 */
object ChatLorebookScoring {

    /** 统一评分权重（对齐 PC `chatConstants.LOREBOOK_SCORE_WEIGHTS`）。 */
    const val KEYWORD_WEIGHT = 0.35
    const val SEMANTIC_WEIGHT = 0.35
    const val ENTITY_WEIGHT = 0.15
    const val RECENCY_WEIGHT = 0.15

    /** 最近多少轮内触发过的条目获得 recency 加权。 */
    const val RECENCY_WINDOW = 5

    /** 频率计分的单关键词计数上限（防御超长文本下的循环开销）。 */
    const val KEYWORD_COUNT_MAX = 100

    /** 词面重叠近似的强度（= 语义权重满配 0.35/1.0）。 */
    const val OVERLAP_STRENGTH = 0.35

    /** JS `\s` 空白集合（JVM 默认 `\s` 只保证 ASCII，会让两端边界判定漂移）。 */
    private const val JS_SPACE_CLASS =
        "\\t\\n\\u000B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"

    /** CJK 单字关键词命中处的边界字符（标点/空白）。 */
    private val CJK_BOUNDARY = Regex("[$JS_SPACE_CLASS，。、；：！？…·—\"\"''（）【】《》〈〉「」『』,.!?;:()\\[\\]{}<>\"'|/\\\\-]")

    // ---------------------------------------------------------------- 去噪与转义

    /**
     * 剥离 Markdown 噪声（对话文本用）。递归触发的条目内容**不去噪**（那是世界书作者原文）。
     */
    fun stripMarkdownNoise(text: String): String {
        if (text.isEmpty()) return text
        var result = text
        // 1. 围栏代码块整体移除
        result = Regex("(```|~~~)[\\s\\S]*?\\1").replace(result, " ")
        // 2. 图片整体移除（先于链接，避免 ![]() 被当成链接保留 alt）
        result = Regex("!\\[[^\\]]*\\]\\([^)]*\\)").replace(result, " ")
        // 3. 链接保留文字
        result = Regex("\\[([^\\]]*)\\]\\([^)]*\\)").replace(result, "$1")
        // 4. HTML 标签移除
        result = Regex("</?[a-zA-Z][^>]*>").replace(result, " ")
        // 5. 行内代码去反引号
        result = Regex("`([^`\\n]*)`").replace(result, "$1")
        // 6. 粗体/删除线/斜体标记剥离（**x** / __x__ / ~~x~~ / *x* / _x_）
        result = Regex("(\\*\\*|__|~~)(?=\\S)([\\s\\S]*?\\S)\\1").replace(result, "$2")
        result = Regex("(?<![A-Za-z0-9_*])(\\*|_)(?=\\S)([^*_\\n]*?\\S)\\1(?![A-Za-z0-9_*])").replace(result, "$2")
        // 7. 行首标题/引用/列表/表格分隔符标记
        result = Regex(
            "^[ \\t]*(?:#{1,6}[ \\t]+|>[ \\t]?|[-*+][ \\t]+|[0-9]+[.)][ \\t]+|[|][-|: ]+[|])[ \\t]*",
            RegexOption.MULTILINE,
        ).replace(result, "")
        // 8. 水平分割线
        result = Regex("^[ \\t]*(?:-{3,}|\\*{3,}|_{3,})[ \\t]*$", RegexOption.MULTILINE).replace(result, " ")
        return result
    }

    /** 转义正则特殊字符。 */
    fun escapeRegExp(text: String): String {
        val builder = StringBuilder(text.length + 8)
        for (ch in text) {
            if (ch in ".*+?^\${}()|[]\\") {
                // 与 JS 的 `\\$&` 等价：在特殊字符前插入反斜杠
                builder.append('\\')
            }
            builder.append(ch)
        }
        return builder.toString()
    }

    private fun isAsciiOnly(text: String): Boolean = text.all { it.code < 128 }

    private fun isWordChar(ch: Char): Boolean = ch == '_' || ch.isLetterOrDigit()

    private fun isCjkChar(ch: Char): Boolean {
        val code = ch.code
        return (code in 0x4E00..0x9FFF) || (code in 0x3400..0x4DBF) || (code in 0xF900..0xFAFF)
    }

    // ---------------------------------------------------------------- 关键词匹配

    /**
     * 普通关键词匹配（词边界感知）。
     * `textLower` 必须是已转小写的扫描文本。
     */
    fun keywordMatch(keyword: String, textLower: String): Boolean {
        val kw = keyword.trim().lowercase()
        if (kw.isEmpty()) return false

        // 纯 ASCII：词边界匹配
        if (isAsciiOnly(kw)) {
            val start = if (isWordChar(kw[0])) "\\b" else ""
            val end = if (isWordChar(kw[kw.length - 1])) "\\b" else ""
            val regex = runCatching { Regex("$start${escapeRegExp(kw)}$end") }.getOrNull()
            return regex?.containsMatchIn(textLower) ?: textLower.contains(kw)
        }

        // 含 CJK 的多字词：子串匹配
        if (kw.length >= 2) return textLower.contains(kw)

        // CJK 单字：要求命中处前后为边界
        var index = textLower.indexOf(kw)
        while (index != -1) {
            val before = if (index == 0) null else textLower[index - 1]
            val after = if (index + kw.length >= textLower.length) null else textLower[index + kw.length]
            val beforeOk = before == null || CJK_BOUNDARY.matches(before.toString())
            val afterOk = after == null || CJK_BOUNDARY.matches(after.toString())
            if (beforeOk && afterOk) return true
            index = textLower.indexOf(kw, index + 1)
        }
        return false
    }

    /** 解析 ST 的 `/pattern/flags` 关键词；非法正则回退为普通关键词。 */
    private fun parseRegexLiteral(keyword: String): Pair<String, String>? {
        val match = Regex("^/([\\s\\S]*)/([a-z]*)$", RegexOption.IGNORE_CASE).find(keyword.trim()) ?: return null
        val pattern = match.groupValues[1]
        val flags = match.groupValues[2]
        return runCatching {
            Regex(pattern, jsFlagsToOptions(flags))
            pattern to flags
        }.getOrNull()
    }

    /** JS 正则 flag → Kotlin [RegexOption]（仅覆盖实际会用到的几种）。 */
    private fun jsFlagsToOptions(flags: String): Set<RegexOption> {
        val options = mutableSetOf<RegexOption>()
        if (flags.contains('i')) options += RegexOption.IGNORE_CASE
        if (flags.contains('m')) options += RegexOption.MULTILINE
        if (flags.contains('s')) options += RegexOption.DOT_MATCHES_ALL
        return options
    }

    /** 统计正则匹配次数（强制全局；上限 [KEYWORD_COUNT_MAX]）。 */
    private fun countRegexMatches(pattern: String, flags: String, text: String): Int {
        val options = jsFlagsToOptions(flags)
        val regex = runCatching { Regex(pattern, options) }.getOrNull() ?: return 0
        var count = 0
        for (match in regex.findAll(text)) {
            count++
            if (count >= KEYWORD_COUNT_MAX) break
        }
        return count
    }

    /** 子串出现次数计数。 */
    private fun countSubstring(haystack: String, needle: String): Int {
        if (needle.isEmpty()) return 0
        var count = 0
        var index = haystack.indexOf(needle)
        while (index != -1 && count < KEYWORD_COUNT_MAX) {
            count++
            index = haystack.indexOf(needle, index + 1)
        }
        return count
    }

    /** CJK 单字关键词的边界命中计数。 */
    private fun countCjkSingleChar(text: String, kw: String): Int {
        var count = 0
        var index = text.indexOf(kw)
        while (index != -1 && count < KEYWORD_COUNT_MAX) {
            val before = if (index == 0) null else text[index - 1]
            val after = if (index + kw.length >= text.length) null else text[index + kw.length]
            val beforeOk = before == null || CJK_BOUNDARY.matches(before.toString())
            val afterOk = after == null || CJK_BOUNDARY.matches(after.toString())
            if (beforeOk && afterOk) count++
            index = text.indexOf(kw, index + 1)
        }
        return count
    }

    /** 条目级关键词定义（对齐 `LoreEntry` 的相关字段）。 */
    data class Entry(
        val content: String = "",
        val keywords: List<String> = emptyList(),
        val secondaryKeywords: List<String> = emptyList(),
        /** and_any | and_all | not_any | not_all（null = 不做二级过滤） */
        val selectiveLogic: String? = null,
        val useRegex: Boolean = false,
        val regexFlags: String? = null,
        val caseSensitive: Boolean = false,
        /** PC 默认 true（`matchWholeWords !== false`） */
        val matchWholeWords: Boolean = true,
        val enabled: Boolean = true,
    )

    /** 条目级关键词命中计数（P0 频率计分核心）。 */
    fun entryKeywordCount(entry: Entry, keyword: String, text: String, textLower: String): Int {
        parseRegexLiteral(keyword)?.let { (pattern, flags) ->
            return countRegexMatches(pattern, flags, text)
        }
        if (entry.useRegex) {
            return countRegexMatches(keyword, entry.regexFlags ?: "i", text)
        }
        val trimmed = keyword.trim()
        if (trimmed.isEmpty()) return 0
        val haystack = if (entry.caseSensitive) text else textLower
        val needle = if (entry.caseSensitive) trimmed else trimmed.lowercase()
        if (!entry.matchWholeWords) return countSubstring(haystack, needle)

        return if (!entry.caseSensitive) {
            if (isAsciiOnly(needle)) {
                val start = if (isWordChar(needle[0])) "\\b" else ""
                val end = if (isWordChar(needle[needle.length - 1])) "\\b" else ""
                countRegexMatches("$start${escapeRegExp(needle)}$end", "", textLower)
            } else if (needle.length >= 2) {
                countSubstring(textLower, needle)
            } else {
                countCjkSingleChar(textLower, needle)
            }
        } else {
            if (isAsciiOnly(needle)) {
                val start = if (isWordChar(needle[0])) "\\b" else ""
                val end = if (isWordChar(needle[needle.length - 1])) "\\b" else ""
                countRegexMatches("$start${escapeRegExp(needle)}$end", "", text)
            } else if (needle.length >= 2) {
                countSubstring(text, needle)
            } else {
                countCjkSingleChar(text, needle)
            }
        }
    }

    /** 条目级关键词匹配（布尔）：命中次数 > 0。 */
    fun entryKeywordMatch(entry: Entry, keyword: String, text: String, textLower: String): Boolean =
        entryKeywordCount(entry, keyword, text, textLower) > 0

    /** 主关键词命中后的 ST/CC 二级关键词过滤。 */
    fun entrySecondaryMatch(entry: Entry, text: String, textLower: String): Boolean {
        val secondary = entry.secondaryKeywords.filter { it.isNotBlank() }
        val logic = entry.selectiveLogic
        if (logic == null || secondary.isEmpty()) return true
        val matches = secondary.map { entryKeywordMatch(entry, it, text, textLower) }
        return when (logic) {
            "and_all" -> matches.all { it }
            "not_any" -> matches.all { !it }
            "not_all" -> !matches.all { it }
            else -> matches.any { it }
        }
    }

    // ---------------------------------------------------------------- 语义近似（无语义索引时的补偿）

    /**
     * 是否对该条目使用词面重叠近似：仅当该内容本轮没有真实语义命中
     * （有真实相似度时近似值无意义）。
     */
    fun shouldUseOverlapApprox(itemScore: Double?, content: String, semanticScoreByContent: Map<String, Double>): Boolean {
        if (itemScore != null && itemScore.isFinite()) return false
        val contentScore = semanticScoreByContent[content]
        return contentScore == null || !contentScore.isFinite()
    }

    /**
     * 词面重叠语义近似：大粒度 token（CJK 双字滑窗 + ASCII 词），Dice 系数对长度差异鲁棒。
     * keywords 与 content 各出一组 token 后 Dice 合并。
     */
    fun semanticScoreByOverlap(
        keywords: List<String>,
        content: String,
        dialogueTextLower: String,
        strength: Double = OVERLAP_STRENGTH,
    ): Double {
        val dialogueTokens = overlapTokens(dialogueTextLower)
        if (dialogueTokens.isEmpty()) return 0.0
        val contentScore = diceCoefficient(overlapTokens(content.lowercase()), dialogueTokens)
        val keywordScore = diceCoefficient(
            overlapTokens(keywords.filter { it.isNotBlank() }.joinToString(" ").lowercase()),
            dialogueTokens,
        )
        return minOf(1.0, strength * (0.5 * contentScore + 0.5 * keywordScore))
    }

    /** 大粒度 token：ASCII 按词（≥2 字符），CJK 双字滑窗。 */
    fun overlapTokens(text: String): List<String> {
        val tokens = mutableListOf<String>()
        tokens += Regex("[a-zA-Z0-9]{2,}").findAll(text).map { it.value }
        for (index in 0 until maxOf(0, text.length - 1)) {
            val first = text[index]
            val second = text[index + 1]
            if (isCjkChar(first) && isCjkChar(second)) tokens += "$first$second"
        }
        return tokens
    }

    /** Dice 系数（2|A∩B| / (|A|+|B|)）：任一集合为空返回 0。 */
    fun diceCoefficient(a: List<String>, b: List<String>): Double {
        if (a.isEmpty() || b.isEmpty()) return 0.0
        val counts = mutableMapOf<String, Int>()
        for (token in a) counts[token] = (counts[token] ?: 0) + 1
        var intersection = 0
        for (token in b) {
            val remaining = counts[token] ?: 0
            if (remaining > 0) {
                intersection++
                counts[token] = remaining - 1
            }
        }
        return (2.0 * intersection) / (a.size + b.size)
    }

    // ---------------------------------------------------------------- 实体增强

    /**
     * 从受控词表收集「最近对话中被提及的」实体。
     * 受控词表 = charName + entityVocabulary + 激活条目全部 keywords，
     * 再用词边界匹配过滤——零误报且保留「最近被提及」语义。
     */
    fun extractEntities(
        scanTextLower: String,
        charName: String,
        entityVocabulary: List<String> = emptyList(),
        lorebooks: List<Pair<Boolean, List<Entry>>> = emptyList(),
    ): Set<String> {
        val vocabulary = linkedSetOf<String>()
        fun add(word: String?) {
            val trimmed = word?.trim()?.lowercase().orEmpty()
            if (trimmed.isNotEmpty()) vocabulary += trimmed
        }
        add(charName)
        entityVocabulary.forEach { add(it) }
        for ((enabled, entries) in lorebooks) {
            if (!enabled) continue
            for (entry in entries) {
                if (!entry.enabled) continue
                entry.keywords.forEach { add(it) }
            }
        }
        return vocabulary.filter { keywordMatch(it, scanTextLower) }.toSet()
    }

    /**
     * 实体命中检查：条目 keywords 直接命中最近实体，或条目内容包含实体名
     * （长度 < 2 的实体跳过 includes，降低双字误报）。
     */
    fun checkEntityBoost(keywords: List<String>, content: String, recentEntities: Set<String>): Boolean {
        for (keyword in keywords) {
            if (recentEntities.contains(keyword.trim().lowercase())) return true
        }
        if (recentEntities.isEmpty()) return false
        val contentLower = content.lowercase()
        return recentEntities.any { it.length >= 2 && contentLower.contains(it) }
    }

    // ---------------------------------------------------------------- 统一评分

    data class ScoredItem(
        val item: ChatLorebookBudget.Item,
        val keywordHits: Double,
        val semanticScore: Double,
        /** real | approx | none */
        val semanticSource: String,
        val entityHit: Boolean,
        val recencyHit: Boolean,
        val score: Double,
    ) {
        /** 交给预算层的条目（score 已写入）。 */
        fun toBudgetItem(): ChatLorebookBudget.Item = item.copy(score = score)
    }

    data class ScoreContext(
        val scanText: String,
        val scanTextLower: String,
        /** 对话扫描文本（不含递归条目内容）：关键词频率计数基于对话相关度。 */
        val dialogueText: String,
        val dialogueTextLower: String,
        val entriesByKey: Map<String, Entry>,
        val semanticScoreByContent: Map<String, Double> = emptyMap(),
        val recentEntities: Set<String> = emptySet(),
        val recentTriggered: Set<String> = emptySet(),
    )

    /**
     * 统一评分：score = w_keyword×keywordHits + w_semantic×semanticScore
     *                  + w_entity×entityBoost + w_recency×recencyBoost。
     *
     * `keywordHits` = 0.5×coverage + 0.5×frequency，其中 frequency = 1 - e^(-totalOccurrences)
     * （每词命中次数上限 3，防单关键词刷屏主导）。
     */
    fun scoreItems(items: List<ChatLorebookBudget.Item>, context: ScoreContext): List<ScoredItem> =
        items.map { item ->
            val entry = item.key?.let { context.entriesByKey[it] }
            val validKeywords = entry?.keywords?.filter { it.isNotBlank() } ?: emptyList()
            val hitCounts = if (entry != null) {
                validKeywords.map { entryKeywordCount(entry, it, context.dialogueText, context.dialogueTextLower) }
            } else {
                emptyList()
            }
            val hitKeywords = hitCounts.count { it > 0 }
            val totalOccurrences = hitCounts.sumOf { minOf(it, 3) }
            val coverage = if (validKeywords.isNotEmpty()) {
                hitKeywords.toDouble() / validKeywords.size
            } else {
                0.0
            }
            val frequency = 1 - kotlin.math.exp(-totalOccurrences.toDouble())
            val keywordHits = 0.5 * coverage + 0.5 * frequency

            val rawSemantic = item.score ?: context.semanticScoreByContent[item.content]
            // 词面重叠补偿：无真实语义命中时填补 semantic 维度
            val approxSemantic = if (entry != null &&
                shouldUseOverlapApprox(item.score, item.content, context.semanticScoreByContent)
            ) {
                semanticScoreByOverlap(validKeywords, item.content, context.dialogueTextLower)
            } else {
                0.0
            }
            val rawFinite = rawSemantic != null && rawSemantic.isFinite()
            val semanticScore = minOf(1.0, maxOf(0.0, if (rawFinite) rawSemantic!! else approxSemantic))
            val entityHit = checkEntityBoost(validKeywords, item.content, context.recentEntities)
            val recencyHit = item.key != null && context.recentTriggered.contains(item.key)

            ScoredItem(
                item = item,
                keywordHits = keywordHits,
                semanticScore = semanticScore,
                semanticSource = when {
                    rawFinite -> "real"
                    semanticScore > 0 -> "approx"
                    else -> "none"
                },
                entityHit = entityHit,
                recencyHit = recencyHit,
                score = KEYWORD_WEIGHT * keywordHits +
                    SEMANTIC_WEIGHT * (if (item.score != null && item.score.isFinite()) item.score else semanticScore) +
                    (if (entityHit) ENTITY_WEIGHT else 0.0) +
                    (if (recencyHit) RECENCY_WEIGHT else 0.0),
            )
        }

    /** 将本轮触发的条目 key 追加到会话语义近因环形缓冲（最多保留 windowSize 轮）。 */
    fun appendRecentTriggeredIds(
        previous: List<List<String>>?,
        ids: List<String>,
        windowSize: Int = RECENCY_WINDOW,
    ): List<List<String>> {
        if (ids.isEmpty() && (previous == null || previous.isEmpty())) return emptyList()
        val combined = (previous ?: emptyList()) + listOf(ids)
        return combined.takeLast(windowSize)
    }
}
