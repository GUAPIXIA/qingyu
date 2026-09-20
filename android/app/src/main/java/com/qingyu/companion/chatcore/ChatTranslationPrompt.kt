package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-04：消息翻译的系统提示词
 * （对齐 `shared/translationPrompt.ts`，PC 单聊与群聊桥接共用同一份）。
 *
 * 提示词文本本身就是契约：两端不一致会让同一段对话在 PC 与 Android 上
 * 得到不同的译文风格。因此这里逐字对齐，并由 fixture 锁定。
 */
object ChatTranslationPrompt {

    /** 默认目标语言（与 PC `settings.translationTargetLang || '中文'` 一致）。 */
    const val DEFAULT_TARGET_LANG = "中文"

    /** 翻译请求的采样参数（与 PC 一致：低温、非确定性受控）。 */
    const val TEMPERATURE = 0.3
    const val TOP_P = 0.9

    /**
     * 系统提示词——**纯插值**，与 PC 的 `buildMessageTranslationSystemPrompt` 逐字一致。
     *
     * 刻意不在这里做空值兜底：PC 对空目标语言就是直接插值（产出「翻译成。」）。
     * 兜底属于调用方的 `resolveTargetLang`，放在这里会让两端的提示词文本产生分歧。
     */
    fun buildMessageTranslationSystemPrompt(targetLang: String): String =
        "你是一个翻译助手。请将以下文本翻译成$targetLang。只输出翻译结果，不要添加任何解释或额外内容。" +
            "保留原文中的 Markdown 格式、HTML 标签和特殊符号不变。"

    /**
     * 解析目标语言——逐字对齐 PC 的 `settings.translationTargetLang || '中文'`。
     *
     * **只在空串时回退**：JS 的 `||` 把空白串视为真值，因此 `"   "` 会被原样使用
     * （产出「翻译成   。」）。用 `isBlank()` 会更「合理」，但那样两端在某些配置下
     * 会给出不同的提示词，而提示词差异会直接变成译文差异。
     */
    fun resolveTargetLang(configured: String?): String =
        configured?.takeIf { it.isNotEmpty() } ?: DEFAULT_TARGET_LANG

    /**
     * 清理模型可能附带的外壳：翻译提示要求「只输出译文」，
     * 但模型偶尔仍会包一层代码块或引号。仅去掉**包裹整体**的那一层，不动正文内部。
     */
    fun stripTranslationWrapper(text: String): String {
        var trimmed = text.trim()
        if (trimmed.length >= 6 && trimmed.startsWith("```") && trimmed.endsWith("```")) {
            val inner = trimmed.removePrefix("```").removeSuffix("```")
            // 去掉可能的语言标注行（```markdown\n...）
            val firstNewline = inner.indexOf('\n')
            trimmed = if (firstNewline >= 0 && !inner.substring(0, firstNewline).contains(' ')) {
                inner.substring(firstNewline + 1)
            } else {
                inner
            }.trim()
        }
        if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
            trimmed = trimmed.substring(1, trimmed.length - 1).trim()
        }
        return trimmed
    }
}
