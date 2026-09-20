package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 A3b-2：世界书触发匹配与统一评分的跨语言一致性测试
 * （对齐 fixture `lorebook-scoring.json`，oracle 为 PC 的
 * `shared/chat-core/lorebook.ts` 中真实被 runtime 调用的那批函数）。
 *
 * 这一层把候选条目变成「带分数的条目」，交给预算层分桶裁剪。
 * 边界语义错一处就会让两端注入不同的条目：`cat` 命中 `category`、
 * CJK 单字命中半个词、或把「英文分析里夹的一句中文」当成正文。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatLorebookScoringGoldenTest {

    private val root = ChatCoreFixtures.root("lorebook-scoring")

    private fun entryOf(map: Map<String, Any?>): ChatLorebookScoring.Entry =
        ChatLorebookScoring.Entry(
            content = ChatCoreFixtures.str(map, "content") ?: "",
            keywords = (ChatCoreFixtures.listOrNull(map, "keywords") as? List<*>)?.map { it.toString() } ?: emptyList(),
            secondaryKeywords = (ChatCoreFixtures.listOrNull(map, "secondaryKeywords") as? List<*>)?.map { it.toString() }
                ?: emptyList(),
            selectiveLogic = ChatCoreFixtures.str(map, "selectiveLogic"),
            useRegex = ChatCoreFixtures.boolOrNull(map, "useRegex") ?: false,
            regexFlags = ChatCoreFixtures.str(map, "regexFlags"),
            caseSensitive = ChatCoreFixtures.boolOrNull(map, "caseSensitive") ?: false,
            matchWholeWords = ChatCoreFixtures.boolOrNull(map, "matchWholeWords") ?: true,
            enabled = ChatCoreFixtures.boolOrNull(map, "enabled") ?: true,
        )

    @Test
    fun constantsMatchPc() {
        val constants = ChatCoreFixtures.mapOrNull(root, "constants")!!
        val weights = ChatCoreFixtures.mapOrNull(constants, "weights")!!
        assertEquals("keyword", (weights["keyword"] as Number).toDouble(), ChatLorebookScoring.KEYWORD_WEIGHT, 1e-9)
        assertEquals("semantic", (weights["semantic"] as Number).toDouble(), ChatLorebookScoring.SEMANTIC_WEIGHT, 1e-9)
        assertEquals("entity", (weights["entity"] as Number).toDouble(), ChatLorebookScoring.ENTITY_WEIGHT, 1e-9)
        assertEquals("recency", (weights["recency"] as Number).toDouble(), ChatLorebookScoring.RECENCY_WEIGHT, 1e-9)
        assertEquals(
            "recencyWindow",
            ChatCoreFixtures.intOrNull(constants, "recencyWindow"),
            ChatLorebookScoring.RECENCY_WINDOW,
        )
    }

    @Test
    fun markdownNoiseStrippingMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "stripCases") as? List<Map<String, Any?>>)
            ?: error("缺少 stripCases")
        for (case in cases) {
            val text = ChatCoreFixtures.str(case, "text") ?: ""
            assertEquals(
                "stripMarkdownNoise(${text.take(20)})",
                ChatCoreFixtures.str(case, "stripped"),
                ChatLorebookScoring.stripMarkdownNoise(text),
            )
        }
        @Suppress("UNCHECKED_CAST")
        val escapeCases = (ChatCoreFixtures.listOrNull(root, "escapeCases") as? List<Map<String, Any?>>)
            ?: error("缺少 escapeCases")
        for (case in escapeCases) {
            val text = ChatCoreFixtures.str(case, "text") ?: ""
            assertEquals("escapeRegExp($text)", ChatCoreFixtures.str(case, "escaped"), ChatLorebookScoring.escapeRegExp(text))
        }
    }

    @Test
    fun keywordBoundaryMatchingMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "keywordCases") as? List<Map<String, Any?>>)
            ?: error("缺少 keywordCases")
        for (case in cases) {
            val keyword = ChatCoreFixtures.str(case, "keyword") ?: ""
            val text = ChatCoreFixtures.str(case, "text") ?: ""
            assertEquals(
                "keywordMatch('$keyword', '${text.take(20)}')",
                ChatCoreFixtures.boolOrNull(case, "matched"),
                ChatLorebookScoring.keywordMatch(keyword, text),
            )
        }
    }

    @Test
    fun overlapApproximationMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "overlapCases") as? List<Map<String, Any?>>)
            ?: error("缺少 overlapCases")
        for (case in cases) {
            val keywords = (ChatCoreFixtures.listOrNull(case, "keywords") as? List<*>)?.map { it.toString() } ?: emptyList()
            val content = ChatCoreFixtures.str(case, "content") ?: ""
            val dialogue = ChatCoreFixtures.str(case, "dialogue") ?: ""
            assertEquals(
                "semanticScoreByOverlap(${keywords}, ${content.take(12)})",
                (case["score"] as Number).toDouble(),
                ChatLorebookScoring.semanticScoreByOverlap(keywords, content, dialogue),
                1e-12,
            )
        }

        @Suppress("UNCHECKED_CAST")
        val approxCases = (ChatCoreFixtures.listOrNull(root, "overlapApproxCases") as? List<Map<String, Any?>>)
            ?: error("缺少 overlapApproxCases")
        for (case in approxCases) {
            val content = ChatCoreFixtures.str(case, "content") ?: ""
            val semantic = (ChatCoreFixtures.mapOrNull(case, "semanticByContent") ?: emptyMap())
                .mapValues { (it.value as Number).toDouble() }
            assertEquals(
                "shouldUseOverlapApprox($content)",
                ChatCoreFixtures.boolOrNull(case, "useApprox"),
                ChatLorebookScoring.shouldUseOverlapApprox(
                    (case["itemScore"] as? Number)?.toDouble(),
                    content,
                    semantic,
                ),
            )
        }
    }

    @Test
    fun entityExtractionAndBoostMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "entityCases") as? List<Map<String, Any?>>)
            ?: error("缺少 entityCases")
        for (case in cases) {
            val scan = ChatCoreFixtures.str(case, "scanTextLower") ?: ""
            val charName = ChatCoreFixtures.str(case, "charName") ?: ""
            val vocabulary = (ChatCoreFixtures.listOrNull(case, "entityVocabulary") as? List<*>)?.map { it.toString() }
                ?: emptyList<String>()
            val entries: List<ChatLorebookScoring.Entry> =
                ((ChatCoreFixtures.listOrNull(case, "entries") as? List<Map<String, Any?>>) ?: emptyList())
                    .map { entry -> entryOf(entry) }
            val entities = ChatLorebookScoring.extractEntities(
                scanTextLower = scan,
                charName = charName,
                entityVocabulary = vocabulary,
                lorebooks = listOf(true to entries),
            )
            val expected = (ChatCoreFixtures.listOrNull(case, "entities") as? List<*>)?.map { it.toString() } ?: emptyList()
            assertEquals("extractEntities(${scan.take(16)})", expected.sorted(), entities.sorted())
        }

        @Suppress("UNCHECKED_CAST")
        val boostCases = (ChatCoreFixtures.listOrNull(root, "entityBoostCases") as? List<Map<String, Any?>>)
            ?: error("缺少 entityBoostCases")
        for (case in boostCases) {
            val keywords = (ChatCoreFixtures.listOrNull(case, "keywords") as? List<*>)?.map { it.toString() } ?: emptyList()
            val content = ChatCoreFixtures.str(case, "content") ?: ""
            val recent: Set<String> = ((ChatCoreFixtures.listOrNull(case, "recentEntities") as? List<*>) ?: emptyList<Any?>())
                .map { it.toString() }.toSet()
            assertEquals(
                "checkEntityBoost($keywords, ${content.take(12)})",
                ChatCoreFixtures.boolOrNull(case, "boosted"),
                ChatLorebookScoring.checkEntityBoost(keywords, content, recent),
            )
        }
    }

    @Test
    fun recencyBufferMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "recencyCases") as? List<Map<String, Any?>>)
            ?: error("缺少 recencyCases")
        for (case in cases) {
            val previous = (ChatCoreFixtures.listOrNull(case, "previous") as? List<List<*>>)
                ?.map { round -> round.map { it.toString() } }
            val ids = ((ChatCoreFixtures.listOrNull(case, "ids") as? List<*>) ?: emptyList<Any?>()).map { it.toString() }
            val result = ChatLorebookScoring.appendRecentTriggeredIds(previous, ids)
            val expected = ((ChatCoreFixtures.listOrNull(case, "result") as? List<List<*>>) ?: emptyList())
                .map { round -> round.map { it.toString() } }
            assertEquals("appendRecentTriggeredIds($previous, $ids)", expected, result)
        }
    }

    @Test
    fun unifiedScoringMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "scoreCases") as? List<Map<String, Any?>>)
            ?: error("缺少 scoreCases")
        for ((caseIndex, case) in cases.withIndex()) {
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val items = ((ChatCoreFixtures.listOrNull(input, "items") as? List<Map<String, Any?>>)
                ?: error("缺少 items")).map { raw ->
                ChatLorebookBudget.Item(
                    content = ChatCoreFixtures.str(raw, "content") ?: "",
                    order = ChatCoreFixtures.intOrNull(raw, "order") ?: 0,
                    position = ChatCoreFixtures.str(raw, "position") ?: "before_char",
                    depth = ChatCoreFixtures.intOrNull(raw, "depth"),
                    priority = ChatCoreFixtures.str(raw, "priority"),
                    key = ChatCoreFixtures.str(raw, "key"),
                )
            }
            val entriesByKey = (ChatCoreFixtures.mapOrNull(input, "entries") ?: emptyMap())
                .mapValues { (it.value as Map<String, Any?>).let { entry -> entryOf(entry) } }
            val scanText = ChatCoreFixtures.str(input, "scanText") ?: ""
            val dialogueText = ChatCoreFixtures.str(input, "dialogueText") ?: ""
            val semanticByContent = (ChatCoreFixtures.mapOrNull(input, "semanticByContent") ?: emptyMap())
                .mapValues { (it.value as Number).toDouble() }
            val recentEntities = ((ChatCoreFixtures.listOrNull(input, "recentEntities") as? List<*>)
                ?: emptyList<Any?>()).map { it.toString() }.toSet()
            val recentTriggered = ((ChatCoreFixtures.listOrNull(input, "recentTriggered") as? List<*>)
                ?: emptyList<Any?>()).map { it.toString() }.toSet()

            val scored = ChatLorebookScoring.scoreItems(
                items,
                ChatLorebookScoring.ScoreContext(
                    scanText = scanText,
                    scanTextLower = scanText.lowercase(),
                    dialogueText = dialogueText,
                    dialogueTextLower = dialogueText.lowercase(),
                    entriesByKey = entriesByKey,
                    semanticScoreByContent = semanticByContent,
                    recentEntities = recentEntities,
                    recentTriggered = recentTriggered,
                ),
            )
            @Suppress("UNCHECKED_CAST")
            val expected = (ChatCoreFixtures.listOrNull(case, "scored") as? List<Map<String, Any?>>)
                ?: error("缺少 scored")
            assertEquals("scoreCases[$caseIndex] 条数", expected.size, scored.size)
            expected.forEachIndexed { index, item ->
                val label = "scoreCases[$caseIndex][$index]"
                assertEquals("$label.key", ChatCoreFixtures.str(item, "key"), scored[index].item.key)
                assertEquals(
                    "$label.keywordHits",
                    (item["keywordHits"] as Number).toDouble(),
                    scored[index].keywordHits,
                    1e-12,
                )
                assertEquals(
                    "$label.semanticScore",
                    (item["semanticScore"] as Number).toDouble(),
                    scored[index].semanticScore,
                    1e-12,
                )
                assertEquals("$label.semanticSource", ChatCoreFixtures.str(item, "semanticSource"), scored[index].semanticSource)
                assertEquals("$label.entityHit", ChatCoreFixtures.boolOrNull(item, "entityHit"), scored[index].entityHit)
                assertEquals("$label.recencyHit", ChatCoreFixtures.boolOrNull(item, "recencyHit"), scored[index].recencyHit)
                assertEquals("$label.score", (item["score"] as Number).toDouble(), scored[index].score, 1e-12)
            }
        }
    }

    @Test
    fun asciiKeywordDoesNotMatchLongerWord() {
        // 词边界语义是防止世界书误触发的核心：`cat` 绝不能命中 `category`
        assertTrue(ChatLorebookScoring.keywordMatch("cat", "a cat here"))
        assertFalse(ChatLorebookScoring.keywordMatch("cat", "a category here"))
        assertFalse(ChatLorebookScoring.keywordMatch("cat", "concat"))
    }

    @Test
    fun cjkSingleCharRequiresBoundary() {
        // 单字关键词必须**两侧都是边界**：被夹在词中一律不算命中（防半个词误触发）
        assertTrue(ChatLorebookScoring.keywordMatch("雨", "雨。"))
        assertTrue(ChatLorebookScoring.keywordMatch("雨", "今天 雨 很大"))
        // 被汉字夹住 → 不命中（PC 语义，fixture 已锁定）
        assertFalse(ChatLorebookScoring.keywordMatch("雨", "下雨了。"))
        assertFalse(ChatLorebookScoring.keywordMatch("雨", "大雨纷飞。"))
        assertFalse(ChatLorebookScoring.keywordMatch("雨", "雨下得很大。"))
        // 多字 CJK 维持子串匹配（不引入漏触发）
        assertTrue(ChatLorebookScoring.keywordMatch("码头", "他们在码头边等了很久。"))
    }

    @Test
    fun frequencyDistinguishesSingleMentionFromRepeatedDiscussion() {
        // coverage 相同（都命中 1/2 个关键词），但反复讨论应得到更高分
        val entry = ChatLorebookScoring.Entry(keywords = listOf("码头", "灯塔"))
        val once = ChatLorebookScoring.entryKeywordCount(entry, "码头", "码头", "码头")
        val many = ChatLorebookScoring.entryKeywordCount(entry, "码头", "码头码头码头码头", "码头码头码头码头")
        assertTrue("反复讨论的命中次数必须更多", many > once)
        // 但单关键词计数有上限（防刷屏主导）
        val capped = ChatLorebookScoring.entryKeywordCount(
            entry,
            "码头",
            "码头".repeat(ChatLorebookScoring.KEYWORD_COUNT_MAX * 2),
            "码头".repeat(ChatLorebookScoring.KEYWORD_COUNT_MAX * 2),
        )
        assertEquals(ChatLorebookScoring.KEYWORD_COUNT_MAX, capped)
    }

    @Test
    fun nanSemanticScoreIsTreatedAsUnavailable() {
        // NaN 经 JSON 无法往返，因此该输入不在夹具里；但语义必须与 PC 一致：
        // NaN 视为「没有真实语义命中」→ 使用词面重叠近似
        assertTrue(
            ChatLorebookScoring.shouldUseOverlapApprox(null, "甲", mapOf("甲" to Double.NaN)),
        )
        assertFalse(
            ChatLorebookScoring.shouldUseOverlapApprox(0.5, "甲", emptyMap()),
        )
    }
}