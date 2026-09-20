package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-04：输入续写控制项
 * （对齐 `shared/continueIntensity.ts`）。
 *
 * 两个维度职责**不可互换**：剧情变化决定「发生多大的变化」，续写长度决定「本次增加多少文字」。
 */
object ChatContinueIntensity {

    const val DEFAULT_INTENSITY = "active"
    const val DEFAULT_LENGTH = "standard"

    val INTENSITIES = listOf("subtle", "steady", "active", "bold")
    val LENGTHS = listOf("brief", "standard", "detailed", "extended")

    data class Option(val value: String, val label: String, val description: String)

    val INTENSITY_OPTIONS: List<Option> = listOf(
        Option("subtle", "延续", "保持当前走向，不主动加入新事件或转折"),
        Option("steady", "波澜", "加入小阻碍或新信息，但不改变当前主线"),
        Option("active", "转折", "引入事件、压力或线索，明显改变当前局势"),
        Option("bold", "剧变", "允许重大转折、场景切换或新的冲突线"),
    )

    val LENGTH_OPTIONS: List<Option> = listOf(
        Option("brief", "短句", "预计新增 20–60 字 · 1–2 句"),
        Option("standard", "小段", "预计新增 80–180 字 · 1 个完整自然段"),
        Option("detailed", "展开", "预计新增 220–420 字 · 2–3 个自然段"),
        Option("extended", "长篇", "预计新增 500–900 字 · 4–6 个自然段"),
    )

    /**
     * 剧情变化只控制推进幅度与采样创造性，**不隐式改变篇幅**。
     * 温度收窄到 0.45–0.75：过高会同时增加新支线、新人物与解释性细节，使续写长度更难预测。
     */
    val INTENSITY_TEMPERATURES: Map<String, Double> = linkedMapOf(
        "subtle" to 0.45,
        "steady" to 0.55,
        "active" to 0.65,
        "bold" to 0.75,
    )

    data class LengthParams(val minChars: Int, val maxChars: Int, val structure: String)

    /**
     * 续写长度只控制「本次新增内容」的目标区间，不改变剧情推进幅度。
     * minChars/maxChars 既是给模型的字数指令，也是生成后校验的依据；
     * 它**不承担输出上限职责**——输出预算由统一任务预算器换算。
     */
    val LENGTH_PARAMS: Map<String, LengthParams> = linkedMapOf(
        "brief" to LengthParams(20, 60, "1–2 句"),
        "standard" to LengthParams(80, 180, "形成 1 个完整自然段"),
        "detailed" to LengthParams(220, 420, "形成 2–3 个自然段"),
        "extended" to LengthParams(500, 900, "形成 4–6 个自然段"),
    )

    /** 长度校验阈值（方案 §6.5）。 */
    const val ACCEPT_LOWER_RATIO = 0.8
    const val REPAIR_CEILING_RATIO = 1.2
    const val SOFT_LOWER_RATIO = 0.6
    const val SOFT_UPPER_RATIO = 1.5

    fun isIntensity(value: String?): Boolean = value != null && INTENSITIES.contains(value)

    fun isLength(value: String?): Boolean = value != null && LENGTHS.contains(value)

    /** 从高到低解析默认值；非法值与空值会被跳过。 */
    fun resolveIntensity(vararg candidates: String?): String =
        candidates.firstOrNull { isIntensity(it) } ?: DEFAULT_INTENSITY

    fun resolveLength(vararg candidates: String?): String =
        candidates.firstOrNull { isLength(it) } ?: DEFAULT_LENGTH

    fun intensityLabel(intensity: String): String =
        INTENSITY_OPTIONS.firstOrNull { it.value == intensity }?.label ?: "转折"

    fun lengthLabel(length: String): String =
        LENGTH_OPTIONS.firstOrNull { it.value == length }?.label ?: "小段"

    fun temperatureOf(intensity: String): Double = INTENSITY_TEMPERATURES[intensity] ?: 0.65

    fun paramsOf(length: String): LengthParams = LENGTH_PARAMS[length] ?: LENGTH_PARAMS.getValue(DEFAULT_LENGTH)
}
