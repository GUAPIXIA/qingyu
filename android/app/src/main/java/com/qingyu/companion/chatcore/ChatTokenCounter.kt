package com.qingyu.companion.chatcore

import kotlin.math.ceil
import kotlin.math.roundToInt

/**
 * 阶段 4 S4-02：Token 计数策略（对齐 `shared/chat-core/tokenCounter.ts` 的启发式分支）。
 *
 * - [estimateTokens]：与 PC 同口径的同步启发式估算，用于 UI 即时预算；
 * - [estimateImageTokens]：图片按 OpenAI high-detail 粗略值计；
 * - [formatTokens]：展示格式。
 *
 * 精确 tokenizer（tiktoken 等）在移动端属可重建资源、不同步；
 * 不可用时一律以本估算为「estimated」口径（阶段 4 §2）。
 */
object ChatTokenCounter {

    /** 每张图片的 token 估算值（OpenAI high-detail 视觉计费的粗略值）。 */
    const val IMAGE_TOKEN_ESTIMATE = 500

    private val CJK = Regex("[\\u4e00-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff]")

    /**
     * 标点集合，**逐字符对齐 PC**：`[，。！？；：""''（）【】《》、\s]`。
     *
     * 两个易错点（本轮由 fixture 抓出）：
     * 1. PC 用的是 **ASCII 直引号** `"` `'`（源码里各写了两遍），**不是**中文引号
     *    `“”‘’`。把它「美化」成中文引号会让中文引号被当成标点，token 估算整体偏移；
     * 2. `\s` 用显式的 JS 空白集合：JVM 默认 `\s` 只保证 ASCII 空白，
     *    而 JS `\s` 含 `\u3000`、`\u00a0` 等，依赖平台默认会让两端计数漂移。
     */
    private const val JS_SPACE_CLASS =
        "\\t\\n\\u000B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"

    private val PUNCTUATION = Regex("[，。！？；：\"'（）【】《》、$JS_SPACE_CLASS]")

    /**
     * 启发式估算：按模型族取「汉字/token」与「英文/token」系数。
     * claude 与 gemini 的系数不同于默认族（与 PC 一致）。
     */
    fun estimateTokens(text: String, model: String? = null): Int {
        if (text.isEmpty()) return 0
        val lower = model?.lowercase() ?: ""
        val chPerZhTok = when {
            lower.contains("claude") -> 0.85
            lower.contains("gemini") -> 0.9
            else -> 0.9
        }
        val chPerEnTok = when {
            lower.contains("claude") -> 3.6
            lower.contains("gemini") -> 3.3
            else -> 3.4
        }

        val cjkChars = CJK.findAll(text).count()
        val punctuation = PUNCTUATION.findAll(text).count()
        val englishLike = text.length - cjkChars - punctuation

        return ceil(cjkChars * chPerZhTok + punctuation * 0.25 + englishLike / chPerEnTok).toInt()
    }

    /** N 张图片的估算（负数按 0 处理）。 */
    fun estimateImageTokens(count: Int): Int = maxOf(0, count) * IMAGE_TOKEN_ESTIMATE

    /** 展示格式：<1000 原样；<10000 保留一位 K；否则整数 K。 */
    fun formatTokens(tokens: Int): String {
        if (tokens < 1000) return "$tokens"
        if (tokens < 10000) return String.format(java.util.Locale.ROOT, "%.1fK", tokens / 1000.0)
        return "${(tokens / 1000.0).roundToInt()}K"
    }
}
