package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 A3b-2（地基）：世界书预算与分配的跨语言一致性测试
 * （对齐 fixture `lorebook-budget.json`，oracle 为 PC 的 `shared/chat-core/lorebook.ts`
 * 中真实被 runtime 调用的那批函数）。
 *
 * 这一层决定「哪些世界书条目最终进入提示词、以全文还是摘要、以及要不要发起压缩请求」。
 * Android 此前**完全没有世界书注入**（检索/渲染模块只被测试使用），
 * 因此本层是让世界书在本地模式真正生效的第一块地基。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatLorebookBudgetGoldenTest {

    private val root = ChatCoreFixtures.root("lorebook-budget")

    private fun itemOf(map: Map<String, Any?>): ChatLorebookBudget.Item =
        ChatLorebookBudget.Item(
            content = ChatCoreFixtures.str(map, "content") ?: "",
            order = ChatCoreFixtures.intOrNull(map, "order") ?: 0,
            position = ChatCoreFixtures.str(map, "position") ?: "before_char",
            depth = ChatCoreFixtures.intOrNull(map, "depth"),
            priority = ChatCoreFixtures.str(map, "priority"),
            score = (map["score"] as? Number)?.toDouble(),
            key = ChatCoreFixtures.str(map, "key"),
            summary = ChatCoreFixtures.str(map, "summary"),
            ignoreBudget = ChatCoreFixtures.boolOrNull(map, "ignoreBudget") ?: false,
            role = ChatCoreFixtures.str(map, "role"),
        )

    private fun itemsOf(list: List<Any?>): List<ChatLorebookBudget.Item> = list.map { raw ->
        @Suppress("UNCHECKED_CAST")
        itemOf(raw as Map<String, Any?>)
    }

    private fun cacheOf(map: Map<String, Any?>?): Map<String, ChatLorebookBudget.CompressionCacheEntry> {
        if (map == null) return emptyMap()
        return map.entries.associate { (key, value) ->
            @Suppress("UNCHECKED_CAST")
            val entry = value as Map<String, Any?>
            key to ChatLorebookBudget.CompressionCacheEntry(
                summary = ChatCoreFixtures.str(entry, "summary") ?: "",
                createdAt = (entry["createdAt"] as? Number)?.toLong() ?: 0L,
                lastUsedAt = (entry["lastUsedAt"] as? Number)?.toLong(),
            )
        }
    }

    @Test
    fun constantsMatchPc() {
        val constants = ChatCoreFixtures.mapOrNull(root, "constants")!!
        assertEquals(
            "alwaysRatio",
            (constants["alwaysRatio"] as Number).toDouble(),
            ChatLorebookBudget.ALWAYS_RATIO,
            1e-9,
        )
        assertEquals(
            "alwaysPlusConditionalRatio",
            (constants["alwaysPlusConditionalRatio"] as Number).toDouble(),
            ChatLorebookBudget.ALWAYS_PLUS_CONDITIONAL_RATIO,
            1e-9,
        )
        assertEquals(
            "minCompressTargetTokens",
            ChatCoreFixtures.intOrNull(constants, "minCompressTargetTokens"),
            ChatLorebookBudget.MIN_COMPRESS_TARGET_TOKENS,
        )
        assertEquals(
            "compressionCacheMaxEntries",
            ChatCoreFixtures.intOrNull(constants, "compressionCacheMaxEntries"),
            ChatLorebookBudget.COMPRESSION_CACHE_MAX_ENTRIES,
        )
    }

    @Test
    fun hashAndCompressionKeyMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val hashCases = (ChatCoreFixtures.listOrNull(root, "hashCases") as? List<Map<String, Any?>>)
            ?: error("缺少 hashCases")
        for (case in hashCases) {
            val text = ChatCoreFixtures.str(case, "text") ?: ""
            assertEquals(
                "hashString(${text.take(16)})",
                ChatCoreFixtures.str(case, "hash"),
                ChatLorebookBudget.hashString(text),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val keyCases = (ChatCoreFixtures.listOrNull(root, "compressionKeyCases") as? List<Map<String, Any?>>)
            ?: error("缺少 compressionKeyCases")
        for (case in keyCases) {
            val items = itemsOf((ChatCoreFixtures.listOrNull(case, "items") as? List<Any?>) ?: emptyList())
            assertEquals(
                "buildCompressionKey(${items.map { it.key }})",
                ChatCoreFixtures.str(case, "key"),
                ChatLorebookBudget.buildCompressionKey(items),
            )
        }
    }

    @Test
    fun globalAllocationMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "allocateCases") as? List<Map<String, Any?>>)
            ?: error("缺少 allocateCases")
        for (case in cases) {
            val globalBudget = ChatCoreFixtures.intOrNull(case, "globalBudget") ?: 0
            val bookBudgets = (ChatCoreFixtures.mapOrNull(case, "bookBudgets") ?: emptyMap())
                .mapValues { (it.value as Number).toInt() }
            val expected = ChatCoreFixtures.mapOrNull(case, "result")
            val actual = ChatLorebookBudget.allocateGlobalBudgetByBooks(globalBudget, bookBudgets)
            if (expected == null) {
                assertNull("allocate($bookBudgets) 应为 null", actual)
            } else {
                assertEquals(
                    "allocate($bookBudgets, global=$globalBudget)",
                    expected.mapValues { (it.value as Number).toInt() },
                    actual,
                )
            }
        }
    }

    @Test
    fun perBookEnforcementMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "enforceCases") as? List<Map<String, Any?>>)
            ?: error("缺少 enforceCases")
        for (case in cases) {
            val items = itemsOf((ChatCoreFixtures.listOrNull(case, "items") as? List<Any?>) ?: emptyList())
            val caps = (ChatCoreFixtures.mapOrNull(case, "bookCaps") ?: emptyMap())
                .mapValues { (it.value as Number).toInt() }
            val lbIdByKey = (ChatCoreFixtures.mapOrNull(case, "lbIdByKey") ?: emptyMap())
                .mapValues { it.value.toString() }
            val model = ChatCoreFixtures.str(case, "model") ?: "gpt-4o-mini"
            val result = ChatLorebookBudget.enforceBookBudgets(items, caps, lbIdByKey, model)
            val expectedKept = ((ChatCoreFixtures.listOrNull(case, "kept") as? List<Map<String, Any?>>)
                ?: error("缺少 kept")).map { ChatCoreFixtures.str(it, "content") to ChatCoreFixtures.str(it, "key") }
            val actualKept = result.items.map { it.content to it.key }
            assertEquals("enforce($caps) 保留集合", expectedKept, actualKept)
            assertEquals("enforce($caps) 丢弃数", ChatCoreFixtures.intOrNull(case, "dropped"), result.dropped)
        }
    }

    @Test
    fun budgetFitMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "fitCases") as? List<Map<String, Any?>>)
            ?: error("缺少 fitCases")
        for (case in cases) {
            val items = itemsOf((ChatCoreFixtures.listOrNull(case, "items") as? List<Any?>) ?: emptyList())
            val budget = ChatCoreFixtures.intOrNull(case, "budget") ?: 0
            val model = ChatCoreFixtures.str(case, "model") ?: "gpt-4o-mini"
            val cache = cacheOf(ChatCoreFixtures.mapOrNull(case, "compressionCache"))
            val result = ChatLorebookBudget.fitByPriority(items, budget, model, cache)

            val label = "fit(budget=$budget, items=${items.size})"
            val expectedKeptKeys = (ChatCoreFixtures.listOrNull(case, "keptKeys") as? List<*>)
                ?.map { if (it == null) null else it.toString() }
            assertEquals("$label.keptKeys", expectedKeptKeys, result.kept.map { it.key })
            val expectedContents = (ChatCoreFixtures.listOrNull(case, "keptContents") as? List<*>)
                ?.map { it.toString() }
            assertEquals("$label.keptContents（摘要替代会改变正文）", expectedContents, result.kept.map { it.content })
            assertEquals("$label.usedTokens", ChatCoreFixtures.intOrNull(case, "usedTokens"), result.usedTokens)
            assertEquals("$label.alwaysDropped", ChatCoreFixtures.intOrNull(case, "alwaysDropped"), result.alwaysDropped)
            assertEquals(
                "$label.conditionalDropped",
                ChatCoreFixtures.intOrNull(case, "conditionalDropped"),
                result.conditionalDropped,
            )
            assertEquals("$label.detailDropped", ChatCoreFixtures.intOrNull(case, "detailDropped"), result.detailDropped)

            val expectedRequests = ChatCoreFixtures.listOrNull(case, "compressionRequests")
            if (expectedRequests == null) {
                assertTrue("$label 不应发出压缩请求", result.compressionRequests.isEmpty())
            } else {
                assertEquals("$label 压缩请求条数", expectedRequests.size, result.compressionRequests.size)
                expectedRequests.forEachIndexed { index, raw ->
                    @Suppress("UNCHECKED_CAST")
                    val expected = raw as Map<String, Any?>
                    val actual = result.compressionRequests[index]
                    val reqLabel = "$label.requests[$index]"
                    assertEquals("$reqLabel.key", ChatCoreFixtures.str(expected, "key"), actual.key)
                    assertEquals("$reqLabel.targetTokens", ChatCoreFixtures.intOrNull(expected, "targetTokens"), actual.targetTokens)
                    assertEquals(
                        "$reqLabel.entryKeys",
                        (ChatCoreFixtures.listOrNull(expected, "entryKeys") as? List<*>)?.map { it.toString() },
                        actual.entryKeys,
                    )
                    assertEquals(
                        "$reqLabel.contents",
                        (ChatCoreFixtures.listOrNull(expected, "contents") as? List<*>)?.map { it.toString() },
                        actual.contents,
                    )
                }
            }

            val expectedHitKeys = ChatCoreFixtures.listOrNull(case, "compressionCacheHitKeys")
            if (expectedHitKeys == null) {
                assertTrue("$label 不应命中压缩缓存", result.compressionCacheHitKeys.isEmpty())
            } else {
                assertEquals(
                    "$label 缓存命中键",
                    expectedHitKeys.map { it.toString() },
                    result.compressionCacheHitKeys,
                )
            }
            val expectedCovered = (ChatCoreFixtures.listOrNull(case, "compressionCoveredKeys") as? List<*>)
                ?.map { if (it == null) null else it.toString() } ?: emptyList()
            assertEquals("$label 已覆盖条目", expectedCovered, result.compressionCoveredItems.map { it.key })
        }
    }

    @Test
    fun compressionCacheMaintenanceMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cacheCases = (ChatCoreFixtures.listOrNull(root, "cacheCases") as? List<Map<String, Any?>>)
            ?: error("缺少 cacheCases")
        for (case in cacheCases) {
            val initial = ChatCoreFixtures.mapOrNull(case, "initial")?.let { cacheOf(it) }
            val key = ChatCoreFixtures.str(case, "key") ?: ""
            val entryMap = ChatCoreFixtures.mapOrNull(case, "entry")!!
            val entry = ChatLorebookBudget.CompressionCacheEntry(
                summary = ChatCoreFixtures.str(entryMap, "summary") ?: "",
                createdAt = (entryMap["createdAt"] as? Number)?.toLong() ?: 0L,
                lastUsedAt = (entryMap["lastUsedAt"] as? Number)?.toLong(),
            )
            val result = ChatLorebookBudget.upsertCompressionCache(
                initial,
                key,
                entry,
                ChatCoreFixtures.intOrNull(case, "maxEntries") ?: ChatLorebookBudget.COMPRESSION_CACHE_MAX_ENTRIES,
            )
            assertCacheEquals(
                "upsert($key, max=${case["maxEntries"]})",
                ChatCoreFixtures.mapOrNull(case, "result")!!,
                result,
            )
        }

        @Suppress("UNCHECKED_CAST")
        val touchCases = (ChatCoreFixtures.listOrNull(root, "touchCases") as? List<Map<String, Any?>>)
            ?: error("缺少 touchCases")
        for (case in touchCases) {
            val cacheMap = ChatCoreFixtures.mapOrNull(case, "cache")
            val cache: Map<String, ChatLorebookBudget.CompressionCacheEntry>? = cacheMap?.let { cacheOf(it) }
            val keys: List<String> =
                ((ChatCoreFixtures.listOrNull(case, "keys") as? List<*>) ?: emptyList<Any?>())
                    .map { it.toString() }
            val usedAt = (case["usedAt"] as? Number)?.toLong() ?: 0L
            val result = ChatLorebookBudget.touchCompressionCache(cache, keys, usedAt)
            val expected = ChatCoreFixtures.mapOrNull(case, "result")
            if (expected == null) {
                assertNull("touch($keys) 应为 null", result)
            } else {
                assertCacheEquals("touch($keys, $usedAt)", expected, result!!)
            }
        }
    }

    private fun assertCacheEquals(
        label: String,
        expected: Map<String, Any?>,
        actual: Map<String, ChatLorebookBudget.CompressionCacheEntry>,
    ) {
        assertEquals("$label 键集合", expected.keys.sorted(), actual.keys.sorted())
        for ((key, value) in expected) {
            @Suppress("UNCHECKED_CAST")
            val entry = value as Map<String, Any?>
            val actualEntry = actual[key]!!
            assertEquals("$label[$key].summary", ChatCoreFixtures.str(entry, "summary"), actualEntry.summary)
            assertEquals(
                "$label[$key].createdAt",
                (entry["createdAt"] as? Number)?.toLong(),
                actualEntry.createdAt,
            )
            assertEquals(
                "$label[$key].lastUsedAt",
                (entry["lastUsedAt"] as? Number)?.toLong(),
                actualEntry.lastUsedAt,
            )
        }
    }

    @Test
    fun alwaysBucketHasHardCapAndNeverCompresses() {
        // always 段是硬上限 40%，超限按 order 截断且**不产生压缩请求**（PC 原语义）
        val items = (0 until 6).map { index ->
            ChatLorebookBudget.Item(
                content = "常驻条目$index。".repeat(4),
                order = index,
                position = "before_char",
                priority = "always",
                key = "a$index",
            )
        }
        val result = ChatLorebookBudget.fitByPriority(items, budget = 40, model = "gpt-4o-mini")
        assertTrue("always 超限必须截断", result.alwaysDropped > 0)
        assertTrue("always 段不参与压缩", result.compressionRequests.isEmpty())
        assertEquals("截断必须按 order 保留前缀", result.kept.map { it.order }, result.kept.map { it.order }.sorted())
    }

    @Test
    fun ignoreBudgetItemsAlwaysSurvive() {
        val items = listOf(
            ChatLorebookBudget.Item(
                content = "很长的常驻内容".repeat(100),
                order = 0,
                position = "at_end",
                priority = "always",
                ignoreBudget = true,
                key = "ignored",
            ),
            ChatLorebookBudget.Item(
                content = "普通条目。",
                order = 1,
                position = "before_char",
                priority = "conditional",
                score = 0.5,
                key = "normal",
            ),
        )
        val result = ChatLorebookBudget.fitByPriority(items, budget = 1, model = "gpt-4o-mini")
        assertTrue("ignoreBudget 条目必须始终保留", result.kept.any { it.key == "ignored" })
    }
}
