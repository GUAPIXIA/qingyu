package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-04：输入框 AI 辅助（续写/润色）的跨语言一致性测试
 * （对齐 fixture `ai-input-helper.json`，oracle 为 PC 的 `shared/chat-core/aiInputHelper.ts`）。
 *
 * 这一层的每个判据都直接决定「模型输出能不能写回输入框」：
 * 放行角色视角内容会让用户误发角色的话；放行英文分析会让输入框出现思维链残留；
 * 长度校验缺失会让半截正文被当成完整消息发出。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatAiInputHelperGoldenTest {

    private val root = ChatCoreFixtures.root("ai-input-helper")

    @Test
    fun constantsMatchPc() {
        val constants = ChatCoreFixtures.mapOrNull(root, "constants")!!
        assertEquals(
            "DEFAULT_CONTINUE_INTENSITY",
            ChatCoreFixtures.str(constants, "defaultIntensity"),
            ChatContinueIntensity.DEFAULT_INTENSITY,
        )
        assertEquals(
            "DEFAULT_CONTINUE_LENGTH",
            ChatCoreFixtures.str(constants, "defaultLength"),
            ChatContinueIntensity.DEFAULT_LENGTH,
        )
        val temperatures = ChatCoreFixtures.mapOrNull(constants, "intensityTemperatures")!!
        assertEquals("强度档位集合", temperatures.keys.sorted(), ChatContinueIntensity.INTENSITY_TEMPERATURES.keys.sorted())
        for ((key, value) in temperatures) {
            val expected = (value as Map<*, *>)["temperature"] as Number
            assertEquals("temperature[$key]", expected.toDouble(), ChatContinueIntensity.temperatureOf(key.toString()), 1e-9)
        }
        val lengths = ChatCoreFixtures.mapOrNull(constants, "lengthParams")!!
        assertEquals("长度档位集合", lengths.keys.sorted(), ChatContinueIntensity.LENGTH_PARAMS.keys.sorted())
        for ((key, value) in lengths) {
            val entry = value as Map<*, *>
            val params = ChatContinueIntensity.paramsOf(key.toString())
            assertEquals("minChars[$key]", (entry["minChars"] as Number).toInt(), params.minChars)
            assertEquals("maxChars[$key]", (entry["maxChars"] as Number).toInt(), params.maxChars)
            assertEquals("structure[$key]", entry["structure"], params.structure)
        }
        val tolerance = ChatCoreFixtures.mapOrNull(constants, "tolerance")!!
        assertEquals(
            "acceptLowerRatio",
            (tolerance["acceptLowerRatio"] as Number).toDouble(),
            ChatContinueIntensity.ACCEPT_LOWER_RATIO,
            1e-9,
        )
        assertEquals(
            "repairCeilingRatio",
            (tolerance["repairCeilingRatio"] as Number).toDouble(),
            ChatContinueIntensity.REPAIR_CEILING_RATIO,
            1e-9,
        )
        assertEquals(
            "softLowerRatio",
            (tolerance["softLowerRatio"] as Number).toDouble(),
            ChatContinueIntensity.SOFT_LOWER_RATIO,
            1e-9,
        )
        assertEquals(
            "softUpperRatio",
            (tolerance["softUpperRatio"] as Number).toDouble(),
            ChatContinueIntensity.SOFT_UPPER_RATIO,
            1e-9,
        )
    }

    @Test
    fun perspectiveAndNormalizeMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val perspectiveCases = (ChatCoreFixtures.listOrNull(root, "perspectiveCases") as? List<Map<String, Any?>>)
            ?: error("缺少 perspectiveCases")
        for (case in perspectiveCases) {
            val raw = ChatCoreFixtures.str(case, "raw") ?: ""
            assertEquals(
                "ensureUserPerspective(${raw.take(24)})",
                ChatCoreFixtures.str(case, "result"),
                ChatAiInputHelper.ensureUserPerspective(
                    raw,
                    ChatCoreFixtures.str(case, "userName") ?: "",
                    ChatCoreFixtures.str(case, "charName") ?: "",
                ),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val normalizeCases = (ChatCoreFixtures.listOrNull(root, "normalizeCases") as? List<Map<String, Any?>>)
            ?: error("缺少 normalizeCases")
        for (case in normalizeCases) {
            val raw = ChatCoreFixtures.str(case, "raw") ?: ""
            val mode = ChatCoreFixtures.str(case, "narrativeMode") ?: "immersive"
            assertEquals(
                "normalizeContinueOutput(${raw.take(20)}, $mode)",
                ChatCoreFixtures.str(case, "result"),
                ChatAiInputHelper.normalizeContinueOutput(raw, "旅人", "苏晚", mode),
            )
        }
    }

    @Test
    fun taggedExtractionAndParseMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val tagCases = (ChatCoreFixtures.listOrNull(root, "tagCases") as? List<Map<String, Any?>>)
            ?: error("缺少 tagCases")
        for (case in tagCases) {
            val raw = ChatCoreFixtures.str(case, "raw") ?: ""
            val tag = ChatCoreFixtures.str(case, "tag") ?: ""
            assertEquals(
                "extractTaggedResult(${raw.take(24)}, $tag)",
                ChatCoreFixtures.str(case, "result"),
                ChatAiInputHelper.extractTaggedResult(raw, tag),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val parseCases = (ChatCoreFixtures.listOrNull(root, "parseCases") as? List<Map<String, Any?>>)
            ?: error("缺少 parseCases")
        for (case in parseCases) {
            val raw = ChatCoreFixtures.str(case, "raw") ?: ""
            val charName = ChatCoreFixtures.str(case, "charName") ?: "苏晚"
            val mode = ChatCoreFixtures.str(case, "narrativeMode") ?: "immersive"
            assertEquals(
                "parseContinueResult(${raw.take(28)}, $mode)",
                ChatCoreFixtures.str(case, "result"),
                ChatAiInputHelper.parseContinueResult(raw, "旅人", charName, mode),
            )
        }
    }

    @Test
    fun failureClassificationMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "failureCases") as? List<Map<String, Any?>>)
            ?: error("缺少 failureCases")
        for (case in cases) {
            val raw = ChatCoreFixtures.str(case, "raw") ?: ""
            assertEquals(
                "classifyContinueFailure(${raw.take(24)})",
                ChatCoreFixtures.str(case, "kind"),
                ChatAiInputHelper.classifyContinueFailure(raw),
            )
            assertEquals(
                "shouldRetryContinueFormat(${raw.take(24)})",
                ChatCoreFixtures.boolOrNull(case, "shouldRetry"),
                ChatAiInputHelper.shouldRetryContinueFormat(raw),
            )
        }
    }

    @Test
    fun lengthEvaluationAndRepairMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val lengthCases = (ChatCoreFixtures.listOrNull(root, "lengthCases") as? List<Map<String, Any?>>)
            ?: error("缺少 lengthCases")
        for (case in lengthCases) {
            val text = ChatCoreFixtures.str(case, "text") ?: ""
            val length = ChatCoreFixtures.str(case, "length") ?: "standard"
            val evaluation = ChatAiInputHelper.evaluateContinueLength(text, length)
            val label = "evaluateContinueLength(len=${text.length}, $length)"
            assertEquals("$label.chars", ChatCoreFixtures.intOrNull(case, "chars"), evaluation.chars)
            assertEquals("$label.truncated", ChatCoreFixtures.boolOrNull(case, "truncated"), evaluation.truncated)
            assertEquals("$label.action", ChatCoreFixtures.str(case, "action"), evaluation.action)
            assertEquals("$label.trimmedText", ChatCoreFixtures.str(case, "trimmedText"), evaluation.trimmedText)
            assertEquals(
                "$label.acceptableAfterRepair",
                ChatCoreFixtures.boolOrNull(case, "acceptableAfterRepair"),
                ChatAiInputHelper.isAcceptableAfterLengthRepair(text, length),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val repairCases = (ChatCoreFixtures.listOrNull(root, "repairInstructionCases") as? List<Map<String, Any?>>)
            ?: error("缺少 repairInstructionCases")
        for (case in repairCases) {
            val mode = ChatCoreFixtures.str(case, "mode") ?: "supplement"
            val length = ChatCoreFixtures.str(case, "length") ?: "standard"
            assertEquals(
                "buildLengthRepairInstruction($mode, $length)",
                ChatCoreFixtures.str(case, "instruction"),
                ChatAiInputHelper.buildLengthRepairInstruction(
                    mode,
                    length,
                    ChatCoreFixtures.intOrNull(case, "chars") ?: 0,
                    ChatCoreFixtures.boolOrNull(case, "truncated") ?: false,
                ),
            )
        }
    }

    @Test
    fun systemPromptAndContextMatchPc() {
        @Suppress("UNCHECKED_CAST")
        val promptCases = (ChatCoreFixtures.listOrNull(root, "systemPromptCases") as? List<Map<String, Any?>>)
            ?: error("缺少 systemPromptCases")
        for (case in promptCases) {
            val hasInput = ChatCoreFixtures.boolOrNull(case, "hasInput") ?: false
            val mode = ChatCoreFixtures.str(case, "narrativeMode") ?: "immersive"
            val intensity = ChatCoreFixtures.str(case, "intensity") ?: "active"
            val length = ChatCoreFixtures.str(case, "length") ?: "standard"
            assertEquals(
                "buildContinueSystemPrompt(input=$hasInput, $mode, $intensity, $length)",
                ChatCoreFixtures.str(case, "prompt"),
                ChatAiInputHelper.buildContinueSystemPrompt(
                    ChatCoreFixtures.str(case, "userName") ?: "",
                    ChatCoreFixtures.str(case, "charName") ?: "",
                    hasInput,
                    mode,
                    intensity,
                    length,
                ),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val contextCases = (ChatCoreFixtures.listOrNull(root, "contextCases") as? List<Map<String, Any?>>)
            ?: error("缺少 contextCases")
        for (case in contextCases) {
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val hasInput = ChatCoreFixtures.boolOrNull(input, "hasInput") ?: false
            val mode = ChatCoreFixtures.str(input, "narrativeMode") ?: "immersive"
            val messages = ChatAiInputHelper.buildContinueContext(
                ChatAiInputHelper.ContinueContextInput(
                    charName = ChatCoreFixtures.str(input, "charName") ?: "",
                    charDescription = "旧书店的店主。",
                    charScenario = "深夜的旧书店",
                    userName = ChatCoreFixtures.str(input, "userName") ?: "",
                    recentMessages = listOf(
                        ChatAiInputHelper.ContinueContextMessage("user", "夜安。"),
                        // 历史里的 thought 必须被剥离：否则会诱导模型模仿角色视角
                        ChatAiInputHelper.ContinueContextMessage("assistant", "<thought>内心</thought>夜安，要坐一会儿吗？"),
                    ),
                    originalInput = ChatCoreFixtures.str(input, "originalInput") ?: "",
                    hasInput = hasInput,
                    narrativeMode = mode,
                    intensity = ChatCoreFixtures.str(input, "intensity"),
                    length = ChatCoreFixtures.str(input, "length"),
                ),
            )
            @Suppress("UNCHECKED_CAST")
            val expected = (ChatCoreFixtures.listOrNull(case, "messages") as? List<Map<String, Any?>>)
                ?: error("缺少 messages")
            assertEquals("buildContinueContext(input=$hasInput, $mode) 条数", expected.size, messages.size)
            expected.forEachIndexed { index, item ->
                val label = "buildContinueContext(input=$hasInput, $mode)[$index]"
                assertEquals("$label.role", ChatCoreFixtures.str(item, "role"), messages[index].role)
                assertEquals("$label.content", ChatCoreFixtures.str(item, "content"), messages[index].content)
            }
        }
    }

    @Test
    fun contextStripsThoughtFromHistory() {
        // 直接断言这条原因：历史里的 thought 若原样喂给续写，会让模型模仿角色视角，
        // 随后被 ensureUserPerspective 整段清空，表现为「续写未生成可用内容」
        val messages = ChatAiInputHelper.buildContinueContext(
            ChatAiInputHelper.ContinueContextInput(
                charName = "苏晚",
                charDescription = "",
                charScenario = "",
                userName = "旅人",
                recentMessages = listOf(
                    ChatAiInputHelper.ContinueContextMessage("assistant", "<thought>苏晚的内心</thought>夜安。"),
                ),
                originalInput = "",
                hasInput = false,
            ),
        )
        val history = messages.first { it.role == "assistant" }
        assertFalse("历史 thought 必须被剥离", history.content.contains("<thought>"))
        assertTrue(history.content.contains("夜安。"))
    }

    @Test
    fun sampleGuidanceIsRejectedEndToEnd() {
        // 端到端：模型回了一段「英文分析 + 中文尾巴」，绝不能写回输入框
        val raw = "Need final only. 应该继续推进剧情。"
        assertEquals("解析结果必须为空", "", ChatAiInputHelper.parseContinueResult(raw, "旅人", "苏晚", "immersive"))
        assertEquals(
            ChatAiInputHelper.FAILURE_INVALID_CONTENT,
            ChatAiInputHelper.classifyContinueFailure(raw),
        )
        assertTrue("值得重试一次格式", ChatAiInputHelper.shouldRetryContinueFormat(raw))
    }
}
