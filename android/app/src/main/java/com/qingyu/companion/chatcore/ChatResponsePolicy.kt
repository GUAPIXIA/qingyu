package com.qingyu.companion.chatcore

import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.roundToLong

/**
 * 阶段 4 S4-01 第 7 层：回复篇幅策略
 * （对齐 `shared/responsePolicy.ts`）。
 *
 * 职责：把「篇幅模式 + 近期对话节奏」解析成一轮回复的字符软区间与硬保护线；
 * 只给提示范围与保护线，不在生成后机械补字、也不做硬截取。
 *
 * 优先级（高 → 低）：用户本轮明确要求 → 会话级 → 预设提示 → 全局默认 → 自动（基线回归）。
 */
object ChatResponsePolicy {

    /** 篇幅模式：auto | brief | balanced | detailed（保持 TS 字面量）。 */
    val LENGTH_MODES = listOf("auto", "brief", "balanced", "detailed")

    val VALID_MODES: Set<String> = LENGTH_MODES.toSet()

    /** 固定软区间与硬保护线（方案 §4.1 表）。 */
    data class LengthRange(
        val preferredMinChars: Int,
        val preferredMaxChars: Int,
        val hardMaxChars: Int,
        val targetParagraphsMin: Int,
        val targetParagraphsMax: Int,
        val maxNewBeats: Int,
    )

    val RESPONSE_LENGTH_RANGES: Map<String, LengthRange> = mapOf(
        "brief" to LengthRange(40, 140, 260, 1, 2, 1),
        "balanced" to LengthRange(120, 360, 600, 1, 4, 1),
        "detailed" to LengthRange(300, 700, 1100, 2, 6, 2),
    )

    /** 自动模式硬保护线（可见字符）：任何自动目标都不超过该值。 */
    const val AUTO_HARD_MAX_CHARS = 900

    /** 自动模式默认基线：无近期样本时按「适中」回合估计。 */
    const val AUTO_DEFAULT_BASELINE_CHARS = 240

    const val AUTO_TARGET_MIN_CHARS = 80
    const val AUTO_TARGET_MAX_CHARS = 700

    /** 自动模式回归基线采样最近 N 条已完成助手回复。 */
    const val AUTO_BASELINE_WINDOW = 5

    const val AUTO_TARGET_PARAGRAPHS_MIN = 1
    const val AUTO_TARGET_PARAGRAPHS_MAX = 5
    const val AUTO_MAX_NEW_BEATS = 1

    /** 篇幅模式的界面显示名。 */
    val RESPONSE_LENGTH_LABELS: Map<String, String> = mapOf(
        "auto" to "自动",
        "brief" to "简短",
        "balanced" to "适中",
        "detailed" to "展开",
    )

    /** 解析结果（对齐 TS `ResponsePolicy` 的字段子集）。 */
    data class Policy(
        val mode: String,
        /** user | session | preset | settings | auto */
        val source: String,
        val preferredMinChars: Int,
        val preferredMaxChars: Int,
        val hardMaxChars: Int,
        val targetParagraphsMin: Int,
        val targetParagraphsMax: Int,
        val maxNewBeats: Int,
    )

    // ---------------------------------------------------------------- 基础工具

    private val THOUGHT_BLOCK = Regex("<thought>[\\s\\S]*?</thought>", RegexOption.IGNORE_CASE)
    private val WHITESPACE = Regex("\\s+")

    /** 可见字符统计口径：剥离思考块与**所有 Unicode 空白**（星号/引号等展示符号属正文，计入）。 */
    fun countVisibleChars(text: String): Int {
        if (text.isEmpty()) return 0
        return WHITESPACE.replace(THOUGHT_BLOCK.replace(text, ""), "").length
    }

    /** 中位数（偶数个取平均并四舍五入）；无有效样本返回 null。 */
    fun median(values: List<Double>): Int? {
        val sorted = values.filter { it.isFinite() }.sorted()
        if (sorted.isEmpty()) return null
        val mid = floor(sorted.size / 2.0).toInt()
        return if (sorted.size % 2 == 1) {
            sorted[mid].toInt()
        } else {
            ((sorted[mid - 1] + sorted[mid]) / 2).roundToLong().toInt()
        }
    }

    /** 可参与可见字符统计的最小消息形状。 */
    interface VisibleCharsSource {
        val role: String
        val content: String?
    }

    /** 从历史消息提取最近 N 条已完成助手回复的可见字符数。 */
    fun collectRecentAssistantChars(
        messages: List<VisibleCharsSource>,
        window: Int = AUTO_BASELINE_WINDOW,
    ): List<Int> {
        val samples = mutableListOf<Int>()
        var index = messages.size - 1
        while (index >= 0 && samples.size < window) {
            val message = messages[index]
            // 接口属性不能智能转换，先取局部值
            val content = message.content
            if (message.role == "assistant" && !content.isNullOrEmpty()) {
                samples += countVisibleChars(content)
            }
            index--
        }
        return samples
    }

    // ---------------------------------------------------------------- 用户本轮意图

    /**
     * S5：只识别明确的指令式词组，不做泛化语义猜测。
     * 两组合并命中时以「简短」优先（同一句里既说别太长又说展开时，收紧更安全）。
     */
    private val BRIEF_INTENT_PATTERNS = listOf(
        Regex("简短|简洁|简明|简要|精简|从简|言简意赅|长话短说"),
        Regex("简单(点|一点)?(说|讲|说说|讲讲)"),
        Regex("(只|就|请|能|可以|能否)(回答|回复|说|讲)(一|1)句"),
        Regex("(回答|回复|说明|概括)(一|1)句(话)?"),
        Regex("(用|以|只|就|请)?(一|1)句话(回答|回复|说明|概括|总结|说完|说清)"),
        Regex("(短|少)(一点|一些|点)(说|写|讲|回答)?"),
        Regex("(别|不要|不用|无需)(写|说|讲)?(太长|太多|那么长|这么长)"),
    )

    private val DETAILED_INTENT_PATTERNS = listOf(
        Regex("详细(一点|一些|点|地)?(说|讲|写|描写|说明|展开|说说|讲讲)"),
        Regex("写得?详细(一点|一些|点)?"),
        Regex("(更|再)(加)?详细(一点|一些|点|地)?(说|讲|写)?"),
        Regex("(展开|扩写)(一点|一些|来说|说说|讲讲|地|写)"),
        Regex("(详细|具体)(展开|说说|讲讲|描写|说明)"),
        Regex("具体(说|讲)(说|讲讲)?"),
        Regex("多(写|说)(一点|一些|点)"),
        Regex("(描写|写得)?(细致|丰富)(一点|一些|点)"),
        Regex("(写|说|讲)(长|多)(一点|一些)"),
    )

    /** 识别本轮用户消息中的明确篇幅要求；无明确词组返回 null。 */
    fun detectUserLengthIntent(text: String?): String? {
        val value = text?.trim().orEmpty()
        if (value.isEmpty()) return null
        if (BRIEF_INTENT_PATTERNS.any { it.containsMatchIn(value) }) return "brief"
        if (DETAILED_INTENT_PATTERNS.any { it.containsMatchIn(value) }) return "detailed"
        return null
    }

    // ---------------------------------------------------------------- 场景系数

    private val SCENE_SHIFT_PATTERN =
        Regex("【\\s*(场景|时间|地点|环境|新场景)\\s*】|场景切换|转场|换个场景|换个地方|新的场景")

    /** 高压即时问答：短问句（去空白后 ≤ 12 字符且以问号结尾）。 */
    private fun isQuickExchange(text: String): Boolean {
        val compact = WHITESPACE.replace(text, "")
        return compact.isNotEmpty() && compact.length <= 12 && Regex("[？?]$").containsMatchIn(compact)
    }

    /**
     * S5：自动模式场景系数——只根据确定事件调整。
     * 明确场景切换 1.25 / 首轮开场 1.15 / 高压即时问答 0.85 / 其余 1。
     */
    fun resolveSceneFactor(latestUserText: String?, hasAssistantReply: Boolean): Double {
        val text = latestUserText?.trim().orEmpty()
        if (text.isNotEmpty() && SCENE_SHIFT_PATTERN.containsMatchIn(text)) return 1.25
        if (!hasAssistantReply) return 1.15
        if (isQuickExchange(text)) return 0.85
        return 1.0
    }

    // ---------------------------------------------------------------- 模式与策略解析

    data class ModeResolution(val mode: String, val source: String)

    /** 解析篇幅模式与来源；无效值一律视为未设置（回退到下一优先级）。 */
    fun resolveResponseLengthMode(
        sessionMode: String?,
        presetHint: String?,
        defaultMode: String?,
        userIntent: String?,
    ): ModeResolution {
        val intent = userIntent?.takeIf { it in VALID_MODES && it != "auto" }
        if (intent != null) return ModeResolution(intent, "user")
        if (sessionMode != null && sessionMode in VALID_MODES && sessionMode != "auto") {
            return ModeResolution(sessionMode, "session")
        }
        if (presetHint != null && presetHint in VALID_MODES && presetHint != "auto") {
            return ModeResolution(presetHint, "preset")
        }
        if (defaultMode != null && defaultMode in VALID_MODES && defaultMode != "auto") {
            return ModeResolution(defaultMode, "settings")
        }
        return ModeResolution("auto", "auto")
    }

    /**
     * 解析一轮回复的篇幅策略。
     * - 非自动模式：固定区间；
     * - 自动模式：baseline = median(recent) || 240；target = clamp(baseline × sceneFactor, 80, 700)；
     *   preferredMin = 0.55·target，preferredMax = 1.35·target，hardMax = min(1.7·preferredMax, 900)。
     */
    fun resolveResponsePolicy(
        sessionMode: String? = null,
        presetHint: String? = null,
        defaultMode: String? = null,
        userIntent: String? = null,
        recentAssistantVisibleChars: List<Double>? = null,
        sceneFactor: Double? = null,
    ): Policy {
        val resolution = resolveResponseLengthMode(sessionMode, presetHint, defaultMode, userIntent)
        if (resolution.mode != "auto") {
            val range = RESPONSE_LENGTH_RANGES.getValue(resolution.mode)
            return Policy(
                mode = resolution.mode,
                source = resolution.source,
                preferredMinChars = range.preferredMinChars,
                preferredMaxChars = range.preferredMaxChars,
                hardMaxChars = range.hardMaxChars,
                targetParagraphsMin = range.targetParagraphsMin,
                targetParagraphsMax = range.targetParagraphsMax,
                maxNewBeats = range.maxNewBeats,
            )
        }

        val baseline = median(recentAssistantVisibleChars ?: emptyList()) ?: AUTO_DEFAULT_BASELINE_CHARS
        val factor = clamp(
            sceneFactor?.takeIf { it.isFinite() } ?: 1.0,
            0.5,
            2.0,
        )
        val target = clamp(
            (baseline * factor).roundToLong().toDouble(),
            AUTO_TARGET_MIN_CHARS.toDouble(),
            AUTO_TARGET_MAX_CHARS.toDouble(),
        ).toInt()
        val preferredMinChars = (target * 0.55).roundToLong().toInt()
        val preferredMaxChars = (target * 1.35).roundToLong().toInt()
        val hardMaxChars = min((preferredMaxChars * 1.7).roundToLong().toInt(), AUTO_HARD_MAX_CHARS)
        return Policy(
            mode = "auto",
            source = resolution.source,
            preferredMinChars = preferredMinChars,
            preferredMaxChars = preferredMaxChars,
            hardMaxChars = hardMaxChars,
            targetParagraphsMin = AUTO_TARGET_PARAGRAPHS_MIN,
            targetParagraphsMax = AUTO_TARGET_PARAGRAPHS_MAX,
            maxNewBeats = AUTO_MAX_NEW_BEATS,
        )
    }

    private fun clamp(value: Double, min: Double, max: Double): Double = min(max, maxOf(min, value))

    // ---------------------------------------------------------------- 主对话输出约束

    /**
     * 主对话输出约束提示（对齐 `contextBuilder.buildMainChatOutputPrompt`）。
     * `beatText` 由 `policy.maxNewBeats <= 1` 决定「一个」/「两个」。
     */
    fun buildMainChatOutputPrompt(policy: Policy): String {
        val beatText = if (policy.maxNewBeats <= 1) "一个" else "两个"
        return buildString {
            appendLine("【本轮回应范围】")
            appendLine("- 只完成一个自然互动回合：先回应最近输入，再最多推进${beatText}主要事件、信息或情绪变化。")
            appendLine("- 推进到需要用户回应、选择或行动的位置就停止；不要连续代写下一轮，也不要自动写完整个场景。")
            append("- 本轮正文通常为 ${policy.preferredMinChars}–${policy.preferredMaxChars} 个可见字符；")
            appendLine("语义完整和自然收尾优先，不为凑字数重复。")
            appendLine("- 不得与最近对话的既有事实、已完成动作或已说过的信息矛盾或重复；新引入的信息要能从当前场景自然推出。")
            appendLine("- 接近篇幅上限时停止引入新信息，完成当前句，并在完整对白、动作或观察后结束。")
            appendLine("- 除非用户明确要求，不做总结、尾声、未来预告，也不同时开启第二条支线。")
            appendLine()
            appendLine("【正文结构】")
            appendLine("- 按说话、动作或叙事焦点的自然变化分段；短回应可以只有一个段落。")
            appendLine("- 对白使用中文引号；动作和环境用普通叙述段落。不要为了排版重复角色名。")
            appendLine("- 不输出标题、列表、代码块、创作说明或写作计划。")
            append("- 不把角色心理活动混入正文；启用 <thought> 时严格遵循单独的内心想法契约。")
        }
    }

    /** 供测试与诊断：模式是否合法。 */
    fun isValidMode(value: String?): Boolean = value != null && value in VALID_MODES

    internal fun normalizeForCompare(value: String): String = value.lowercase(Locale.ROOT)

    internal fun approxEquals(a: Double, b: Double, tolerance: Double = 1e-9): Boolean =
        abs(a - b) <= tolerance * maxOf(1.0, abs(a))
}
