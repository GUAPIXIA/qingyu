package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 A3b-2：世界书运行时的跨语言一致性测试
 * （对齐 fixture `lorebook-runtime.json`，oracle 为 PC 真实的 `executeLorebookRuntime`）。
 *
 * 这是让世界书在 Android **真正生效**的入口：此前检索/渲染/预算/评分四层都已移植，
 * 却没有一层把它们串起来，因此用户绑定了世界书却一条都不注入。
 *
 * 夹具限定在已覆盖路径（无词法通道、概率 100/0、无时效/包含组/向量/诊断），
 * 未覆盖项在 `ChatLorebookRuntime` 的文档注释里逐条列出。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatLorebookRuntimeGoldenTest {

    private val root = ChatCoreFixtures.root("lorebook-runtime")

    private fun entryOf(map: Map<String, Any?>): ChatLorebookRuntime.Entry =
        ChatLorebookRuntime.Entry(
            id = ChatCoreFixtures.str(map, "id") ?: "",
            content = ChatCoreFixtures.str(map, "content") ?: "",
            keywords = (ChatCoreFixtures.listOrNull(map, "keywords") as? List<*>)?.map { it.toString() } ?: emptyList(),
            secondaryKeywords = (ChatCoreFixtures.listOrNull(map, "secondaryKeywords") as? List<*>)
                ?.map { it.toString() } ?: emptyList(),
            selectiveLogic = ChatCoreFixtures.str(map, "selectiveLogic"),
            useRegex = ChatCoreFixtures.boolOrNull(map, "useRegex") ?: false,
            regexFlags = ChatCoreFixtures.str(map, "regexFlags"),
            caseSensitive = ChatCoreFixtures.boolOrNull(map, "caseSensitive") ?: false,
            matchWholeWords = ChatCoreFixtures.boolOrNull(map, "matchWholeWords") ?: true,
            enabled = ChatCoreFixtures.boolOrNull(map, "enabled") ?: true,
            position = ChatCoreFixtures.str(map, "position") ?: "before_char",
            depth = ChatCoreFixtures.intOrNull(map, "depth"),
            role = ChatCoreFixtures.str(map, "role"),
            priority = ChatCoreFixtures.str(map, "priority"),
            order = ChatCoreFixtures.intOrNull(map, "order") ?: 0,
            summary = ChatCoreFixtures.str(map, "summary"),
            ignoreBudget = ChatCoreFixtures.boolOrNull(map, "ignoreBudget") ?: false,
            probability = (map["probability"] as? Number)?.toDouble(),
            preventRecursion = ChatCoreFixtures.boolOrNull(map, "preventRecursion") ?: false,
            excludeRecursion = ChatCoreFixtures.boolOrNull(map, "excludeRecursion") ?: false,
            scanDepth = ChatCoreFixtures.intOrNull(map, "scanDepth"),
            generationTriggers = (ChatCoreFixtures.listOrNull(map, "generationTriggers") as? List<*>)?.map { it.toString() },
            characterFilter = ChatCoreFixtures.mapOrNull(map, "characterFilter")?.let { filter ->
                ChatLorebookRuntime.CharacterFilter(
                    names = (ChatCoreFixtures.listOrNull(filter, "names") as? List<*>)?.map { it.toString() }
                        ?: emptyList(),
                    tags = (ChatCoreFixtures.listOrNull(filter, "tags") as? List<*>)?.map { it.toString() } ?: emptyList(),
                    exclude = ChatCoreFixtures.boolOrNull(filter, "exclude") ?: false,
                )
            },
        )

    private fun inputOf(case: Map<String, Any?>): ChatLorebookRuntime.Input {
        val books = ((ChatCoreFixtures.listOrNull(case, "lorebooks") as? List<Map<String, Any?>>)
            ?: error("缺少 lorebooks")).map { book ->
            ChatLorebookRuntime.Book(
                id = ChatCoreFixtures.str(book, "id") ?: "",
                name = ChatCoreFixtures.str(book, "name") ?: "",
                enabled = ChatCoreFixtures.boolOrNull(book, "enabled") ?: true,
                scanDepth = ChatCoreFixtures.intOrNull(book, "scanDepth"),
                tokenBudget = ChatCoreFixtures.intOrNull(book, "tokenBudget"),
                recursiveScanning = ChatCoreFixtures.boolOrNull(book, "recursiveScanning") ?: true,
                entries = ((ChatCoreFixtures.listOrNull(book, "entries") as? List<Map<String, Any?>>)
                    ?: emptyList()).map { entryOf(it) },
            )
        }
        val cache = ChatCoreFixtures.mapOrNull(case, "compressionCache")?.mapValues { (value) ->
            @Suppress("UNCHECKED_CAST")
            val entry = value as Map<String, Any?>
            ChatLorebookBudget.CompressionCacheEntry(
                summary = ChatCoreFixtures.str(entry, "summary") ?: "",
                createdAt = (entry["createdAt"] as? Number)?.toLong() ?: 0L,
            )
        } ?: emptyMap()
        return ChatLorebookRuntime.Input(
            lorebooks = books,
            scanText = ChatCoreFixtures.str(case, "scanText") ?: "",
            scanMessages = (ChatCoreFixtures.listOrNull(case, "scanMessages") as? List<*>)?.map { it.toString() },
            userName = ChatCoreFixtures.str(case, "userName") ?: "",
            charName = ChatCoreFixtures.str(case, "charName") ?: "",
            characterNames = (ChatCoreFixtures.listOrNull(case, "characterNames") as? List<*>)?.map { it.toString() }
                ?: emptyList(),
            characterTags = (ChatCoreFixtures.listOrNull(case, "characterTags") as? List<*>)?.map { it.toString() }
                ?: emptyList(),
            generationType = ChatCoreFixtures.str(case, "generationType") ?: "normal",
            messageCount = ChatCoreFixtures.intOrNull(case, "messageCount"),
            budget = ChatCoreFixtures.intOrNull(case, "budget") ?: 0,
            model = ChatCoreFixtures.str(case, "model") ?: "gpt-4o-mini",
            maxRecursiveDepth = ChatCoreFixtures.intOrNull(case, "maxRecursiveDepth") ?: 5,
            entityVocabulary = (ChatCoreFixtures.listOrNull(case, "entityVocabulary") as? List<*>)?.map { it.toString() }
                ?: emptyList(),
            recentTriggeredIds = (ChatCoreFixtures.listOrNull(case, "recentTriggeredIds") as? List<List<*>>)
                ?.map { round -> round.map { it.toString() } },
            compressionCache = cache,
            semanticEnabled = false,
            // 概率用例只用 100（必然通过）与 0（必然失败）：
            // 0 时 `random()*100 >= 0` 恒真 → 与具体随机数无关，因此无需注入随机源
            random = { Math.random() },
        )
    }

    @Test
    fun triggerPipelineAndDistributionMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "cases") as? List<Map<String, Any?>>)
            ?: error("缺少 cases")
        assertEquals("夹具用例数（含空输入与各类边界）", 12, cases.size)
        for (case in cases) {
            val index = ChatCoreFixtures.intOrNull(case, "caseIndex")
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val result = ChatLorebookRuntime.execute(inputOf(input))
            val label = "runtime#$index"

            assertEquals(
                "$label.beforeChar",
                (ChatCoreFixtures.listOrNull(case, "beforeChar") as? List<*>)?.map { it.toString() },
                result.beforeChar,
            )
            assertEquals(
                "$label.afterChar",
                (ChatCoreFixtures.listOrNull(case, "afterChar") as? List<*>)?.map { it.toString() },
                result.afterChar,
            )
            assertEquals(
                "$label.atEnd",
                (ChatCoreFixtures.listOrNull(case, "atEnd") as? List<*>)?.map { it.toString() },
                result.atEnd,
            )

            val expectedDepth = (ChatCoreFixtures.listOrNull(case, "atDepth") as? List<Map<String, Any?>>)
                ?: error("缺少 atDepth")
            assertEquals("$label.atDepth 条数", expectedDepth.size, result.atDepth.size)
            expectedDepth.forEachIndexed { depthIndex, item ->
                val depthLabel = "$label.atDepth[$depthIndex]"
                assertEquals("$depthLabel.content", ChatCoreFixtures.str(item, "content"), result.atDepth[depthIndex].content)
                assertEquals("$depthLabel.depth", ChatCoreFixtures.intOrNull(item, "depth"), result.atDepth[depthIndex].depth)
                assertEquals("$depthLabel.order", ChatCoreFixtures.intOrNull(item, "order"), result.atDepth[depthIndex].order)
                assertEquals("$depthLabel.role", ChatCoreFixtures.str(item, "role"), result.atDepth[depthIndex].role)
            }

            assertEquals("$label.triggeredCount", ChatCoreFixtures.intOrNull(case, "triggeredCount"), result.triggeredCount)
            assertEquals("$label.droppedCount", ChatCoreFixtures.intOrNull(case, "droppedCount"), result.droppedCount)
            assertEquals("$label.alwaysDropped", ChatCoreFixtures.intOrNull(case, "alwaysDropped"), result.alwaysDropped)
            assertEquals(
                "$label.conditionalDropped",
                ChatCoreFixtures.intOrNull(case, "conditionalDropped"),
                result.conditionalDropped,
            )
            assertEquals("$label.detailDropped", ChatCoreFixtures.intOrNull(case, "detailDropped"), result.detailDropped)
            assertEquals(
                "$label.bookBudgetDropped",
                ChatCoreFixtures.intOrNull(case, "bookBudgetDropped"),
                result.bookBudgetDropped,
            )
            assertEquals(
                "$label.triggeredEntryKeys",
                (ChatCoreFixtures.listOrNull(case, "triggeredEntryKeys") as? List<*>)?.map { it.toString() },
                result.triggeredEntryKeys,
            )
        }
    }

    @Test
    fun recursionTriggersContentReferencedEntries() {
        // 递归是「条目正文成为下一层扫描文本」：e1 命中「码头」，其正文含「管理员」→ e2 命中
        val input = ChatLorebookRuntime.Input(
            lorebooks = listOf(
                ChatLorebookRuntime.Book(
                    id = "lb1",
                    name = "递归",
                    entries = listOf(
                        ChatLorebookRuntime.Entry(
                            id = "e1",
                            content = "灯塔管理员住在灯塔里。",
                            keywords = listOf("码头"),
                            position = "before_char",
                            order = 0,
                        ),
                        ChatLorebookRuntime.Entry(
                            id = "e2",
                            content = "管理员有一本旧航海日志。",
                            keywords = listOf("管理员"),
                            position = "before_char",
                            order = 1,
                        ),
                    ),
                ),
            ),
            scanText = "他们在码头边。",
            budget = 500,
            model = "gpt-4o-mini",
        )
        val result = ChatLorebookRuntime.execute(input)
        assertEquals(listOf("lb1:e1", "lb1:e2"), result.triggeredEntryKeys)
        assertEquals(2, result.beforeChar.size)
    }

    @Test
    fun preventRecursionStopsTheChain() {
        val input = ChatLorebookRuntime.Input(
            lorebooks = listOf(
                ChatLorebookRuntime.Book(
                    id = "lb1",
                    name = "阻断",
                    entries = listOf(
                        ChatLorebookRuntime.Entry(
                            id = "e1",
                            content = "灯塔管理员住在灯塔里。",
                            keywords = listOf("码头"),
                            position = "before_char",
                            order = 0,
                            preventRecursion = true,
                        ),
                        ChatLorebookRuntime.Entry(
                            id = "e2",
                            content = "管理员有一本旧航海日志。",
                            keywords = listOf("管理员"),
                            position = "before_char",
                            order = 1,
                        ),
                    ),
                ),
            ),
            scanText = "他们在码头边。",
            budget = 500,
            model = "gpt-4o-mini",
        )
        val result = ChatLorebookRuntime.execute(input)
        assertEquals("preventRecursion 必须阻断递归链", listOf("lb1:e1"), result.triggeredEntryKeys)
    }

    @Test
    fun disabledBooksAndEntriesAreSkipped() {
        val input = ChatLorebookRuntime.Input(
            lorebooks = listOf(
                ChatLorebookRuntime.Book(
                    id = "lb-off",
                    name = "停用书",
                    enabled = false,
                    entries = listOf(
                        ChatLorebookRuntime.Entry(id = "e1", content = "不该出现。", keywords = listOf("码头"), position = "before_char"),
                    ),
                ),
                ChatLorebookRuntime.Book(
                    id = "lb1",
                    name = "启用书",
                    entries = listOf(
                        ChatLorebookRuntime.Entry(
                            id = "e1",
                            content = "停用条目。",
                            keywords = listOf("码头"),
                            position = "before_char",
                            enabled = false,
                        ),
                        ChatLorebookRuntime.Entry(id = "e2", content = "启用条目。", keywords = listOf("码头"), position = "before_char"),
                    ),
                ),
            ),
            scanText = "码头。",
            budget = 500,
            model = "gpt-4o-mini",
        )
        val result = ChatLorebookRuntime.execute(input)
        assertEquals(listOf("lb1:e2"), result.triggeredEntryKeys)
        assertTrue("停用书不得注入", result.beforeChar.none { it.contains("不该出现") })
    }

    @Test
    fun zeroProbabilityAlwaysFails() {
        // probability=0 → `random()*100 >= 0` 恒真 → 必然失败（与随机数无关，故可确定性断言）
        val input = ChatLorebookRuntime.Input(
            lorebooks = listOf(
                ChatLorebookRuntime.Book(
                    id = "lb1",
                    name = "概率",
                    entries = listOf(
                        ChatLorebookRuntime.Entry(
                            id = "e1",
                            content = "必然丢弃。",
                            keywords = listOf("码头"),
                            position = "before_char",
                            probability = 0.0,
                        ),
                    ),
                ),
            ),
            scanText = "码头。",
            budget = 500,
            model = "gpt-4o-mini",
        )
        val result = ChatLorebookRuntime.execute(input)
        assertTrue("概率 0 的条目不得注入", result.triggeredEntryKeys.isEmpty())
    }

    @Test
    fun scanDepthRestrictsWhichMessagesAreScanned() {
        // 书级窗口 1 只扫最近一条；条目级窗口 3 能扫到更早的消息
        val input = ChatLorebookRuntime.Input(
            lorebooks = listOf(
                ChatLorebookRuntime.Book(
                    id = "lb1",
                    name = "窗口",
                    scanDepth = 1,
                    entries = listOf(
                        ChatLorebookRuntime.Entry(id = "e1", content = "书级窗口。", keywords = listOf("码头"), position = "before_char", order = 0),
                        ChatLorebookRuntime.Entry(
                            id = "e2",
                            content = "条目窗口。",
                            keywords = listOf("码头"),
                            position = "before_char",
                            order = 1,
                            scanDepth = 3,
                        ),
                    ),
                ),
            ),
            scanText = "整体文本不含关键词。",
            scanMessages = listOf("他们在码头边。", "后来下了雨。", "夜深了。"),
            budget = 500,
            model = "gpt-4o-mini",
        )
        val result = ChatLorebookRuntime.execute(input)
        assertEquals("只有条目级窗口能扫到更早消息", listOf("lb1:e2"), result.triggeredEntryKeys)
    }
}
