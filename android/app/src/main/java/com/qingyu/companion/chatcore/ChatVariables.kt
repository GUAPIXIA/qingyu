package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-01：变量替换与显示名（对齐 `shared/chat-core/variables.ts`）。
 *
 * 行为由 `ChatCoreGoldenTest` 对 `shared/fixtures/cross-platform/chat-core/variables.json` 校验。
 */
object ChatVariables {

    private val USER = Regex("\\{\\{user\\}\\}", RegexOption.IGNORE_CASE)
    private val CHAR = Regex("\\{\\{char\\}\\}", RegexOption.IGNORE_CASE)
    private val ORIGINAL = Regex("\\{\\{original\\}\\}", RegexOption.IGNORE_CASE)

    /**
     * 将 `{{user}}` / `{{char}}` / `{{original}}` 替换为对应名字（大小写不敏感）。
     *
     * 与 TS 一致：
     * - 空文本原样返回；
     * - `userName` / `charName` 为 null 时按空串处理（PC 端 BUG-26：不输出字面量 "undefined"）；
     * - `originalCharName` 缺省时回退为 `charName`；
     * - 不支持嵌套（`{{{{user}}}}` 只替换内层）。
     */
    fun replaceVariables(
        text: String,
        userName: String?,
        charName: String?,
        originalCharName: String? = null,
    ): String {
        if (text.isEmpty()) return text
        val user = userName ?: ""
        val char = charName ?: ""
        val original = originalCharName ?: char
        var result = JsRegex.jsReplace(text, USER, user, global = true).first
        result = JsRegex.jsReplace(result, CHAR, char, global = true).first
        result = JsRegex.jsReplace(result, ORIGINAL, original, global = true).first
        return result
    }

    /**
     * 角色显示名：有翻译且与原名不同时显示「中文名 (原名)」，否则只显示原名。
     * 无角色返回空串。
     */
    fun getDisplayName(name: String?, translatedName: String?): String {
        if (name == null) return ""
        if (!translatedName.isNullOrEmpty() && translatedName != name) {
            return "$translatedName ($name)"
        }
        return name
    }
}
