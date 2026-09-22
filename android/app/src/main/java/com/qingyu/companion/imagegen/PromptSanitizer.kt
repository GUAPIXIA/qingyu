package com.qingyu.companion.imagegen

import java.text.Normalizer

/**
 * 生图提示词清洗与尺寸归一化（PC `electron/services/imageGen.ts` 等价纯逻辑）。
 */
object PromptSanitizer {

    /**
     * SD WebUI 提示词清洗（参考 SillyTavern processReply）：
     * 1. 移除引号（ASCII 双引号 + 中文左右弯引号）；
     * 2. 换行替换为逗号；
     * 3. NFC 规范化（NFD 会拆散 é 等拉丁扩展字符，被白名单剥掉后失真）；
     * 4. 移除非 SD 语法字符（保留字母数字、SD 语法符号、CJK/假名/韩文与拉丁扩展）；
     * 5. 按逗号分割、trim、过滤空值、重新 join。
     */
    fun sanitizeSdPrompt(raw: String): String {
        if (raw.isEmpty()) return raw
        var s = raw
            .replace("\"", "")
            .replace("\u201C", "")
            .replace("\u201D", "")
            .replace("\n", ", ")
        s = Normalizer.normalize(s, Normalizer.Form.NFC)
        s = SD_ILLEGAL_CHARS.replace(s, " ")
        return s.split(',')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .joinToString(", ")
    }

    private val SD_ILLEGAL_CHARS =
        Regex("[^a-zA-Z0-9.,:_(){}<>\\[\\]/\\-'|\u00C0-\u024F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\\s]")

    /**
     * OpenAI DALL-E 提示词轻度清洗：DALL-E 支持自然语言，
     * 仅移除多余引号并把空白折叠，保留原始语义。
     */
    fun sanitizeOpenAiPrompt(raw: String): String {
        if (raw.isEmpty()) return raw
        return raw
            .replace("\"", "")
            .replace("\u201C", "")
            .replace("\u201D", "")
            .replace(Regex("\\s+"), " ")
            .trim()
    }
}

/** 尺寸解析与 DALL-E 合法尺寸归一化（PC `parseSize` / `normalizeOpenAiSize`）。 */
object ImageGenSizes {

    /** DALL-E 3 仅接受这三种尺寸；DALL-E 2 接受另外一组。 */
    val DALLE3_SIZES = listOf("1024x1024", "1792x1024", "1024x1792")
    val DALLE2_SIZES = listOf("256x256", "512x512", "1024x1024")

    /** 解析尺寸字符串 `512x512`（也接受全角 `×`）→ (width, height)；非法时回退 512x512。 */
    fun parseSize(size: String): Pair<Int, Int> {
        val match = Regex("^(\\d+)\\s*[x×]\\s*(\\d+)$", RegexOption.IGNORE_CASE).find(size.trim())
        return if (match != null) {
            val (w, h) = match.destructured
            (w.toInt()) to (h.toInt())
        } else {
            512 to 512
        }
    }

    /**
     * 把任意尺寸字符串归一化为该模型可接受的合法尺寸。
     *
     * 调用方使用竖版等非标准尺寸（如角色封面 3:4），直接透传会被 DALL-E 拒绝（400）。
     * 这里按宽高取向映射到最接近的合法值，保留竖/横意图而非一律退化为正方形。
     */
    fun normalizeOpenAiSize(raw: String, model: String): String {
        val allowed = if (Regex("dall-e-2", RegexOption.IGNORE_CASE).containsMatchIn(model)) {
            DALLE2_SIZES
        } else {
            DALLE3_SIZES
        }
        val size = raw.trim()
        if (size in allowed) return size

        val (width, height) = parseSize(size)
        return if (Regex("dall-e-2", RegexOption.IGNORE_CASE).containsMatchIn(model)) {
            // DALL-E 2 只有正方形规格，非正方形一律取中间档位。
            if (width == height && "${width}x${height}" in DALLE2_SIZES) "${width}x${height}" else "512x512"
        } else {
            when {
                height > width -> "1024x1792"
                width > height -> "1792x1024"
                else -> "1024x1024"
            }
        }
    }
}
