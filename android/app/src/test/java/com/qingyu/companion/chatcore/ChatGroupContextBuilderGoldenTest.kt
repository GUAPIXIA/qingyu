package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 6 S6-01(c)：**群聊上下文完整装配**的跨语言一致性测试
 * （对齐 fixture `group-context.json`，oracle 为 `shared/chat-core/groupContextBuilder.ts`，
 * 即 PC `buildGroupChatContext` 组装顺序 1–19 的逐字抽出）。
 *
 * 阶段 6 §3 第一条「群聊三模式对同一 fixture 产生相同发言计划与上下文」的
 * 「上下文」半边：发言计划由 `ChatGroupSchedulingGoldenTest` 钉住，
 * 上下文（system 拼装顺序/历史归属/裁剪与压缩/深度插入/宏展开/模板前缀）由本用例钉住。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatGroupContextBuilderGoldenTest {

    private val root = ChatCoreFixtures.root("group-context")

    @Suppress("UNCHECKED_CAST")
    private fun cases(key: String): List<Map<String, Any?>> =
        (ChatCoreFixtures.listOrNull(root, key) as? List<Map<String, Any?>>)
            ?: error("缺少 $key（请先运行 TS 生成器：CHAT_CORE_UPDATE_FIXTURES=1 pnpm exec vitest run shared/__tests__/groupChatCoreGolden.test.ts）")

    private fun long(map: Map<String, Any?>, key: String): Long? = (map[key] as? Number)?.toLong()
    private fun int(map: Map<String, Any?>, key: String): Int? = (map[key] as? Number)?.toInt()
    private fun bool(map: Map<String, Any?>, key: String): Boolean? = map[key] as? Boolean

    @Suppress("UNCHECKED_CAST")
    private fun members(map: Map<String, Any?>): List<ChatGroupContextBlocks.Member> =
        (ChatCoreFixtures.listOrNull(map, "members") as? List<Map<String, Any?>>).orEmpty().map {
            ChatGroupContextBlocks.Member(
                id = ChatCoreFixtures.str(it, "id") ?: "",
                name = ChatCoreFixtures.str(it, "name") ?: "",
                translatedName = ChatCoreFixtures.str(it, "translatedName"),
                description = ChatCoreFixtures.str(it, "description"),
                personality = ChatCoreFixtures.str(it, "personality"),
                scenario = ChatCoreFixtures.str(it, "scenario"),
                systemPrompt = ChatCoreFixtures.str(it, "systemPrompt"),
                exampleDialog = ChatCoreFixtures.str(it, "exampleDialog"),
                postHistoryInstructions = ChatCoreFixtures.str(it, "postHistoryInstructions"),
            )
        }

    @Suppress("UNCHECKED_CAST")
    private fun messages(map: Map<String, Any?>): List<ChatGroupContextBuilder.Message> =
        (ChatCoreFixtures.listOrNull(map, "messages") as? List<Map<String, Any?>>).orEmpty().map {
            ChatGroupContextBuilder.Message(
                characterId = ChatCoreFixtures.str(it, "characterId") ?: "",
                content = ChatCoreFixtures.str(it, "content") ?: "",
                images = (ChatCoreFixtures.listOrNull(it, "images") as? List<*>).orEmpty().map { img -> img.toString() },
                timestamp = (it["timestamp"] as Number).toLong(),
            )
        }

    @Suppress("UNCHECKED_CAST")
    private fun session(map: Map<String, Any?>): ChatGroupContextBuilder.SessionInput? {
        val s = ChatCoreFixtures.mapOrNull(map, "session") ?: return null
        val range = ChatCoreFixtures.mapOrNull(s, "compressedRange")
        val facts = (ChatCoreFixtures.listOrNull(s, "memoryFacts") as? List<*>).orEmpty().map { fact ->
            when (fact) {
                is String -> ChatMemoryFacts.FactRecord.TextFact(fact)
                is Map<*, *> -> ChatMemoryFacts.FactRecord.Structured(
                    id = fact["id"] as? String ?: "",
                    subject = fact["subject"] as? String ?: "",
                    predicate = fact["predicate"] as? String ?: "",
                    value = fact["value"] as? String ?: "",
                )
                else -> ChatMemoryFacts.FactRecord.TextFact(fact.toString())
            }
        }
        return ChatGroupContextBuilder.SessionInput(
            personaId = ChatCoreFixtures.str(s, "personaId"),
            narrativeMode = ChatCoreFixtures.str(s, "narrativeMode"),
            memoryEnabled = bool(s, "memoryEnabled") ?: false,
            memory = ChatCoreFixtures.str(s, "memory"),
            memoryCurrentState = ChatCoreFixtures.str(s, "memoryCurrentState"),
            memoryFacts = if (ChatCoreFixtures.listOrNull(s, "memoryFacts") != null) facts else null,
            compressedSummary = ChatCoreFixtures.str(s, "compressedSummary"),
            compressedRange = range?.let { (long(it, "startTs") ?: 0L) to (long(it, "endTs") ?: 0L) },
        )
    }

    private fun settings(map: Map<String, Any?>): ChatGroupContextBuilder.Settings {
        val s = ChatCoreFixtures.mapOrNull(map, "settings") ?: return ChatGroupContextBuilder.Settings()
        val compression = ChatCoreFixtures.mapOrNull(s, "contextCompression")
        return ChatGroupContextBuilder.Settings(
            defaultNarrativeMode = ChatCoreFixtures.str(s, "defaultNarrativeMode"),
            enableThoughtFormat = bool(s, "enableThoughtFormat") ?: true,
            omniscientNarrativeRules = ChatCoreFixtures.str(s, "omniscientNarrativeRules"),
            scenarioInjectionMode = ChatCoreFixtures.str(s, "scenarioInjectionMode"),
            contextCompression = compression?.let {
                ChatGroupContextBuilder.CompressionSettings(
                    enabled = bool(it, "enabled") ?: true,
                    minDropTokens = int(it, "minDropTokens") ?: 2000,
                )
            },
        )
    }

    private fun input(map: Map<String, Any?>): ChatGroupContextBuilder.Input {
        val group = ChatCoreFixtures.mapOrNull(map, "group")!!
        val presetMap = ChatCoreFixtures.mapOrNull(map, "preset")
        val profileMap = ChatCoreFixtures.mapOrNull(map, "profile")
        val planMap = ChatCoreFixtures.mapOrNull(map, "lorebookPlan")
        val injectionMap = ChatCoreFixtures.mapOrNull(map, "personaInjection")
        return ChatGroupContextBuilder.Input(
            groupName = ChatCoreFixtures.str(group, "name") ?: "",
            chatMode = ChatCoreFixtures.str(group, "chatMode") ?: "",
            groupSystemPrompt = ChatCoreFixtures.str(group, "systemPrompt") ?: "",
            defaultNarrativeMode = ChatCoreFixtures.str(group, "defaultNarrativeMode"),
            members = members(map),
            targetId = ChatCoreFixtures.str(map, "targetId"),
            session = session(map),
            messages = messages(map),
            userName = ChatCoreFixtures.str(map, "userName") ?: "",
            userDescription = ChatCoreFixtures.str(map, "userDescription"),
            userPersona = ChatCoreFixtures.str(map, "userPersona"),
            personaInjection = injectionMap?.let {
                ChatGroupContextBlocks.PersonaInjection(
                    enabled = bool(it, "enabled") ?: true,
                    position = ChatCoreFixtures.str(it, "position") ?: "system",
                    includeDescription = bool(it, "includeDescription"),
                    includePersona = bool(it, "includePersona"),
                )
            },
            settings = settings(map),
            semanticFacts = (ChatCoreFixtures.listOrNull(map, "semanticFacts") as? List<Map<String, Any?>>)
                ?.map { ChatGroupContextBuilder.SemanticFact(ChatCoreFixtures.str(it, "text") ?: "", (it["score"] as Number).toDouble()) },
            preset = presetMap?.let {
                ChatGroupContextBuilder.PresetInput(
                    systemPrompt = ChatCoreFixtures.str(it, "systemPrompt"),
                    jailbreak = ChatCoreFixtures.str(it, "jailbreak"),
                    contextTemplate = ChatCoreFixtures.str(it, "contextTemplate"),
                )
            },
            profile = profileMap?.let {
                ChatGroupContextBuilder.ProfileInput(
                    provider = ChatCoreFixtures.str(it, "provider"),
                    useInstructTemplate = bool(it, "useInstructTemplate"),
                )
            },
            model = ChatCoreFixtures.str(map, "model") ?: "",
            maxContext = int(map, "maxContext") ?: 0,
            requestMaxTokens = int(map, "requestMaxTokens") ?: 0,
            lorebookPlan = planMap?.let {
                ChatGroupContextBuilder.LorebookPlan(
                    beforeCharacter = strList(it, "beforeCharacter"),
                    afterCharacter = strList(it, "afterCharacter"),
                    beforeExamples = strList(it, "beforeExamples"),
                    afterExamples = strList(it, "afterExamples"),
                    promptEnd = strList(it, "promptEnd"),
                    authorsNoteTop = strList(it, "authorsNoteTop"),
                    authorsNoteBottom = strList(it, "authorsNoteBottom"),
                    chat = (ChatCoreFixtures.listOrNull(it, "chat") as? List<Map<String, Any?>>).orEmpty().map { item ->
                        ChatContextShared.DepthInsertItem(
                            content = ChatCoreFixtures.str(item, "content") ?: "",
                            depth = int(item, "depth") ?: 0,
                            order = int(item, "order") ?: 0,
                            role = ChatCoreFixtures.str(item, "role"),
                        )
                    },
                )
            },
            trackUsage = bool(map, "trackUsage") ?: true,
        )
    }

    @Suppress("UNCHECKED_CAST")
    private fun strList(map: Map<String, Any?>, key: String): List<String> =
        (ChatCoreFixtures.listOrNull(map, key) as? List<*>).orEmpty().map { it.toString() }

    @Test
    fun personaResolutionMatchesPc() {
        for (case in cases("personaResolutionCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val personaMap = ChatCoreFixtures.mapOrNull(input, "sessionPersona")
            val result = ChatGroupContextBuilder.resolvePersonaFields(
                sessionPersonaId = ChatCoreFixtures.str(input, "sessionPersonaId"),
                sessionPersonaIdDefined = bool(input, "sessionPersonaIdDefined") ?: false,
                sessionPersona = personaMap?.let {
                    ChatGroupContextBlocks.PersonaLike(
                        name = ChatCoreFixtures.str(it, "name"),
                        description = ChatCoreFixtures.str(it, "description"),
                        persona = ChatCoreFixtures.str(it, "persona"),
                    )
                },
                defaultPersonaId = ChatCoreFixtures.str(input, "defaultPersonaId"),
                activePersonaId = ChatCoreFixtures.str(input, "activePersonaId"),
                globalUserName = ChatCoreFixtures.str(input, "globalUserName") ?: "",
                globalUserDescription = ChatCoreFixtures.str(input, "globalUserDescription") ?: "",
                globalUserPersona = ChatCoreFixtures.str(input, "globalUserPersona") ?: "",
            )
            val expected = ChatCoreFixtures.mapOrNull(case, "expected")!!
            assertEquals("$label：用户名解析必须与 PC 相同", ChatCoreFixtures.str(expected, "userName"), result.userName)
            assertEquals("$label：用户描述解析必须与 PC 相同", ChatCoreFixtures.str(expected, "userDescription"), result.userDescription)
            assertEquals("$label：用户性格解析必须与 PC 相同", ChatCoreFixtures.str(expected, "userPersona"), result.userPersona)
        }
    }

    @Test
    fun assembledContextMatchesPcForThreeModes() {
        for (case in cases("buildCases")) {
            val label = ChatCoreFixtures.str(case, "label") ?: "?"
            val expected = ChatCoreFixtures.mapOrNull(case, "expected")!!
            val result = ChatGroupContextBuilder.build(input(ChatCoreFixtures.mapOrNull(case, "input")!!))

            assertEquals(
                "$label：叙事模式解析必须与 PC 相同",
                ChatCoreFixtures.str(expected, "narrativeMode"),
                result.narrativeMode,
            )

            @Suppress("UNCHECKED_CAST")
            val expectedMessages = (ChatCoreFixtures.listOrNull(expected, "messages") as? List<Map<String, Any?>>).orEmpty()
            assertEquals(
                "$label：组装出的消息条数必须与 PC 相同（system 段/历史/模板前缀的条数都算数）",
                expectedMessages.size,
                result.messages.size,
            )
            for ((index, exp) in expectedMessages.withIndex()) {
                val act = result.messages[index]
                val prefix = "$label：第 ${index + 1} 条"
                assertEquals("$prefix role 必须与 PC 相同", ChatCoreFixtures.str(exp, "role"), act.role)
                assertEquals(
                    "$prefix 正文必须与 PC 逐字一致（组装顺序/归属前缀/宏展开/变量替换都在其中）",
                    ChatCoreFixtures.str(exp, "content"),
                    act.content,
                )
                assertEquals("$prefix 图片必须与 PC 相同", strList(exp, "images"), act.images.orEmpty())
                assertEquals(
                    "$prefix keepSeparate 必须与 PC 相同",
                    bool(exp, "keepSeparate") ?: false,
                    act.keepSeparate,
                )
            }

            val expPending = ChatCoreFixtures.mapOrNull(expected, "pendingCompression")
            val actPending = result.pendingCompression
            if (expPending == null) {
                assertNull("$label：不应产出 pendingCompression", actPending)
            } else {
                assertNotNull("$label：必须产出 pendingCompression（溢出压缩触发）", actPending)
                assertEquals(
                    "$label：pending 被裁文本（含用户名/成员名/未知角色归属）必须与 PC 逐字一致",
                    ChatCoreFixtures.str(expPending, "droppedText"),
                    actPending!!.droppedText,
                )
                assertEquals("$label：droppedStartTs 必须与 PC 相同", long(expPending, "droppedStartTs"), actPending.droppedStartTs)
                assertEquals("$label：droppedEndTs 必须与 PC 相同", long(expPending, "droppedEndTs"), actPending.droppedEndTs)
            }
        }
    }

    @Test
    fun fixtureCoverageIsPinned() {
        // 用例数突变要复审覆盖（三模式 + 场景门控 + 压缩摘要 + pending + 语义事实）
        assertEquals("group-context 装配用例数变了，请复审覆盖矩阵", 8, cases("buildCases").size)
        assertEquals("身份解析用例数变了，请复审覆盖矩阵", 3, cases("personaResolutionCases").size)
    }
}
