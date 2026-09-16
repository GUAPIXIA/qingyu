package com.qingyu.companion.network.models

/**
 * Anthropic Messages / Gemini / Ollama 适配器（阶段 3 请求构造与 SSE 解析）。
 * HTTP 执行层由后续 OkHttp 接线；此处冻结请求形状与解析，便于 MockWebServer 扩展。
 */
class AnthropicAdapter(
    private val allowHttp: Boolean = false,
) : ModelAdapter {
    override val provider: ModelProvider = ModelProvider.Anthropic

    override fun buildChatRequest(request: ModelChatRequest): BuiltHttpRequest {
        throw IllegalStateException("use buildChatRequest(profile, request)")
    }

    fun buildChatRequest(profile: ConnectionProfilePublic, request: ModelChatRequest): BuiltHttpRequest {
        val base = requireSafeBaseUrl(profile.baseUrl, allowHttp)
        val url = joinUrl(base, "v1/messages")
        val system = request.messages.filter { it.role == "system" }.joinToString("\n") { it.content }
        val messages = request.messages.filter { it.role != "system" }
            .joinToString(",") { m ->
                val c = m.content.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")
                """{"role":"${m.role}","content":"$c"}"""
            }
        val sb = StringBuilder()
        sb.append("{\"model\":\"").append(request.model.ifBlank { profile.model }).append("\",")
        if (system.isNotEmpty()) {
            val s = system.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")
            sb.append("\"system\":\"").append(s).append("\",")
        }
        sb.append("\"messages\":[").append(messages).append("]")
        request.maxTokens?.let { sb.append(",\"max_tokens\":").append(it) }
        sb.append(",\"stream\":").append(request.stream)
        sb.append("}")
        return BuiltHttpRequest(
            method = "POST",
            url = url,
            headers = mapOf("Content-Type" to "application/json", "anthropic-version" to "2023-06-01"),
            body = sb.toString(),
        )
    }

    override fun parseSseLine(line: String): ModelStreamEvent? {
        val raw = line.trim()
        if (!raw.startsWith("data:")) return null
        val payload = raw.removePrefix("data:").trim()
        if (payload.isEmpty()) return null
        if (payload.contains("\"type\":\"message_stop\"")) {
            return ModelStreamEvent.Completed(finishReason = "stop", usage = null)
        }
        val text = extractJsonString(payload, "text")
        val type = extractJsonString(payload, "type")
        return when {
            type == "content_block_delta" && !text.isNullOrEmpty() ->
                ModelStreamEvent.Chunk(ModelChunk(deltaText = text))
            type == "error" -> ModelStreamEvent.Failure(
                ModelError(code = "ANTHROPIC_ERROR", message = text ?: "stream error", retryable = false),
            )
            else -> null
        }
    }
}

class GeminiAdapter(
    private val allowHttp: Boolean = false,
) : ModelAdapter {
    override val provider: ModelProvider = ModelProvider.Gemini

    override fun buildChatRequest(request: ModelChatRequest): BuiltHttpRequest {
        throw IllegalStateException("use buildChatRequest(profile, request)")
    }

    fun buildChatRequest(profile: ConnectionProfilePublic, request: ModelChatRequest): BuiltHttpRequest {
        val base = requireSafeBaseUrl(profile.baseUrl, allowHttp)
        val model = request.model.ifBlank { profile.model }
        val url = joinUrl(base, "v1beta/models/${model}:streamGenerateContent?alt=sse")
        val contents = request.messages.filter { it.role != "system" }.joinToString(",") { m ->
            val c = m.content.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")
            """{"role":"${if (m.role == "assistant") "model" else "user"}","parts":[{"text":"$c"}]}"""
        }
        return BuiltHttpRequest(
            method = "POST",
            url = url,
            headers = mapOf("Content-Type" to "application/json"),
            body = """{"contents":[$contents],"generationConfig":{"stream":true}}""",
        )
    }

    override fun parseSseLine(line: String): ModelStreamEvent? {
        val raw = line.trim()
        if (!raw.startsWith("data:")) return null
        val payload = raw.removePrefix("data:").trim()
        if (payload.isEmpty()) return null
        val text = extractJsonString(payload, "text")
        return if (!text.isNullOrEmpty()) {
            ModelStreamEvent.Chunk(ModelChunk(deltaText = text))
        } else {
            null
        }
    }
}

class OllamaAdapter(
    private val allowHttp: Boolean = true,
) : ModelAdapter {
    override val provider: ModelProvider = ModelProvider.Ollama

    override fun buildChatRequest(request: ModelChatRequest): BuiltHttpRequest {
        throw IllegalStateException("use buildChatRequest(profile, request)")
    }

    fun buildChatRequest(profile: ConnectionProfilePublic, request: ModelChatRequest): BuiltHttpRequest {
        val base = requireSafeBaseUrl(profile.baseUrl, allowHttp)
        val url = joinUrl(base, "api/chat")
        val messages = request.messages.joinToString(",") { m ->
            val c = m.content.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")
            """{"role":"${m.role}","content":"$c"}"""
        }
        return BuiltHttpRequest(
            method = "POST",
            url = url,
            headers = mapOf("Content-Type" to "application/json"),
            body = """{"model":"${request.model.ifBlank { profile.model }}","messages":[$messages],"stream":true}""",
        )
    }

    override fun parseSseLine(line: String): ModelStreamEvent? {
        val raw = line.trim()
        if (raw.isEmpty()) return null
        // Ollama NDJSON：整行 JSON
        val content = extractJsonString(raw, "content")
        val done = raw.contains("\"done\":true")
        return when {
            done -> ModelStreamEvent.Chunk(
                ModelChunk(deltaText = content.orEmpty(), finished = true, finishReason = "stop"),
            )
            !content.isNullOrEmpty() -> ModelStreamEvent.Chunk(ModelChunk(deltaText = content))
            else -> null
        }
    }
}
