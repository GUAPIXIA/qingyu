package com.qingyu.companion.chatcore

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * 阶段 4 S4-01 第 5 层：模型输出能力档案与请求预算
 * （对齐 `shared/modelOutputProfile.ts`）。
 *
 * 正文预算与推理余量分别估算，再合并为请求上限：
 * - `bodyReserve = ceil(正文硬保护线估算 token × 1.25) + 96`
 * - `reasoningReserve` 按模型的推理通道类型解析（可由推理门控覆盖）
 * - `requestMaxTokens = min(模型输出上限, bodyReserve + reasoningReserve, 用户硬上限)`
 *
 * 不对特定模型固定放大；篇幅由响应策略（字符）表达，推理模型通过能力档案获得独立余量。
 */
object ChatModelOutputProfile {

    /** none | separate | shared-known | shared-unknown */
    val REASONING_RESERVE_MODES = listOf("none", "separate", "shared-known", "shared-unknown")

    /** exact | family | fallback | runtime */
    val MATCH_KINDS = listOf("exact", "family", "fallback", "runtime")

    /** 协议余量：可关闭/独立推理的模型仅保留的请求开销余量。 */
    const val PROTOCOL_RESERVE_TOKENS = 192

    /** 自动预算的通用能力回退（不按模型名分叉）。 */
    const val DEFAULT_AUTOMATIC_OUTPUT_LIMIT = 32768

    /** 无可靠样本时所有端点共用的自动推理余量。 */
    val DEFAULT_AUTOMATIC_REASONING_RESERVE: Int = DEFAULT_AUTOMATIC_OUTPUT_LIMIT / 4

    /** 正文预算安全系数与固定协议开销。 */
    const val BODY_RESERVE_MULTIPLIER = 1.25
    const val BODY_RESERVE_OVERHEAD_TOKENS = 96

    /** 推理共享模型即使获得完整 reasoning 余量，也必须至少留下这部分正文空间。 */
    const val MIN_USABLE_BODY_TOKENS = 256

    data class Profile(
        /** 模型侧最大输出 token（请求上限的模型硬顶） */
        val outputLimit: Int,
        /** 输入+输出合并窗口的内置保守值 */
        val contextLimit: Int,
        /** none | separate | shared-known | shared-unknown */
        val reasoningMode: String,
        /** 无近期统计时的默认推理余量（仅 shared-* 模式使用） */
        val defaultReasoningReserve: Int,
        /** 推理余量档位上限 */
        val maxReasoningReserve: Int,
        /** 角色扮演回合的默认门控档位 */
        val defaultGate: String,
        /** 可尝试的门控 knob，按序探测；必须以 none 结尾 */
        val gateKnobs: List<String>,
        /** exact | family | fallback | runtime */
        val matchedBy: String,
        /** high | low */
        val confidence: String,
    )

    data class UserOverride(val outputLimit: Int? = null, val contextLimit: Int? = null)

    data class CapabilityCorrection(
        val outputLimit: Int? = null,
        val contextLimit: Int? = null,
        /** context_limit | output_limit */
        val reason: String,
        val updatedAt: Long,
    )

    data class ResolveOptions(
        val userOverride: UserOverride? = null,
        val runtimeCorrection: CapabilityCorrection? = null,
    )

    val AUTOMATIC_PROFILE = Profile(
        outputLimit = DEFAULT_AUTOMATIC_OUTPUT_LIMIT,
        // 未知型号的保守回退窗口（无数据时不猜测供应商宣传值）
        contextLimit = 32768,
        reasoningMode = "shared-unknown",
        defaultReasoningReserve = DEFAULT_AUTOMATIC_REASONING_RESERVE,
        maxReasoningReserve = DEFAULT_AUTOMATIC_OUTPUT_LIMIT - MIN_USABLE_BODY_TOKENS,
        defaultGate = "standard",
        gateKnobs = listOf("none"),
        matchedBy = "fallback",
        confidence = "low",
    )

    private val DEEPSEEK_V4_PROFILE = AUTOMATIC_PROFILE.copy(
        contextLimit = 65536,
        gateKnobs = listOf("thinking-disable", "reasoning-effort", "none"),
        matchedBy = "exact",
        confidence = "high",
    )

    private val DEEPSEEK_REASONER_PROFILE = AUTOMATIC_PROFILE.copy(
        contextLimit = 65536,
        gateKnobs = listOf("none"),
        matchedBy = "exact",
        confidence = "high",
    )

    private val CLAUDE_THINKING_PROFILE = AUTOMATIC_PROFILE.copy(
        contextLimit = 200000,
        gateKnobs = listOf("thinking-budget", "none"),
        matchedBy = "exact",
        confidence = "high",
    )

    private val GEMINI_THINKING_PROFILE = AUTOMATIC_PROFILE.copy(
        contextLimit = 1048576,
        gateKnobs = listOf("gemini-thinking-config", "none"),
        matchedBy = "exact",
        confidence = "high",
    )

    private val OPENAI_REASONING_PROFILE = AUTOMATIC_PROFILE.copy(
        contextLimit = 200000,
        gateKnobs = listOf("reasoning-effort", "none"),
        matchedBy = "exact",
        confidence = "high",
    )

    /** 档案匹配规则：match 为模型名小写子串，先命中先生效。 */
    private val MODEL_PROFILE_RULES: List<Pair<List<String>, Profile>> = listOf(
        listOf("deepseek-v4") to DEEPSEEK_V4_PROFILE,
        listOf("deepseek-reasoner", "deepseek-r1") to DEEPSEEK_REASONER_PROFILE,
        // haiku 无扩展思考，需排在 claude-4 之前
        listOf("haiku") to AUTOMATIC_PROFILE.copy(contextLimit = 200000),
        listOf("claude-3-7", "claude-3.7", "claude-4") to CLAUDE_THINKING_PROFILE,
        listOf("gemini-2.5", "gemini-3") to GEMINI_THINKING_PROFILE,
        listOf("o1", "o3", "o4", "gpt-5") to OPENAI_REASONING_PROFILE,
    )

    val DEFAULT_OUTPUT_PROFILE: Profile = AUTOMATIC_PROFILE

    /** 族通配回退（低置信）：只修正「上下文窗口」这一项能力。 */
    private val FAMILY_CONTEXT_HINTS: List<Pair<List<String>, Int>> = listOf(
        listOf("claude", "anthropic") to 200000,
        listOf("gemini") to 1000000,
        listOf("deepseek") to 65536,
        listOf("kimi", "moonshot") to 131072,
        listOf("glm", "zhipu") to 131072,
        listOf("qwen", "qwq") to 32768,
        listOf("llama", "mistral", "mixtral", "yi-", "baichuan") to 32768,
        listOf("gpt-", "openai", "chatgpt") to 128000,
    )

    /** 内置档案解析：精确登记优先（高置信）→ 族通配（低置信）→ 保守回退。纯函数，不读用户设置。 */
    fun getModelOutputProfile(model: String): Profile {
        val lower = (model).lowercase()
        if (lower.isEmpty()) return DEFAULT_OUTPUT_PROFILE
        for ((tokens, profile) in MODEL_PROFILE_RULES) {
            if (tokens.any { lower.contains(it) }) {
                return profile.copy(matchedBy = "exact", confidence = "high")
            }
        }
        for ((tokens, contextLimit) in FAMILY_CONTEXT_HINTS) {
            if (tokens.any { lower.contains(it) }) {
                return AUTOMATIC_PROFILE.copy(
                    contextLimit = contextLimit,
                    matchedBy = "family",
                    confidence = "low",
                )
            }
        }
        return DEFAULT_OUTPUT_PROFILE.copy(matchedBy = "fallback", confidence = "low")
    }

    /**
     * 完整能力解析：内置（精确优先）→ 用户显式覆盖 → 运行时纠正。
     * - 用户覆盖优先，可收紧也可放大（用户对私有端点的明确声明）；
     * - 运行时纠正只能收紧（取 min），不得擅自放大。
     */
    fun resolveModelOutputProfile(model: String, options: ResolveOptions = ResolveOptions()): Profile {
        val builtin = getModelOutputProfile(model)
        var outputLimit = builtin.outputLimit
        var contextLimit = builtin.contextLimit
        var matchedBy = builtin.matchedBy
        var confidence = builtin.confidence

        options.userOverride?.let { override ->
            override.outputLimit?.let { value ->
                if (value > 0) {
                    outputLimit = floor(value.toDouble()).toInt()
                    matchedBy = "runtime"
                    confidence = "high"
                }
            }
            override.contextLimit?.let { value ->
                if (value > 0) {
                    contextLimit = floor(value.toDouble()).toInt()
                    matchedBy = "runtime"
                    confidence = "high"
                }
            }
        }

        options.runtimeCorrection?.let { correction ->
            correction.outputLimit?.let { value ->
                if (value > 0) {
                    outputLimit = min(outputLimit, floor(value.toDouble()).toInt())
                }
            }
            correction.contextLimit?.let { value ->
                if (value > 0) {
                    contextLimit = min(contextLimit, floor(value.toDouble()).toInt())
                }
            }
            matchedBy = "runtime"
            confidence = "low"
        }

        return builtin.copy(
            outputLimit = outputLimit,
            contextLimit = contextLimit,
            matchedBy = matchedBy,
            confidence = confidence,
        )
    }

    /** 最近 reasoning token 样本的 P90（样本不足 10 个时取最大值，方向偏保守）。 */
    fun percentile90(values: List<Double>): Int {
        val sorted = values.filter { it.isFinite() && it >= 0 }.sorted()
        if (sorted.isEmpty()) return 0
        if (sorted.size < 10) return sorted.last().toInt()
        val idx = min(sorted.size - 1, ceil(sorted.size * 0.9).toInt() - 1)
        return sorted[idx].toInt()
    }

    /**
     * 解析推理余量：
     * - none / separate：协议余量；
     * - shared-*：有近期样本时取 P90 × 1.2（钳制在 [协议余量, maxReasoningReserve]），
     *   无样本回退档案默认余量。
     *
     * 全 0 样本对共享窗口模型**不是可信证据**（可能只是该桶缺少上报），故回退档案默认余量：
     * 两种解释代价不对称——max_tokens 是上限而非花费，多留推理空间不会多花钱。
     */
    fun resolveReasoningReserve(profile: Profile, recentReasoningTokens: List<Double>? = null): Int {
        if (profile.reasoningMode == "none" || profile.reasoningMode == "separate") {
            return PROTOCOL_RESERVE_TOKENS
        }
        val samples = (recentReasoningTokens ?: emptyList()).filter { it.isFinite() && it >= 0 }
        if (samples.isEmpty()) return profile.defaultReasoningReserve
        val estimate = ceil(percentile90(samples) * 1.2).toInt()
        if (estimate <= 0) return profile.defaultReasoningReserve
        return min(profile.maxReasoningReserve, max(PROTOCOL_RESERVE_TOKENS, estimate))
    }

    /** 可见字符 → 正文 token 的保守估算（中文约 1 token/字，按 1:1 向上取整）。 */
    fun estimateTokensForVisibleChars(visibleChars: Double): Int {
        if (!visibleChars.isFinite() || visibleChars <= 0) return 0
        return ceil(visibleChars).toInt()
    }

    data class RequestBudgetInput(
        val model: String,
        /** 本轮篇幅策略的硬保护线（可见字符）。 */
        val hardMaxChars: Double,
        /** 用户明确指定的模型输出硬上限（空/0 = 未指定）。 */
        val userHardCap: Int? = null,
        val recentReasoningTokens: List<Double>? = null,
        val reasoningGate: ChatReasoningGate.Resolved? = null,
        val profileOverride: UserOverride? = null,
    )

    data class GateSummary(
        val level: String,
        val knob: String,
        val enforced: Boolean,
        val source: String,
    )

    data class RequestBudget(
        val model: String,
        val profile: Profile,
        val bodyReserve: Int,
        val reasoningReserve: Int,
        val minimumViableOutputTokens: Int,
        val requestMaxTokens: Int,
        val gate: GateSummary? = null,
        /** 用户硬上限不足以同时容纳推理余量和最小正文时置位（不静默放大） */
        val riskNotice: String? = null,
    )

    /** 0、空值和非法值都表示「自动」，正数才是用户明确的严格硬上限。 */
    fun resolveUserHardCap(value: Int?): Int? =
        if (value != null && value > 0) floor(value.toDouble()).toInt() else null

    /** 只有用户显式启用端点能力覆盖时，覆盖值才进入预算。 */
    fun enabledProfileOverride(
        enabled: Boolean?,
        contextLimit: Int? = null,
        outputLimit: Int? = null,
    ): UserOverride? {
        if (enabled != true) return null
        val result = UserOverride(
            contextLimit = contextLimit?.takeIf { it > 0 }?.let { floor(it.toDouble()).toInt() },
            outputLimit = outputLimit?.takeIf { it > 0 }?.let { floor(it.toDouble()).toInt() },
        )
        return if (result.contextLimit == null && result.outputLimit == null) null else result
    }

    /**
     * W10 输入能力语义：内置档案是默认事实来源；旧 maxContext 仍可收紧，
     * 但只有显式能力覆盖可以放大。预设 maxContext 是用户编辑的本轮硬限制。
     */
    fun resolveEffectiveContextLimit(
        model: String,
        profileMaxContext: Int? = null,
        presetMaxContext: Int? = null,
        capabilityOverrideEnabled: Boolean? = null,
        capabilityContextLimit: Int? = null,
        capabilityOutputLimit: Int? = null,
    ): Int {
        val override = enabledProfileOverride(
            capabilityOverrideEnabled,
            capabilityContextLimit,
            capabilityOutputLimit,
        )
        val builtin = getModelOutputProfile(model).contextLimit
        val profile = profileMaxContext?.takeIf { it > 0 }?.let { floor(it.toDouble()).toInt() }
        val preset = presetMaxContext?.takeIf { it > 0 }?.let { floor(it.toDouble()).toInt() }
        val endpointLimit = override?.contextLimit ?: (if (profile != null) min(profile, builtin) else builtin)
        return if (preset != null) min(endpointLimit, preset) else endpointLimit
    }

    /** 面向界面的可操作风险说明。 */
    fun formatRequestBudgetRisk(budget: RequestBudget?): String? {
        if (budget == null) return null
        if (budget.riskNotice != "user_cap_below_reasoning_reserve") return null
        return "当前模型输出硬上限为 ${budget.requestMaxTokens} Token，低于该推理模型稳定输出正文所需的约 " +
            "${budget.minimumViableOutputTokens} Token。请提高硬上限，或设为 0 使用自动预算。"
    }

    /**
     * 计算本轮请求输出预算。
     * 上下文构建的输出预留与实际请求的 max_tokens 必须使用同一个返回值，禁止两处分别推导。
     */
    fun resolveRequestBudget(input: RequestBudgetInput): RequestBudget {
        val profile = resolveModelOutputProfile(input.model, ResolveOptions(userOverride = input.profileOverride))
        val hardMaxChars = if (input.hardMaxChars.isFinite() && input.hardMaxChars > 0) input.hardMaxChars else 0.0
        val bodyTokens = estimateTokensForVisibleChars(hardMaxChars)
        val bodyReserve = if (hardMaxChars > 0) {
            ceil(bodyTokens * BODY_RESERVE_MULTIPLIER).toInt() + BODY_RESERVE_OVERHEAD_TOKENS
        } else {
            0
        }
        val conservativeReserve = resolveReasoningReserve(profile, input.recentReasoningTokens)
        val reasoningReserve = input.reasoningGate?.let { gate ->
            if (gate.enforced) gate.gateTokens else max(gate.gateTokens, conservativeReserve)
        } ?: conservativeReserve
        val needed = bodyReserve + reasoningReserve
        val minimumViableOutputTokens = reasoningReserve + min(bodyReserve, MIN_USABLE_BODY_TOKENS)

        val cap = resolveUserHardCap(input.userHardCap)

        var requestMaxTokens = min(profile.outputLimit, needed)
        var riskNotice: String? = null
        if (cap != null) {
            if (cap < minimumViableOutputTokens) riskNotice = "user_cap_below_reasoning_reserve"
            requestMaxTokens = min(requestMaxTokens, cap)
        }

        val gate = input.reasoningGate?.let {
            GateSummary(level = it.level, knob = it.knob, enforced = it.enforced, source = it.source)
        }

        return RequestBudget(
            model = input.model,
            profile = profile,
            bodyReserve = bodyReserve,
            reasoningReserve = reasoningReserve,
            minimumViableOutputTokens = minimumViableOutputTokens,
            requestMaxTokens = requestMaxTokens,
            gate = gate,
            riskNotice = riskNotice,
        )
    }
}
