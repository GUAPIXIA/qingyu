package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-01 第 5 层：上下文主装配（无世界书子集）的跨语言一致性测试
 * （对齐 fixture `context-builder.json`，oracle 为 PC 的真实 `buildContextMessagesFromData`，
 * 输入限定为 `activeLorebookIds` 为空、`shadow` 关闭的路径）。
 *
 * 这是阶段 4 §3「同一角色、预设、世界书、记忆、历史和设置，PC/Android 生成的**请求消息数组**一致」
 * 的核心断言：数组、顺序、角色、正文、keepSeparate 与用量都必须逐项相同。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatContextBuilderGoldenTest {

    private val root = ChatCoreFixtures.root("context-builder")

    // ---------------------------------------------------------------- fixture → Kotlin 数据

    private fun characterOf(map: Map<String, Any?>?): ChatContextBuilder.CharacterSnapshot? {
        if (map == null) return null
        val authorNote = ChatCoreFixtures.mapOrNull(map, "authorNote")?.let {
            ChatContextBuilder.AuthorNote(
                enabled = ChatCoreFixtures.boolOrNull(it, "enabled") ?: false,
                text = ChatCoreFixtures.str(it, "text") ?: "",
                position = ChatCoreFixtures.str(it, "position") ?: "bottom",
                depth = ChatCoreFixtures.intOrNull(it, "depth") ?: 0,
            )
        }
        val translated = ChatCoreFixtures.mapOrNull(map, "translatedContent")?.let {
            ChatContextBuilder.TranslatedContent(
                name = ChatCoreFixtures.str(it, "name"),
                description = ChatCoreFixtures.str(it, "description"),
                personality = ChatCoreFixtures.str(it, "personality"),
                scenario = ChatCoreFixtures.str(it, "scenario"),
                firstMessage = ChatCoreFixtures.str(it, "firstMessage"),
                exampleDialog = ChatCoreFixtures.str(it, "exampleDialog"),
            )
        }
        return ChatContextBuilder.CharacterSnapshot(
            id = ChatCoreFixtures.str(map, "id") ?: "",
            name = ChatCoreFixtures.str(map, "name") ?: "",
            description = ChatCoreFixtures.str(map, "description") ?: "",
            personality = ChatCoreFixtures.str(map, "personality") ?: "",
            scenario = ChatCoreFixtures.str(map, "scenario") ?: "",
            exampleDialog = ChatCoreFixtures.str(map, "exampleDialog") ?: "",
            systemPrompt = ChatCoreFixtures.str(map, "systemPrompt"),
            postHistoryInstructions = ChatCoreFixtures.str(map, "postHistoryInstructions"),
            defaultNarrativeMode = ChatCoreFixtures.str(map, "defaultNarrativeMode"),
            authorNote = authorNote,
            translatedContent = translated,
        )
    }

    private fun presetOf(map: Map<String, Any?>?): ChatContextBuilder.PresetSnapshot? {
        if (map == null) return null
        return ChatContextBuilder.PresetSnapshot(
            id = ChatCoreFixtures.str(map, "id") ?: "",
            systemPrompt = ChatCoreFixtures.str(map, "systemPrompt") ?: "",
            jailbreak = ChatCoreFixtures.str(map, "jailbreak") ?: "",
            maxContext = ChatCoreFixtures.intOrNull(map, "maxContext") ?: 0,
            maxTokens = ChatCoreFixtures.intOrNull(map, "maxTokens") ?: 0,
            responseLengthHint = ChatCoreFixtures.str(map, "responseLengthHint"),
            contextTemplate = ChatCoreFixtures.str(map, "contextTemplate"),
            exampleDialogMode = ChatCoreFixtures.str(map, "exampleDialogMode"),
            enableThoughtFormat = ChatCoreFixtures.boolOrNull(map, "enableThoughtFormat"),
        )
    }

    private fun sessionOf(map: Map<String, Any?>): ChatContextBuilder.SessionSnapshot {
        val range = ChatCoreFixtures.mapOrNull(map, "compressedRange")?.let {
            ChatContextBuilder.CompressedRange(
                startTs = (it["startTs"] as? Number)?.toLong() ?: 0L,
                endTs = (it["endTs"] as? Number)?.toLong() ?: 0L,
            )
        }
        return ChatContextBuilder.SessionSnapshot(
            id = ChatCoreFixtures.str(map, "id") ?: "",
            characterId = ChatCoreFixtures.str(map, "characterId") ?: "",
            memoryEnabled = ChatCoreFixtures.boolOrNull(map, "memoryEnabled") ?: false,
            memory = ChatCoreFixtures.str(map, "memory") ?: "",
            memoryCurrentState = ChatCoreFixtures.str(map, "memoryCurrentState"),
            // 事实一律以旧文本事实表达（fixture 里是字符串数组），与 PC 的 memoryFacts 形状一致
            memoryFacts = ((ChatCoreFixtures.listOrNull(map, "memoryFacts") as? List<*>) ?: emptyList<Any?>())
                .map { item -> ChatMemoryFacts.FactRecord.TextFact(item.toString()) },
            narrativeMode = ChatCoreFixtures.str(map, "narrativeMode"),
            responseLengthMode = ChatCoreFixtures.str(map, "responseLengthMode"),
            compressedSummary = ChatCoreFixtures.str(map, "compressedSummary"),
            compressedRange = range,
        )
    }

    private fun settingsOf(map: Map<String, Any?>?): ChatContextBuilder.SettingsSnapshot {
        if (map == null) return ChatContextBuilder.SettingsSnapshot()
        val persona = ChatCoreFixtures.mapOrNull(map, "personaInjection")?.let {
            ChatContextBuilder.PersonaInjection(
                enabled = ChatCoreFixtures.boolOrNull(it, "enabled") ?: true,
                position = ChatCoreFixtures.str(it, "position") ?: "system",
                includeDescription = ChatCoreFixtures.boolOrNull(it, "includeDescription") ?: true,
                includePersona = ChatCoreFixtures.boolOrNull(it, "includePersona") ?: true,
            )
        }
        val compression = ChatCoreFixtures.mapOrNull(map, "contextCompression")
        return ChatContextBuilder.SettingsSnapshot(
            userName = ChatCoreFixtures.str(map, "userName") ?: "",
            activeModel = ChatCoreFixtures.str(map, "activeModel") ?: "",
            defaultNarrativeMode = ChatCoreFixtures.str(map, "defaultNarrativeMode"),
            omniscientNarrativeRules = ChatCoreFixtures.str(map, "omniscientNarrativeRules"),
            personaInjection = persona,
            userDescription = ChatCoreFixtures.str(map, "userDescription"),
            userPersona = ChatCoreFixtures.str(map, "userPersona"),
            enableThoughtFormat = ChatCoreFixtures.boolOrNull(map, "enableThoughtFormat"),
            exampleDialogPosition = ChatCoreFixtures.str(map, "exampleDialogPosition"),
            exampleDialogMode = ChatCoreFixtures.str(map, "exampleDialogMode"),
            contextCompressionEnabled = compression?.let { ChatCoreFixtures.boolOrNull(it, "enabled") },
            contextCompressionMinDropTokens = compression?.let { ChatCoreFixtures.intOrNull(it, "minDropTokens") },
        )
    }

    private fun dataOf(map: Map<String, Any?>): ChatContextBuilder.BuildData {
        @Suppress("UNCHECKED_CAST")
        val chat = ChatCoreFixtures.mapOrNull(map, "chat") ?: error("缺少 chat")
        val messages = ((ChatCoreFixtures.listOrNull(chat, "messages") as? List<Map<String, Any?>>) ?: emptyList())
            .map {
                ChatContextBuilder.MessageSnapshot(
                    id = ChatCoreFixtures.str(it, "id") ?: "",
                    role = ChatCoreFixtures.str(it, "role") ?: "",
                    content = ChatCoreFixtures.str(it, "content") ?: "",
                    images = (ChatCoreFixtures.listOrNull(it, "images") as? List<*>)?.map { image -> image.toString() },
                    timestamp = (it["timestamp"] as? Number)?.toLong() ?: 0L,
                )
            }
        val sessions = ((ChatCoreFixtures.listOrNull(chat, "sessions") as? List<Map<String, Any?>>) ?: emptyList())
            .map { sessionOf(it) }
        val settingsWrapper = ChatCoreFixtures.mapOrNull(map, "settings")
        val settings = settingsOf(settingsWrapper?.let { ChatCoreFixtures.mapOrNull(it, "settings") })
        val profileMap = settingsWrapper?.let { ChatCoreFixtures.mapOrNull(it, "profile") }
        val profile = profileMap?.let {
            ChatContextBuilder.ProfileSnapshot(
                provider = ChatCoreFixtures.str(it, "provider") ?: "openai",
                model = ChatCoreFixtures.str(it, "model") ?: "",
                useInstructTemplate = ChatCoreFixtures.boolOrNull(it, "useInstructTemplate"),
                maxContext = ChatCoreFixtures.intOrNull(it, "maxContext") ?: 0,
            )
        }
        return ChatContextBuilder.BuildData(
            character = characterOf(ChatCoreFixtures.mapOrNull(map, "character")),
            preset = presetOf(ChatCoreFixtures.mapOrNull(map, "preset")),
            chat = ChatContextBuilder.ChatSnapshot(
                messages = messages,
                sessions = sessions,
                currentSessionId = ChatCoreFixtures.str(chat, "currentSessionId"),
                activeLorebookIds = (ChatCoreFixtures.listOrNull(chat, "activeLorebookIds") as? List<*>)
                    ?.map { it.toString() } ?: emptyList(),
            ),
            settings = settings,
            profile = profile,
            lorebooks = lorebooksOf(map),
        )
    }

    /**
     * fixture 的世界书 → 运行时输入。
     *
     * 注意 `enabled` 必须显式补默认 true：PC 的 `Lorebook/LoreEntry.enabled` 是必填布尔，
     * 省略会变成 `undefined`（falsy），运行时将静默跳过全部条目。
     */
    private fun lorebooksOf(map: Map<String, Any?>): List<ChatLorebookRuntime.Book> {
        val raw = ChatCoreFixtures.listOrNull(map, "lorebooks") as? List<Map<String, Any?>> ?: return emptyList()
        return raw.map { book ->
            ChatLorebookRuntime.Book(
                id = ChatCoreFixtures.str(book, "id") ?: "",
                name = ChatCoreFixtures.str(book, "name") ?: "",
                enabled = ChatCoreFixtures.boolOrNull(book, "enabled") ?: true,
                scanDepth = ChatCoreFixtures.intOrNull(book, "scanDepth"),
                tokenBudget = ChatCoreFixtures.intOrNull(book, "tokenBudget"),
                recursiveScanning = ChatCoreFixtures.boolOrNull(book, "recursiveScanning") ?: true,
                entries = ((ChatCoreFixtures.listOrNull(book, "entries") as? List<Map<String, Any?>>)
                    ?: emptyList()).map { entry ->
                    ChatLorebookRuntime.Entry(
                        id = ChatCoreFixtures.str(entry, "id") ?: "",
                        content = ChatCoreFixtures.str(entry, "content") ?: "",
                        keywords = (ChatCoreFixtures.listOrNull(entry, "keywords") as? List<*>)?.map { it.toString() }
                            ?: emptyList(),
                        enabled = ChatCoreFixtures.boolOrNull(entry, "enabled") ?: true,
                        position = ChatCoreFixtures.str(entry, "position") ?: "before_char",
                        depth = ChatCoreFixtures.intOrNull(entry, "depth"),
                        role = ChatCoreFixtures.str(entry, "role"),
                        priority = ChatCoreFixtures.str(entry, "priority"),
                        order = ChatCoreFixtures.intOrNull(entry, "order") ?: 0,
                        summary = ChatCoreFixtures.str(entry, "summary"),
                        ignoreBudget = ChatCoreFixtures.boolOrNull(entry, "ignoreBudget") ?: false,
                    )
                },
            )
        }
    }

    private fun optionsOf(map: Map<String, Any?>?): ChatContextBuilder.BuildOptions {
        if (map == null) return ChatContextBuilder.BuildOptions()
        return ChatContextBuilder.BuildOptions(
            continuation = ChatCoreFixtures.boolOrNull(map, "continuation") ?: false,
            narrativeMode = ChatCoreFixtures.str(map, "narrativeMode"),
            generationType = ChatCoreFixtures.str(map, "generationType"),
        )
    }

    // ---------------------------------------------------------------- 断言

    private fun assertPolicy(label: String, expected: Map<String, Any?>, actual: ChatResponsePolicy.Policy) {
        assertEquals("$label.mode", ChatCoreFixtures.str(expected, "mode"), actual.mode)
        assertEquals("$label.source", ChatCoreFixtures.str(expected, "source"), actual.source)
        assertEquals("$label.preferredMinChars", ChatCoreFixtures.intOrNull(expected, "preferredMinChars"), actual.preferredMinChars)
        assertEquals("$label.preferredMaxChars", ChatCoreFixtures.intOrNull(expected, "preferredMaxChars"), actual.preferredMaxChars)
        assertEquals("$label.hardMaxChars", ChatCoreFixtures.intOrNull(expected, "hardMaxChars"), actual.hardMaxChars)
        assertEquals("$label.maxNewBeats", ChatCoreFixtures.intOrNull(expected, "maxNewBeats"), actual.maxNewBeats)
        val paragraphs = ChatCoreFixtures.mapOrNull(expected, "targetParagraphs")!!
        assertEquals("$label.targetParagraphs.min", ChatCoreFixtures.intOrNull(paragraphs, "min"), actual.targetParagraphsMin)
        assertEquals("$label.targetParagraphs.max", ChatCoreFixtures.intOrNull(paragraphs, "max"), actual.targetParagraphsMax)
    }

    @Test
    fun constantsMatchPc() {
        val constants = ChatCoreFixtures.mapOrNull(root, "constants")!!
        assertEquals(
            "DEFAULT_SYSTEM_PROMPT",
            ChatCoreFixtures.str(constants, "defaultSystemPrompt"),
            ChatContextBuilder.DEFAULT_SYSTEM_PROMPT,
        )
        assertEquals("DEFAULT_USER_NAME", ChatCoreFixtures.str(constants, "defaultUserName"), ChatContextBuilder.DEFAULT_USER_NAME)
        assertEquals("DEFAULT_MODEL", ChatCoreFixtures.str(constants, "defaultModel"), ChatContextBuilder.DEFAULT_MODEL)
        assertEquals(
            "CONTINUATION_INSTRUCTION",
            ChatCoreFixtures.str(constants, "continuationInstruction"),
            ChatContextBuilder.CONTINUATION_INSTRUCTION,
        )
    }

    @Test
    fun requestPlanMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "planCases") as? List<Map<String, Any?>>)
            ?: error("缺少 planCases")
        for (case in cases) {
            val caseIndex = ChatCoreFixtures.intOrNull(case, "caseIndex")
            val data = dataOf(case["data"] as Map<String, Any?>)
            val plan = ChatContextBuilder.resolveChatRequestPlan(data)
            val label = "plan#$caseIndex"
            assertPolicy("$label.responsePolicy", ChatCoreFixtures.mapOrNull(case, "responsePolicy")!!, plan.responsePolicy)
            assertEquals("$label.requestMaxTokens", ChatCoreFixtures.intOrNull(case, "requestMaxTokens"), plan.requestMaxTokens)
            assertEquals("$label.responseIntent", ChatCoreFixtures.str(case, "responseIntent"), plan.responseIntent)
            assertEquals(
                "$label.sceneFactor",
                (case["sceneFactor"] as Number).toDouble(),
                plan.sceneFactor,
                1e-9,
            )
            assertEquals("$label.bodyReserve", ChatCoreFixtures.intOrNull(case, "bodyReserve"), plan.requestBudget.bodyReserve)
            assertEquals(
                "$label.reasoningReserve",
                ChatCoreFixtures.intOrNull(case, "reasoningReserve"),
                plan.requestBudget.reasoningReserve,
            )
        }
    }

    @Test
    fun buildMessagesMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "buildCases") as? List<Map<String, Any?>>)
            ?: error("缺少 buildCases")
        for (case in cases) {
            val caseIndex = ChatCoreFixtures.intOrNull(case, "caseIndex")
            val data = dataOf(case["data"] as Map<String, Any?>)
            val result = ChatContextBuilder.buildContextMessagesFromData(data, optionsOf(ChatCoreFixtures.mapOrNull(case, "opts")))
            val label = "build#$caseIndex"

            @Suppress("UNCHECKED_CAST")
            val expectedMessages = (ChatCoreFixtures.listOrNull(case, "messages") as? List<Map<String, Any?>>)
                ?: error("缺少 messages")
            assertEquals("$label 消息条数", expectedMessages.size, result.messages.size)
            expectedMessages.forEachIndexed { index, expected ->
                val actual = result.messages[index]
                val messageLabel = "$label.messages[$index]"
                assertEquals("$messageLabel.role", ChatCoreFixtures.str(expected, "role"), actual.role)
                assertEquals(
                    "$messageLabel.content",
                    ChatCoreFixtures.str(expected, "content") ?: "",
                    actual.content,
                )
                assertEquals(
                    "$messageLabel.keepSeparate",
                    ChatCoreFixtures.boolOrNull(expected, "keepSeparate") ?: false,
                    actual.keepSeparate,
                )
                val expectedImages = (ChatCoreFixtures.listOrNull(expected, "images") as? List<*>)?.map { it.toString() }
                assertEquals("$messageLabel.images", expectedImages, actual.images)
            }

            val usage = ChatCoreFixtures.mapOrNull(case, "lastContextUsage")!!
            assertEquals("$label.lastContextUsage.used", ChatCoreFixtures.intOrNull(usage, "used"), result.lastContextUsage.used)
            assertEquals("$label.lastContextUsage.max", ChatCoreFixtures.intOrNull(usage, "max"), result.lastContextUsage.max)
            assertEquals("$label.requestMaxTokens", ChatCoreFixtures.intOrNull(case, "requestMaxTokens"), result.requestMaxTokens)
            assertEquals("$label.responseIntent", ChatCoreFixtures.str(case, "responseIntent"), result.responseIntent)
            assertEquals("$label.narrativeMode", ChatCoreFixtures.str(case, "narrativeMode"), result.narrativeMode)

            val expectedPending = ChatCoreFixtures.mapOrNull(case, "pendingCompression")
            if (expectedPending == null) {
                assertNull("$label.pendingCompression 期望 null", result.pendingCompression)
            } else {
                assertTrue("$label 必须产生 pendingCompression", result.pendingCompression != null)
                assertEquals(
                    "$label.pendingCompression.characterId",
                    ChatCoreFixtures.str(expectedPending, "characterId"),
                    result.pendingCompression!!.characterId,
                )
                assertEquals(
                    "$label.pendingCompression.sessionId",
                    ChatCoreFixtures.str(expectedPending, "sessionId"),
                    result.pendingCompression!!.sessionId,
                )
                assertEquals(
                    "$label.pendingCompression.droppedStartTs",
                    (expectedPending["droppedStartTs"] as? Number)?.toLong(),
                    result.pendingCompression!!.droppedStartTs,
                )
                assertEquals(
                    "$label.pendingCompression.droppedEndTs",
                    (expectedPending["droppedEndTs"] as? Number)?.toLong(),
                    result.pendingCompression!!.droppedEndTs,
                )
                assertEquals(
                    "$label.pendingCompression.droppedText",
                    ChatCoreFixtures.str(expectedPending, "droppedText"),
                    result.pendingCompression!!.droppedText,
                )
            }
        }
    }
}
