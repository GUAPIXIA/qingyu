package com.qingyu.companion.embedding

import com.qingyu.companion.chatcore.ChatLorebookRetrieval

/**
 * 阶段 6 S6-05 第 3 档的词法通道：把阶段 4 已移植的 BM25
 * （[ChatLorebookRetrieval]，tokenizer `unicode-bigram-v1`）**接成可用通道**。
 *
 * 阶段 5 §2.21 的「平台级缺口」（PC 的 hybrid 条目恒可走词法、本机不能）由此收口：
 * 向量不可用时，`hybrid` / `semanticPreferred` 条目走这里兜底，与 PC
 * `isLexicalEligibleMode` 的口径一致。索引是可丢弃重建的缓存，不落盘、不同步。
 */
class LexicalFallbackChannel(
    private val provider: ChatLorebookRetrieval.Provider = ChatLorebookRetrieval.Provider(),
) {
    /** 通道标识（RRF 融合的通道名用 `lexical`，与 [ChatLorebookRetrieval.reciprocalRankFusion] 同名）。 */
    val channelName: String = "lexical"

    /** 分词器版本（与索引一起构成 chunk/分析策略版本的一部分）。 */
    val analyzerVersion: String = ChatLorebookRetrieval.LEXICAL_ANALYZER_VERSION

    /** 词法通道永远可用：纯 JVM BM25，无网络、无模型、无原生依赖。 */
    fun available(): Boolean = true

    fun search(
        query: String,
        books: List<ChatLorebookRetrieval.Book>,
        topK: Int = ChatLorebookRetrieval.DEFAULT_TOP_K,
        threshold: Double = ChatLorebookRetrieval.DEFAULT_THRESHOLD,
    ): List<ChatLorebookRetrieval.Hit> = provider.search(query, books, topK, threshold)

    /** 语料变化时失效（内部按语料指纹自动重建，这里只是显式入口）。 */
    fun invalidate(changes: List<String>? = null) = provider.invalidate(changes)
}
