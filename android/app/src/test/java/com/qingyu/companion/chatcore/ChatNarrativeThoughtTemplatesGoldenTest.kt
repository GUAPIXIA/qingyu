package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-01 第 7 层：叙事模式 / thought 契约 / instruct 模板的跨语言一致性测试
 * （对齐 fixture `narrative-thought-templates.json`，oracle 为 PC 的
 * `shared/narrativeMode.ts`、`shared/thoughtContract.ts`、`shared/chat-core/chatTemplates.ts`）。
 *
 * 提示词逐字符比对：叙事模式与 thought 契约决定「谁在说话」，
 * 两端措辞不同会让同一会话在 PC 与 Android 呈现不同叙事身份。
 *
 * 需要 Robolectric：fixture 读取依赖 `org.json`（JVM 单测里未实现）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatNarrativeThoughtTemplatesGoldenTest {

    private val root = ChatCoreFixtures.root("narrative-thought-templates")

    /**
     * 解码叙事模式实参标记。
     * fixture 里 `undefined` 与 `null` 以显式判别对象记录（数组元素无法经 JSON 往返），
     * 两者对本模块的函数行为一致，均解码为 null。
     */
    private fun decodeModeArg(raw: Any?): String? {
        val map = raw as? Map<*, *> ?: return null
        return when (map["kind"]) {
            "string" -> map["value"] as? String
            else -> null
        }
    }

    private fun assertTemplate(label: String, expected: Map<String, Any?>?, actual: ChatTemplates.InstructTemplate?) {
        if (expected == null) {
            assertNull("$label 期望 null", actual)
            return
        }
        requireNotNull(actual) { "$label 期望非 null" }
        assertEquals("$label.systemPrefix", ChatCoreFixtures.str(expected, "systemPrefix") ?: "", actual.systemPrefix)
        assertEquals("$label.systemSuffix", ChatCoreFixtures.str(expected, "systemSuffix") ?: "", actual.systemSuffix)
        assertEquals("$label.userPrefix", ChatCoreFixtures.str(expected, "userPrefix") ?: "", actual.userPrefix)
        assertEquals("$label.userSuffix", ChatCoreFixtures.str(expected, "userSuffix") ?: "", actual.userSuffix)
        assertEquals(
            "$label.assistantPrefix",
            ChatCoreFixtures.str(expected, "assistantPrefix") ?: "",
            actual.assistantPrefix,
        )
        assertEquals(
            "$label.assistantSuffix",
            ChatCoreFixtures.str(expected, "assistantSuffix") ?: "",
            actual.assistantSuffix,
        )
        assertEquals(
            "$label.systemAsTopLevel",
            ChatCoreFixtures.boolOrNull(expected, "systemAsTopLevel"),
            actual.systemAsTopLevel,
        )
        assertEquals(
            "$label.stopSequences",
            (ChatCoreFixtures.listOrNull(expected, "stopSequences") as? List<*>)?.map { item -> item.toString() } ?: emptyList<String>(),
            actual.stopSequences,
        )
        assertEquals(
            "$label.appendAssistantPrefix",
            ChatCoreFixtures.boolOrNull(expected, "appendAssistantPrefix") ?: false,
            actual.appendAssistantPrefix,
        )
    }

    @Test
    fun narrativeModeMatchesPc() {
        val narrative = ChatCoreFixtures.mapOrNull(root, "narrative")!!

        assertEquals(
            "DEFAULT_NARRATIVE_MODE",
            ChatCoreFixtures.str(narrative, "defaultMode"),
            ChatNarrativeMode.DEFAULT_NARRATIVE_MODE,
        )

        // 选项表（顺序与文案）
        @Suppress("UNCHECKED_CAST")
        val options = (ChatCoreFixtures.listOrNull(narrative, "options") as? List<Map<String, Any?>>)
            ?: error("缺少 options")
        assertEquals("选项数量", options.size, ChatNarrativeMode.NARRATIVE_MODE_OPTIONS.size)
        options.forEachIndexed { index, expected ->
            val actual = ChatNarrativeMode.NARRATIVE_MODE_OPTIONS[index]
            assertEquals("option[$index].value", ChatCoreFixtures.str(expected, "value"), actual.value)
            assertEquals("option[$index].label", ChatCoreFixtures.str(expected, "label"), actual.label)
            assertEquals("option[$index].shortLabel", ChatCoreFixtures.str(expected, "shortLabel"), actual.shortLabel)
            assertEquals("option[$index].description", ChatCoreFixtures.str(expected, "description"), actual.description)
        }

        // 记忆侧重点
        @Suppress("UNCHECKED_CAST")
        val guidances = (ChatCoreFixtures.listOrNull(narrative, "memoryGuidance") as? List<Map<String, Any?>>)
            ?: error("缺少 memoryGuidance")
        for (case in guidances) {
            val mode = ChatCoreFixtures.str(case, "mode")!!
            assertEquals(
                "getNarrativeMemoryGuidance($mode)",
                ChatCoreFixtures.str(case, "guidance"),
                ChatNarrativeMode.getNarrativeMemoryGuidance(mode),
            )
        }

        // isNarrativeMode
        @Suppress("UNCHECKED_CAST")
        val isModeCases = (ChatCoreFixtures.listOrNull(narrative, "isModeCases") as? List<Map<String, Any?>>)
            ?: error("缺少 isModeCases")
        for (case in isModeCases) {
            val value = decodeModeArg(case["value"])
            assertEquals(
                "isNarrativeMode($value)",
                ChatCoreFixtures.boolOrNull(case, "valid"),
                ChatNarrativeMode.isNarrativeMode(value),
            )
        }

        // resolveNarrativeMode（候选按优先级）
        @Suppress("UNCHECKED_CAST")
        val resolveCases = (ChatCoreFixtures.listOrNull(narrative, "resolveCases") as? List<Map<String, Any?>>)
            ?: error("缺少 resolveCases")
        for (case in resolveCases) {
            val candidates = ((ChatCoreFixtures.listOrNull(case, "candidates") as? List<*>)
                ?: emptyList<Any?>()).map { decodeModeArg(it) }
            assertEquals(
                "resolveNarrativeMode(${candidates.joinToString(",")})",
                ChatCoreFixtures.str(case, "resolved"),
                ChatNarrativeMode.resolveNarrativeMode(*candidates.toTypedArray()),
            )
        }

        // 标签（含未知模式回退）
        @Suppress("UNCHECKED_CAST")
        val labelCases = (ChatCoreFixtures.listOrNull(narrative, "labelCases") as? List<Map<String, Any?>>)
            ?: error("缺少 labelCases")
        for (case in labelCases) {
            val mode = ChatCoreFixtures.str(case, "mode")!!
            assertEquals(
                "getNarrativeModeLabel($mode)",
                ChatCoreFixtures.str(case, "label"),
                ChatNarrativeMode.getNarrativeModeLabel(mode),
            )
        }

        // 提示词逐字符比对
        @Suppress("UNCHECKED_CAST")
        val promptCases = (ChatCoreFixtures.listOrNull(narrative, "promptCases") as? List<Map<String, Any?>>)
            ?: error("缺少 promptCases")
        for (case in promptCases) {
            val mode = ChatCoreFixtures.str(case, "mode")!!
            val userName = ChatCoreFixtures.str(case, "userName") ?: ""
            val characterName = ChatCoreFixtures.str(case, "characterName") ?: ""
            val rules = ChatCoreFixtures.str(case, "omniscientRules")
            assertEquals(
                "buildNarrativeModePrompt($mode, $characterName, rules=$rules)",
                ChatCoreFixtures.str(case, "prompt"),
                ChatNarrativeMode.buildNarrativeModePrompt(mode, userName, characterName, rules),
            )
        }
    }

    @Test
    fun thoughtContractMatchesPc() {
        val thought = ChatCoreFixtures.mapOrNull(root, "thought")!!
        assertEquals(
            "THOUGHT_CONTRACT_CLAUSES",
            (ChatCoreFixtures.listOrNull(thought, "clauses") as? List<*>)?.map { it.toString() },
            ChatThoughtContract.THOUGHT_CONTRACT_CLAUSES,
        )

        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(thought, "cases") as? List<Map<String, Any?>>)
            ?: error("缺少 cases")
        for (case in cases) {
            val mode = ChatCoreFixtures.str(case, "narrativeMode")!!
            val subject = ChatCoreFixtures.str(case, "subjectName")
            val expected = ChatCoreFixtures.str(case, "body")!!
            val actual = ChatThoughtContract.buildThoughtContractBody(mode, subject)
            assertEquals("buildThoughtContractBody($mode, $subject)", expected, actual)
            // 契约要点必须在正文中可断言（防止文案改动后契约落空）
            assertTrue("正文应含「第一人称」要点", actual.contains("第一人称"))
            assertTrue("正文应含「不超过 3 句」要点", actual.contains("不超过 3 句"))
        }
    }

    @Test
    fun instructTemplatesMatchPc() {
        val templates = ChatCoreFixtures.mapOrNull(root, "templates")!!

        assertEquals(
            "BUILTIN_TEMPLATE_NAMES",
            (ChatCoreFixtures.listOrNull(templates, "builtinNames") as? List<*>)?.map { it.toString() },
            ChatTemplates.BUILTIN_TEMPLATE_NAMES,
        )

        // 按名解析（大小写/空白/未知/空）
        @Suppress("UNCHECKED_CAST")
        val byNameCases = (ChatCoreFixtures.listOrNull(templates, "byNameCases") as? List<Map<String, Any?>>)
            ?: error("缺少 byNameCases")
        for (case in byNameCases) {
            val name = ChatCoreFixtures.str(case, "name")
            assertTemplate(
                "getTemplateByName($name)",
                ChatCoreFixtures.mapOrNull(case, "template"),
                ChatTemplates.getTemplateByName(name),
            )
        }

        // provider/model 推断（含 anthropic 与 claude 的差异）
        @Suppress("UNCHECKED_CAST")
        val inferCases = (ChatCoreFixtures.listOrNull(templates, "inferCases") as? List<Map<String, Any?>>)
            ?: error("缺少 inferCases")
        for (case in inferCases) {
            val provider = ChatCoreFixtures.str(case, "provider")!!
            val model = ChatCoreFixtures.str(case, "model")!!
            assertTemplate(
                "getInstructTemplate($provider, $model)",
                ChatCoreFixtures.mapOrNull(case, "template"),
                ChatTemplates.getInstructTemplate(provider, model),
            )
        }

        // 生效模板解析（预设 > 自动推断 > 无）
        @Suppress("UNCHECKED_CAST")
        val effectiveCases = (ChatCoreFixtures.listOrNull(templates, "effectiveCases") as? List<Map<String, Any?>>)
            ?: error("缺少 effectiveCases")
        for (case in effectiveCases) {
            val contextTemplate = ChatCoreFixtures.str(case, "contextTemplate")
            val provider = ChatCoreFixtures.str(case, "provider")!!
            val model = ChatCoreFixtures.str(case, "model")!!
            val useInstruct = ChatCoreFixtures.boolOrNull(case, "useInstructTemplate")
            assertTemplate(
                "resolveEffectiveTemplate($contextTemplate, $provider, $model, $useInstruct)",
                ChatCoreFixtures.mapOrNull(case, "template"),
                ChatTemplates.resolveEffectiveTemplate(contextTemplate, provider, model, useInstruct),
            )
        }

        // 纯文本包装逐字符比对
        @Suppress("UNCHECKED_CAST")
        val applyCases = (ChatCoreFixtures.listOrNull(templates, "applyCases") as? List<Map<String, Any?>>)
            ?: error("缺少 applyCases")
        for (case in applyCases) {
            val templateName = ChatCoreFixtures.str(case, "templateName")!!
            val template = ChatTemplates.getTemplateByName(templateName) ?: error("未知模板 $templateName")
            val messages = ((ChatCoreFixtures.listOrNull(case, "messages") as? List<Map<String, Any?>>) ?: emptyList())
                .map {
                    InstructMessage(
                        role = ChatCoreFixtures.str(it, "role") ?: "",
                        content = ChatCoreFixtures.str(it, "content") ?: "",
                    )
                }
            val applied = ChatTemplates.applyInstructTemplate(messages, template)
            assertEquals(
                "applyInstructTemplate($templateName).text",
                ChatCoreFixtures.str(case, "text"),
                applied.text,
            )
            assertEquals(
                "applyInstructTemplate($templateName).stopSequences",
                (ChatCoreFixtures.listOrNull(case, "stopSequences") as? List<*>)?.map { item -> item.toString() } ?: emptyList<String>(),
                applied.stopSequences,
            )
        }
    }
}
