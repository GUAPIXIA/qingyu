package com.qingyu.companion.embedding

import com.qingyu.companion.chatcore.ChatLorebookRetrieval
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 第 3 档降级的**词法通道必须真实可召回**——降级不是把功能关了，
 * 而是换一条同样能召回条目的通道（阶段 5 §2.21 的平台级缺口就此收口）。
 */
class LexicalFallbackChannelTest {

    private fun book(id: String, entryId: String, keywords: List<String>, content: String) =
        ChatLorebookRetrieval.Book(
            id = id,
            name = "书-$id",
            entries = listOf(
                ChatLorebookRetrieval.Entry(id = entryId, keywords = keywords, content = content),
            ),
        )

    @Test
    fun lexicalChannelRecallsCjkEntriesWithoutAnyEmbedding() {
        val channel = LexicalFallbackChannel()
        assertTrue("词法通道永远可用（纯 JVM BM25），这是降级档的立身之本", channel.available())

        val books = listOf(
            book("lb1", "e1", listOf("码头"), "码头仓库里藏着走私的钟表"),
            book("lb2", "e2", listOf("雪山"), "雪山顶上的修行者"),
        )
        val hits = channel.search("码头 走私", books, threshold = 0.0)
        assertTrue("词法检索必须能召回相关条目（降级档不能变成什么都不召回）", hits.isNotEmpty())
        assertEquals("召回的应是码头那条而不是雪山那条", "lb1", hits.first().bookId)
        assertTrue("命中要带匹配词（调试面板展示触发来源）", hits.first().matchedTokens.isNotEmpty())
    }

    @Test
    fun invalidateRebuildsIndexWithoutBreakingRecall() {
        val channel = LexicalFallbackChannel()
        val books = listOf(book("lb1", "e1", listOf("灯塔"), "灯塔守夜人的秘密"))
        assertTrue("第一次能召回", channel.search("灯塔", books, threshold = 0.0).isNotEmpty())

        channel.invalidate()
        assertTrue("失效后内部重建仍要能召回（索引是可丢弃缓存）", channel.search("灯塔", books, threshold = 0.0).isNotEmpty())

        // 换语料后按新语料召回（旧索引不许继续答旧答案）
        val newBooks = listOf(book("lb1", "e1", listOf("灯塔"), "灯塔已经拆除，只剩基座"))
        val hits = channel.search("拆除", newBooks, threshold = 0.0)
        assertTrue("语料变化后要按新语料召回", hits.isNotEmpty())
    }

    @Test
    fun analyzerVersionIsExposedForIndexFingerprinting() {
        assertEquals(
            "分词器版本要对外可读（它是失效键里 chunk 策略的一部分，改动必须能被识别）",
            ChatLorebookRetrieval.LEXICAL_ANALYZER_VERSION,
            LexicalFallbackChannel().analyzerVersion,
        )
    }
}
