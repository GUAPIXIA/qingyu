package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-01 第 5 层：预算链的跨语言一致性测试
 * （对齐 fixture `budget-chain.json`，oracle 为 PC 的
 * `shared/modelOutputProfile.ts`、`shared/reasoningGate.ts`、`shared/generationTaskBudget.ts`）。
 *
 * 这一层决定**请求的 max_tokens 与上下文预留**：两端不一致会让同一会话在
 * PC 与 Android 得到不同的输出长度上限与截断行为。contextBuilder 的
 * `resolveChatRequestPlan` 直接消费本模块。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatBudgetChainGoldenTest {

    private val root = ChatCoreFixtures.root("budget-chain")

    private fun assertProfile(label: String, expected: Map<String, Any?>, actual: ChatModelOutputProfile.Profile) {
        assertEquals("$label.outputLimit", ChatCoreFixtures.intOrNull(expected, "outputLimit"), actual.outputLimit)
        assertEquals("$label.contextLimit", ChatCoreFixtures.intOrNull(expected, "contextLimit"), actual.contextLimit)
        assertEquals("$label.reasoningMode", ChatCoreFixtures.str(expected, "reasoningMode"), actual.reasoningMode)
        assertEquals(
            "$label.defaultReasoningReserve",
            ChatCoreFixtures.intOrNull(expected, "defaultReasoningReserve"),
            actual.defaultReasoningReserve,
        )
        assertEquals(
            "$label.maxReasoningReserve",
            ChatCoreFixtures.intOrNull(expected, "maxReasoningReserve"),
            actual.maxReasoningReserve,
        )
        assertEquals("$label.defaultGate", ChatCoreFixtures.str(expected, "defaultGate"), actual.defaultGate)
        assertEquals(
            "$label.gateKnobs",
            (ChatCoreFixtures.listOrNull(expected, "gateKnobs") as? List<*>)?.map { it.toString() },
            actual.gateKnobs,
        )
        assertEquals("$label.matchedBy", ChatCoreFixtures.str(expected, "matchedBy"), actual.matchedBy)
        assertEquals("$label.confidence", ChatCoreFixtures.str(expected, "confidence"), actual.confidence)
    }

    @Test
    fun constantsMatchPc() {
        val constants = ChatCoreFixtures.mapOrNull(root, "constants")!!
        assertEquals(
            "PROTOCOL_RESERVE_TOKENS",
            ChatCoreFixtures.intOrNull(constants, "protocolReserveTokens"),
            ChatModelOutputProfile.PROTOCOL_RESERVE_TOKENS,
        )
        assertEquals(
            "DEFAULT_AUTOMATIC_OUTPUT_LIMIT",
            ChatCoreFixtures.intOrNull(constants, "defaultAutomaticOutputLimit"),
            ChatModelOutputProfile.DEFAULT_AUTOMATIC_OUTPUT_LIMIT,
        )
        assertEquals(
            "DEFAULT_AUTOMATIC_REASONING_RESERVE",
            ChatCoreFixtures.intOrNull(constants, "defaultAutomaticReasoningReserve"),
            ChatModelOutputProfile.DEFAULT_AUTOMATIC_REASONING_RESERVE,
        )
        assertEquals(
            "BODY_RESERVE_OVERHEAD_TOKENS",
            ChatCoreFixtures.intOrNull(constants, "bodyReserveOverheadTokens"),
            ChatModelOutputProfile.BODY_RESERVE_OVERHEAD_TOKENS,
        )
        assertEquals(
            "MIN_USABLE_BODY_TOKENS",
            ChatCoreFixtures.intOrNull(constants, "minUsableBodyTokens"),
            ChatModelOutputProfile.MIN_USABLE_BODY_TOKENS,
        )
        assertEquals("LOW_GATE_TOKENS", ChatCoreFixtures.intOrNull(constants, "lowGateTokens"), ChatReasoningGate.LOW_GATE_TOKENS)
        assertEquals(
            "GATE_PROBE_MAX_SAMPLES",
            ChatCoreFixtures.intOrNull(constants, "gateProbeMaxSamples"),
            ChatReasoningGate.GATE_PROBE_MAX_SAMPLES,
        )
        val taskDefaults = ChatCoreFixtures.mapOrNull(constants, "taskBodyDefaults")!!
        val tasks = (ChatCoreFixtures.listOrNull(constants, "tasks") as? List<*>)?.map { it.toString() } ?: emptyList()
        assertEquals("TASK_BODY_DEFAULTS 键集合", tasks.sorted(), ChatGenerationTaskBudget.TASK_BODY_DEFAULTS.keys.sorted())
        for ((task, value) in taskDefaults) {
            assertEquals(
                "TASK_BODY_DEFAULTS[$task]",
                (value as Number).toInt(),
                ChatGenerationTaskBudget.TASK_BODY_DEFAULTS[task.toString()],
            )
        }
    }

    @Test
    fun modelOutputProfileMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val profileCases = (ChatCoreFixtures.listOrNull(root, "profileCases") as? List<Map<String, Any?>>)
            ?: error("缺少 profileCases")
        for (case in profileCases) {
            val model = ChatCoreFixtures.str(case, "model") ?: ""
            assertProfile(
                "getModelOutputProfile($model)",
                ChatCoreFixtures.mapOrNull(case, "profile")!!,
                ChatModelOutputProfile.getModelOutputProfile(model),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val resolveCases = (ChatCoreFixtures.listOrNull(root, "resolveProfileCases") as? List<Map<String, Any?>>)
            ?: error("缺少 resolveProfileCases")
        for (case in resolveCases) {
            val model = ChatCoreFixtures.str(case, "model") ?: ""
            val userOverride = ChatCoreFixtures.mapOrNull(case, "userOverride")?.let {
                ChatModelOutputProfile.UserOverride(
                    outputLimit = ChatCoreFixtures.intOrNull(it, "outputLimit"),
                    contextLimit = ChatCoreFixtures.intOrNull(it, "contextLimit"),
                )
            }
            val correction = ChatCoreFixtures.mapOrNull(case, "runtimeCorrection")?.let {
                ChatModelOutputProfile.CapabilityCorrection(
                    outputLimit = ChatCoreFixtures.intOrNull(it, "outputLimit"),
                    contextLimit = ChatCoreFixtures.intOrNull(it, "contextLimit"),
                    reason = ChatCoreFixtures.str(it, "reason") ?: "output_limit",
                    updatedAt = (it["updatedAt"] as? Number)?.toLong() ?: 0L,
                )
            }
            assertProfile(
                "resolveModelOutputProfile($model)",
                ChatCoreFixtures.mapOrNull(case, "profile")!!,
                ChatModelOutputProfile.resolveModelOutputProfile(
                    model,
                    ChatModelOutputProfile.ResolveOptions(userOverride, correction),
                ),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val percentileCases = (ChatCoreFixtures.listOrNull(root, "percentileCases") as? List<Map<String, Any?>>)
            ?: error("缺少 percentileCases")
        for (case in percentileCases) {
            val values = (ChatCoreFixtures.listOrNull(case, "values") as? List<*>)?.map { sentinel(it) } ?: emptyList()
            assertEquals("percentile90($values)", ChatCoreFixtures.intOrNull(case, "p90"), ChatModelOutputProfile.percentile90(values))
        }

        @Suppress("UNCHECKED_CAST")
        val reserveCases = (ChatCoreFixtures.listOrNull(root, "reserveCases") as? List<Map<String, Any?>>)
            ?: error("缺少 reserveCases")
        for (case in reserveCases) {
            val model = ChatCoreFixtures.str(case, "model") ?: ""
            val samples = (ChatCoreFixtures.listOrNull(case, "recentReasoningTokens") as? List<*>)?.map { sentinel(it) }
            assertEquals(
                "resolveReasoningReserve($model, $samples)",
                ChatCoreFixtures.intOrNull(case, "reserve"),
                ChatModelOutputProfile.resolveReasoningReserve(
                    ChatModelOutputProfile.getModelOutputProfile(model),
                    samples,
                ),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val hardCapCases = (ChatCoreFixtures.listOrNull(root, "hardCapCases") as? List<Map<String, Any?>>)
            ?: error("缺少 hardCapCases")
        for (case in hardCapCases) {
            val raw = sentinel(case["value"])
            val value = if (raw != raw) null else raw.toInt()
            assertEquals("resolveUserHardCap(${case["value"]})", ChatCoreFixtures.intOrNull(case, "cap"), ChatModelOutputProfile.resolveUserHardCap(value))
        }

        @Suppress("UNCHECKED_CAST")
        val overrideCases = (ChatCoreFixtures.listOrNull(root, "overrideCases") as? List<Map<String, Any?>>)
            ?: error("缺少 overrideCases")
        for (case in overrideCases) {
            val actual = ChatModelOutputProfile.enabledProfileOverride(
                enabled = ChatCoreFixtures.boolOrNull(case, "enabled"),
                contextLimit = ChatCoreFixtures.intOrNull(case, "contextLimit"),
                outputLimit = ChatCoreFixtures.intOrNull(case, "outputLimit"),
            )
            val expected = ChatCoreFixtures.mapOrNull(case, "override")
            if (expected == null) {
                assertNull("enabledProfileOverride($case) 期望 null", actual)
            } else {
                assertEquals("override.contextLimit", ChatCoreFixtures.intOrNull(expected, "contextLimit"), actual!!.contextLimit)
                assertEquals("override.outputLimit", ChatCoreFixtures.intOrNull(expected, "outputLimit"), actual.outputLimit)
            }
        }

        @Suppress("UNCHECKED_CAST")
        val contextLimitCases = (ChatCoreFixtures.listOrNull(root, "contextLimitCases") as? List<Map<String, Any?>>)
            ?: error("缺少 contextLimitCases")
        for (case in contextLimitCases) {
            val capability = ChatCoreFixtures.mapOrNull(case, "capabilityOverride")
            assertEquals(
                "resolveEffectiveContextLimit(${case["model"]})",
                ChatCoreFixtures.intOrNull(case, "limit"),
                ChatModelOutputProfile.resolveEffectiveContextLimit(
                    model = ChatCoreFixtures.str(case, "model") ?: "",
                    profileMaxContext = ChatCoreFixtures.intOrNull(case, "profileMaxContext"),
                    presetMaxContext = ChatCoreFixtures.intOrNull(case, "presetMaxContext"),
                    capabilityOverrideEnabled = capability?.let { ChatCoreFixtures.boolOrNull(it, "enabled") },
                    capabilityContextLimit = capability?.let { ChatCoreFixtures.intOrNull(it, "contextLimit") },
                    capabilityOutputLimit = capability?.let { ChatCoreFixtures.intOrNull(it, "outputLimit") },
                ),
            )
        }
    }

    @Test
    fun requestBudgetMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "requestBudgetCases") as? List<Map<String, Any?>>)
            ?: error("缺少 requestBudgetCases")
        for (case in cases) {
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val budget = ChatModelOutputProfile.resolveRequestBudget(buildBudgetInput(input))
            val label = "resolveRequestBudget(${input["model"]}, chars=${input["hardMaxChars"]})"
            assertEquals("$label.bodyReserve", ChatCoreFixtures.intOrNull(case, "bodyReserve"), budget.bodyReserve)
            assertEquals("$label.reasoningReserve", ChatCoreFixtures.intOrNull(case, "reasoningReserve"), budget.reasoningReserve)
            assertEquals(
                "$label.minimumViableOutputTokens",
                ChatCoreFixtures.intOrNull(case, "minimumViableOutputTokens"),
                budget.minimumViableOutputTokens,
            )
            assertEquals("$label.requestMaxTokens", ChatCoreFixtures.intOrNull(case, "requestMaxTokens"), budget.requestMaxTokens)
            assertEquals("$label.riskNotice", ChatCoreFixtures.str(case, "riskNotice"), budget.riskNotice)
            assertEquals("$label.formattedRisk", ChatCoreFixtures.str(case, "formattedRisk"), ChatModelOutputProfile.formatRequestBudgetRisk(budget))
            val expectedGate = ChatCoreFixtures.mapOrNull(case, "gate")
            if (expectedGate == null) {
                assertNull("$label.gate 期望 null", budget.gate)
            } else {
                assertEquals("$label.gate.level", ChatCoreFixtures.str(expectedGate, "level"), budget.gate!!.level)
                assertEquals("$label.gate.knob", ChatCoreFixtures.str(expectedGate, "knob"), budget.gate!!.knob)
                assertEquals("$label.gate.enforced", ChatCoreFixtures.boolOrNull(expectedGate, "enforced"), budget.gate!!.enforced)
                assertEquals("$label.gate.source", ChatCoreFixtures.str(expectedGate, "source"), budget.gate!!.source)
            }
        }
    }

    @Test
    fun reasoningGateMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val levelCases = (ChatCoreFixtures.listOrNull(root, "levelCases") as? List<Map<String, Any?>>)
            ?: error("缺少 levelCases")
        for (case in levelCases) {
            val level = ChatCoreFixtures.str(case, "level")!!
            val knob = ChatCoreFixtures.str(case, "knob")!!
            assertEquals(
                "levelToTokens($level, $knob)",
                ChatCoreFixtures.intOrNull(case, "tokens"),
                ChatReasoningGate.levelToTokens(level, knob),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val nextCases = (ChatCoreFixtures.listOrNull(root, "nextLowerCases") as? List<Map<String, Any?>>)
            ?: error("缺少 nextLowerCases")
        for (case in nextCases) {
            val level = ChatCoreFixtures.str(case, "level")!!
            assertEquals("nextLowerGateLevel($level)", ChatCoreFixtures.str(case, "next"), ChatReasoningGate.nextLowerGateLevel(level))
        }

        @Suppress("UNCHECKED_CAST")
        val knobCases = (ChatCoreFixtures.listOrNull(root, "knobCases") as? List<Map<String, Any?>>)
            ?: error("缺少 knobCases")
        for (case in knobCases) {
            val model = ChatCoreFixtures.str(case, "model")!!
            val level = ChatCoreFixtures.str(case, "level")!!
            val probe = ChatCoreFixtures.mapOrNull(case, "probe")?.let { probeOf(it) }
            assertEquals(
                "selectGateKnob($model, $level)",
                ChatCoreFixtures.str(case, "knob"),
                ChatReasoningGate.selectGateKnob(ChatModelOutputProfile.getModelOutputProfile(model), probe, level),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val gateCases = (ChatCoreFixtures.listOrNull(root, "gateCases") as? List<Map<String, Any?>>)
            ?: error("缺少 gateCases")
        for (case in gateCases) {
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val resolved = ChatReasoningGate.resolveReasoningGate(
                ChatReasoningGate.ResolveInput(
                    model = ChatCoreFixtures.str(input, "model") ?: "",
                    enabled = ChatCoreFixtures.boolOrNull(input, "enabled"),
                    auxiliary = ChatCoreFixtures.boolOrNull(input, "auxiliary"),
                    requestedLevel = ChatCoreFixtures.str(input, "requestedLevel"),
                    startLevel = ChatCoreFixtures.str(input, "startLevel"),
                    probe = ChatCoreFixtures.mapOrNull(input, "probe")?.let { probeOf(it) },
                    recentReasoningTokens = (ChatCoreFixtures.listOrNull(input, "recentReasoningTokens") as? List<*>)?.map { sentinel(it) },
                ),
            )
            val expected = ChatCoreFixtures.mapOrNull(case, "resolved")!!
            val label = "resolveReasoningGate(${input["model"]}, lvl=${input["requestedLevel"] ?: input["startLevel"]})"
            assertEquals("$label.level", ChatCoreFixtures.str(expected, "level"), resolved.level)
            assertEquals("$label.knob", ChatCoreFixtures.str(expected, "knob"), resolved.knob)
            assertEquals("$label.enforced", ChatCoreFixtures.boolOrNull(expected, "enforced"), resolved.enforced)
            assertEquals("$label.gateTokens", ChatCoreFixtures.intOrNull(expected, "gateTokens"), resolved.gateTokens)
            assertEquals("$label.source", ChatCoreFixtures.str(expected, "source"), resolved.source)
        }

        @Suppress("UNCHECKED_CAST")
        val defaultCases = (ChatCoreFixtures.listOrNull(root, "defaultLevelCases") as? List<Map<String, Any?>>)
            ?: error("缺少 defaultLevelCases")
        for (case in defaultCases) {
            assertEquals(
                "resolveDefaultGateLevel(${case["model"]}, ${case["enabled"]}, ${case["auxiliary"]})",
                ChatCoreFixtures.str(case, "level"),
                ChatReasoningGate.resolveDefaultGateLevel(
                    model = ChatCoreFixtures.str(case, "model") ?: "",
                    enabled = ChatCoreFixtures.boolOrNull(case, "enabled") ?: false,
                    auxiliary = ChatCoreFixtures.boolOrNull(case, "auxiliary"),
                ),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val mergeCases = (ChatCoreFixtures.listOrNull(root, "probeMergeCases") as? List<Map<String, Any?>>)
            ?: error("缺少 probeMergeCases")
        for (case in mergeCases) {
            val current = ChatCoreFixtures.mapOrNull(case, "current")?.let { probeOf(it) }
            val updateMap = ChatCoreFixtures.mapOrNull(case, "update")!!
            val tokensRaw = updateMap["reasoningTokens"]
            val merged = ChatReasoningGate.mergeGateProbe(
                current,
                ChatReasoningGate.ProbeUpdate(
                    knob = ChatCoreFixtures.str(updateMap, "knob"),
                    knobAccepted = ChatCoreFixtures.boolOrNull(updateMap, "knobAccepted"),
                    disableIgnored = ChatCoreFixtures.boolOrNull(updateMap, "disableIgnored"),
                    reportsReasoningUsage = ChatCoreFixtures.boolOrNull(updateMap, "reportsReasoningUsage"),
                    reasoningTokens = tokensRaw?.let { sentinel(it) },
                    updatedAt = (updateMap["updatedAt"] as? Number)?.toLong() ?: 0L,
                ),
            )
            val expected = ChatCoreFixtures.mapOrNull(case, "merged")!!
            val label = "mergeGateProbe(${case["current"]})"
            assertEquals("$label.knob", ChatCoreFixtures.str(expected, "knob"), merged.knob)
            assertEquals("$label.knobAccepted", ChatCoreFixtures.boolOrNull(expected, "knobAccepted"), merged.knobAccepted)
            assertEquals("$label.disableIgnored", ChatCoreFixtures.boolOrNull(expected, "disableIgnored"), merged.disableIgnored)
            assertEquals("$label.updatedAt", (expected["updatedAt"] as? Number)?.toLong(), merged.updatedAt)
            val expectedSamples = (ChatCoreFixtures.listOrNull(expected, "recentReasoningTokens") as? List<*>)
                ?.map { sentinel(it) } ?: emptyList()
            assertEquals("$label.recentReasoningTokens", expectedSamples, merged.recentReasoningTokens)
        }

        @Suppress("UNCHECKED_CAST")
        val clampCases = (ChatCoreFixtures.listOrNull(root, "clampCases") as? List<Map<String, Any?>>)
            ?: error("缺少 clampCases")
        for (case in clampCases) {
            assertEquals(
                "clampGateBudgetForBody(${case["gateTokens"]}, ${case["requestMaxTokens"]})",
                ChatCoreFixtures.intOrNull(case, "clamped"),
                ChatReasoningGate.clampGateBudgetForBody(sentinel(case["gateTokens"]), sentinel(case["requestMaxTokens"])),
            )
        }
    }

    @Test
    fun generationTaskBudgetMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val bodyCases = (ChatCoreFixtures.listOrNull(root, "bodyCharsCases") as? List<Map<String, Any?>>)
            ?: error("缺少 bodyCharsCases")
        for (case in bodyCases) {
            val task = ChatCoreFixtures.str(case, "task")!!
            assertEquals(
                "resolveGenerationTaskBodyChars($task, ${case["inputChars"]}, ${case["expectedBodyChars"]})",
                ChatCoreFixtures.intOrNull(case, "chars"),
                ChatGenerationTaskBudget.resolveGenerationTaskBodyChars(
                    task = task,
                    inputChars = ChatCoreFixtures.intOrNull(case, "inputChars"),
                    expectedBodyChars = ChatCoreFixtures.intOrNull(case, "expectedBodyChars"),
                ),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val expandCases = (ChatCoreFixtures.listOrNull(root, "expandCases") as? List<Map<String, Any?>>)
            ?: error("缺少 expandCases")
        for (case in expandCases) {
            val budgetMap = ChatCoreFixtures.mapOrNull(case, "budget")!!
            val observed = case["observedReasoningTokens"]
            assertEquals(
                "expandAdaptiveOutputBudget(${case["currentMaxTokens"]})",
                ChatCoreFixtures.intOrNull(case, "next"),
                ChatGenerationTaskBudget.expandAdaptiveOutputBudget(
                    currentMaxTokens = (case["currentMaxTokens"] as Number).toInt(),
                    budget = ChatGenerationTaskBudget.AdaptiveOutputBudget(
                        ceilingTokens = (budgetMap["ceilingTokens"] as Number).toInt(),
                        bodyReserveTokens = (budgetMap["bodyReserveTokens"] as Number).toInt(),
                    ),
                    observedReasoningTokens = observed?.let { sentinel(it) },
                ),
            )
        }

        @Suppress("UNCHECKED_CAST")
        val taskCases = (ChatCoreFixtures.listOrNull(root, "taskBudgetCases") as? List<Map<String, Any?>>)
            ?: error("缺少 taskBudgetCases")
        for (case in taskCases) {
            val input = ChatCoreFixtures.mapOrNull(case, "input")!!
            val budget = ChatGenerationTaskBudget.resolveGenerationTaskBudget(
                ChatGenerationTaskBudget.Input(
                    task = ChatCoreFixtures.str(input, "task")!!,
                    model = ChatCoreFixtures.str(input, "model")!!,
                    inputChars = ChatCoreFixtures.intOrNull(input, "inputChars"),
                    expectedBodyChars = ChatCoreFixtures.intOrNull(input, "expectedBodyChars"),
                    userHardCap = ChatCoreFixtures.intOrNull(input, "userHardCap"),
                    recentReasoningTokens = (ChatCoreFixtures.listOrNull(input, "recentReasoningTokens") as? List<*>)
                        ?.map { sentinel(it) },
                    reasoningLevel = ChatCoreFixtures.str(input, "reasoningLevel"),
                ),
            )
            val label = "taskBudget(${input["task"]}, ${input["model"]})"
            assertEquals("$label.task", ChatCoreFixtures.str(case, "task"), budget.task)
            assertEquals("$label.expectedBodyChars", ChatCoreFixtures.intOrNull(case, "expectedBodyChars"), budget.expectedBodyChars)
            assertEquals("$label.requestMaxTokens", ChatCoreFixtures.intOrNull(case, "requestMaxTokens"), budget.request.requestMaxTokens)
            assertEquals("$label.bodyReserve", ChatCoreFixtures.intOrNull(case, "bodyReserve"), budget.request.bodyReserve)
            assertEquals(
                "$label.minimumViableOutputTokens",
                ChatCoreFixtures.intOrNull(case, "minimumViableOutputTokens"),
                budget.request.minimumViableOutputTokens,
            )
            val expectedGate = ChatCoreFixtures.mapOrNull(case, "reasoningGate")!!
            assertEquals("$label.gate.level", ChatCoreFixtures.str(expectedGate, "level"), budget.reasoningGate.level)
            assertEquals("$label.gate.knob", ChatCoreFixtures.str(expectedGate, "knob"), budget.reasoningGate.knob)
            assertEquals("$label.gate.gateTokens", ChatCoreFixtures.intOrNull(expectedGate, "gateTokens"), budget.reasoningGate.gateTokens)
            val expectedAdaptive = ChatCoreFixtures.mapOrNull(case, "adaptiveOutputBudget")
            if (expectedAdaptive == null) {
                assertNull("$label.adaptive 期望 null", budget.adaptiveOutputBudget)
            } else {
                assertEquals(
                    "$label.adaptive.ceilingTokens",
                    ChatCoreFixtures.intOrNull(expectedAdaptive, "ceilingTokens"),
                    budget.adaptiveOutputBudget!!.ceilingTokens,
                )
                assertEquals(
                    "$label.adaptive.bodyReserveTokens",
                    ChatCoreFixtures.intOrNull(expectedAdaptive, "bodyReserveTokens"),
                    budget.adaptiveOutputBudget!!.bodyReserveTokens,
                )
            }
        }
    }

    private fun probeOf(map: Map<String, Any?>): ChatReasoningGate.Probe = ChatReasoningGate.Probe(
        knob = ChatCoreFixtures.str(map, "knob") ?: "unknown",
        knobAccepted = ChatCoreFixtures.boolOrNull(map, "knobAccepted"),
        disableIgnored = ChatCoreFixtures.boolOrNull(map, "disableIgnored"),
        reportsReasoningUsage = ChatCoreFixtures.boolOrNull(map, "reportsReasoningUsage"),
        recentReasoningTokens = (ChatCoreFixtures.listOrNull(map, "recentReasoningTokens") as? List<*>)
            ?.map { sentinel(it) } ?: emptyList(),
        updatedAt = (map["updatedAt"] as? Number)?.toLong() ?: 0L,
    )

    private fun buildBudgetInput(input: Map<String, Any?>): ChatModelOutputProfile.RequestBudgetInput =
        ChatModelOutputProfile.RequestBudgetInput(
            model = ChatCoreFixtures.str(input, "model") ?: "",
            hardMaxChars = sentinel(input["hardMaxChars"]),
            userHardCap = ChatCoreFixtures.intOrNull(input, "userHardCap"),
            recentReasoningTokens = (ChatCoreFixtures.listOrNull(input, "recentReasoningTokens") as? List<*>)
                ?.map { sentinel(it) },
            reasoningGate = ChatCoreFixtures.mapOrNull(input, "reasoningGate")?.let { gate ->
                ChatReasoningGate.Resolved(
                    level = ChatCoreFixtures.str(gate, "level") ?: "",
                    knob = ChatCoreFixtures.str(gate, "knob") ?: "unknown",
                    enforced = ChatCoreFixtures.boolOrNull(gate, "enforced") ?: false,
                    gateTokens = (gate["gateTokens"] as Number).toInt(),
                    source = ChatCoreFixtures.str(gate, "source") ?: "conservative",
                )
            },
            profileOverride = ChatCoreFixtures.mapOrNull(input, "profileOverride")?.let {
                ChatModelOutputProfile.UserOverride(
                    outputLimit = ChatCoreFixtures.intOrNull(it, "outputLimit"),
                    contextLimit = ChatCoreFixtures.intOrNull(it, "contextLimit"),
                )
            },
        )

    /** 哨兵解码：与 fixture 约定一致（NaN/Infinity/-Infinity 以字符串保存）。 */
    private fun sentinel(value: Any?): Double = when (value) {
        null -> Double.NaN
        is String -> when (value) {
            "NaN" -> Double.NaN
            "Infinity" -> Double.POSITIVE_INFINITY
            "-Infinity" -> Double.NEGATIVE_INFINITY
            else -> error("未知哨兵：$value")
        }
        is Number -> value.toDouble()
        else -> error("非法数值类型：$value")
    }

    @Test
    fun constantsPresenceGuard() {
        assertTrue("任务默认值不得为空", ChatGenerationTaskBudget.TASK_BODY_DEFAULTS.isNotEmpty())
        assertEquals("任务清单条数", 18, ChatGenerationTaskBudget.TASKS.size)
    }
}
