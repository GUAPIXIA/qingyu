package com.qingyu.companion.chatcore

import java.text.Normalizer
import java.util.Locale
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min

/**
 * 阶段 4 S4-01 第 3 层：世界书关键词/词法检索与 RRF 融合
 * （对齐 `shared/chat-core/lorebookRetrieval.ts`）。
 *
 * 与 PC 一致的要点：
 * - tokenizer 版本 `unicode-bigram-v1`：NFKC + 小写 + 去代码块/URL；
 *   CJK（Han/Hiragana/Katakana/Hangul）连续串产 bigram 与 trigram，单字串保留 unigram；
 *   Latin/数字按词切分，长度 ≥2 或纯数字才入索引；
 * - 字段权重 title 4 / keywords 3.5 / summary 2 / content 1；
 * - BM25（k1=1.2, b=0.75）+ 覆盖率修正 `(raw/(raw+6)) * (0.6 + 0.4*coverage)`；
 * - 排序 score 降序、同分按 key 的 UTF-16 码元序（与 JS `localeCompare` 在本语料上一致）；
 * - 索引是可删除重建的缓存，fingerprint 变化时重建（`runtime.revision` 优先，其次内容哈希）。
 */
object ChatLorebookRetrieval {

    const val LEXICAL_ANALYZER_VERSION = "unicode-bigram-v1"
    const val DEFAULT_TOP_K = 24
    const val DEFAULT_THRESHOLD = 0.08

    // ---------------------------------------------------------------- 数据模型

    /** 条目/书级运行时元数据（`revision` 是**书**级字段，见 [Book.revision]）。 */
    data class Runtime(val title: String? = null)

    data class Entry(
        val id: String,
        val keywords: List<String> = emptyList(),
        val content: String = "",
        val position: String = "before_char",
        val depth: Int? = null,
        val role: String? = null,
        val order: Int = 0,
        val probability: Int = 100,
        val enabled: Boolean = true,
        val summary: String? = null,
        val runtime: Runtime? = null,
    )

    data class Book(
        val id: String,
        val name: String = "",
        val description: String = "",
        val entries: List<Entry> = emptyList(),
        val enabled: Boolean = true,
        val scanDepth: Int = 4,
        /** 书级语料修订号（PC `book.runtime.revision`）：存在时索引指纹用 `id@revision`。 */
        val revision: Int? = null,
    )

    data class Hit(
        val key: String,
        val bookId: String,
        val entryId: String,
        val rank: Int,
        val score: Double,
        val rawScore: Double,
        val matchedTokens: List<String>,
    )

    data class RankedHit(val key: String, val score: Double)

    data class FusedHit(
        val key: String,
        val score: Double,
        val normalizedScore: Double,
        val ranks: Map<String, Int>,
        val scores: Map<String, Double>,
    )

    // ---------------------------------------------------------------- 文本规范化与分词

    private val CODE_BLOCK = Regex("```[\\s\\S]*?```|~~~[\\s\\S]*?~~~")
    private val URL = Regex("https?://\\S+")

    /** CJK 连续串：Han / Hiragana / Katakana / Hangul（与 TS `\p{Script=...}` 等价）。 */
    private val CJK_RUN = Regex(
        "[\\p{IsHan}\\p{IsHiragana}\\p{IsKatakana}\\p{IsHangul}]+",
    )

    /** Latin 与数字（等价 `[\p{Script=Latin}\p{N}]+`）。 */
    private val LATIN_TOKEN = Regex("[\\p{IsLatin}\\p{Nd}]+")

    internal fun normalizeText(text: String): String {
        val nfkc = Normalizer.normalize(text, Normalizer.Form.NFKC)
        val lowered = nfkc.lowercase(Locale.ROOT)
        return URL.replace(CODE_BLOCK.replace(lowered, " "), " ")
    }

    /** 拉丁词按词切分；CJK 无空格文本使用 bigram/trigram，单字查询保留 unigram。 */
    fun tokenizeLexicalText(text: String): List<String> {
        val normalized = normalizeText(text)
        val tokens = mutableListOf<String>()
        val cjkRanges = mutableListOf<IntRange>()

        for (match in CJK_RUN.findAll(normalized)) {
            val run = match.value
            cjkRanges += match.range
            if (run.length == 1) {
                tokens += run
                continue
            }
            for (size in 2..3) {
                if (run.length < size) continue
                for (index in 0..(run.length - size)) {
                    tokens += run.substring(index, index + size)
                }
            }
        }

        // 把 CJK 区间替换为空格后再抽 Latin token（等价 TS 的 cjkRanges.reduceRight）
        val latinOnly = buildString(normalized.length) {
            var cursor = 0
            for (range in cjkRanges) {
                if (range.first > cursor) append(normalized, cursor, range.first)
                append(' ')
                cursor = range.last + 1
            }
            if (cursor < normalized.length) append(normalized, cursor, normalized.length)
        }
        for (match in LATIN_TOKEN.findAll(latinOnly)) {
            val token = match.value
            if (token.length >= 2 || token.all { it.isDigit() }) tokens += token
        }
        return tokens
    }

    // ---------------------------------------------------------------- 索引构建

    private class IndexedEntry(
        val key: String,
        val bookId: String,
        val entryId: String,
        val length: Double,
        val terms: Map<String, Double>,
    )

    private class LexicalIndex(
        val fingerprint: String,
        val entries: List<IndexedEntry>,
        val documentFrequency: Map<String, Int>,
        val averageLength: Double,
    )

    private const val WEIGHT_TITLE = 4.0
    private const val WEIGHT_KEYWORDS = 3.5
    private const val WEIGHT_SUMMARY = 2.0
    private const val WEIGHT_CONTENT = 1.0

    private fun addFieldTerms(target: MutableMap<String, Double>, text: String?, weight: Double): Double {
        if (text.isNullOrEmpty()) return 0.0
        val tokens = tokenizeLexicalText(text)
        for (token in tokens) target[token] = (target[token] ?: 0.0) + weight
        return tokens.size * weight
    }

    private fun entryKey(bookId: String, entry: Entry): String =
        "$bookId:${entry.id.ifEmpty { entry.keywords.joinToString(",") }}"

    /** FNV-1a 32 位（与 TS `hashText` 一致，`Math.imul` 等价于 32 位乘法）。 */
    internal fun hashText(value: String): String {
        var hash = 2166136261L
        for (ch in value) {
            hash = hash xor ch.code.toLong()
            hash = (hash * 16777619L) and 0xFFFFFFFFL
        }
        return java.lang.Long.toString(hash, 36)
    }

    private fun corpusFingerprint(books: List<Book>): String = books
        .filter { it.enabled }
        .map { book ->
            val revision = book.runtimeRevision()
            if (revision != null) {
                "${book.id}@$revision"
            } else {
                val joined = book.entries.joinToString("|") { entry ->
                    // 与 TS 的 JSON.stringify(part) 对齐：null -> null，字符串加引号
                    listOf(
                        jsonPart(entry.id),
                        jsonPart(entry.enabled),
                        jsonPart(entry.runtime?.title),
                        jsonPart(entry.keywords),
                        jsonPart(entry.summary),
                        jsonPart(entry.content),
                    ).joinToString("|")
                }
                "${book.id}@${hashText(joined)}"
            }
        }
        .sorted()
        .joinToString(";")

    /** 书级修订号（PC 侧 `book.runtime.revision`）：存在时直接用 `id@revision` 作为指纹。 */
    private fun Book.runtimeRevision(): Int? = revision

    private fun jsonPart(value: Any?): String = when (value) {
        null -> "null"
        is String -> "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""
        is Boolean -> value.toString()
        is List<*> -> value.joinToString(",", "[", "]") { jsonPart(it) }
        is Number -> value.toString()
        else -> jsonPart(value.toString())
    }

    private fun buildIndex(books: List<Book>, fingerprint: String): LexicalIndex {
        val entries = mutableListOf<IndexedEntry>()
        for (book in books) {
            if (!book.enabled) continue
            for (entry in book.entries) {
                if (!entry.enabled || entry.content.trim().isEmpty()) continue
                val terms = mutableMapOf<String, Double>()
                var length = 0.0
                length += addFieldTerms(terms, entry.runtime?.title, WEIGHT_TITLE)
                length += addFieldTerms(terms, entry.keywords.joinToString(" "), WEIGHT_KEYWORDS)
                length += addFieldTerms(terms, entry.summary, WEIGHT_SUMMARY)
                length += addFieldTerms(terms, entry.content, WEIGHT_CONTENT)
                if (terms.isEmpty()) continue
                entries += IndexedEntry(
                    key = entryKey(book.id, entry),
                    bookId = book.id,
                    entryId = entry.id,
                    length = max(1.0, length),
                    terms = terms,
                )
            }
        }

        val documentFrequency = mutableMapOf<String, Int>()
        for (entry in entries) {
            for (term in entry.terms.keys) documentFrequency[term] = (documentFrequency[term] ?: 0) + 1
        }
        val averageLength = if (entries.isNotEmpty()) entries.sumOf { it.length } / entries.size else 1.0
        return LexicalIndex(fingerprint, entries, documentFrequency, averageLength)
    }

    /** 无原生依赖的内存 BM25 provider（索引可丢弃重建）。 */
    class Provider {
        val id: String = "local.lexical.$LEXICAL_ANALYZER_VERSION"
        private var index: LexicalIndex? = null

        fun available(): Pair<Boolean, String?> = true to null

        fun ensureIndex(books: List<Book>) {
            val fingerprint = corpusFingerprint(books)
            if (index?.fingerprint == fingerprint) return
            index = buildIndex(books, fingerprint)
        }

        fun search(
            query: String,
            books: List<Book>,
            topK: Int = DEFAULT_TOP_K,
            threshold: Double = DEFAULT_THRESHOLD,
        ): List<Hit> {
            ensureIndex(books)
            val current = index ?: return emptyList()
            if (current.entries.isEmpty()) return emptyList()

            val queryTokens = tokenizeLexicalText(query).distinct()
            if (queryTokens.isEmpty()) return emptyList()

            val documentCount = current.entries.size
            val k1 = 1.2
            val b = 0.75

            data class Scored(
                val entry: IndexedEntry,
                val score: Double,
                val rawScore: Double,
                val matched: List<String>,
            )

            val scored = mutableListOf<Scored>()
            for (entry in current.entries) {
                var rawScore = 0.0
                val matchedTokens = mutableListOf<String>()
                for (token in queryTokens) {
                    val termFrequency = entry.terms[token] ?: 0.0
                    if (termFrequency <= 0.0) continue
                    matchedTokens += token
                    val df = current.documentFrequency[token] ?: 0
                    val inverseDocumentFrequency = ln(1.0 + (documentCount - df + 0.5) / (df + 0.5))
                    val lengthNorm = termFrequency + k1 * (1 - b + b * entry.length / current.averageLength)
                    rawScore += inverseDocumentFrequency * (termFrequency * (k1 + 1)) / lengthNorm
                }
                if (matchedTokens.isEmpty()) continue
                val coverage = matchedTokens.size.toDouble() / queryTokens.size
                val score = (rawScore / (rawScore + 6)) * (0.6 + 0.4 * coverage)
                if (score < threshold) continue
                scored += Scored(entry, score, rawScore, matchedTokens)
            }

            val limited = scored
                .sortedWith(compareByDescending<Scored> { it.score }.thenBy { it.entry.key })
                .take(max(1, floor(topK.toDouble()).toInt()))

            return limited.mapIndexed { position, hit ->
                Hit(
                    key = hit.entry.key,
                    bookId = hit.entry.bookId,
                    entryId = hit.entry.entryId,
                    rank = position + 1,
                    score = hit.score,
                    rawScore = hit.rawScore,
                    matchedTokens = hit.matched,
                )
            }
        }

        fun invalidate(changes: List<String>? = null) {
            if (changes == null || changes.isNotEmpty()) index = null
        }
    }

    // ---------------------------------------------------------------- RRF 融合

    /**
     * 加权 Reciprocal Rank Fusion：各通道只用 rank，避免混加 BM25 与余弦分数。
     * 默认 k=60，权重 keyword 3 / lexical 1.5 / vector 2。
     */
    fun reciprocalRankFusion(
        channels: Map<String, List<RankedHit>>,
        k: Int = 60,
        weights: Map<String, Double> = emptyMap(),
    ): List<FusedHit> {
        val effectiveK = max(1, k)
        val merged = mapOf(
            "keyword" to (weights["keyword"] ?: 3.0),
            "lexical" to (weights["lexical"] ?: 1.5),
            "vector" to (weights["vector"] ?: 2.0),
        )
        val maxScore = (merged.getValue("keyword") + merged.getValue("lexical") + merged.getValue("vector")) /
            (effectiveK + 1)

        class Acc(var score: Double = 0.0) {
            var normalized = 0.0
            val ranks = LinkedHashMap<String, Int>()
            val scores = LinkedHashMap<String, Double>()
        }

        val fused = LinkedHashMap<String, Acc>()
        for (channel in listOf("keyword", "lexical", "vector")) {
            val hits = channels[channel] ?: continue
            hits.forEachIndexed { index, hit ->
                val rank = index + 1
                val acc = fused.getOrPut(hit.key) { Acc() }
                acc.score += merged.getValue(channel) / (effectiveK + rank)
                acc.normalized = min(1.0, acc.score / maxScore)
                acc.ranks[channel] = rank
                acc.scores[channel] = hit.score
            }
        }
        return fused.entries
            .map { (key, acc) ->
                FusedHit(
                    key = key,
                    score = acc.score,
                    normalizedScore = acc.normalized,
                    ranks = acc.ranks,
                    scores = acc.scores,
                )
            }
            .sortedWith(compareByDescending<FusedHit> { it.score }.thenBy { it.key })
    }
}
