package com.qingyu.companion.chatcore

import org.json.JSONObject

/**
 * 阶段 4 S4-04：会话级预设 → 装配器输入。
 *
 * 本地预设内容存在 `local_presets.body_json`（受控 JSON），而**它的完整字段 schema
 * 属于阶段 5 §S5-03**（System Prompt、温度、topP、maxTokens、stop、生成规划字段…）。
 * 因此这里只取装配器当前确实会消费的那几个字段，并且：
 * - **缺失即取默认值**，不把「预设还没写全」当成错误；
 * - **未知字段一律忽略**（S5-03 落地前，body 里可能有任何东西）；
 * - 解析失败不至于让整轮生成失败——退化为「没有预设」，并保留其余上下文。
 *
 * 存在的意义：此前本地生成路径**从未把会话预设传给装配器**
 * （`LocalChatGenerationUseCase` 里没有任何 `preset`），用户设置了预设却毫无效果，
 * 且不报任何错。这是「功能在、接线不在」的又一例。
 */
object ChatPresetCompile {

    fun parse(bodyJson: String?): ChatContextBuilder.PresetSnapshot {
        val id = ""
        if (bodyJson.isNullOrBlank()) return ChatContextBuilder.PresetSnapshot(id = id)
        val body = runCatching { JSONObject(bodyJson) }.getOrNull()
            ?: return ChatContextBuilder.PresetSnapshot(id = id)

        fun stringOf(vararg keys: String): String {
            for (key in keys) {
                val value = body.optString(key)
                if (value.isNotEmpty()) return value
            }
            return ""
        }

        fun intOf(vararg keys: String): Int {
            for (key in keys) {
                if (body.has(key)) {
                    val value = body.optInt(key, 0)
                    if (value > 0) return value
                }
            }
            return 0
        }

        return ChatContextBuilder.PresetSnapshot(
            id = id,
            systemPrompt = stringOf("systemPrompt", "system_prompt", "mainPrompt", "main_prompt"),
            jailbreak = stringOf("jailbreak", "postHistoryInstructions", "post_history_instructions"),
            maxContext = intOf("maxContext", "max_context"),
            maxTokens = intOf("maxTokens", "max_tokens"),
            responseLengthHint = stringOf("responseLengthHint", "response_length_hint").takeIf { it.isNotEmpty() },
            contextTemplate = stringOf("contextTemplate", "context_template").takeIf { it.isNotEmpty() },
            exampleDialogMode = stringOf("exampleDialogMode", "example_dialog_mode").takeIf { it.isNotEmpty() },
            enableThoughtFormat = if (body.has("enableThoughtFormat")) {
                body.optBoolean("enableThoughtFormat")
            } else if (body.has("enable_thought_format")) {
                body.optBoolean("enable_thought_format")
            } else {
                null
            },
        )
    }

    /** 预设 id 需要回填到快照（供诊断/去重识别本轮用了哪个预设）。 */
    fun parse(bodyJson: String?, presetId: String): ChatContextBuilder.PresetSnapshot =
        parse(bodyJson).copy(id = presetId)
}
