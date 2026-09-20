package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-01：Prompt 格式转换器（对齐 `shared/chat-core/promptConverters.ts`）。
 *
 * - OpenAI：原样返回
 * - Claude：system 合并提取到最前；连续同角色合并；末条为 assistant 时补 `[Continue]` user
 * - Gemini：system 合并提取到最前；连续同角色合并
 */
object ChatPromptConverters {

    /**
     * 统一消息模型（对应 TS 的 `ChatMessage`）。
     * `keepSeparate` 供后处理跳过合并；`images` 供 vision 模型识别。
     */
    data class ChatMessage(
        val role: String,
        val content: String,
        val images: List<String>? = null,
        val keepSeparate: Boolean = false,
    )

    data class PromptNames(val charName: String, val userName: String)

    fun convertToOpenAI(messages: List<ChatMessage>): List<ChatMessage> = messages

    /** Claude：system 合并到最前；其余按角色交替合并；末尾 assistant 补 `[Continue]`。 */
    fun convertToClaude(messages: List<ChatMessage>, names: PromptNames = PromptNames("", "")): List<ChatMessage> {
        if (messages.isEmpty()) return emptyList()
        val result = mutableListOf<ChatMessage>()

        val systemContent = messages.filter { it.role == "system" }
            .joinToString("\n\n") { it.content }
        if (systemContent.isNotEmpty()) {
            result += ChatMessage("system", systemContent)
        }

        var lastRole: String? = null
        for (msg in messages) {
            if (msg.role == "system") continue
            if (msg.role == lastRole) {
                val last = result.last()
                result[result.lastIndex] = last.copy(
                    content = last.content + "\n\n" + msg.content,
                    images = mergeImages(last.images, msg.images),
                )
            } else {
                result += msg
                lastRole = msg.role
            }
        }

        if (result.isNotEmpty() && result.last().role == "assistant") {
            result += ChatMessage("user", "[Continue]")
        }
        return result
    }

    /** Gemini：system 合并到最前；其余连续同角色合并。 */
    fun convertToGemini(messages: List<ChatMessage>): List<ChatMessage> {
        if (messages.isEmpty()) return emptyList()
        val result = mutableListOf<ChatMessage>()

        val systemContent = messages.filter { it.role == "system" }
            .joinToString("\n\n") { it.content }
        if (systemContent.isNotEmpty()) {
            result += ChatMessage("system", systemContent)
        }

        var lastRole: String? = null
        for (msg in messages) {
            if (msg.role == "system") continue
            if (msg.role == lastRole) {
                val last = result.last()
                result[result.lastIndex] = last.copy(
                    content = last.content + "\n\n" + msg.content,
                    images = mergeImages(last.images, msg.images),
                )
            } else {
                result += msg
                lastRole = msg.role
            }
        }
        return result
    }

    /** 按 provider 名分发（大小写不敏感，包含匹配）。 */
    fun convertMessages(
        provider: String,
        messages: List<ChatMessage>,
        names: PromptNames = PromptNames("", ""),
    ): List<ChatMessage> {
        val lower = provider.lowercase()
        if (lower.contains("claude")) return convertToClaude(messages, names)
        if (lower.contains("gemini")) return convertToGemini(messages)
        return convertToOpenAI(messages)
    }

    /** 续写模式：末条非 assistant 时追加一条 assistant（内容为 prefix 或空）。 */
    fun addAssistantPrefix(messages: List<ChatMessage>, prefix: String? = null): List<ChatMessage> {
        if (messages.isEmpty()) return messages
        if (messages.last().role == "assistant") return messages
        return messages + ChatMessage("assistant", prefix ?: "")
    }

    private fun mergeImages(base: List<String>?, extra: List<String>?): List<String>? {
        if (extra.isNullOrEmpty()) return base
        return (base ?: emptyList()) + extra
    }
}
