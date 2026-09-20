package com.qingyu.companion.network.models

/**
 * 阶段 3 S3-05：模型适配器统一契约。
 *
 * 设计约束：
 * - **连接测试与真实生成使用同一 adapter 与同一认证头构造**（阶段 3 §2 S3-05），
 *   因此认证头由 adapter 从 `apiKey` 派生，执行层不额外注入。
 * - 统一返回 chunk、结构化完成原因、用量、供应商错误、可取消句柄和能力探测结果。
 * - provider 的 base URL / path / SSE 形状差异全部收敛在 adapter 内。
 */
enum class ModelProvider(val wire: String) {
    OpenAI("openai"),
    Anthropic("anthropic"),
    Gemini("gemini"),
    Ollama("ollama"),
    ;

    companion object {
        fun fromWire(value: String): ModelProvider? = entries.firstOrNull { it.wire == value.lowercase() }
    }
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
    val system: String? = null,
)

data class ModelChunk(
    val deltaText: String,
    val finished: Boolean = false,
    val finishReason: String? = null,
    val promptTokens: Int? = null,
    val completionTokens: Int? = null,
)

/**
 * 供应商错误分类（重试策略的唯一依据）。
 * - `retryable = true`：限流、5xx、连接/读超时、瞬时 IO；
 * - `retryable = false`：鉴权、配额耗尽、请求非法、模型不存在、订阅/权限、畸形响应。
 */
data class ModelError(
    val code: String,
    val message: String,
    val retryable: Boolean,
    val httpStatus: Int? = null,
) {
    fun toUserMessage(): String = when (code) {
        "HTTP_401", "HTTP_403" -> "认证失败：请检查 API Key 是否有效"
        "HTTP_429" -> "请求过于频繁或额度已用完，请稍后重试"
        "HTTP_404" -> "模型或接口不存在：请检查模型名与 base URL"
        "TIMEOUT" -> "请求超时，请检查网络后重试"
        "CANCELLED" -> "已取消"
        "MALFORMED_JSON" -> "供应商返回了无法解析的响应"
        else -> message
    }

    override fun toString(): String = "ModelError(code=$code, retryable=$retryable, httpStatus=$httpStatus)"
}

sealed class ModelStreamEvent {
    data class Chunk(val value: ModelChunk) : ModelStreamEvent()
    data class Failure(val error: ModelError) : ModelStreamEvent()
    data class Completed(val finishReason: String, val usage: Pair<Int?, Int?>?) : ModelStreamEvent()
}

data class BuiltHttpRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String>,
    val body: String,
)

/** 能力探测结果：连接测试产出，不阻断生成（失败只降级提示）。 */
data class ModelCapabilities(
    val supportsStreaming: Boolean = true,
    val supportsUsage: Boolean = true,
    val supportsSystemPrompt: Boolean = true,
    val notes: List<String> = emptyList(),
)

interface ModelAdapter {
    val provider: ModelProvider

    /** 由已保存的 public profile + 解密后的 secret 构造请求（含认证头）。 */
    fun buildChatRequest(
        profile: ConnectionProfilePublic,
        request: ModelChatRequest,
        apiKey: String?,
    ): BuiltHttpRequest

    /** 单行流式解析（SSE `data:` 行或 Ollama NDJSON 行）。 */
    fun parseSseLine(line: String): ModelStreamEvent?

    /** 非流式响应体解析（连接测试与 stream=false 使用）。 */
    fun parseNonStreamingBody(body: String): ModelStreamEvent

    /** 能力探测（默认基于 provider 静态能力；失败不阻断）。 */
    fun capabilities(): ModelCapabilities = ModelCapabilities()
}

/**
 * HTTPS 默认；用户显式允许后才可 http（LAN Ollama / 内网网关）。
 *
 * 规范化与加固（阶段 3 §2 S3-05「base URL 做 scheme/host/路径规范化，
 * 防止凭据发送到重定向后的非预期主机」）：
 * - 只接受 `scheme://host[:port][/path]` 形状，**显式拒绝 userinfo**（`https://user:pass@host`）；
 *   userinfo 是经典的凭据夹带手法，一旦拼进 URL 就可能被转发到第三方；
 * - 拒绝 query/fragment（模型端点的路径必须由适配器决定）；
 * - host 必须是合法域名/IPv4/IPv6 字面量，端口必须是 1—65535 的十进制；
 * - 路径部分不得包含 `..`（避免路径穿越到同主机其他端点）。
 */
fun requireSafeBaseUrl(url: String, allowHttp: Boolean): String {
    val trimmed = url.trim().trimEnd('/')
    if (trimmed.isEmpty()) throw IllegalArgumentException("base URL 不能为空")

    val schemeEnd = trimmed.indexOf("://")
    if (schemeEnd <= 0) throw IllegalArgumentException("非法 base URL：缺少 scheme")
    val scheme = trimmed.substring(0, schemeEnd).lowercase()
    if (scheme != "https" && scheme != "http") {
        throw IllegalArgumentException("非法 base URL：仅支持 https:// 与 http://")
    }
    if (scheme == "http" && !allowHttp) {
        throw IllegalArgumentException("默认仅允许 HTTPS；如需访问 Ollama/内网网关请在该连接档案中显式启用 HTTP")
    }

    val authorityAndPath = trimmed.substring(schemeEnd + 3)
    if (authorityAndPath.isEmpty()) throw IllegalArgumentException("非法 base URL：缺少主机")

    val pathStart = authorityAndPath.indexOf('/')
    val authority = if (pathStart < 0) authorityAndPath else authorityAndPath.substring(0, pathStart)
    val path = if (pathStart < 0) "" else authorityAndPath.substring(pathStart)

    if (authority.isEmpty()) throw IllegalArgumentException("非法 base URL：缺少主机")
    if (authority.contains('@')) {
        throw IllegalArgumentException("base URL 不允许包含用户名/密码（userinfo），请把凭据配置在 API Key 中")
    }
    if (authority.contains('?') || authority.contains('#') || path.contains('?') || path.contains('#')) {
        throw IllegalArgumentException("base URL 不允许包含 query 或 fragment")
    }
    if (path.split('/').any { it == ".." }) {
        throw IllegalArgumentException("base URL 路径不允许包含 ..")
    }

    validateHost(authority)
    return trimmed
}

private val HOST_LABEL = Regex("^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")

private fun validateHost(authority: String) {
    val hostPart: String
    val portPart: String?
    if (authority.startsWith("[")) {
        // IPv6 字面量：[::1]:11434
        val close = authority.indexOf(']')
        if (close < 0) throw IllegalArgumentException("非法 base URL：IPv6 字面量未闭合")
        hostPart = authority.substring(1, close)
        val rest = authority.substring(close + 1)
        portPart = when {
            rest.isEmpty() -> null
            rest.startsWith(":") -> rest.substring(1)
            else -> throw IllegalArgumentException("非法 base URL：主机后出现无法识别的字符")
        }
        if (hostPart.isEmpty() || !hostPart.contains(':')) {
            throw IllegalArgumentException("非法 base URL：IPv6 字面量格式错误")
        }
    } else {
        val colonCount = authority.count { it == ':' }
        if (colonCount > 1) throw IllegalArgumentException("非法 base URL：IPv6 必须使用 [] 包裹")
        val parts = authority.split(':')
        hostPart = parts[0]
        portPart = parts.getOrNull(1)
        if (hostPart.isEmpty()) throw IllegalArgumentException("非法 base URL：缺少主机")
        val isIpv4 = hostPart.split('.').let { segs ->
            segs.size == 4 && segs.all { s -> s.isNotEmpty() && s.length <= 3 && s.all { it.isDigit() } && s.toInt() in 0..255 }
        }
        if (!isIpv4) {
            // 允许 localhost / 域名；其余必须逐标签合法
            if (hostPart != "localhost" && hostPart.split('.').any { it.isEmpty() || !HOST_LABEL.matches(it) }) {
                throw IllegalArgumentException("非法 base URL：主机名不合法（$hostPart）")
            }
        }
    }
    if (portPart != null) {
        val port = portPart.toIntOrNull()
        if (port == null || port !in 1..65535 || portPart.any { !it.isDigit() }) {
            throw IllegalArgumentException("非法 base URL：端口不合法（$portPart）")
        }
    }
}

/** 规范化 base + path，避免重复斜杠。 */
fun joinUrl(base: String, path: String): String {
    val b = base.trimEnd('/')
    val p = if (path.startsWith("/")) path else "/$path"
    return b + p
}

/** JSON 字符串转义（请求体构造共用）。 */
internal fun escapeJson(text: String): String = buildString(text.length + 8) {
    for (ch in text) {
        when (ch) {
            '\\' -> append("\\\\")
            '"' -> append("\\\"")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (ch.code < 0x20) append("\\u%04x".format(ch.code)) else append(ch)
        }
    }
}

/** 阶段 3 连接档案的 public 视图（设备本地，不进入同步 envelope）。 */
data class ConnectionProfilePublic(
    val id: String,
    val provider: ModelProvider,
    val baseUrl: String,
    val model: String,
    val allowHttp: Boolean = false,
)

/**
 * OpenAI 兼容 Chat Completions。
 *
 * 认证：`Authorization: Bearer <apiKey>`；未配置 apiKey 时不带该头
 * （本地 OpenAI 兼容网关常无需鉴权）。
 */
class OpenAiCompatibleAdapter(
    private val allowHttp: Boolean = false,
) : ModelAdapter {
    override val provider: ModelProvider = ModelProvider.OpenAI

    override fun buildChatRequest(
        profile: ConnectionProfilePublic,
        request: ModelChatRequest,
        apiKey: String?,
    ): BuiltHttpRequest {
        val base = requireSafeBaseUrl(profile.baseUrl, allowHttp || profile.allowHttp)
        val url = joinUrl(base, "chat/completions")
        val headers = mutableMapOf("Content-Type" to "application/json", "Accept" to "text/event-stream")
        if (!apiKey.isNullOrEmpty()) headers["Authorization"] = "Bearer $apiKey"
        return BuiltHttpRequest(
            method = "POST",
            url = url,
            headers = headers,
            body = buildChatRequestBody(request.model.ifBlank { profile.model }, request),
        )
    }

    override fun capabilities(): ModelCapabilities = ModelCapabilities()

    companion object {
        /** 仅供内部区分「无内容增量」与真正错误；不作为用户可见错误码。 */
        const val EMPTY_DELTA_CODE = "EMPTY_DELTA"

        fun buildChatRequestBody(model: String, request: ModelChatRequest): String {
            val messages = mutableListOf<String>()
            request.system?.takeIf { it.isNotEmpty() }?.let {
                messages += """{"role":"system","content":"${escapeJson(it)}"}"""
            }
            messages += request.messages.map { m ->
                """{"role":"${escapeJson(m.role)}","content":"${escapeJson(m.content)}"}"""
            }
            val sb = StringBuilder()
            sb.append("{\"model\":\"").append(escapeJson(model)).append("\",")
            sb.append("\"messages\":[").append(messages.joinToString(",")).append("]")
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
        if (payload.isEmpty()) return null
        if (payload == "[DONE]") return ModelStreamEvent.Completed(finishReason = "stop", usage = null)
        return runCatching { parseChatCompletionJson(payload) }.getOrElse {
            ModelStreamEvent.Failure(ModelError("MALFORMED_JSON", "无法解析 SSE payload", retryable = false))
        }.takeUnless { it is ModelStreamEvent.Failure && it.error.code == EMPTY_DELTA_CODE }
    }

    override fun parseNonStreamingBody(body: String): ModelStreamEvent =
        runCatching { parseChatCompletionJson(body.trim()) }.getOrElse {
            ModelStreamEvent.Failure(ModelError("MALFORMED_JSON", "无法解析响应体", retryable = false))
        }.let { event ->
            if (event is ModelStreamEvent.Failure && event.error.code == EMPTY_DELTA_CODE) {
                ModelStreamEvent.Failure(ModelError("EMPTY_RESPONSE", "供应商返回空内容", retryable = true))
            } else {
                event
            }
        }

    private fun parseChatCompletionJson(json: String): ModelStreamEvent {
        // {"error":{...}} 形态
        if (json.contains("\"error\"")) {
            val message = extractJsonString(json, "message") ?: json.take(200)
            return ModelStreamEvent.Failure(ModelError("PROVIDER_ERROR", message, retryable = false))
        }
        // 明显畸形（引号/括号不平衡、缺 choices 容器）必须报错，不能静默当成空增量
        if (!isStructurallyValid(json) || !json.contains("\"choices\"")) {
            return ModelStreamEvent.Failure(
                ModelError("MALFORMED_JSON", "无法解析 SSE payload", retryable = false),
            )
        }
        val finish = extractJsonString(json, "finish_reason")
        val content = extractJsonString(json, "content")
        val promptTokens = extractJsonInt(json, "prompt_tokens")
        val completionTokens = extractJsonInt(json, "completion_tokens")
        val reasoning = extractJsonString(json, "reasoning_content") ?: extractJsonString(json, "reasoning")
        val visible = content.orEmpty()
        if (finish != null) {
            return ModelStreamEvent.Chunk(
                ModelChunk(
                    deltaText = visible,
                    finished = true,
                    finishReason = finish,
                    promptTokens = promptTokens,
                    completionTokens = completionTokens,
                ),
            )
        }
        // reasoning/thought 单独通道：不混入正文（阶段 4 另行消费）
        if (visible.isEmpty() && !reasoning.isNullOrEmpty()) {
            return ModelStreamEvent.Chunk(
                ModelChunk(deltaText = "", promptTokens = promptTokens, completionTokens = completionTokens),
            )
        }
        if (visible.isEmpty() && promptTokens == null && completionTokens == null) {
            // SSE 分片里常见的「心跳/角色帧」：无正文也无用量，调用方应忽略
            return ModelStreamEvent.Failure(ModelError(EMPTY_DELTA_CODE, "无内容增量", retryable = true))
        }
        return ModelStreamEvent.Chunk(
            ModelChunk(deltaText = visible, promptTokens = promptTokens, completionTokens = completionTokens),
        )
    }
}

/** Anthropic Messages API。认证：`x-api-key` + `anthropic-version`。 */
class AnthropicAdapter(
    private val allowHttp: Boolean = false,
) : ModelAdapter {
    override val provider: ModelProvider = ModelProvider.Anthropic

    override fun buildChatRequest(
        profile: ConnectionProfilePublic,
        request: ModelChatRequest,
        apiKey: String?,
    ): BuiltHttpRequest {
        val base = requireSafeBaseUrl(profile.baseUrl, allowHttp || profile.allowHttp)
        val url = joinUrl(base, "v1/messages")
        val system = (request.system?.takeIf { it.isNotEmpty() }
            ?: request.messages.filter { it.role == "system" }.joinToString("\n") { it.content })
        val messages = request.messages.filter { it.role != "system" }.joinToString(",") { m ->
            """{"role":"${if (m.role == "assistant") "assistant" else "user"}","content":"${escapeJson(m.content)}"}"""
        }
        val sb = StringBuilder()
        sb.append("{\"model\":\"").append(escapeJson(request.model.ifBlank { profile.model })).append("\",")
        if (system.isNotEmpty()) sb.append("\"system\":\"").append(escapeJson(system)).append("\",")
        // Anthropic 要求 max_tokens 必填
        sb.append("\"max_tokens\":").append(request.maxTokens ?: DEFAULT_MAX_TOKENS)
        request.temperature?.let { sb.append(",\"temperature\":").append(it) }
        sb.append(",\"messages\":[").append(messages).append("]")
        sb.append(",\"stream\":").append(request.stream)
        sb.append("}")
        val headers = mutableMapOf(
            "Content-Type" to "application/json",
            "anthropic-version" to ANTHROPIC_VERSION,
        )
        if (!apiKey.isNullOrEmpty()) headers["x-api-key"] = apiKey
        return BuiltHttpRequest(method = "POST", url = url, headers = headers, body = sb.toString())
    }

    override fun capabilities(): ModelCapabilities =
        ModelCapabilities(notes = listOf("max_tokens 必填，未指定时使用 $DEFAULT_MAX_TOKENS"))

    override fun parseSseLine(line: String): ModelStreamEvent? {
        val raw = line.trim()
        if (!raw.startsWith("data:")) return null
        val payload = raw.removePrefix("data:").trim()
        if (payload.isEmpty()) return null
        val type = extractJsonString(payload, "type")
        return when (type) {
            "content_block_delta" -> extractJsonString(payload, "text")
                ?.takeIf { it.isNotEmpty() }
                ?.let { ModelStreamEvent.Chunk(ModelChunk(deltaText = it)) }
                ?: null
            "message_delta" -> {
                val stop = extractJsonString(payload, "stop_reason")
                val outputTokens = extractJsonInt(payload, "output_tokens")
                val inputTokens = extractJsonInt(payload, "input_tokens")
                ModelStreamEvent.Chunk(
                    ModelChunk(
                        deltaText = "",
                        finished = stop != null,
                        finishReason = stop,
                        promptTokens = inputTokens,
                        completionTokens = outputTokens,
                    ),
                )
            }
            "message_stop" -> ModelStreamEvent.Completed(finishReason = "stop", usage = null)
            "error" -> ModelStreamEvent.Failure(
                ModelError("ANTHROPIC_ERROR", extractJsonString(payload, "message") ?: "stream error", retryable = false),
            )
            else -> null
        }
    }

    override fun parseNonStreamingBody(body: String): ModelStreamEvent {
        val json = body.trim()
        if (json.contains("\"type\":\"error\"")) {
            return ModelStreamEvent.Failure(
                ModelError("ANTHROPIC_ERROR", extractJsonString(json, "message") ?: json.take(200), retryable = false),
            )
        }
        val text = extractJsonString(json, "text").orEmpty()
        val stop = extractJsonString(json, "stop_reason")
        val inputTokens = extractJsonInt(json, "input_tokens")
        val outputTokens = extractJsonInt(json, "output_tokens")
        return if (text.isEmpty() && stop == null) {
            ModelStreamEvent.Failure(ModelError("EMPTY_RESPONSE", "供应商返回空内容", retryable = true))
        } else {
            ModelStreamEvent.Chunk(
                ModelChunk(
                    deltaText = text,
                    finished = true,
                    finishReason = stop ?: "stop",
                    promptTokens = inputTokens,
                    completionTokens = outputTokens,
                ),
            )
        }
    }

    private companion object {
        const val ANTHROPIC_VERSION = "2023-06-01"
        const val DEFAULT_MAX_TOKENS = 4096
    }
}

/** Gemini `generateContent` / `streamGenerateContent`。认证：`x-goog-api-key`（不回显在 URL）。 */
class GeminiAdapter(
    private val allowHttp: Boolean = false,
) : ModelAdapter {
    override val provider: ModelProvider = ModelProvider.Gemini

    override fun buildChatRequest(
        profile: ConnectionProfilePublic,
        request: ModelChatRequest,
        apiKey: String?,
    ): BuiltHttpRequest {
        val base = requireSafeBaseUrl(profile.baseUrl, allowHttp || profile.allowHttp)
        val model = request.model.ifBlank { profile.model }
        val verb = if (request.stream) ":streamGenerateContent?alt=sse" else ":generateContent"
        val url = joinUrl(base, "v1beta/models/$model$verb")
        val system = request.system?.takeIf { it.isNotEmpty() }
            ?: request.messages.filter { it.role == "system" }.joinToString("\n") { it.content }.takeIf { it.isNotEmpty() }
        val contents = request.messages.filter { it.role != "system" }.joinToString(",") { m ->
            """{"role":"${if (m.role == "assistant") "model" else "user"}","parts":[{"text":"${escapeJson(m.content)}"}]}"""
        }
        val sb = StringBuilder()
        sb.append("{\"contents\":[").append(contents).append("]")
        if (system != null) {
            sb.append(",\"systemInstruction\":{\"parts\":[{\"text\":\"").append(escapeJson(system)).append("\"}]}")
        }
        sb.append(",\"generationConfig\":{")
        val config = mutableListOf<String>()
        request.temperature?.let { config += "\"temperature\":$it" }
        request.maxTokens?.let { config += "\"maxOutputTokens\":$it" }
        sb.append(config.joinToString(",")).append("}}")
        val headers = mutableMapOf("Content-Type" to "application/json")
        if (!apiKey.isNullOrEmpty()) headers["x-goog-api-key"] = apiKey
        return BuiltHttpRequest(method = "POST", url = url, headers = headers, body = sb.toString())
    }

    override fun capabilities(): ModelCapabilities =
        ModelCapabilities(notes = listOf("usage 仅在最终 chunk 的 usageMetadata 中给出"))

    override fun parseSseLine(line: String): ModelStreamEvent? {
        val raw = line.trim()
        if (!raw.startsWith("data:")) return null
        val payload = raw.removePrefix("data:").trim()
        if (payload.isEmpty()) return null
        return parseGeminiPayload(payload)
    }

    override fun parseNonStreamingBody(body: String): ModelStreamEvent =
        parseGeminiPayload(body.trim())
            ?: ModelStreamEvent.Failure(ModelError("EMPTY_RESPONSE", "供应商返回空内容", retryable = true))

    private fun parseGeminiPayload(json: String): ModelStreamEvent? {
        if (json.contains("\"error\"")) {
            return ModelStreamEvent.Failure(
                ModelError("GEMINI_ERROR", extractJsonString(json, "message") ?: json.take(200), retryable = false),
            )
        }
        val text = extractJsonString(json, "text").orEmpty()
        val finish = extractJsonString(json, "finishReason")
        val promptTokens = extractJsonInt(json, "promptTokenCount")
        val completionTokens = extractJsonInt(json, "candidatesTokenCount")
        val blocked = json.contains("\"blockReason\"")
        return when {
            blocked -> ModelStreamEvent.Failure(
                ModelError("CONTENT_BLOCKED", "内容被供应商安全策略拦截", retryable = false),
            )
            finish != null -> ModelStreamEvent.Chunk(
                ModelChunk(
                    deltaText = text,
                    finished = true,
                    finishReason = finish,
                    promptTokens = promptTokens,
                    completionTokens = completionTokens,
                ),
            )
            text.isNotEmpty() -> ModelStreamEvent.Chunk(ModelChunk(deltaText = text))
            else -> null
        }
    }
}

/** Ollama `/api/chat`（NDJSON 流）。默认允许 http（本地/内网）。 */
class OllamaAdapter(
    private val allowHttp: Boolean = true,
) : ModelAdapter {
    override val provider: ModelProvider = ModelProvider.Ollama

    override fun buildChatRequest(
        profile: ConnectionProfilePublic,
        request: ModelChatRequest,
        apiKey: String?,
    ): BuiltHttpRequest {
        val base = requireSafeBaseUrl(profile.baseUrl, allowHttp || profile.allowHttp)
        val url = joinUrl(base, "api/chat")
        val messages = mutableListOf<String>()
        request.system?.takeIf { it.isNotEmpty() }?.let {
            messages += """{"role":"system","content":"${escapeJson(it)}"}"""
        }
        messages += request.messages.map { m ->
            """{"role":"${escapeJson(m.role)}","content":"${escapeJson(m.content)}"}"""
        }
        val options = mutableListOf<String>()
        request.temperature?.let { options += "\"temperature\":$it" }
        request.maxTokens?.let { options += "\"num_predict\":$it" }
        val sb = StringBuilder()
        sb.append("{\"model\":\"").append(escapeJson(request.model.ifBlank { profile.model })).append("\",")
        sb.append("\"messages\":[").append(messages.joinToString(",")).append("],")
        sb.append("\"stream\":").append(request.stream)
        if (options.isNotEmpty()) sb.append(",\"options\":{").append(options.joinToString(",")).append("}")
        sb.append("}")
        val headers = mutableMapOf("Content-Type" to "application/json")
        if (!apiKey.isNullOrEmpty()) headers["Authorization"] = "Bearer $apiKey"
        return BuiltHttpRequest(method = "POST", url = url, headers = headers, body = sb.toString())
    }

    override fun capabilities(): ModelCapabilities =
        ModelCapabilities(notes = listOf("使用 options.num_predict 控制生成长度"))

    override fun parseSseLine(line: String): ModelStreamEvent? {
        val raw = line.trim()
        if (raw.isEmpty()) return null
        // Ollama 偶发以 `data:` 前缀包裹；两种形状都接受
        val payload = if (raw.startsWith("data:")) raw.removePrefix("data:").trim() else raw
        if (payload.isEmpty()) return null
        return parseNdjson(payload)
    }

    override fun parseNonStreamingBody(body: String): ModelStreamEvent {
        val json = body.trim()
        if (json.isEmpty()) {
            return ModelStreamEvent.Failure(ModelError("EMPTY_RESPONSE", "响应为空", retryable = true))
        }
        return parseNdjson(json)
    }

    private fun parseNdjson(json: String): ModelStreamEvent {
        if (json.contains("\"error\"")) {
            return ModelStreamEvent.Failure(
                ModelError("OLLAMA_ERROR", extractJsonString(json, "error") ?: json.take(200), retryable = false),
            )
        }
        val content = extractJsonString(json, "content")
        val thinkingOnly = content.isNullOrEmpty() && !extractJsonString(json, "thinking").isNullOrEmpty()
        val done = json.contains("\"done\":true")
        val promptTokens = extractJsonInt(json, "prompt_eval_count")
        val completionTokens = extractJsonInt(json, "eval_count")
        return when {
            done -> ModelStreamEvent.Chunk(
                ModelChunk(
                    deltaText = content.orEmpty(),
                    finished = true,
                    finishReason = extractJsonString(json, "done_reason") ?: "stop",
                    promptTokens = promptTokens,
                    completionTokens = completionTokens,
                ),
            )
            thinkingOnly -> ModelStreamEvent.Failure(ModelError(EMPTY_DELTA_CODE, "仅思考增量", retryable = true))
            !content.isNullOrEmpty() -> ModelStreamEvent.Chunk(ModelChunk(deltaText = content))
            promptTokens != null || completionTokens != null -> ModelStreamEvent.Chunk(
                ModelChunk(deltaText = "", promptTokens = promptTokens, completionTokens = completionTokens),
            )
            else -> ModelStreamEvent.Failure(ModelError(EMPTY_DELTA_CODE, "无内容增量", retryable = true))
        }
    }
}

/** provider -> adapter 工厂（连接测试与生成共用同一实例语义）。 */
fun adapterFor(provider: ModelProvider, allowHttp: Boolean = false): ModelAdapter = when (provider) {
    ModelProvider.OpenAI -> OpenAiCompatibleAdapter(allowHttp)
    ModelProvider.Anthropic -> AnthropicAdapter(allowHttp)
    ModelProvider.Gemini -> GeminiAdapter(allowHttp)
    ModelProvider.Ollama -> OllamaAdapter(allowHttp = true || allowHttp)
}

// ---------------------------------------------------------------- 轻量 JSON 提取
// 只读取扁平字符串/整数字段；不做完整 JSON 解析（避免依赖并在流式分片上保持健壮）。

internal fun extractJsonString(json: String, key: String): String? {
    val marker = "\"$key\":\""
    val idx = json.indexOf(marker)
    if (idx < 0) return null
    var i = idx + marker.length
    val sb = StringBuilder()
    while (i < json.length) {
        val c = json[i]
        if (c == '\\' && i + 1 < json.length) {
            when (json[i + 1]) {
                'n' -> sb.append('\n')
                'r' -> sb.append('\r')
                't' -> sb.append('\t')
                'b' -> sb.append('\b')
                'f' -> sb.append('\u000c')
                '"' -> sb.append('"')
                '\\' -> sb.append('\\')
                '/' -> sb.append('/')
                'u' -> {
                    if (i + 5 < json.length) {
                        val hex = json.substring(i + 2, i + 6)
                        hex.toIntOrNull(16)?.let { sb.append(it.toChar()) }
                        i += 6
                        continue
                    }
                    sb.append(json[i + 1])
                }
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

internal fun extractJsonInt(json: String, key: String): Int? {
    val marker = "\"$key\":"
    var searchFrom = 0
    while (true) {
        val idx = json.indexOf(marker, searchFrom)
        if (idx < 0) return null
        var i = idx + marker.length
        while (i < json.length && json[i] == ' ') i++
        val start = i
        if (i < json.length && (json[i] == '-' || json[i].isDigit())) {
            i++
            while (i < json.length && json[i].isDigit()) i++
            return json.substring(start, i).toIntOrNull()
        }
        searchFrom = idx + marker.length
    }
}

/**
 * 结构完整性检查：引号成对、括号配对。
 * 轻量解析器无法识别所有畸形输入，这一步用于把「截断/乱码」与「合法的空增量」区分开。
 */
internal fun isStructurallyValid(json: String): Boolean {
    var inString = false
    var escaped = false
    var depth = 0
    for (ch in json) {
        if (inString) {
            when {
                escaped -> escaped = false
                ch == '\\' -> escaped = true
                ch == '"' -> inString = false
            }
            continue
        }
        when (ch) {
            '"' -> inString = true
            '{', '[' -> depth++
            '}', ']' -> {
                depth--
                if (depth < 0) return false
            }
        }
    }
    return !inString && depth == 0
}
