package com.qingyu.companion.network.models

/**
 * 阶段 3 模型适配器统一契约（生产路径后续接 OkHttp）。
 */
enum class ModelProvider {
    OpenAI,
    Anthropic,
    Gemini,
    Ollama,
}

data class ChatMessageDto(
    val role: String,
    val content: String,
)

data class ModelChatRequest(
    val model: String,
    val messages: List<ChatMessageDto>,
    val temperature: Double? = null,
    val maxTokens: Int? = null,
    val stream: Boolean = true,
)

data class ModelChunk(
    val deltaText: String,
    val finished: Boolean = false,
    val finishReason: String? = null,
    val promptTokens: Int? = null,
    val completionTokens: Int? = null,
)

data class ModelError(
    val code: String,
    val message: String,
    val retryable: Boolean,
    val httpStatus: Int? = null,
)

sealed class ModelStreamEvent {
    data class Chunk(val value: ModelChunk) : ModelStreamEvent()
    data class Failure(val error: ModelError) : ModelStreamEvent()
    data class Completed(val finishReason: String, val usage: Pair<Int?, Int?>?) : ModelStreamEvent()
}

interface ModelAdapter {
    val provider: ModelProvider

    /** 连接测试与真实生成共用同一路径构造与认证头 */
    fun buildChatRequest(request: ModelChatRequest): BuiltHttpRequest

    fun parseSseLine(line: String): ModelStreamEvent?
}

data class BuiltHttpRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String>,
    val body: String,
)

/** HTTPS 默认；用户显式允许后才可 http（LAN Ollama）。 */
fun requireSafeBaseUrl(url: String, allowHttp: Boolean): String {
    val trimmed = url.trim().trimEnd('/')
    val lower = trimmed.lowercase()
    if (lower.startsWith("https://")) return trimmed
    if (lower.startsWith("http://")) {
        if (allowHttp) return trimmed
        throw IllegalArgumentException("默认仅允许 HTTPS（可显式启用 HTTP 以访问 Ollama）")
    }
    throw IllegalArgumentException("非法 base URL")
}

/** 规范化 base + path，避免重复斜杠 */
fun joinUrl(base: String, path: String): String {
    val b = base.trimEnd('/')
    val p = if (path.startsWith("/")) path else "/$path"
    return b + p
}

class OpenAiCompatibleAdapter(
    private val allowHttp: Boolean = false,
) : ModelAdapter {
    override val provider: ModelProvider = ModelProvider.OpenAI

    override fun buildChatRequest(request: ModelChatRequest): BuiltHttpRequest {
        // baseUrl 由调用方注入到 request 扩展字段；此处用环境约定：model 字段不承载 URL
        // 实际 profile.baseUrl 通过 ChatRequestProfile 传入
        throw IllegalStateException("use buildChatRequest(profile, request)")
    }

    fun buildChatRequest(profile: ConnectionProfilePublic, request: ModelChatRequest): BuiltHttpRequest {
        val base = requireSafeBaseUrl(profile.baseUrl, allowHttp)
        val url = joinUrl(base, "chat/completions")
        val body = buildChatRequestBody(request.model.ifBlank { profile.model }, request)
        return BuiltHttpRequest(
            method = "POST",
            url = url,
            headers = mapOf(
                "Content-Type" to "application/json",
                // API Key 由 OkHttp 拦截器追加，不进入 BuiltHttpRequest 便于脱敏日志
            ),
            body = body,
        )
    }

    companion object {
        fun buildChatRequestBody(model: String, request: ModelChatRequest): String {
            val msgs = request.messages.joinToString(",") { m ->
                val content = m.content
                    .replace("\\", "\\\\")
                    .replace("\"", "\\\"")
                    .replace("\n", "\\n")
                    .replace("\r", "\\r")
                    .replace("\t", "\\t")
                """{"role":"${m.role}","content":"$content"}"""
            }
            val sb = StringBuilder()
            sb.append("{\"model\":\"").append(model).append("\",")
            sb.append("\"messages\":[").append(msgs).append("]")
            request.temperature?.let { sb.append(",\"temperature\":").append(it) }
            request.maxTokens?.let { sb.append(",\"max_tokens\":").append(it) }
            sb.append(",\"stream\":").append(request.stream)
            sb.append("}")
            return sb.toString()
        }
    }

    override fun parseSseLine(line: String): ModelStreamEvent? {
        val raw = line.trim()
        if (!raw.startsWith("data:")) return null
        val payload = raw.removePrefix("data:").trim()
        if (payload.isEmpty() || payload == "[DONE]") {
            return ModelStreamEvent.Completed(finishReason = "stop", usage = null)
        }
        return try {
            // 轻量解析：提取 content 与 finish_reason
            val content = extractJsonString(payload, "content")
            val finish = extractJsonString(payload, "finish_reason")
            when {
                finish != null && finish.isNotEmpty() && finish != "null" ->
                    ModelStreamEvent.Chunk(ModelChunk(deltaText = content.orEmpty(), finished = true, finishReason = finish))
                !content.isNullOrEmpty() ->
                    ModelStreamEvent.Chunk(ModelChunk(deltaText = content))
                payload.contains("\"choices\"") -> null
                else -> ModelStreamEvent.Failure(
                    ModelError(code = "MALFORMED_JSON", message = "无法解析 SSE payload", retryable = false),
                )
            }
        } catch (_: Exception) {
            ModelStreamEvent.Failure(
                ModelError(code = "MALFORMED_JSON", message = "无法解析 SSE payload", retryable = false),
            )
        }
    }
}

internal fun extractJsonString(json: String, key: String): String? {
    val marker = "\"$key\":\""
    val idx = json.indexOf(marker)
    if (idx < 0) {
        val nullMarker = "\"$key\":null"
        return if (json.contains(nullMarker)) null else null
    }
    val start = idx + marker.length
    val sb = StringBuilder()
    var i = start
    while (i < json.length) {
        val c = json[i]
        if (c == '\\' && i + 1 < json.length) {
            when (json[i + 1]) {
                'n' -> sb.append('\n')
                'r' -> sb.append('\r')
                't' -> sb.append('\t')
                '"' -> sb.append('"')
                '\\' -> sb.append('\\')
                else -> sb.append(json[i + 1])
            }
            i += 2
            continue
        }
        if (c == '"') return sb.toString()
        sb.append(c)
        i += 1
    }
    return sb.toString()
}

data class ConnectionProfilePublic(
    val id: String,
    val provider: ModelProvider,
    val baseUrl: String,
    val model: String,
)
