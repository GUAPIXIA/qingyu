package com.qingyu.companion.chatcore

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * 阶段 4 S4-01 第 5 层：生成任务预算
 * （对齐 `shared/generationTaskBudget.ts`）。
 *
 * **所有文本生成任务的唯一预算入口**：任务只描述正文体量，模型名不决定 token 数值。
 * 阶段 4 的单聊生成用它解析本轮 `max_tokens`；后续 S4-05 的长记忆总结复用同一入口（task = memory）。
 */
object ChatGenerationTaskBudget {

    /** 生成任务类型（保持 TS 字面量）。 */
    val TASKS = listOf(
        "main", "translation", "continuation", "tail_repair", "polish", "memory", "compression",
        "title", "direction", "character_expand", "character_field", "greeting", "preset_draft",
        "image_prompt", "image_prompt_translation", "lorebook_keywords", "group_reply", "generic",
    )

    val TASK_BODY_DEFAULTS: Map<String, Int> = linkedMapOf(
        "main" to 600,
        "translation" to 256,
        "continuation" to 180,
        "tail_repair" to 200,
        "polish" to 600,
        "memory" to 2500,
        "compression" to 600,
        "title" to 20,
        "direction" to 800,
        "character_expand" to 1800,
        "character_field" to 800,
        "greeting" to 900,
        "preset_draft" to 900,
        "image_prompt" to 1200,
        "image_prompt_translation" to 256,
        "lorebook_keywords" to 600,
        "group_reply" to 600,
        "generic" to 600,
    )

    data class AdaptiveOutputBudget(
        /** 当前端点允许的输出能力顶点；扩容永不越过它。 */
        val ceilingTokens: Int,
        /** 本任务需要保留的正文空间，用于按实际推理压力推导下一档。 */
        val bodyReserveTokens: Int,
    )

    data class Input(
        val task: String,
        val model: String,
        val inputChars: Int? = null,
        val expectedBodyChars: Int? = null,
        val userHardCap: Int? = null,
        val recentReasoningTokens: List<Double>? = null,
        val profileOverride: ChatModelOutputProfile.UserOverride? = null,
        val reasoningGate: ChatReasoningGate.Resolved? = null,
        val reasoningLevel: String? = null,
    )

    data class Budget(
        val task: String,
        val expectedBodyChars: Int,
        val reasoningGate: ChatReasoningGate.Resolved,
        val request: ChatModelOutputProfile.RequestBudget,
        /** 自动模式失败后可逐次扩容；显式用户硬上限不会生成此指令。 */
        val adaptiveOutputBudget: AdaptiveOutputBudget? = null,
    )

    /**
     * 自动预算触顶后的下一次请求上限。
     * 按当前预算、正文体量和本次实际推理消耗动态增长，不使用任务/模型专属固定 token。
     * 返回 null 表示已经到达端点能力上限。
     */
    fun expandAdaptiveOutputBudget(
        currentMaxTokens: Int,
        budget: AdaptiveOutputBudget,
        observedReasoningTokens: Double? = null,
    ): Int? {
        val current = max(1, floor(currentMaxTokens.toDouble()).toInt())
        val ceiling = max(1, floor(budget.ceilingTokens.toDouble()).toInt())
        if (current >= ceiling) return null

        val body = max(0, floor(budget.bodyReserveTokens.toDouble()).toInt())
        val observedReasoning = if (observedReasoningTokens != null && observedReasoningTokens.isFinite()) {
            max(0, floor(observedReasoningTokens).toInt())
        } else {
            0
        }
        // 至少扩大一个「当前窗口」，同时保证已观测推理后仍留有完整正文空间
        val growthTarget = current + max(current, body)
        val observedTarget = observedReasoning + body
        val next = min(ceiling, maxOf(current + 1, growthTarget, observedTarget))
        return if (next > current) next else null
    }

    fun resolveGenerationTaskBodyChars(
        task: String,
        inputChars: Int? = null,
        expectedBodyChars: Int? = null,
    ): Int {
        if (expectedBodyChars != null && expectedBodyChars > 0) return ceil(expectedBodyChars.toDouble()).toInt()
        val chars = if (inputChars != null && inputChars > 0) ceil(inputChars.toDouble()).toInt() else 0
        if (task == "translation" || task == "image_prompt_translation") {
            return max(TASK_BODY_DEFAULTS.getValue(task), ceil(chars * 1.5).toInt())
        }
        if (task == "polish") {
            return max(256, ceil(chars * 1.1).toInt())
        }
        return TASK_BODY_DEFAULTS.getValue(task)
    }

    /** 所有文本生成任务的唯一预算入口。 */
    fun resolveGenerationTaskBudget(input: Input): Budget {
        val expectedBodyChars = resolveGenerationTaskBodyChars(input.task, input.inputChars, input.expectedBodyChars)
        val reasoningGate = input.reasoningGate ?: ChatReasoningGate.resolveReasoningGate(
            ChatReasoningGate.ResolveInput(
                model = input.model,
                requestedLevel = input.reasoningLevel ?: (if (input.task == "main") "standard" else "off"),
                enabled = true,
                recentReasoningTokens = input.recentReasoningTokens?.takeIf { it.isNotEmpty() },
            ),
        )
        val request = ChatModelOutputProfile.resolveRequestBudget(
            ChatModelOutputProfile.RequestBudgetInput(
                model = input.model,
                hardMaxChars = expectedBodyChars.toDouble(),
                userHardCap = input.userHardCap,
                recentReasoningTokens = input.recentReasoningTokens?.takeIf { it.isNotEmpty() },
                reasoningGate = reasoningGate,
                profileOverride = input.profileOverride,
            ),
        )
        val adaptive = if (ChatModelOutputProfile.resolveUserHardCap(input.userHardCap) == null &&
            request.requestMaxTokens < request.profile.outputLimit
        ) {
            AdaptiveOutputBudget(
                ceilingTokens = request.profile.outputLimit,
                bodyReserveTokens = request.bodyReserve,
            )
        } else {
            null
        }
        return Budget(
            task = input.task,
            expectedBodyChars = expectedBodyChars,
            reasoningGate = reasoningGate,
            request = request,
            adaptiveOutputBudget = adaptive,
        )
    }
}
