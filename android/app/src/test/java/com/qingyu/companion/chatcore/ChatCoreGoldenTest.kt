package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-01：Kotlin chat-core 与 TypeScript（PC）实现的跨语言一致性测试。
 *
 * 数据源：`shared/fixtures/cross-platform/chat-core/` 下的 golden JSON（由
 * `shared/__tests__/chatCoreGolden.test.ts` 从 TS 实现生成）。
 * 任何差异都意味着两端业务规则漂移：必须先改契约（fixture）或同时修两端，
 * 不允许只改 Kotlin 让它「看起来对」。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatCoreGoldenTest {

    // ---------------------------------------------------------------- variables

    @Test
    fun variablesMatchGolden() {
        val cases = ChatCoreFixtures.cases("variables")
        assertTrue("variables fixture 不应为空", cases.isNotEmpty())
        for (case in cases) {
            val text = ChatCoreFixtures.str(case, "text")!!
            val userName = ChatCoreFixtures.str(case, "userName")!!
            val charName = ChatCoreFixtures.str(case, "charName")!!
            val original = ChatCoreFixtures.str(case, "original")
            val expected = ChatCoreFixtures.str(case, "replaced")!!
            val actual = ChatVariables.replaceVariables(text, userName, charName, original)
            assertEquals("replaceVariables(text=$text)", expected, actual)
        }
    }

    @Test
    fun displayNameFollowsTranslationRules() {
        assertEquals("", ChatVariables.getDisplayName(null, null))
        assertEquals("Original", ChatVariables.getDisplayName("Original", null))
        assertEquals("译名 (Original)", ChatVariables.getDisplayName("Original", "译名"))
        assertEquals("Same", ChatVariables.getDisplayName("Same", "Same"))
    }

    // ---------------------------------------------------------------- macros

    @Test
    fun macrosMatchGolden() {
        val root = ChatCoreFixtures.root("macros")
        val ctxMap = ChatCoreFixtures.mapOrNull(root, "context")!!
        val ctx = ChatMacros.Context(
            userName = ChatCoreFixtures.str(ctxMap, "userName")!!,
            charName = ChatCoreFixtures.str(ctxMap, "charName")!!,
            originalCharName = ChatCoreFixtures.str(ctxMap, "originalCharName"),
            groupName = ChatCoreFixtures.str(ctxMap, "groupName"),
            lastMessage = ChatCoreFixtures.str(ctxMap, "lastMessage"),
            lastUserMessage = ChatCoreFixtures.str(ctxMap, "lastUserMessage"),
        )
        val cases = ChatCoreFixtures.cases("macros")
        assertTrue(cases.isNotEmpty())

        for (case in cases) {
            val text = ChatCoreFixtures.str(case, "text")!!
            val hasMacro = ChatCoreFixtures.boolOrNull(case, "hasMacro")!!
            val normalized = ChatCoreFixtures.str(case, "normalized")!!
            @Suppress("UNCHECKED_CAST")
            val options = ChatCoreFixtures.listOrNull(case, "randomOptions") as? List<String>
            val idShape = ChatCoreFixtures.boolOrNull(case, "idShape")

            assertEquals("hasMacro(text=$text)", hasMacro, ChatMacros.hasMacro(text))

            // 固定非确定来源：唯一选项 / 取列表首项；id 用固定随机源保证形状
            ChatMacros.random = kotlin.random.Random(1234)
            val expanded = ChatMacros.expandMacros(text, ctx)
            val chosen = when {
                options == null -> null
                options.size > 1 -> options.firstOrNull { expanded.startsWith(it) } ?: options.first()
                else -> options.firstOrNull { it.isNotEmpty() }
            }
            var actual = expanded
            if (chosen != null) actual = actual.replace(chosen, "<RANDOM>")
            if (text.contains("{{id}}")) actual = actual.replace(Regex("[a-z0-9]{6}"), "<ID>")

            assertEquals("expandMacros(text=$text)", normalized, actual)
            if (idShape == true) {
                val idPart = expanded.substringBefore(" 长度不定")
                assertTrue("{{id}} 应为 6 位 [a-z0-9]，实际 $idPart", Regex("^[a-z0-9]{6}$").matches(idPart))
            }
        }
    }

    @Test
    fun macroSplitArgsHandlesEscapeAndTrim() {
        assertEquals(listOf("a", "b"), ChatMacros.splitArgs("a|b"))
        assertEquals(listOf("a|b"), ChatMacros.splitArgs("a\\|b"))
        assertEquals(listOf("", ""), ChatMacros.splitArgs("|"))
        assertEquals(emptyList<String>(), ChatMacros.splitArgs(""))
        assertEquals(emptyList<String>(), ChatMacros.splitArgs(null))
        assertEquals(listOf("a", "b"), ChatMacros.splitArgs("  a  |  b  "))
    }

    @Test
    fun buildMacroContextUsesLastNonBlankMessages() {
        val messages = listOf(
            TestMessage("user", "一"),
            TestMessage("assistant", "二"),
            TestMessage("user", "三"),
            TestMessage("assistant", "   "),
        )
        val ctx = ChatMacros.buildContext(messages, userName = "u", charName = "c", groupName = "g")
        assertEquals("三", ctx.lastMessage)
        assertEquals("三", ctx.lastUserMessage)
        assertEquals("g", ctx.groupName)

        val empty = ChatMacros.buildContext(null, userName = "u", charName = "c")
        assertEquals("", empty.lastMessage)
        assertEquals("", empty.lastUserMessage)
    }

    private data class TestMessage(override val role: String, override val content: String) :
        ChatMacros.MessageLike

    // ---------------------------------------------------------------- regex

    private fun ruleFrom(map: Map<String, Any?>): ChatRegex.Rule = ChatRegex.Rule(
        id = ChatCoreFixtures.str(map, "id") ?: "r",
        name = ChatCoreFixtures.str(map, "name") ?: "r",
        pattern = ChatCoreFixtures.str(map, "pattern") ?: "",
        replacement = ChatCoreFixtures.str(map, "replacement") ?: "",
        flags = ChatCoreFixtures.str(map, "flags") ?: "g",
        enabled = ChatCoreFixtures.boolOrNull(map, "enabled") ?: true,
        scope = ChatCoreFixtures.str(map, "scope") ?: "output",
        group = ChatCoreFixtures.str(map, "group"),
        stage = ChatCoreFixtures.str(map, "stage") ?: "text",
        triggerPattern = ChatCoreFixtures.str(map, "triggerPattern"),
        triggerFlags = ChatCoreFixtures.str(map, "triggerFlags") ?: "i",
        stopStrings = (ChatCoreFixtures.listOrNull(map, "stopStrings") as? List<*>)?.map { it.toString() } ?: emptyList(),
    )

    private fun rulesFrom(root: Map<String, Any?>): List<ChatRegex.Rule> =
        (ChatCoreFixtures.listOrNull(root, "rules") as? List<Map<String, Any?>>)?.map { ruleFrom(it) } ?: emptyList()

    @Test
    fun regexApplyMatchesGolden() {
        val root = ChatCoreFixtures.root("regex-apply")
        val rules = rulesFrom(root)
        val cases = ChatCoreFixtures.cases("regex-apply")
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val text = ChatCoreFixtures.str(case, "text")!!
            val scope = ChatCoreFixtures.str(case, "scope")!!
            val stage = ChatCoreFixtures.str(case, "stage")!!
            val result = ChatCoreFixtures.mapOrNull(case, "result")!!
            val actual = ChatRegex.applyRegexRules(text, rules, scope, stage)
            assertEquals("text=$scope/$stage", ChatCoreFixtures.str(result, "text"), actual.text)
            assertEquals("applied", ChatCoreFixtures.intOrNull(result, "applied"), actual.applied)
            assertEquals("matched", ChatCoreFixtures.intOrNull(result, "matched"), actual.matched)
        }
    }

    @Test
    fun regexOutputMatchesGolden() {
        val root = ChatCoreFixtures.root("regex-apply")
        val rules = rulesFrom(root)
        for (case in ChatCoreFixtures.cases("regex-output")) {
            val text = ChatCoreFixtures.str(case, "text")!!
            val expected = ChatCoreFixtures.str(case, "result")!!
            assertEquals("applyOutputRegexRules(text=$text)", expected, ChatRegex.applyOutputRegexRules(text, rules))
        }
    }

    @Test
    fun regexSingleRuleMatchesGolden() {
        val root = ChatCoreFixtures.root("regex-apply")
        val rules = rulesFrom(root).associateBy { it.id }
        for (case in ChatCoreFixtures.cases("regex-single-rule")) {
            val text = ChatCoreFixtures.str(case, "text")!!
            @Suppress("UNCHECKED_CAST")
            val appliedList = ChatCoreFixtures.listOrNull(case, "applied") as? List<Map<String, Any?>>
                ?: error("regex-single-rule 缺少 applied")
            for (entry in appliedList) {
                val id = ChatCoreFixtures.str(entry, "id")!!
                val rule = rules[id] ?: error("缺少规则 $id")
                val expectedText = ChatCoreFixtures.str(entry, "text")!!
                val expectedReplaced = ChatCoreFixtures.boolOrNull(entry, "replaced")!!
                val (actualText, actualReplaced) = ChatRegex.applyRuleOnce(text, rule)
                assertEquals("applyRuleOnce($id, text=$text)", expectedText, actualText)
                assertEquals("applyRuleOnce($id).replaced", expectedReplaced, actualReplaced)
            }
        }
    }

    @Test
    fun regexStopsMatchGolden() {
        val root = ChatCoreFixtures.root("regex-apply")
        val rules = rulesFrom(root)
        val stopRoot = ChatCoreFixtures.root("regex-stops")
        val collected = (ChatCoreFixtures.listOrNull(stopRoot, "collectedStops") as? List<*>)
            ?.map { it.toString() } ?: emptyList()
        assertEquals("collectStopStrings", collected, ChatRegex.collectStopStrings(rules))

        for (case in ChatCoreFixtures.cases("regex-stops")) {
            val text = ChatCoreFixtures.str(case, "text")!!
            val stops = (ChatCoreFixtures.listOrNull(case, "stops") as? List<*>)?.map { it.toString() } ?: emptyList()
            val expectedIndex = ChatCoreFixtures.intOrNull(case, "findStopIndex")!!
            val truncated = ChatCoreFixtures.mapOrNull(case, "truncated")!!
            assertEquals("findStopIndex(text=$text)", expectedIndex, ChatRegex.findStopIndex(text, stops))
            val (actualText, actualStopped) = ChatRegex.truncateAtStop(text, stops)
            assertEquals("truncateAtStop(text=$text).text", ChatCoreFixtures.str(truncated, "text"), actualText)
            assertEquals(
                "truncateAtStop(text=$text).stopped",
                ChatCoreFixtures.boolOrNull(truncated, "stopped"),
                actualStopped,
            )
        }
    }

    @Test
    fun regexPredicatesMatchGolden() {
        val root = ChatCoreFixtures.root("regex-apply")
        val rules = rulesFrom(root).associateBy { it.id }
        val predicateRoot = ChatCoreFixtures.root("regex-predicates")

        @Suppress("UNCHECKED_CAST")
        val predicates = ChatCoreFixtures.listOrNull(predicateRoot, "predicateCases") as? List<Map<String, Any?>>
            ?: error("缺少 predicateCases")
        for (case in predicates) {
            val rule = rules[ChatCoreFixtures.str(case, "id")]!!
            val scope = ChatCoreFixtures.str(case, "scope")!!
            val stage = ChatCoreFixtures.str(case, "stage")!!
            assertEquals(
                "matchesScope(${rule.id}, $scope)",
                ChatCoreFixtures.boolOrNull(case, "matchesScope"),
                ChatRegex.ruleMatchesScope(rule, scope),
            )
            assertEquals(
                "matchesStage(${rule.id}, $scope, $stage)",
                ChatCoreFixtures.boolOrNull(case, "matchesStage"),
                ChatRegex.ruleMatchesStage(rule, scope, stage),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val triggers = ChatCoreFixtures.listOrNull(predicateRoot, "triggerCases") as? List<Map<String, Any?>>
            ?: error("缺少 triggerCases")
        for (case in triggers) {
            val rule = rules[ChatCoreFixtures.str(case, "id")]!!
            val text = ChatCoreFixtures.str(case, "text")!!
            assertEquals(
                "ruleTriggers(${rule.id}, text=$text)",
                ChatCoreFixtures.boolOrNull(case, "triggers"),
                ChatRegex.ruleTriggers(rule, text),
            )
        }
    }

    @Test
    fun regexSafeMatchesGolden() {
        for (case in ChatCoreFixtures.cases("regex-safe")) {
            val pattern = ChatCoreFixtures.str(case, "pattern")!!
            val flags = ChatCoreFixtures.str(case, "flags")!!
            val ok = ChatCoreFixtures.boolOrNull(case, "ok")!!
            assertEquals("safeRegExp(len=${pattern.length})", ok, ChatRegex.safeRegExp(pattern, flags) != null)
        }
    }

    // ---------------------------------------------------------------- prompt converters

    private fun messagesFrom(root: Map<String, Any?>): List<ChatPromptConverters.ChatMessage> {
        @Suppress("UNCHECKED_CAST")
        val list = ChatCoreFixtures.listOrNull(root, "messages") as? List<Map<String, Any?>> ?: emptyList()
        return list.map { m ->
            ChatPromptConverters.ChatMessage(
                role = ChatCoreFixtures.str(m, "role")!!,
                content = ChatCoreFixtures.str(m, "content") ?: "",
                images = (ChatCoreFixtures.listOrNull(m, "images") as? List<*>)?.map { it.toString() },
                keepSeparate = ChatCoreFixtures.boolOrNull(m, "keepSeparate") ?: false,
            )
        }
    }

    /** 把消息列表转成 fixture 可比较的结构（只比较 role/content/images）。 */
    private fun messageShape(list: List<ChatPromptConverters.ChatMessage>): List<Map<String, Any?>> = list.map { m ->
        val map = LinkedHashMap<String, Any?>()
        map["role"] = m.role
        map["content"] = m.content
        if (!m.images.isNullOrEmpty()) map["images"] = m.images
        map
    }

    /** 从 fixture 的期望消息列表里剥掉 fixture 没写的字段（如空的 images）。 */
    private fun expectedShape(list: List<Map<String, Any?>>): List<Map<String, Any?>> = list.map { m ->
        val map = LinkedHashMap<String, Any?>()
        map["role"] = ChatCoreFixtures.str(m, "role")
        map["content"] = ChatCoreFixtures.str(m, "content") ?: ""
        (ChatCoreFixtures.listOrNull(m, "images") as? List<*>)?.takeIf { it.isNotEmpty() }?.let { images ->
            map["images"] = images.map { it.toString() }
        }
        map
    }

    @Test
    fun promptConvertersMatchGolden() {
        val names = ChatPromptConverters.PromptNames(charName = "c", userName = "u")
        for (case in ChatCoreFixtures.cases("prompt-converters")) {
            val messages = messagesFrom(case)
            assertEquals("openai", expectedShape(field(case, "openai")), messageShape(ChatPromptConverters.convertToOpenAI(messages)))
            assertEquals("claude", expectedShape(field(case, "claude")), messageShape(ChatPromptConverters.convertToClaude(messages, names)))
            assertEquals("gemini", expectedShape(field(case, "gemini")), messageShape(ChatPromptConverters.convertToGemini(messages)))
            assertEquals(
                "viaClaude",
                expectedShape(field(case, "viaClaude")),
                messageShape(ChatPromptConverters.convertMessages("claude-3-5-sonnet", messages, names)),
            )
            assertEquals(
                "viaGemini",
                expectedShape(field(case, "viaGemini")),
                messageShape(ChatPromptConverters.convertMessages("gemini-1.5-pro", messages, names)),
            )
            assertEquals(
                "viaOpenai",
                expectedShape(field(case, "viaOpenai")),
                messageShape(ChatPromptConverters.convertMessages("gpt-4o", messages, names)),
            )
            assertEquals(
                "withPrefix",
                expectedShape(field(case, "withPrefix")),
                messageShape(ChatPromptConverters.addAssistantPrefix(messages, "前缀")),
            )
            assertEquals(
                "withPrefixNoArg",
                expectedShape(field(case, "withPrefixNoArg")),
                messageShape(ChatPromptConverters.addAssistantPrefix(messages)),
            )
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun field(case: Map<String, Any?>, key: String): List<Map<String, Any?>> =
        case[key] as? List<Map<String, Any?>> ?: emptyList()

    // ---------------------------------------------------------------- 后处理

    @Test
    fun messagePostProcessMatchesGolden() {
        for (case in ChatCoreFixtures.cases("message-post-process")) {
            val messages = messagesFrom(case)
            assertEquals("merged", expectedShape(field(case, "merged")), messageShape(ChatMessagePostProcess.mergeConsecutiveMessages(messages)))
            assertEquals("strict", expectedShape(field(case, "strict")), messageShape(ChatMessagePostProcess.strictAlternatingMessages(messages)))
            assertEquals("semi", expectedShape(field(case, "semi")), messageShape(ChatMessagePostProcess.semiStrictMessages(messages)))

            @Suppress("UNCHECKED_CAST")
            val dialogue = ChatCoreFixtures.listOrNull(case, "dialogue") as? List<Map<String, Any?>>
                ?: error("缺少 dialogue")
            for (d in dialogue) {
                val text = ChatCoreFixtures.str(d, "text")!!
                val name = ChatCoreFixtures.str(d, "name")!!
                val mode = ChatCoreFixtures.str(d, "mode")!!
                val expected = ChatCoreFixtures.str(d, "result")!!
                val actual = ChatMessagePostProcess.normalizeRoleplayDialoguePrefixes(text, name, mode)
                assertEquals("dialogue(text=$text,name=$name,mode=$mode)", expected, actual)
            }
        }
    }

    @Test
    fun thoughtExtractionMatchesGolden() {
        for (case in ChatCoreFixtures.cases("thought")) {
            val text = ChatCoreFixtures.str(case, "text")!!
            val extract = ChatCoreFixtures.mapOrNull(case, "extract")!!
            val expectedThought = ChatCoreFixtures.str(extract, "thought")
            val expectedContent = ChatCoreFixtures.str(extract, "content")!!
            val expectedFallback = ChatCoreFixtures.boolOrNull(extract, "isFallback")!!

            val actual = ChatMessagePostProcess.extractThought(text)
            assertEquals("extractThought(text=$text).thought", expectedThought, actual.thought)
            assertEquals("extractThought(text=$text).content", expectedContent, actual.content)
            assertEquals("extractThought(text=$text).isFallback", expectedFallback, actual.isFallback)

            assertEquals(
                "stripThought(text=$text)",
                ChatCoreFixtures.str(case, "stripped")!!,
                ChatMessagePostProcess.stripThought(text),
            )
            assertEquals(
                "stripThoughtTags(text=$text)",
                ChatCoreFixtures.str(case, "tagsOnly")!!,
                ChatMessagePostProcess.stripThoughtTags(text),
            )
        }
    }

    @Test
    fun continuationSeamMatchesGolden() {
        for (case in ChatCoreFixtures.cases("continuation-seam")) {
            val prev = ChatCoreFixtures.str(case, "prev")!!
            val next = ChatCoreFixtures.str(case, "next")!!
            assertEquals("seam(prev=$prev)", ChatCoreFixtures.str(case, "seam"), ChatMessagePostProcess.trimContinuationSeam(prev, next))
            assertEquals(
                "overlapDefault8(prev=$prev)",
                ChatCoreFixtures.str(case, "overlapDefault8"),
                ChatMessagePostProcess.trimContinuationOverlap(prev, next),
            )
            assertEquals(
                "overlapCustom4(prev=$prev)",
                ChatCoreFixtures.str(case, "overlapCustom4"),
                ChatMessagePostProcess.trimContinuationOverlap(prev, next, 4),
            )
            assertEquals(
                "overlapCustom3(prev=$prev)",
                ChatCoreFixtures.str(case, "overlapCustom3"),
                ChatMessagePostProcess.trimContinuationOverlap(prev, next, 3),
            )
        }
    }

    // ---------------------------------------------------------------- 世界书检索/渲染

    private fun bookFrom(map: Map<String, Any?>): ChatLorebookRetrieval.Book {
        @Suppress("UNCHECKED_CAST")
        val entries = (ChatCoreFixtures.listOrNull(map, "entries") as? List<Map<String, Any?>>) ?: emptyList()
        return ChatLorebookRetrieval.Book(
            id = ChatCoreFixtures.str(map, "id")!!,
            name = ChatCoreFixtures.str(map, "name") ?: "",
            description = ChatCoreFixtures.str(map, "description") ?: "",
            enabled = ChatCoreFixtures.boolOrNull(map, "enabled") ?: true,
            scanDepth = ChatCoreFixtures.intOrNull(map, "scanDepth") ?: 4,
            revision = ChatCoreFixtures.mapOrNull(map, "runtime")?.let { ChatCoreFixtures.intOrNull(it, "revision") },
            entries = entries.map { entry ->
                ChatLorebookRetrieval.Entry(
                    id = ChatCoreFixtures.str(entry, "id")!!,
                    keywords = (ChatCoreFixtures.listOrNull(entry, "keywords") as? List<*>)?.map { it.toString() } ?: emptyList(),
                    content = ChatCoreFixtures.str(entry, "content") ?: "",
                    enabled = ChatCoreFixtures.boolOrNull(entry, "enabled") ?: true,
                    summary = ChatCoreFixtures.str(entry, "summary"),
                    runtime = ChatCoreFixtures.mapOrNull(entry, "runtime")?.let { runtime ->
                        ChatLorebookRetrieval.Runtime(title = ChatCoreFixtures.str(runtime, "title"))
                    },
                )
            },
        )
    }

    @Test
    fun lexicalTokenizeMatchesGolden() {
        for (case in ChatCoreFixtures.cases("lorebook-tokenize")) {
            val text = ChatCoreFixtures.str(case, "text")!!
            val expected = (ChatCoreFixtures.listOrNull(case, "tokens") as? List<*>)?.map { it.toString() } ?: emptyList()
            assertEquals("tokenize(text=$text)", expected, ChatLorebookRetrieval.tokenizeLexicalText(text))
        }
    }

    @Test
    fun lexicalSearchMatchesGolden() {
        val root = ChatCoreFixtures.root("lorebook-search")
        val providerId = ChatCoreFixtures.str(root, "providerId")
        assertEquals(
            "provider id 必须与 TS 一致",
            "local.lexical.${ChatLorebookRetrieval.LEXICAL_ANALYZER_VERSION}",
            providerId,
        )
        @Suppress("UNCHECKED_CAST")
        val corpus = ((ChatCoreFixtures.listOrNull(root, "corpus") as? List<Map<String, Any?>>) ?: error("缺少 corpus"))
            .map { bookFrom(it) }

        val provider = ChatLorebookRetrieval.Provider()
        for (case in ChatCoreFixtures.cases("lorebook-search")) {
            val query = ChatCoreFixtures.str(case, "query")!!
            val topK = ChatCoreFixtures.intOrNull(case, "topK")
            val threshold = (case["threshold"] as? Number)?.toDouble()
            val actual = provider.search(
                query = query,
                books = corpus,
                topK = topK ?: ChatLorebookRetrieval.DEFAULT_TOP_K,
                threshold = threshold ?: ChatLorebookRetrieval.DEFAULT_THRESHOLD,
            )

            @Suppress("UNCHECKED_CAST")
            val expected = (ChatCoreFixtures.listOrNull(case, "hits") as? List<Map<String, Any?>>) ?: emptyList()
            assertEquals("hits 条数(query=$query, topK=$topK)", expected.size, actual.size)
            expected.forEachIndexed { index, exp ->
                val act = actual[index]
                val label = "query=$query #$index"
                assertEquals("$label key", ChatCoreFixtures.str(exp, "key"), act.key)
                assertEquals("$label bookId", ChatCoreFixtures.str(exp, "bookId"), act.bookId)
                assertEquals("$label entryId", ChatCoreFixtures.str(exp, "entryId"), act.entryId)
                assertEquals("$label rank", ChatCoreFixtures.intOrNull(exp, "rank"), act.rank)
                assertEquals(
                    "$label matchedTokens",
                    (ChatCoreFixtures.listOrNull(exp, "matchedTokens") as? List<*>)?.map { it.toString() },
                    act.matchedTokens,
                )
                assertEqualsApprox("$label score", (exp["score"] as Number).toDouble(), act.score)
                assertEqualsApprox("$label rawScore", (exp["rawScore"] as Number).toDouble(), act.rawScore)
            }
        }
    }

    /** 浮点比较：两端同为 IEEE754 双精度，允许极小相对误差以吸收运算结合顺序差异。 */
    private fun assertEqualsApprox(label: String, expected: Double, actual: Double) {
        val tolerance = 1e-9 * maxOf(1.0, kotlin.math.abs(expected))
        assertTrue("$label 期望 $expected 实际 $actual（容差 $tolerance）", kotlin.math.abs(expected - actual) <= tolerance)
    }

    @Test
    fun retrievalFusionMatchesGolden() {
        for (case in ChatCoreFixtures.cases("retrieval-fusion")) {
            @Suppress("UNCHECKED_CAST")
            val channelsRaw = ChatCoreFixtures.mapOrNull(case, "channels") ?: emptyMap()
            val channels = channelsRaw.mapValues { (_, value) ->
                @Suppress("UNCHECKED_CAST")
                ((value as? List<Map<String, Any?>>) ?: emptyList()).map {
                    ChatLorebookRetrieval.RankedHit(
                        key = ChatCoreFixtures.str(it, "key")!!,
                        score = (it["score"] as Number).toDouble(),
                    )
                }
            }
            val options = ChatCoreFixtures.mapOrNull(case, "options")
            val k = options?.let { ChatCoreFixtures.intOrNull(it, "k") } ?: 60
            val weights: Map<String, Double> =
                (options?.let { ChatCoreFixtures.mapOrNull(it, "weights") } ?: emptyMap<String, Any?>())
                    .mapValues { (_, v) -> (v as Number).toDouble() }

            val actual = ChatLorebookRetrieval.reciprocalRankFusion(channels, k, weights)
            @Suppress("UNCHECKED_CAST")
            val expected = (ChatCoreFixtures.listOrNull(case, "fused") as? List<Map<String, Any?>>) ?: emptyList()
            assertEquals("fused 条数", expected.size, actual.size)
            expected.forEachIndexed { index, exp ->
                val act = actual[index]
                assertEquals("fused #$index key", ChatCoreFixtures.str(exp, "key"), act.key)
                assertEqualsApprox("fused #$index score", (exp["score"] as Number).toDouble(), act.score)
                assertEqualsApprox(
                    "fused #$index normalizedScore",
                    (exp["normalizedScore"] as Number).toDouble(),
                    act.normalizedScore,
                )
                val expRanks = (ChatCoreFixtures.mapOrNull(exp, "ranks") ?: emptyMap())
                    .mapValues { (_, v) -> (v as Number).toInt() }
                assertEquals("fused #$index ranks", expRanks, act.ranks)
                val expScores = (ChatCoreFixtures.mapOrNull(exp, "scores") ?: emptyMap())
                    .mapValues { (_, v) -> (v as Number).toDouble() }
                assertEquals("fused #$index scores.keys", expScores.keys, act.scores.keys)
                expScores.forEach { (channel, value) ->
                    assertEqualsApprox("fused #$index scores.$channel", value, act.scores.getValue(channel))
                }
            }
        }
    }

    private fun insertionFrom(map: Map<String, Any?>): ChatLorebookRenderer.Insertion =
        when (val kind = ChatCoreFixtures.str(map, "kind")) {
            "chat" -> ChatLorebookRenderer.Insertion.Chat(
                depth = (map["depth"] as Number).toDouble(),
                role = ChatCoreFixtures.str(map, "role"),
            )
            "prompt" -> ChatLorebookRenderer.Insertion.Prompt(ChatCoreFixtures.str(map, "anchor")!!)
            "outlet" -> ChatLorebookRenderer.Insertion.Outlet(ChatCoreFixtures.str(map, "name") ?: "")
            "custom" -> ChatLorebookRenderer.Insertion.Custom(
                source = ChatCoreFixtures.str(map, "source") ?: "",
                value = map["value"],
            )
            else -> error("未知 insertion kind=$kind")
        }

    @Test
    fun lorebookRenderMatchesGolden() {
        for (case in ChatCoreFixtures.cases("lorebook-render")) {
            @Suppress("UNCHECKED_CAST")
            val items = ((ChatCoreFixtures.listOrNull(case, "items") as? List<Map<String, Any?>>) ?: emptyList())
                .map { item ->
                    ChatLorebookRenderer.RenderItem(
                        content = ChatCoreFixtures.str(item, "content")!!,
                        order = ChatCoreFixtures.intOrNull(item, "order") ?: 0,
                        insertion = insertionFrom(ChatCoreFixtures.mapOrNull(item, "insertion")!!),
                        key = ChatCoreFixtures.str(item, "key"),
                    )
                }
            val plan = ChatCoreFixtures.mapOrNull(case, "plan")!!
            val actual = ChatLorebookRenderer.render(items)

            assertEquals("beforeCharacter", strings(plan, "beforeCharacter"), actual.beforeCharacter)
            assertEquals("afterCharacter", strings(plan, "afterCharacter"), actual.afterCharacter)
            assertEquals("beforeExamples", strings(plan, "beforeExamples"), actual.beforeExamples)
            assertEquals("afterExamples", strings(plan, "afterExamples"), actual.afterExamples)
            assertEquals("authorsNoteTop", strings(plan, "authorsNoteTop"), actual.authorsNoteTop)
            assertEquals("authorsNoteBottom", strings(plan, "authorsNoteBottom"), actual.authorsNoteBottom)
            assertEquals("promptEnd", strings(plan, "promptEnd"), actual.promptEnd)

            @Suppress("UNCHECKED_CAST")
            val expChat = (ChatCoreFixtures.listOrNull(plan, "chat") as? List<Map<String, Any?>>) ?: emptyList()
            assertEquals("chat 条数", expChat.size, actual.chat.size)
            expChat.forEachIndexed { index, exp ->
                val act = actual.chat[index]
                assertEquals("chat #$index content", ChatCoreFixtures.str(exp, "content"), act.content)
                assertEquals("chat #$index order", ChatCoreFixtures.intOrNull(exp, "order"), act.order)
                assertEquals("chat #$index depth", ChatCoreFixtures.intOrNull(exp, "depth"), act.depth)
                assertEquals("chat #$index role", ChatCoreFixtures.str(exp, "role"), act.role)
            }

            val expOutlets = (ChatCoreFixtures.mapOrNull(plan, "outlets") ?: emptyMap()).mapValues { (_, v) ->
                (v as List<*>).map { it.toString() }
            }
            assertEquals("outlets", expOutlets, actual.outlets)

            @Suppress("UNCHECKED_CAST")
            val expFallbacks = (ChatCoreFixtures.listOrNull(plan, "fallbacks") as? List<Map<String, Any?>>) ?: emptyList()
            assertEquals("fallbacks 条数", expFallbacks.size, actual.fallbacks.size)
            expFallbacks.forEachIndexed { index, exp ->
                val act = actual.fallbacks[index]
                assertEquals("fallback #$index key", ChatCoreFixtures.str(exp, "key"), act.key)
                assertEquals("fallback #$index source", ChatCoreFixtures.str(exp, "source"), act.source)
                assertEquals("fallback #$index target", ChatCoreFixtures.str(exp, "target"), act.target)
                assertEquals("fallback #$index reason", ChatCoreFixtures.str(exp, "reason"), act.reason)
            }

            @Suppress("UNCHECKED_CAST")
            val expDecisions = (ChatCoreFixtures.listOrNull(plan, "decisions") as? List<Map<String, Any?>>) ?: emptyList()
            assertEquals("decisions 条数", expDecisions.size, actual.decisions.size)
            expDecisions.forEachIndexed { index, exp ->
                val act = actual.decisions[index]
                assertEquals("decision #$index key", ChatCoreFixtures.str(exp, "key"), act.key)
                assertEquals("decision #$index status", ChatCoreFixtures.str(exp, "status"), act.status)
                assertEquals("decision #$index target", ChatCoreFixtures.str(exp, "target"), act.target)
                assertEquals("decision #$index reason", ChatCoreFixtures.str(exp, "reason"), act.reason)
            }
        }
    }

    private fun strings(map: Map<String, Any?>, key: String): List<String> =
        (ChatCoreFixtures.listOrNull(map, key) as? List<*>)?.map { it.toString() } ?: emptyList()

    // ---------------------------------------------------------------- 长记忆窗口

    private data class TestWindowMessage(override val id: String, override val content: String) :
        ChatMemoryWindow.WindowMessage

    /** fixture 用字符串哨兵承载 `NaN`/`Infinity`（JSON 无此类型）。 */
    private fun sentinel(value: Any?): Double = when (value) {
        null -> Double.NaN
        is String -> when (value) {
            "NaN" -> Double.NaN
            "Infinity" -> Double.POSITIVE_INFINITY
            "-Infinity" -> Double.NEGATIVE_INFINITY
            else -> error("未知哨兵：$value")
        }
        is Number -> value.toDouble()
        else -> error("预算参数类型非法：$value")
    }

    @Test
    fun memoryBudgetMatchesGolden() {
        val root = ChatCoreFixtures.root("memory-budget")
        val constants = ChatCoreFixtures.mapOrNull(root, "constants")!!
        assertEquals(
            "MEMORY_SUMMARY_INPUT_TOKEN_BUDGET",
            ChatCoreFixtures.intOrNull(constants, "inputTokenBudget"),
            ChatMemoryWindow.MEMORY_SUMMARY_INPUT_TOKEN_BUDGET,
        )
        assertEquals(
            "MEMORY_SUMMARY_MIN_INPUT_TOKEN_BUDGET",
            ChatCoreFixtures.intOrNull(constants, "minInputTokenBudget"),
            ChatMemoryWindow.MEMORY_SUMMARY_MIN_INPUT_TOKEN_BUDGET,
        )
        assertEquals(
            "MEMORY_SUMMARY_OVERLAP_COUNT",
            ChatCoreFixtures.intOrNull(constants, "overlapCount"),
            ChatMemoryWindow.MEMORY_SUMMARY_OVERLAP_COUNT,
        )

        for (case in ChatCoreFixtures.cases("memory-budget")) {
            val expected = ChatCoreFixtures.intOrNull(case, "resolved")!!
            val actual = ChatMemoryWindow.resolveMemorySummaryInputBudget(
                maxContext = sentinel(case["maxContext"]),
                systemPromptTokens = sentinel(case["systemPromptTokens"]),
                reservedOutputTokens = sentinel(case["reservedOutputTokens"]),
            )
            assertEquals(
                "resolveBudget(maxContext=${case["maxContext"]}, prompt=${case["systemPromptTokens"]}, out=${case["reservedOutputTokens"]})",
                expected,
                actual,
            )
        }

        @Suppress("UNCHECKED_CAST")
        val oversized = ChatCoreFixtures.listOrNull(root, "oversized") as? List<Map<String, Any?>>
            ?: error("缺少 oversized")
        for (case in oversized) {
            val text = ChatCoreFixtures.str(case, "text")!!
            val budget = ChatCoreFixtures.intOrNull(case, "tokenBudget")!!
            val expected = ChatCoreFixtures.str(case, "fitted")!!
            val actual = ChatMemoryWindow.fitOversizedMemoryMessage(text, budget) { value ->
                ChatTokenCounter.estimateTokens(value, "gpt-4o")
            }
            assertEquals("fitOversized(len=${text.length}, budget=$budget)", expected, actual)
        }
    }

    @Test
    fun memoryWindowMatchesGolden() {
        val root = ChatCoreFixtures.root("memory-window")
        @Suppress("UNCHECKED_CAST")
        val messages = ((ChatCoreFixtures.listOrNull(root, "messages") as? List<Map<String, Any?>>) ?: error("缺少 messages"))
            .map { TestWindowMessage(ChatCoreFixtures.str(it, "id")!!, ChatCoreFixtures.str(it, "content") ?: "") }

        for (case in ChatCoreFixtures.cases("memory-window")) {
            val cursorId = ChatCoreFixtures.str(case, "cursorId")
            val optionsMap = ChatCoreFixtures.mapOrNull(case, "options").orEmpty()
            val options = ChatMemoryWindow.Options(
                tokenBudget = ChatCoreFixtures.intOrNull(optionsMap, "tokenBudget"),
                overlapCount = ChatCoreFixtures.intOrNull(optionsMap, "overlapCount"),
            )
            val window = ChatMemoryWindow.buildSummaryWindow(
                messages = messages,
                cursorId = cursorId,
                formatMessage = { "${it.id}:${it.content}" },
                estimateTokens = { value -> ChatTokenCounter.estimateTokens(value, "gpt-4o") },
                options = options,
            )
            val label = "cursor=$cursorId budget=${options.tokenBudget} overlap=${options.overlapCount}"
            assertEquals("$label pendingIds", strings(case, "pendingIds"), window.pending.map { it.id })
            assertEquals("$label overlapIds", strings(case, "overlapIds"), window.overlap.map { it.id })
            assertEquals("$label selectedIds", strings(case, "selectedIds"), window.selected.map { it.id })
            assertEquals(
                "$label processedThroughMessageId",
                ChatCoreFixtures.str(case, "processedThroughMessageId"),
                window.processedThroughMessageId,
            )
        }
    }

    // ---------------------------------------------------------------- 上下文裁剪/注入/审计/降级

    private data class TestCropableMessage(
        val id: String,
        override val content: String,
        override val images: List<String>?,
        override val timestamp: Long,
    ) : ChatContextShared.CropableMessage

    private fun cropableFrom(map: Map<String, Any?>): TestCropableMessage = TestCropableMessage(
        id = ChatCoreFixtures.str(map, "id") ?: "",
        content = ChatCoreFixtures.str(map, "content") ?: "",
        images = (ChatCoreFixtures.listOrNull(map, "images") as? List<*>)?.map { it.toString() },
        timestamp = (map["timestamp"] as Number).toLong(),
    )

    @Test
    fun contextCropMatchesGolden() {
        val root = ChatCoreFixtures.root("context-crop")
        val constants = ChatCoreFixtures.mapOrNull(root, "constants")!!
        assertEqualsApprox(
            "TOKEN_BUDGET_SAFETY",
            (constants["tokenBudgetSafety"] as Number).toDouble(),
            ChatContextShared.TOKEN_BUDGET_SAFETY,
        )
        assertEquals(
            "IMAGE_TOKEN_ESTIMATE（裁剪口径，PC chatConstants = 200）",
            ChatCoreFixtures.intOrNull(constants, "imageTokenEstimateForCrop"),
            ChatContextShared.IMAGE_TOKEN_ESTIMATE_FOR_CROP,
        )
        for (case in ChatCoreFixtures.cases("context-crop")) {
            // 每个用例自带语料（图片/时间戳不同，共享一份会静默跑错）
            @Suppress("UNCHECKED_CAST")
            val corpus = ((ChatCoreFixtures.listOrNull(case, "corpus") as? List<Map<String, Any?>>) ?: error("缺少 corpus"))
                .map { cropableFrom(it) }
            val usedTokens = ChatCoreFixtures.intOrNull(case, "usedTokens")!!
            val budgetBase = ChatCoreFixtures.intOrNull(case, "budgetBase")!!
            val model = ChatCoreFixtures.str(case, "model")!!
            val crop = ChatContextShared.cropHistory(corpus, usedTokens, budgetBase, model)
            val label = "used=$usedTokens budget=$budgetBase model=$model"
            assertEquals("$label recentIds", strings(case, "recentIds"), crop.recent.map { it.id })
            assertEquals("$label droppedStartTs", (case["droppedStartTs"] as Number).toLong(), crop.droppedStartTs)
            assertEquals("$label droppedEndTs", (case["droppedEndTs"] as Number).toLong(), crop.droppedEndTs)
            assertEquals("$label droppedTokens", ChatCoreFixtures.intOrNull(case, "droppedTokens"), crop.droppedTokens)
            assertEquals("$label droppedEndIndex", ChatCoreFixtures.intOrNull(case, "droppedEndIndex"), crop.droppedEndIndex)
        }
    }

    @Test
    fun depthInsertMatchesGolden() {
        for (case in ChatCoreFixtures.cases("context-depth-insert")) {
            val history = strings(case, "history")
            @Suppress("UNCHECKED_CAST")
            val inserts = ((ChatCoreFixtures.listOrNull(case, "inserts") as? List<Map<String, Any?>>) ?: emptyList())
                .map { item ->
                    ChatContextShared.DepthInsertItem(
                        content = ChatCoreFixtures.str(item, "content")!!,
                        depth = ChatCoreFixtures.intOrNull(item, "depth") ?: 0,
                        order = ChatCoreFixtures.intOrNull(item, "order") ?: 0,
                        role = ChatCoreFixtures.str(item, "role"),
                    )
                }
            val actual = ChatContextShared.applyDepthInserts(history, inserts) { content, role ->
                if (role != null) "$content@$role" else content
            }
            assertEquals("depthInsert(inserts=${inserts.size})", strings(case, "resultIds"), actual)
        }
    }

    @Test
    fun inputAuditMatchesGolden() {
        val root = ChatCoreFixtures.root("input-audit")
        assertEquals(
            "MAX_INPUT_REALLOCATIONS",
            ChatCoreFixtures.intOrNull(root, "maxReallocations"),
            ChatInputAudit.MAX_INPUT_REALLOCATIONS,
        )
        for (case in ChatCoreFixtures.cases("input-audit")) {
            @Suppress("UNCHECKED_CAST")
            val parts = ((ChatCoreFixtures.listOrNull(case, "parts") as? List<Map<String, Any?>>) ?: emptyList())
                .map { part ->
                    ChatInputAudit.Part(
                        id = ChatCoreFixtures.str(part, "id")!!,
                        role = ChatCoreFixtures.str(part, "role")!!,
                        tokens = ChatCoreFixtures.intOrNull(part, "tokens") ?: 0,
                        confidence = ChatCoreFixtures.str(part, "confidence") ?: "estimated",
                    )
                }
            val serialized = ChatCoreFixtures.boolOrNull(case, "serialized") ?: false
            val ratio = (case["protocolSafetyRatio"] as? Number)?.toDouble()
            val actual = ChatInputAudit.audit(
                view = ChatInputAudit.View(
                    provider = ChatCoreFixtures.str(case, "provider")!!,
                    model = ChatCoreFixtures.str(case, "model")!!,
                    parts = parts,
                    serialized = serialized,
                ),
                reservedOutputTokens = sentinel(case["reservedOutputTokens"]),
                contextLimit = sentinel(case["contextLimit"]),
                protocolSafetyRatio = ratio,
            )
            val expected = ChatCoreFixtures.mapOrNull(case, "audit")!!
            val label = "audit(parts=${parts.size} limit=${case["contextLimit"]})"
            assertEquals("$label inputTokens", ChatCoreFixtures.intOrNull(expected, "inputTokens"), actual.inputTokens)
            assertEquals(
                "$label reservedOutputTokens",
                ChatCoreFixtures.intOrNull(expected, "reservedOutputTokens"),
                actual.reservedOutputTokens,
            )
            assertEquals(
                "$label protocolSafetyTokens",
                ChatCoreFixtures.intOrNull(expected, "protocolSafetyTokens"),
                actual.protocolSafetyTokens,
            )
            assertEquals("$label totalTokens", ChatCoreFixtures.intOrNull(expected, "totalTokens"), actual.totalTokens)
            assertEquals("$label contextLimit", ChatCoreFixtures.intOrNull(expected, "contextLimit"), actual.contextLimit)
            assertEquals("$label overBudget", ChatCoreFixtures.boolOrNull(expected, "overBudget"), actual.overBudget)
            assertEquals(
                "$label remainingReallocations",
                ChatCoreFixtures.intOrNull(expected, "remainingReallocations"),
                actual.remainingReallocations,
            )
            assertEquals(
                "$label accountingConfidence",
                ChatCoreFixtures.str(expected, "accountingConfidence"),
                actual.accountingConfidence,
            )
            assertEquals(
                "$label serializedViewMissing",
                ChatCoreFixtures.boolOrNull(expected, "serializedViewMissing"),
                actual.serializedViewMissing,
            )
            @Suppress("UNCHECKED_CAST")
            val expectedByRole = (ChatCoreFixtures.listOrNull(expected, "byRole") as? List<Map<String, Any?>>) ?: emptyList()
            assertEquals("$label byRole 条数", expectedByRole.size, actual.byRole.size)
            expectedByRole.forEachIndexed { index, stat ->
                val act = actual.byRole[index]
                assertEquals("$label byRole[$index].role", ChatCoreFixtures.str(stat, "role"), act.role)
                assertEquals("$label byRole[$index].parts", ChatCoreFixtures.intOrNull(stat, "parts"), act.parts)
                assertEquals("$label byRole[$index].tokens", ChatCoreFixtures.intOrNull(stat, "tokens"), act.tokens)
            }
        }
    }

    @Test
    fun historyDegradationMatchesGolden() {
        val root = ChatCoreFixtures.root("history-degradation")
        @Suppress("UNCHECKED_CAST")
        val corpus = ((ChatCoreFixtures.listOrNull(root, "corpus") as? List<Map<String, Any?>>) ?: error("缺少 corpus"))
            .map { TestCropableMessage(ChatCoreFixtures.str(it, "id") ?: "h", ChatCoreFixtures.str(it, "content") ?: "", null, (it["timestamp"] as Number).toLong()) }

        for (case in ChatCoreFixtures.cases("history-degradation")) {
            val rangeMap = ChatCoreFixtures.mapOrNull(case, "compressedRange")
            val plan = ChatHistoryDegradation.plan(
                messages = corpus,
                usedTokens = ChatCoreFixtures.intOrNull(case, "usedTokens")!!,
                budgetTokens = sentinel(case["budgetTokens"]),
                model = ChatCoreFixtures.str(case, "model") ?: "",
                compressedSummary = ChatCoreFixtures.str(case, "compressedSummary"),
                compressedRange = rangeMap?.let {
                    ChatHistoryDegradation.Range(
                        startTs = (it["startTs"] as Number).toLong(),
                        endTs = (it["endTs"] as Number).toLong(),
                    )
                },
            )
            val expected = ChatCoreFixtures.mapOrNull(case, "plan")!!
            val label = "degradation(budget=${case["budgetTokens"]}, summary=${case["compressedSummary"] != null})"

            val expExisting = ChatCoreFixtures.mapOrNull(expected, "existing")!!
            assertEquals("$label existing.keptCount", ChatCoreFixtures.intOrNull(expExisting, "keptCount"), plan.existing.keptCount)
            assertEquals("$label existing.keptTokens", ChatCoreFixtures.intOrNull(expExisting, "keptTokens"), plan.existing.keptTokens)
            assertEquals("$label existing.droppedCount", ChatCoreFixtures.intOrNull(expExisting, "droppedCount"), plan.existing.droppedCount)
            assertEquals("$label existing.droppedTokens", ChatCoreFixtures.intOrNull(expExisting, "droppedTokens"), plan.existing.droppedTokens)
            assertEquals(
                "$label existing.summaryInjected",
                ChatCoreFixtures.boolOrNull(expExisting, "summaryInjected"),
                plan.existing.summaryInjected,
            )
            assertEquals(
                "$label existing.summaryTokens",
                ChatCoreFixtures.intOrNull(expExisting, "summaryTokens"),
                plan.existing.summaryTokens,
            )

            val expCandidate = ChatCoreFixtures.mapOrNull(expected, "candidate")!!
            assertEquals("$label cand.keptRawCount", ChatCoreFixtures.intOrNull(expCandidate, "keptRawCount"), plan.candidate.keptRawCount)
            assertEquals("$label cand.keptRawTokens", ChatCoreFixtures.intOrNull(expCandidate, "keptRawTokens"), plan.candidate.keptRawTokens)
            assertEquals(
                "$label cand.summaryReplacedCount",
                ChatCoreFixtures.intOrNull(expCandidate, "summaryReplacedCount"),
                plan.candidate.summaryReplacedCount,
            )
            assertEquals("$label cand.summaryTokens", ChatCoreFixtures.intOrNull(expCandidate, "summaryTokens"), plan.candidate.summaryTokens)
            assertEquals(
                "$label cand.droppedRawCount",
                ChatCoreFixtures.intOrNull(expCandidate, "droppedRawCount"),
                plan.candidate.droppedRawCount,
            )
            assertEquals(
                "$label cand.droppedRawTokens",
                ChatCoreFixtures.intOrNull(expCandidate, "droppedRawTokens"),
                plan.candidate.droppedRawTokens,
            )
            assertEquals("$label cand.totalTokens", ChatCoreFixtures.intOrNull(expCandidate, "totalTokens"), plan.candidate.totalTokens)

            assertEquals("$label budgetTokens", ChatCoreFixtures.intOrNull(expected, "budgetTokens"), plan.budgetTokens)
            assertEquals("$label deltaTokens", ChatCoreFixtures.intOrNull(expected, "deltaTokens"), plan.deltaTokens)
            assertEquals("$label degraded", ChatCoreFixtures.boolOrNull(expected, "degraded"), plan.degraded)

            @Suppress("UNCHECKED_CAST")
            val expItems = (ChatCoreFixtures.listOrNull(expected, "items") as? List<Map<String, Any?>>) ?: emptyList()
            assertEquals("$label items 条数", expItems.size, plan.items.size)
            expItems.forEachIndexed { index, item ->
                val act = plan.items[index]
                assertEquals("$label items[$index].id", ChatCoreFixtures.str(item, "id"), act.id)
                assertEquals("$label items[$index].action", ChatCoreFixtures.str(item, "action"), act.action)
                assertEquals("$label items[$index].tokens", ChatCoreFixtures.intOrNull(item, "tokens"), act.tokens)
                assertEquals(
                    "$label items[$index].coveredBySummary",
                    ChatCoreFixtures.boolOrNull(item, "coveredBySummary"),
                    act.coveredBySummary,
                )
            }
            assertEquals(
                "$label formatted",
                ChatCoreFixtures.str(case, "formatted"),
                ChatHistoryDegradation.formatSummary(plan),
            )
        }
    }

    // ---------------------------------------------------------------- 上下文候选与分配

    /**
     * 递归比较 fixture 的普通 JSON 结构（Map/List/标量）与实际值。
     * 用于 `normalizeContextCandidate` 这类「输出完整对象」的断言：
     * 逐字段显式比较容易漏字段，整体深比较更严格。
     */
    private fun assertDeepEquals(label: String, expected: Any?, actual: Any?) {
        when (expected) {
            null -> assertTrue("$label 期望 null，实际 $actual", actual == null)
            is Map<*, *> -> {
                @Suppress("UNCHECKED_CAST")
                val actualMap = actual as? Map<String, Any?>
                    ?: error("$label 期望对象，实际 ${actual?.javaClass}")
                assertEquals("$label 键集合", expected.keys.map { it.toString() }.sorted(), actualMap.keys.sorted())
                for ((key, value) in expected) {
                    assertDeepEquals("$label.$key", value, actualMap[key.toString()])
                }
            }
            is List<*> -> {
                val actualList = actual as? List<*>
                    ?: error("$label 期望数组，实际 ${actual?.javaClass}")
                assertEquals("$label 长度", expected.size, actualList.size)
                expected.forEachIndexed { index, value ->
                    assertDeepEquals("$label[$index]", value, actualList[index])
                }
            }
            is Number -> {
                val actualNumber = (actual as? Number)?.toDouble()
                assertTrue("$label 期望 $expected，实际 $actual", actualNumber != null && kotlin.math.abs(expected.toDouble() - actualNumber) <= 1e-12)
            }
            else -> assertEquals(label, expected, actual)
        }
    }

    private fun candidateFrom(map: Map<String, Any?>): ChatContextCandidates.Candidate = ChatContextCandidates.Candidate(
        id = ChatCoreFixtures.str(map, "id") ?: "",
        kind = ChatCoreFixtures.str(map, "kind") ?: "",
        // fixture 里可能是小数（如 10.4）：按 PC `normalizeCandidateTokens` 的 ceil 口径收口，
        // 否则 "10.4 -> 11" 这条断言会在解析阶段就丢失信息
        estimatedTokens = (map["estimatedTokens"] as Number).toDouble().let { kotlin.math.ceil(it).toInt() },
        mandatory = ChatCoreFixtures.boolOrNull(map, "mandatory") ?: false,
        stablePrefix = ChatCoreFixtures.boolOrNull(map, "stablePrefix") ?: false,
        relevance = (map["relevance"] as? Number)?.toDouble() ?: 0.0,
        recency = (map["recency"] as? Number)?.toDouble() ?: 0.0,
        importance = (map["importance"] as? Number)?.toDouble() ?: 0.0,
        continuity = (map["continuity"] as? Number)?.toDouble() ?: 0.0,
        dedupeKey = ChatCoreFixtures.str(map, "dedupeKey"),
        originalOrder = (map["originalOrder"] as? Number)?.toInt() ?: 0,
        origin = ChatCoreFixtures.str(map, "origin"),
    )

    /** 把候选渲染成 fixture 同形的 map（省略空 dedupeKey/origin，与 TS JSON 一致）。 */
    private fun candidateToMap(candidate: ChatContextCandidates.Candidate): Map<String, Any?> {
        val map = LinkedHashMap<String, Any?>()
        map["id"] = candidate.id
        map["kind"] = candidate.kind
        map["estimatedTokens"] = candidate.estimatedTokens.toLong()
        map["mandatory"] = candidate.mandatory
        map["stablePrefix"] = candidate.stablePrefix
        map["relevance"] = candidate.relevance
        map["recency"] = candidate.recency
        map["importance"] = candidate.importance
        map["continuity"] = candidate.continuity
        candidate.dedupeKey?.takeIf { it.isNotEmpty() }?.let { map["dedupeKey"] = it }
        map["originalOrder"] = candidate.originalOrder.toLong()
        candidate.origin?.let { map["origin"] = it }
        return map
    }

    private fun kindStatsToMap(stats: Map<String, ChatContextCandidates.KindStat>): Map<String, Any?> =
        stats.mapValues { (_, stat) ->
            linkedMapOf<String, Any?>(
                "count" to stat.count.toLong(),
                "tokens" to stat.tokens.toLong(),
                "mandatoryCount" to stat.mandatoryCount.toLong(),
                "selectedCount" to stat.selectedCount.toLong(),
                "selectedTokens" to stat.selectedTokens.toLong(),
                "stablePrefixTokens" to stat.stablePrefixTokens.toLong(),
                "droppedCount" to stat.droppedCount.toLong(),
            )
        }

    @Test
    fun contextCandidatesMatchGolden() {
        val root = ChatCoreFixtures.root("context-candidates")
        assertEquals(
            "CANDIDATE_KINDS",
            (ChatCoreFixtures.listOrNull(root, "kinds") as? List<*>)?.map { it.toString() },
            ChatContextCandidates.CANDIDATE_KINDS,
        )
        val weights = ChatCoreFixtures.mapOrNull(root, "scoreWeights")!!
        assertEqualsApprox("weight.relevance", (weights["relevance"] as Number).toDouble(), ChatContextCandidates.WEIGHT_RELEVANCE)
        assertEqualsApprox("weight.recency", (weights["recency"] as Number).toDouble(), ChatContextCandidates.WEIGHT_RECENCY)
        assertEqualsApprox("weight.importance", (weights["importance"] as Number).toDouble(), ChatContextCandidates.WEIGHT_IMPORTANCE)
        assertEqualsApprox("weight.continuity", (weights["continuity"] as Number).toDouble(), ChatContextCandidates.WEIGHT_CONTINUITY)
        val thresholds = ChatCoreFixtures.mapOrNull(root, "thresholds")!!
        assertEqualsApprox(
            "recentHistoryRecency",
            (thresholds["recentHistoryRecency"] as Number).toDouble(),
            ChatContextCandidates.RECENT_HISTORY_RECENCY,
        )
        assertEqualsApprox(
            "highRelevance",
            (thresholds["highRelevance"] as Number).toDouble(),
            ChatContextCandidates.HIGH_RELEVANCE_THRESHOLD,
        )

        // 单候选：raw（透传字段）→ normalized → score → tier
        for (case in ChatCoreFixtures.cases("context-candidates")) {
            val raw = ChatCoreFixtures.mapOrNull(case, "candidate")!!
            val candidate = candidateFrom(raw)
            val normalized = ChatContextCandidates.normalize(candidate)
            val expectedNormalized = ChatCoreFixtures.mapOrNull(case, "normalized")!!
            val label = "normalized(id=${candidate.id})"
            // estimatedTokens 不在解析层比较：fixture 可能是小数（10.4），
            // Kotlin 模型按 ceil 口径存 Int，两者表示不同但等价；语义由分配的 selectedTokens 覆盖。
            assertDeepEquals(
                "$label.id",
                ChatCoreFixtures.str(expectedNormalized, "id"),
                normalized.id,
            )
            assertDeepEquals("$label.kind", ChatCoreFixtures.str(expectedNormalized, "kind"), normalized.kind)
            assertDeepEquals(
                "$label.mandatory",
                ChatCoreFixtures.boolOrNull(expectedNormalized, "mandatory"),
                normalized.mandatory,
            )
            assertDeepEquals(
                "$label.stablePrefix",
                ChatCoreFixtures.boolOrNull(expectedNormalized, "stablePrefix"),
                normalized.stablePrefix,
            )
            listOf("relevance", "recency", "importance", "continuity").forEach { field ->
                val expectedValue = (expectedNormalized[field] as Number).toDouble()
                val actualValue = when (field) {
                    "relevance" -> normalized.relevance
                    "recency" -> normalized.recency
                    "importance" -> normalized.importance
                    else -> normalized.continuity
                }
                assertEqualsApprox("$label.$field", expectedValue, actualValue)
            }
            assertEquals(
                "$label.dedupeKey",
                ChatCoreFixtures.str(expectedNormalized, "dedupeKey"),
                normalized.dedupeKey?.takeIf { it.isNotEmpty() },
            )
            assertEquals(
                "$label.originalOrder",
                ChatCoreFixtures.intOrNull(expectedNormalized, "originalOrder"),
                normalized.originalOrder,
            )
            assertEqualsApprox(
                "score(id=${candidate.id})",
                (case["score"] as Number).toDouble(),
                ChatContextCandidates.candidateScore(candidate),
            )
            assertEquals("tier(id=${candidate.id})", ChatCoreFixtures.intOrNull(case, "tier"), ChatContextCandidates.candidateTier(candidate))
        }

        // 排序 / 去重 / 汇总 / 分配：每个 rankCase 的 members 即一个候选组
        @Suppress("UNCHECKED_CAST")
        val rankCases = (ChatCoreFixtures.listOrNull(root, "rankCases") as? List<Map<String, Any?>>) ?: error("缺少 rankCases")
        val groups = rankCases.map { case ->
            @Suppress("UNCHECKED_CAST")
            ((ChatCoreFixtures.listOrNull(case, "members") as? List<Map<String, Any?>>) ?: emptyList())
                .map { candidateFrom(it) }
        }
        for (case in rankCases) {
            @Suppress("UNCHECKED_CAST")
            val members = ((ChatCoreFixtures.listOrNull(case, "members") as? List<Map<String, Any?>>) ?: emptyList())
                .map { candidateFrom(it) }
            val label = "rankCase#${ChatCoreFixtures.intOrNull(case, "groupIndex")}"
            assertEquals(
                "$label rankedIds",
                strings(case, "rankedIds"),
                ChatContextCandidates.rankCandidates(members).map { it.id },
            )
            val dedupe = ChatCoreFixtures.mapOrNull(case, "dedupe")!!
            val actualDedupe = ChatContextCandidates.dedupeCandidates(members)
            assertEquals("$label dedupe.uniqueIds", strings(dedupe, "uniqueIds"), actualDedupe.unique.map { it.id })
            assertEquals("$label dedupe.duplicateIds", strings(dedupe, "duplicateIds"), actualDedupe.duplicateIds)

            val summary = ChatCoreFixtures.mapOrNull(case, "summary")!!
            val actualSummary = ChatContextCandidates.summarizeCandidates(members)
            assertEquals("$label summary.count", ChatCoreFixtures.intOrNull(summary, "count"), actualSummary.count)
            assertEquals("$label summary.tokens", ChatCoreFixtures.intOrNull(summary, "tokens"), actualSummary.tokens)
            assertEquals(
                "$label summary.mandatoryCount",
                ChatCoreFixtures.intOrNull(summary, "mandatoryCount"),
                actualSummary.mandatoryCount,
            )
            assertEquals(
                "$label summary.stablePrefixTokens",
                ChatCoreFixtures.intOrNull(summary, "stablePrefixTokens"),
                actualSummary.stablePrefixTokens,
            )
            assertDeepEquals(
                "$label summary.byKind",
                ChatCoreFixtures.mapOrNull(summary, "byKind"),
                kindStatsToMap(actualSummary.byKind),
            )
        }

        // 分配
        @Suppress("UNCHECKED_CAST")
        val allocationCases = (ChatCoreFixtures.listOrNull(root, "allocationCases") as? List<Map<String, Any?>>)
            ?: error("缺少 allocationCases")
        for (case in allocationCases) {
            val groupIndex = ChatCoreFixtures.intOrNull(case, "groupIndex")!!
            val result = ChatContextCandidates.allocateContextCandidates(
                candidates = groups[groupIndex],
                options = ChatContextCandidates.AllocationOptions(
                    budgetTokens = (case["budgetTokens"] as Number).toDouble(),
                    reservedTokens = (case["reservedTokens"] as Number).toDouble(),
                ),
            )
            val label = "alloc(group=$groupIndex budget=${case["budgetTokens"]} reserved=${case["reservedTokens"]})"
            assertEquals("$label selectedIds", strings(case, "selectedIds"), result.selectedIds)
            assertEquals("$label droppedIds", strings(case, "droppedIds"), result.droppedIds)
            assertEquals("$label selectedTokens", ChatCoreFixtures.intOrNull(case, "selectedTokens"), result.selectedTokens)
            assertEquals("$label mandatoryTokens", ChatCoreFixtures.intOrNull(case, "mandatoryTokens"), result.mandatoryTokens)
            assertEquals(
                "$label effectiveBudgetTokens",
                ChatCoreFixtures.intOrNull(case, "effectiveBudgetTokens"),
                result.effectiveBudgetTokens,
            )
            assertEquals("$label overBudget", ChatCoreFixtures.boolOrNull(case, "overBudget"), result.overBudget)
            assertEquals(
                "$label mandatoryOverBudget",
                ChatCoreFixtures.boolOrNull(case, "mandatoryOverBudget"),
                result.mandatoryOverBudget,
            )
            assertEquals("$label dedupedIds", strings(case, "dedupedIds"), result.dedupedIds)
            assertEquals(
                "$label stablePrefixSelectedTokens",
                ChatCoreFixtures.intOrNull(case, "stablePrefixSelectedTokens"),
                result.stablePrefixSelectedTokens,
            )
            assertDeepEquals("$label byKind", ChatCoreFixtures.mapOrNull(case, "byKind"), kindStatsToMap(result.byKind))
        }
    }

    // ---------------------------------------------------------------- 世界书候选与影子报告

    private fun snapshotFrom(map: Map<String, Any?>): ChatWorldbookCandidates.Snapshot =
        ChatWorldbookCandidates.Snapshot(
            key = ChatCoreFixtures.str(map, "key") ?: "",
            score = (map["score"] as? Number)?.toDouble() ?: 0.0,
            priority = ChatCoreFixtures.str(map, "priority"),
            position = ChatCoreFixtures.str(map, "position") ?: "at_end",
            depth = ChatCoreFixtures.intOrNull(map, "depth"),
            order = ChatCoreFixtures.intOrNull(map, "order") ?: 0,
            tokens = (map["tokens"] as? Number)?.toDouble() ?: 0.0,
            kept = ChatCoreFixtures.boolOrNull(map, "kept") ?: false,
            usedSummary = ChatCoreFixtures.boolOrNull(map, "usedSummary") ?: false,
            ignoreBudget = ChatCoreFixtures.boolOrNull(map, "ignoreBudget") ?: false,
        )

    private fun injectionStatsToMap(stats: ChatWorldbookCandidates.InjectionStats): Map<String, Any?> =
        linkedMapOf(
            "keptCount" to stats.keptCount.toLong(),
            "keptTokens" to stats.keptTokens.toLong(),
            "droppedCount" to stats.droppedCount.toLong(),
            "droppedTokens" to stats.droppedTokens.toLong(),
            "alwaysDropped" to stats.alwaysDropped.toLong(),
            "legacyCapTokens" to stats.legacyCapTokens.toLong(),
            "keptAlwaysCount" to stats.keptAlwaysCount.toLong(),
            "keptConditionalCount" to stats.keptConditionalCount.toLong(),
            "keptDetailCount" to stats.keptDetailCount.toLong(),
            "alwaysKeptTokens" to stats.alwaysKeptTokens.toLong(),
            "conditionalKeptTokens" to stats.conditionalKeptTokens.toLong(),
            "detailKeptTokens" to stats.detailKeptTokens.toLong(),
            "summaryFallbackCount" to stats.summaryFallbackCount.toLong(),
        )

    @Test
    fun worldbookCandidatesMatchGolden() {
        val root = ChatCoreFixtures.root("worldbook-candidates")
        val constants = ChatCoreFixtures.mapOrNull(root, "constants")!!
        assertEqualsApprox(
            "WORLDBOOK_ALWAYS_IMPORTANCE",
            (constants["alwaysImportance"] as Number).toDouble(),
            ChatWorldbookCandidates.WORLDBOOK_ALWAYS_IMPORTANCE,
        )
        assertEqualsApprox(
            "WORLDBOOK_CONDITIONAL_IMPORTANCE",
            (constants["conditionalImportance"] as Number).toDouble(),
            ChatWorldbookCandidates.WORLDBOOK_CONDITIONAL_IMPORTANCE,
        )
        assertEqualsApprox(
            "WORLDBOOK_DETAIL_IMPORTANCE",
            (constants["detailImportance"] as Number).toDouble(),
            ChatWorldbookCandidates.WORLDBOOK_DETAIL_IMPORTANCE,
        )

        // 评分归一（含 NaN/Infinity 哨兵）
        for (case in ChatCoreFixtures.cases("worldbook-candidates")) {
            assertEqualsApprox(
                "normalizeWorldbookScore(${case["score"]})",
                (case["normalized"] as Number).toDouble(),
                ChatWorldbookCandidates.normalizeWorldbookScore(sentinel(case["score"])),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val originCases = (ChatCoreFixtures.listOrNull(root, "originCases") as? List<Map<String, Any?>>) ?: error("缺少 originCases")
        for (case in originCases) {
            val snapshot = snapshotFrom(ChatCoreFixtures.mapOrNull(case, "snapshot")!!)
            assertEquals(
                "worldbookOrigin(key=${snapshot.key})",
                ChatCoreFixtures.str(case, "origin"),
                ChatWorldbookCandidates.worldbookOrigin(snapshot),
            )
        }

        // 候选集合
        @Suppress("UNCHECKED_CAST")
        val candidateSets = (ChatCoreFixtures.listOrNull(root, "candidateSets") as? List<Map<String, Any?>>)
            ?: error("缺少 candidateSets")
        candidateSets.forEachIndexed { setIndex, case ->
            @Suppress("UNCHECKED_CAST")
            val snapshots = ((ChatCoreFixtures.listOrNull(case, "snapshots") as? List<Map<String, Any?>>) ?: emptyList())
                .map { snapshotFrom(it) }
            val actual = ChatWorldbookCandidates.buildWorldbookCandidateSet(snapshots)
            val label = "candidateSet#$setIndex"
            assertDeepEquals(
                "$label.described",
                ChatCoreFixtures.mapOrNull(case, "described"),
                linkedMapOf<String, Any?>(
                    "totalCount" to actual.described.totalCount.toLong(),
                    "totalTokens" to actual.described.totalTokens.toLong(),
                    "alwaysCount" to actual.described.alwaysCount.toLong(),
                    "alwaysTokens" to actual.described.alwaysTokens.toLong(),
                    "conditionalCount" to actual.described.conditionalCount.toLong(),
                    "detailCount" to actual.described.detailCount.toLong(),
                ),
            )
            assertDeepEquals(
                "$label.keyByCandidateId",
                ChatCoreFixtures.mapOrNull(case, "keyByCandidateId"),
                actual.keyByCandidateId,
            )
            assertDeepEquals(
                "$label.priorityByCandidateId",
                ChatCoreFixtures.mapOrNull(case, "priorityByCandidateId"),
                actual.priorityByCandidateId,
            )
            @Suppress("UNCHECKED_CAST")
            val expectedCandidates = (ChatCoreFixtures.listOrNull(case, "candidates") as? List<Map<String, Any?>>)
                ?: emptyList()
            assertEquals("$label candidates 条数", expectedCandidates.size, actual.candidates.size)
            expectedCandidates.forEachIndexed { index, expected ->
                assertDeepEquals("$label.candidates[$index]", expected, candidateToMap(actual.candidates[index]))
            }
        }

        // 既有注入统计
        @Suppress("UNCHECKED_CAST")
        val injectionCases = (ChatCoreFixtures.listOrNull(root, "injectionCases") as? List<Map<String, Any?>>)
            ?: error("缺少 injectionCases")
        for (case in injectionCases) {
            @Suppress("UNCHECKED_CAST")
            val snapshots = ((ChatCoreFixtures.listOrNull(case, "snapshots") as? List<Map<String, Any?>>) ?: emptyList())
                .map { snapshotFrom(it) }
            val legacyCap = (case["legacyCapTokens"] as Number).toDouble()
            val actual = ChatWorldbookCandidates.summarizeWorldbookInjection(snapshots, legacyCap)
            assertDeepEquals(
                "injection(cap=$legacyCap, n=${snapshots.size})",
                ChatCoreFixtures.mapOrNull(case, "stats"),
                injectionStatsToMap(actual),
            )
        }

        // 影子报告
        @Suppress("UNCHECKED_CAST")
        val shadowCases = (ChatCoreFixtures.listOrNull(root, "shadowCases") as? List<Map<String, Any?>>)
            ?: error("缺少 shadowCases")
        for (case in shadowCases) {
            @Suppress("UNCHECKED_CAST")
            val snapshots = ((ChatCoreFixtures.listOrNull(case, "snapshots") as? List<Map<String, Any?>>) ?: emptyList())
                .map { snapshotFrom(it) }
            @Suppress("UNCHECKED_CAST")
            val competitors = ((ChatCoreFixtures.listOrNull(case, "competitors") as? List<Map<String, Any?>>) ?: emptyList())
                .map { candidateFrom(it) }
            val budget = (case["budgetTokens"] as Number).toDouble()
            val legacyCap = (case["legacyCapTokens"] as Number).toDouble()
            val plan = ChatWorldbookCandidates.buildWorldbookCandidateSet(snapshots)
            val existing = ChatWorldbookCandidates.summarizeWorldbookInjection(snapshots, legacyCap)
            val actual = ChatWorldbookCandidates.buildWorldbookShadowReport(plan, existing, budget, competitors)
            val expected = ChatCoreFixtures.mapOrNull(case, "report")!!
            val label = "shadow(budget=$budget, cap=$legacyCap, n=${snapshots.size}, competitors=${competitors.size})"

            assertEquals("$label.mode", ChatCoreFixtures.str(expected, "mode"), actual.mode)
            assertEquals("$label.budgetTokens", ChatCoreFixtures.intOrNull(expected, "budgetTokens"), actual.budgetTokens)
            assertEquals("$label.legacyCapTokens", ChatCoreFixtures.intOrNull(expected, "legacyCapTokens"), actual.legacyCapTokens)
            assertEquals("$label.deltaTokens", ChatCoreFixtures.intOrNull(expected, "deltaTokens"), actual.deltaTokens)
            assertEquals(
                "$label.exceedsLegacyCap",
                ChatCoreFixtures.boolOrNull(expected, "exceedsLegacyCap"),
                actual.exceedsLegacyCap,
            )
            assertEquals("$label.degraded", ChatCoreFixtures.boolOrNull(expected, "degraded"), actual.degraded)
            assertDeepEquals(
                "$label.existing",
                ChatCoreFixtures.mapOrNull(expected, "existing"),
                injectionStatsToMap(actual.existing),
            )
            val expectedCandidate = ChatCoreFixtures.mapOrNull(expected, "candidate")!!
            val actualCandidate = linkedMapOf<String, Any?>(
                "selectedCount" to actual.candidate.selectedCount.toLong(),
                "selectedTokens" to actual.candidate.selectedTokens.toLong(),
                "droppedCount" to actual.candidate.droppedCount.toLong(),
                "alwaysMandatoryCount" to actual.candidate.alwaysMandatoryCount.toLong(),
                "alwaysSelectedCount" to actual.candidate.alwaysSelectedCount.toLong(),
                "alwaysDroppedCount" to actual.candidate.alwaysDroppedCount.toLong(),
                "overBudget" to actual.candidate.overBudget,
                "mandatoryOverBudget" to actual.candidate.mandatoryOverBudget,
            )
            assertDeepEquals("$label.candidate", expectedCandidate, actualCandidate)

            @Suppress("UNCHECKED_CAST")
            val expectedLayers = (ChatCoreFixtures.listOrNull(expected, "byPriority") as? List<Map<String, Any?>>)
                ?: emptyList()
            assertEquals("$label.byPriority 条数", expectedLayers.size, actual.byPriority.size)
            expectedLayers.forEachIndexed { index, layer ->
                val act = actual.byPriority[index]
                assertDeepEquals(
                    "$label.byPriority[$index]",
                    layer,
                    linkedMapOf<String, Any?>(
                        "priority" to act.priority,
                        "existingCount" to act.existingCount.toLong(),
                        "existingTokens" to act.existingTokens.toLong(),
                        "candidateCount" to act.candidateCount.toLong(),
                        "candidateTokens" to act.candidateTokens.toLong(),
                        "candidateDroppedCount" to act.candidateDroppedCount.toLong(),
                    ),
                )
            }
            assertEquals(
                "$label.formatted",
                ChatCoreFixtures.str(case, "formatted"),
                ChatWorldbookCandidates.formatWorldbookShadowSummary(actual),
            )
        }
    }

    // ---------------------------------------------------------------- 回复篇幅策略

    private data class TestVisibleCharsMessage(override val role: String, override val content: String?) :
        ChatResponsePolicy.VisibleCharsSource

    /** 篇幅模式：fixture 里的 null 表示「未设置」。 */
    private fun modeOf(value: Any?): String? = value as? String

    @Test
    fun responsePolicyMatchesGolden() {
        val root = ChatCoreFixtures.root("response-policy")
        val constants = ChatCoreFixtures.mapOrNull(root, "constants")!!
        assertEquals(
            "AUTO_HARD_MAX_CHARS",
            ChatCoreFixtures.intOrNull(constants, "autoHardMaxChars"),
            ChatResponsePolicy.AUTO_HARD_MAX_CHARS,
        )
        assertEquals(
            "AUTO_DEFAULT_BASELINE_CHARS",
            ChatCoreFixtures.intOrNull(constants, "autoDefaultBaselineChars"),
            ChatResponsePolicy.AUTO_DEFAULT_BASELINE_CHARS,
        )
        assertEquals(
            "AUTO_TARGET_MIN_CHARS",
            ChatCoreFixtures.intOrNull(constants, "autoTargetMinChars"),
            ChatResponsePolicy.AUTO_TARGET_MIN_CHARS,
        )
        assertEquals(
            "AUTO_TARGET_MAX_CHARS",
            ChatCoreFixtures.intOrNull(constants, "autoTargetMaxChars"),
            ChatResponsePolicy.AUTO_TARGET_MAX_CHARS,
        )
        assertEquals(
            "AUTO_BASELINE_WINDOW",
            ChatCoreFixtures.intOrNull(constants, "autoBaselineWindow"),
            ChatResponsePolicy.AUTO_BASELINE_WINDOW,
        )
        assertEquals(
            "AUTO_MAX_NEW_BEATS",
            ChatCoreFixtures.intOrNull(constants, "autoMaxNewBeats"),
            ChatResponsePolicy.AUTO_MAX_NEW_BEATS,
        )
        val targetParagraphs = ChatCoreFixtures.mapOrNull(constants, "autoTargetParagraphs")!!
        assertEquals(
            "AUTO_TARGET_PARAGRAPHS.min",
            ChatCoreFixtures.intOrNull(targetParagraphs, "min"),
            ChatResponsePolicy.AUTO_TARGET_PARAGRAPHS_MIN,
        )
        assertEquals(
            "AUTO_TARGET_PARAGRAPHS.max",
            ChatCoreFixtures.intOrNull(targetParagraphs, "max"),
            ChatResponsePolicy.AUTO_TARGET_PARAGRAPHS_MAX,
        )
        val labels = ChatCoreFixtures.mapOrNull(constants, "labels")!!
        for ((mode, label) in labels) {
            assertEquals("RESPONSE_LENGTH_LABELS[$mode]", label, ChatResponsePolicy.RESPONSE_LENGTH_LABELS[mode.toString()])
        }
        val ranges = ChatCoreFixtures.mapOrNull(constants, "ranges")!!
        for ((mode, raw) in ranges) {
            @Suppress("UNCHECKED_CAST")
            val range = raw as Map<String, Any?>
            val actual = ChatResponsePolicy.RESPONSE_LENGTH_RANGES[mode.toString()] ?: error("缺少区间 $mode")
            assertEquals("range[$mode].preferredMinChars", ChatCoreFixtures.intOrNull(range, "preferredMinChars"), actual.preferredMinChars)
            assertEquals("range[$mode].preferredMaxChars", ChatCoreFixtures.intOrNull(range, "preferredMaxChars"), actual.preferredMaxChars)
            assertEquals("range[$mode].hardMaxChars", ChatCoreFixtures.intOrNull(range, "hardMaxChars"), actual.hardMaxChars)
            assertEquals("range[$mode].maxNewBeats", ChatCoreFixtures.intOrNull(range, "maxNewBeats"), actual.maxNewBeats)
            val paragraphs = ChatCoreFixtures.mapOrNull(range, "targetParagraphs")!!
            assertEquals("range[$mode].targetParagraphs.min", ChatCoreFixtures.intOrNull(paragraphs, "min"), actual.targetParagraphsMin)
            assertEquals("range[$mode].targetParagraphs.max", ChatCoreFixtures.intOrNull(paragraphs, "max"), actual.targetParagraphsMax)
        }

        // 可见字符
        for (case in ChatCoreFixtures.cases("response-policy")) {
            val text = ChatCoreFixtures.str(case, "text") ?: ""
            assertEquals(
                "countVisibleChars(${text.take(20)})",
                ChatCoreFixtures.intOrNull(case, "count"),
                ChatResponsePolicy.countVisibleChars(text),
            )
        }

        // 中位数
        @Suppress("UNCHECKED_CAST")
        val medianCases = (ChatCoreFixtures.listOrNull(root, "medianCases") as? List<Map<String, Any?>>) ?: error("缺少 medianCases")
        for (case in medianCases) {
            val values = (ChatCoreFixtures.listOrNull(case, "values") as? List<*>)?.map { sentinel(it) } ?: emptyList()
            assertEquals(
                "median(${values.joinToString(",")})",
                ChatCoreFixtures.intOrNull(case, "median"),
                ChatResponsePolicy.median(values),
            )
        }

        // 近期助手可见字符采样
        @Suppress("UNCHECKED_CAST")
        val collectCases = (ChatCoreFixtures.listOrNull(root, "collectCases") as? List<Map<String, Any?>>) ?: error("缺少 collectCases")
        for (case in collectCases) {
            @Suppress("UNCHECKED_CAST")
            val messages = ((ChatCoreFixtures.listOrNull(case, "messages") as? List<Map<String, Any?>>) ?: emptyList())
                .map { TestVisibleCharsMessage(ChatCoreFixtures.str(it, "role") ?: "", ChatCoreFixtures.str(it, "content")) }
            val window = ChatCoreFixtures.intOrNull(case, "window")
            val expected = (ChatCoreFixtures.listOrNull(case, "samples") as? List<*>)?.map { (it as Number).toInt() } ?: emptyList()
            val actual = if (window != null) {
                ChatResponsePolicy.collectRecentAssistantChars(messages, window)
            } else {
                ChatResponsePolicy.collectRecentAssistantChars(messages)
            }
            assertEquals("collectRecentAssistantChars(n=${messages.size}, window=$window)", expected, actual)
        }

        // 用户篇幅意图
        @Suppress("UNCHECKED_CAST")
        val intentCases = (ChatCoreFixtures.listOrNull(root, "intentCases") as? List<Map<String, Any?>>) ?: error("缺少 intentCases")
        for (case in intentCases) {
            val text = ChatCoreFixtures.str(case, "text")
            assertEquals(
                "detectUserLengthIntent(${text?.take(20)})",
                ChatCoreFixtures.str(case, "intent"),
                ChatResponsePolicy.detectUserLengthIntent(text),
            )
        }

        // 场景系数
        @Suppress("UNCHECKED_CAST")
        val sceneCases = (ChatCoreFixtures.listOrNull(root, "sceneCases") as? List<Map<String, Any?>>) ?: error("缺少 sceneCases")
        for (case in sceneCases) {
            val text = ChatCoreFixtures.str(case, "latestUserText")
            val hasReply = ChatCoreFixtures.boolOrNull(case, "hasAssistantReply")!!
            assertEqualsApprox(
                "resolveSceneFactor(text=$text, hasReply=$hasReply)",
                (case["factor"] as Number).toDouble(),
                ChatResponsePolicy.resolveSceneFactor(text, hasReply),
            )
        }

        // 模式解析
        @Suppress("UNCHECKED_CAST")
        val modeCases = (ChatCoreFixtures.listOrNull(root, "modeCases") as? List<Map<String, Any?>>) ?: error("缺少 modeCases")
        for (case in modeCases) {
            val actual = ChatResponsePolicy.resolveResponseLengthMode(
                sessionMode = modeOf(case["sessionMode"]),
                presetHint = modeOf(case["presetHint"]),
                defaultMode = modeOf(case["defaultMode"]),
                userIntent = modeOf(case["userIntent"]),
            )
            val resolution = ChatCoreFixtures.mapOrNull(case, "resolution")!!
            val label = "resolveMode(session=${case["sessionMode"]}, preset=${case["presetHint"]}, " +
                "default=${case["defaultMode"]}, intent=${case["userIntent"]})"
            assertEquals("$label.mode", ChatCoreFixtures.str(resolution, "mode"), actual.mode)
            assertEquals("$label.source", ChatCoreFixtures.str(resolution, "source"), actual.source)
        }

        // 策略解析
        @Suppress("UNCHECKED_CAST")
        val policyCases = (ChatCoreFixtures.listOrNull(root, "policyCases") as? List<Map<String, Any?>>) ?: error("缺少 policyCases")
        for (case in policyCases) {
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            @Suppress("UNCHECKED_CAST")
            val recent = (ChatCoreFixtures.listOrNull(input, "recentAssistantVisibleChars") as? List<*>)?.map { sentinel(it) }
            val sceneFactorRaw = input["sceneFactor"]
            val actual = ChatResponsePolicy.resolveResponsePolicy(
                sessionMode = modeOf(input["sessionMode"]),
                presetHint = modeOf(input["presetHint"]),
                defaultMode = modeOf(input["defaultMode"]),
                userIntent = modeOf(input["userIntent"]),
                recentAssistantVisibleChars = recent,
                sceneFactor = sceneFactorRaw?.let { sentinel(it) },
            )
            val expected = ChatCoreFixtures.mapOrNull(case, "policy")!!
            val label = "resolvePolicy(session=${input["sessionMode"]}, recent=${recent?.joinToString(",")}, " +
                "factor=${input["sceneFactor"]})"
            assertEquals("$label.mode", ChatCoreFixtures.str(expected, "mode"), actual.mode)
            assertEquals("$label.source", ChatCoreFixtures.str(expected, "source"), actual.source)
            assertEquals("$label.preferredMinChars", ChatCoreFixtures.intOrNull(expected, "preferredMinChars"), actual.preferredMinChars)
            assertEquals("$label.preferredMaxChars", ChatCoreFixtures.intOrNull(expected, "preferredMaxChars"), actual.preferredMaxChars)
            assertEquals("$label.hardMaxChars", ChatCoreFixtures.intOrNull(expected, "hardMaxChars"), actual.hardMaxChars)
            assertEquals("$label.maxNewBeats", ChatCoreFixtures.intOrNull(expected, "maxNewBeats"), actual.maxNewBeats)
            val paragraphs = ChatCoreFixtures.mapOrNull(expected, "targetParagraphs")!!
            assertEquals(
                "$label.targetParagraphs.min",
                ChatCoreFixtures.intOrNull(paragraphs, "min"),
                actual.targetParagraphsMin,
            )
            assertEquals(
                "$label.targetParagraphs.max",
                ChatCoreFixtures.intOrNull(paragraphs, "max"),
                actual.targetParagraphsMax,
            )
        }

        // 主对话输出约束提示（逐字符比较）
        @Suppress("UNCHECKED_CAST")
        val promptCases = (ChatCoreFixtures.listOrNull(root, "promptCases") as? List<Map<String, Any?>>) ?: error("缺少 promptCases")
        for (case in promptCases) {
            val mode = ChatCoreFixtures.str(case, "mode")!!
            val policy = ChatResponsePolicy.resolveResponsePolicy(sessionMode = mode)
            assertEquals(
                "buildMainChatOutputPrompt(mode=$mode)",
                ChatCoreFixtures.str(case, "prompt"),
                ChatResponsePolicy.buildMainChatOutputPrompt(policy),
            )
        }
    }

    // ---------------------------------------------------------------- 生成终止与域错误

    @Test
    fun generationTerminationMatchesGolden() {
        val root = ChatCoreFixtures.root("generation-termination")
        assertEquals(
            "TERMINAL_STATES",
            (ChatCoreFixtures.listOrNull(root, "terminalStates") as? List<*>)?.map { it.toString() },
            ChatGenerationTermination.TERMINAL_STATES,
        )

        // 观测口径推导
        @Suppress("UNCHECKED_CAST")
        val observationCases = (ChatCoreFixtures.listOrNull(root, "observationCases") as? List<Map<String, Any?>>)
            ?: error("缺少 observationCases")
        for (case in observationCases) {
            val outcome = ChatCoreFixtures.str(case, "outcome")!!
            val finishReason = ChatCoreFixtures.str(case, "finishReason")
            val errorKind = ChatCoreFixtures.str(case, "errorKind")
            val cancelReason = ChatCoreFixtures.str(case, "cancelReason")
            assertEquals(
                "observationTerminationCause(outcome=$outcome, finish=$finishReason, err=$errorKind, cancel=$cancelReason)",
                ChatCoreFixtures.str(case, "cause"),
                ChatGenerationTermination.observationTerminationCause(outcome, finishReason, errorKind, cancelReason),
            )
        }

        // finishReason → 应用层原因（含 undefined -> unknown）
        @Suppress("UNCHECKED_CAST")
        val finishReasonCases = (ChatCoreFixtures.listOrNull(root, "finishReasonCases") as? List<Map<String, Any?>>)
            ?: error("缺少 finishReasonCases")
        for (case in finishReasonCases) {
            val reason = ChatCoreFixtures.str(case, "reason")
            assertEquals(
                "terminationCauseFromFinishReason($reason)",
                ChatCoreFixtures.str(case, "cause"),
                ChatGenerationTermination.terminationCauseFromFinishReason(reason),
            )
        }

        // 原因 → 有效 finishReason
        @Suppress("UNCHECKED_CAST")
        val effectiveCases = (ChatCoreFixtures.listOrNull(root, "effectiveCauseCases") as? List<Map<String, Any?>>)
            ?: error("缺少 effectiveCauseCases")
        for (case in effectiveCases) {
            val cause = ChatCoreFixtures.str(case, "cause")!!
            val provider = ChatCoreFixtures.str(case, "providerFinishReason")
            assertEquals(
                "effectiveFinishReasonForCause($cause, $provider)",
                ChatCoreFixtures.str(case, "effective"),
                ChatGenerationTermination.effectiveFinishReasonForCause(cause, provider),
            )
        }

        // 有正文提示
        @Suppress("UNCHECKED_CAST")
        val withContentCases = (ChatCoreFixtures.listOrNull(root, "withContentCases") as? List<Map<String, Any?>>)
            ?: error("缺少 withContentCases")
        for (case in withContentCases) {
            val cause = ChatCoreFixtures.str(case, "cause")!!
            val expected = ChatCoreFixtures.mapOrNull(case, "prompt")
            val actual = ChatGenerationTermination.terminationPromptWithContent(cause)
            if (expected == null) {
                assertTrue("terminationPromptWithContent($cause) 期望 null，实际 $actual", actual == null)
            } else {
                assertEquals("withContent($cause).field", ChatCoreFixtures.str(expected, "field"), actual?.field)
                assertEquals("withContent($cause).text", ChatCoreFixtures.str(expected, "text"), actual?.text)
            }
        }

        // 无正文提示（含 errorMessage 覆盖与空白回退）
        @Suppress("UNCHECKED_CAST")
        val withoutContentCases = (ChatCoreFixtures.listOrNull(root, "withoutContentCases") as? List<Map<String, Any?>>)
            ?: error("缺少 withoutContentCases")
        for (case in withoutContentCases) {
            val cause = ChatCoreFixtures.str(case, "cause")!!
            val errorMessage = ChatCoreFixtures.str(case, "errorMessage")
            assertEquals(
                "terminationPromptWithoutContent($cause, $errorMessage)",
                ChatCoreFixtures.str(case, "text"),
                ChatGenerationTermination.terminationPromptWithoutContent(cause, errorMessage),
            )
        }

        assertEquals(
            "contentFilterPreservesBody",
            ChatCoreFixtures.boolOrNull(root, "contentFilterPreservesBody"),
            ChatGenerationTermination.contentFilterPreservesBody(),
        )

        // 一次性闸门：逐步重放并断言每步状态
        @Suppress("UNCHECKED_CAST")
        val latchCases = (ChatCoreFixtures.listOrNull(root, "latchCases") as? List<Map<String, Any?>>)
            ?: error("缺少 latchCases")
        for (case in latchCases) {
            val requestId = ChatCoreFixtures.str(case, "requestId")!!
            val latch = ChatGenerationTermination.createLatch(requestId)
            @Suppress("UNCHECKED_CAST")
            val trace = (ChatCoreFixtures.listOrNull(case, "trace") as? List<Map<String, Any?>>) ?: error("缺少 trace")
            trace.forEachIndexed { index, step ->
                val op = ChatCoreFixtures.str(step, "op")!!
                val label = "latch($requestId) step#$index $op"
                val result: Boolean? = when (op) {
                    "claim" -> latch.claim(ChatCoreFixtures.str(step, "cause")!!)
                    "markPersisted" -> {
                        latch.markPersisted()
                        null
                    }
                    else -> latch.acceptsStreamEvent()
                }
                if (result != null) {
                    assertEquals("$label result", ChatCoreFixtures.boolOrNull(step, "result"), result)
                }
                assertEquals("$label state", ChatCoreFixtures.str(step, "state"), latch.state)
                assertEquals("$label claimedCause", ChatCoreFixtures.str(step, "claimedCause"), latch.claimedCause)
            }
            assertEquals(
                "latch($requestId) finalState",
                ChatCoreFixtures.str(case, "finalState"),
                latch.state,
            )
        }
    }

    @Test
    fun domainErrorsMatchGolden() {
        val root = ChatCoreFixtures.root("domain-errors")
        assertEquals(
            "DOMAIN_ERROR_CODES",
            (ChatCoreFixtures.listOrNull(root, "codes") as? List<*>)?.map { it.toString() },
            ChatDomainErrors.CODES,
        )
        assertEquals(
            "RETRYABLE_CODES（TASK_INTERRUPTED 不得可重试：进程死亡后不自动重发）",
            (ChatCoreFixtures.listOrNull(root, "retryableCodes") as? List<*>)?.map { it.toString() },
            ChatDomainErrors.RETRYABLE_CODES.sorted(),
        )

        @Suppress("UNCHECKED_CAST")
        val createCases = (ChatCoreFixtures.listOrNull(root, "createCases") as? List<Map<String, Any?>>)
            ?: error("缺少 createCases")
        for (case in createCases) {
            val code = ChatCoreFixtures.str(case, "code")!!
            val created = ChatCoreFixtures.mapOrNull(case, "created")!!
            val actual = ChatDomainErrors.createDomainError(code, "msg")
            assertEquals("createDomainError($code).code", ChatCoreFixtures.str(created, "code"), actual.code)
            assertEquals("createDomainError($code).message", ChatCoreFixtures.str(created, "message"), actual.message)
            assertEquals("createDomainError($code).retryable", ChatCoreFixtures.boolOrNull(created, "retryable"), actual.retryable)
            assertEquals(
                "createDomainError($code, retryable=true)",
                ChatCoreFixtures.boolOrNull(ChatCoreFixtures.mapOrNull(case, "createdRetryableTrue")!!, "retryable"),
                ChatDomainErrors.createDomainError(code, "msg", retryable = true).retryable,
            )
            assertEquals(
                "createDomainError($code, retryable=false)",
                ChatCoreFixtures.boolOrNull(ChatCoreFixtures.mapOrNull(case, "createdRetryableFalse")!!, "retryable"),
                ChatDomainErrors.createDomainError(code, "msg", retryable = false).retryable,
            )
        }

        @Suppress("UNCHECKED_CAST")
        val sanitizeCases = (ChatCoreFixtures.listOrNull(root, "sanitizeCases") as? List<Map<String, Any?>>)
            ?: error("缺少 sanitizeCases")
        for (case in sanitizeCases) {
            val raw = ChatCoreFixtures.str(case, "raw") ?: ""
            val expected = ChatCoreFixtures.str(case, "sanitized")!!
            assertEquals("sanitizeErrorMessage(len=${raw.length})", expected, ChatDomainErrors.sanitizeErrorMessage(raw))
        }
    }

    // ---------------------------------------------------------------- token

    @Test
    fun tokenEstimateMatchesGolden() {
        val root = ChatCoreFixtures.root("token-estimate")
        for (case in ChatCoreFixtures.cases("token-estimate")) {
            val text = ChatCoreFixtures.str(case, "text")!!
            val model = ChatCoreFixtures.str(case, "model")
            val expected = ChatCoreFixtures.intOrNull(case, "tokens")!!
            assertEquals("estimateTokens(len=${text.length}, model=$model)", expected, ChatTokenCounter.estimateTokens(text, model))
            assertEquals(
                "formatTokens(tokens=$expected)",
                ChatCoreFixtures.str(case, "formatted"),
                ChatTokenCounter.formatTokens(expected),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val imageCases = ChatCoreFixtures.listOrNull(root, "imageTokens") as? List<Map<String, Any?>>
            ?: error("缺少 imageTokens")
        for (case in imageCases) {
            val count = ChatCoreFixtures.intOrNull(case, "count")!!
            assertEquals("estimateImageTokens($count)", ChatCoreFixtures.intOrNull(case, "tokens"), ChatTokenCounter.estimateImageTokens(count))
        }

        @Suppress("UNCHECKED_CAST")
        val formats = ChatCoreFixtures.listOrNull(root, "formats") as? List<Map<String, Any?>>
            ?: error("缺少 formats")
        for (case in formats) {
            val tokens = ChatCoreFixtures.intOrNull(case, "tokens")!!
            assertEquals("formatTokens($tokens)", ChatCoreFixtures.str(case, "text"), ChatTokenCounter.formatTokens(tokens))
        }
    }
}
