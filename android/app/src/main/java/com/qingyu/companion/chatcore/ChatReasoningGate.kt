package com.qingyu.companion.chatcore

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * 阶段 4 S4-01 第 5 层：推理门控域
 * （对齐 `shared/reasoningGate.ts`）。
 *
 * 职责：
 * - 把产品档位（off/low/standard/full）解析为端点可下发的 knob；
 * - 给出预算用的推理预留 `gateTokens`：可信门控 = 档位承诺值，不可信/无门控 = 保守余量；
 * - 探测记录 [Probe] 的读取语义与合并（样本有界、unknown 不填 0）；
 * - 降档链 standard → low → off。
 *
 * 与 [ChatModelOutputProfile] 的分工：本模块只解析「推理约束」，
 * 输出预算仍由 `resolveRequestBudget` 唯一计算（它消费本模块结果，不做二次推导）。
 */
object ChatReasoningGate {

    /** 本轮希望供应商执行的推理档位（产品语义，非各家参数名）。 */
    val LEVELS = listOf("off", "low", "standard", "full")

    /** 端点实际可用的门控方式；探测前为 unknown。 */
    val KNOBS = listOf(
        "thinking-disable",
        "reasoning-effort",
        "thinking-budget",
        "gemini-thinking-config",
        "none",
    )

    /** low 档的推理上限。 */
    const val LOW_GATE_TOKENS = 1024

    /** 探测样本上限：每键最多保留的近期样本数。 */
    const val GATE_PROBE_MAX_SAMPLES = 32

    data class Probe(
        val knob: String = "unknown",
        /** 端点是否接受该 knob 参数（明确 400 拒绝 → false，之后不再尝试）。 */
        val knobAccepted: Boolean? = null,
        /** 声称接受但流中仍出现 reasoning_content → off 档被静默忽略。 */
        val disableIgnored: Boolean? = null,
        /** 是否上报 usage.reasoning_tokens。 */
        val reportsReasoningUsage: Boolean? = null,
        /** 近期 reasoning token 样本（有界；unknown 不入样本，绝不填 0）。 */
        val recentReasoningTokens: List<Double> = emptyList(),
        val updatedAt: Long = 0L,
    )

    /** gate | conservative | disabled */
    val SOURCES = listOf("gate", "conservative", "disabled")

    data class Resolved(
        val level: String,
        val knob: String,
        /** gateTokens 是否由供应商强制执行（可信门控）。 */
        val enforced: Boolean,
        /** 本轮推理预留（预算公式的推理项）。 */
        val gateTokens: Int,
        val source: String,
    )

    /**
     * 档位 → 可承诺的推理 token 上限。
     * 返回 null 表示该档位没有可承诺值（standard/full 不干预端点默认；无门控端点无可执行约束）。
     */
    fun levelToTokens(level: String, knob: String): Int? {
        if (knob == "none" || knob == "unknown") return null
        return when (level) {
            "off" -> 0
            "low" -> LOW_GATE_TOKENS
            else -> null
        }
    }

    /** 降档链：full → standard → low → off → null（off 已是最后一级）。 */
    fun nextLowerGateLevel(level: String): String? = when (level) {
        "full" -> "standard"
        "standard" -> "low"
        "low" -> "off"
        else -> null
    }

    /**
     * 按档案顺序选择本轮 knob：
     * - 明确 400 拒绝过的 knob 跳过；
     * - off 档且该端点已确认静默忽略 disable → 剩余 knob 也无从执行 off，落到 none；
     * - 列表以 none 结尾，保证一定有返回值。
     */
    fun selectGateKnob(
        profile: ChatModelOutputProfile.Profile,
        probe: Probe?,
        level: String,
    ): String {
        val knobs = if (profile.gateKnobs.isNotEmpty()) profile.gateKnobs else listOf("none")
        for (knob in knobs) {
            if (knob == "none") return "none"
            if (probe?.knobAccepted == false && probe.knob == knob) continue
            if (level == "off" && probe?.disableIgnored == true) continue
            return knob
        }
        return "none"
    }

    data class ResolveInput(
        val model: String,
        /** false 时门控整体禁用（返回保守余量）。 */
        val enabled: Boolean? = null,
        /** true = 辅助/后台路径（续写、补尾、方向、记忆、标题），默认 off。 */
        val auxiliary: Boolean? = null,
        /** 会话/用户显式档位（优先于 startLevel 与档案默认）。 */
        val requestedLevel: String? = null,
        /** 会话熔断后从更低档起步。 */
        val startLevel: String? = null,
        val probe: Probe? = null,
        val recentReasoningTokens: List<Double>? = null,
    )

    /**
     * 解析本轮门控：档位 → knob → gateTokens。
     * 可信（供应商执行）判定要求探测明确接受过该 knob；未探测一律按不可信处理，
     * 预算退回 `max(档位值, 保守余量)`。
     */
    fun resolveReasoningGate(input: ResolveInput): Resolved {
        val profile = ChatModelOutputProfile.getModelOutputProfile(input.model)
        // 探测样本与用量档案样本合并估计保守余量（两者都是「该端点近期推理量」的证据）
        val samples = (input.probe?.recentReasoningTokens ?: emptyList()) +
            (input.recentReasoningTokens ?: emptyList())
        val conservative = ChatModelOutputProfile.resolveReasoningReserve(profile, samples)
        val level = input.requestedLevel
            ?: input.startLevel
            ?: (if (input.auxiliary == true) "off" else profile.defaultGate)
        val knob = selectGateKnob(profile, input.probe, level)

        if (input.enabled == false) {
            return Resolved(level = level, knob = knob, enforced = false, gateTokens = conservative, source = "disabled")
        }

        val levelTokens = levelToTokens(level, knob)
        val enforced = levelTokens != null && input.probe?.knobAccepted == true
        return Resolved(
            level = level,
            knob = knob,
            enforced = enforced,
            gateTokens = if (enforced) levelTokens!! else max(levelTokens ?: 0, conservative),
            source = if (enforced) "gate" else "conservative",
        )
    }

    /**
     * 默认档位策略（主对话）：所有模型统一按端点默认（standard）。
     * 辅助/后台任务由调用方传 auxiliary，统一请求 off；不按模型名写死策略。
     */
    fun resolveDefaultGateLevel(model: String, enabled: Boolean, auxiliary: Boolean? = null): String? {
        if (!enabled) return null
        if (auxiliary == true) return "off"
        if (model.isEmpty()) return null
        return "standard"
    }

    data class ProbeUpdate(
        val knob: String? = null,
        val knobAccepted: Boolean? = null,
        val disableIgnored: Boolean? = null,
        val reportsReasoningUsage: Boolean? = null,
        /** 本轮观测到的 reasoning token；取不到时不要传（unknown 不入样本）。 */
        val reasoningTokens: Double? = null,
        val updatedAt: Long,
    )

    /**
     * 合并一次探测更新：样本有界、非法值丢弃、
     * 未提供的字段保持原值（false 一经确认不会被缺省覆盖）。
     */
    fun mergeGateProbe(current: Probe?, update: ProbeUpdate): Probe {
        val base = current ?: Probe(knob = "unknown", recentReasoningTokens = emptyList(), updatedAt = 0L)
        val samples = base.recentReasoningTokens.toMutableList()
        val tokens = update.reasoningTokens
        if (tokens != null && tokens.isFinite() && tokens >= 0) samples += tokens
        return Probe(
            knob = update.knob ?: base.knob,
            knobAccepted = update.knobAccepted ?: base.knobAccepted,
            disableIgnored = update.disableIgnored ?: base.disableIgnored,
            reportsReasoningUsage = update.reportsReasoningUsage ?: base.reportsReasoningUsage,
            recentReasoningTokens = samples.takeLast(GATE_PROBE_MAX_SAMPLES),
            updatedAt = update.updatedAt,
        )
    }

    /**
     * 预算型 knob 的下发值：不得超过 `requestMaxTokens − 正文最小空间`，
     * 否则推理预算会吞掉正文保证。
     */
    fun clampGateBudgetForBody(gateTokens: Double, requestMaxTokens: Double): Int {
        if (!gateTokens.isFinite() || gateTokens <= 0) return 0
        if (!requestMaxTokens.isFinite()) return 0
        val headroom = floor(requestMaxTokens).toInt() - ChatModelOutputProfile.MIN_USABLE_BODY_TOKENS
        if (headroom <= 0) return 0
        return min(floor(gateTokens).toInt(), headroom)
    }
}
