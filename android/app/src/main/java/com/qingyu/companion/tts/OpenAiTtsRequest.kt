package com.qingyu.companion.tts

import com.qingyu.companion.network.models.escapeJson
import com.qingyu.companion.network.models.joinUrl
import com.qingyu.companion.network.models.requireSafeBaseUrl

/**
 * 网络 TTS 供应商协议：**OpenAI TTS**（`POST {base}/v1/audio/speech`）。
 * （任务允许 Edge TTS / OpenAI TTS 二选一；选 OpenAI 是因为它是官方公开文档化协议，
 * Edge TTS 为逆向的 WSS + Sec-MS-GEC 协议，稳定性不满足「做完整」的要求。）
 *
 * 请求构造是纯逻辑（本文件），可直接 JVM 单测：
 * - base URL 复用 S3-05 的 [requireSafeBaseUrl] 加固（拒绝 userinfo/query/fragment/路径穿越）；
 * - 鉴权从本地 secret store 注入（[TtsSecretSource]），只出现在 `Authorization` 头的构造一刻；
 * - [OpenAiTtsRequest.toString] / [OpenAiTtsRequest.describeForLog] **强制脱敏**，
 *   凭据（无论哪一种头/体形态）不可能出现在日志行里。
 */

data class OpenAiTtsConfig(
    val baseUrl: String = "https://api.openai.com/v1",
    val model: String = "gpt-4o-mini-tts",
    val responseFormat: String = "mp3",
    val allowHttp: Boolean = false,
    val defaultVoice: String = OpenAiTtsVoices.DEFAULT_ID,
)

/** 已构造的 HTTP 请求。toString/describeForLog 脱敏；真实头仅供执行层读取。 */
data class OpenAiTtsRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String>,
    val body: String,
) {
    fun header(name: String): String? =
        headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value

    /** 日志安全描述：敏感头全部掩码，正文只报长度（正文含用户文本，也不进日志）。 */
    fun describeForLog(): String =
        "OpenAiTtsRequest(method=$method, url=$url, headers=${maskedHeaders()}, bodyBytes=${body.length})"

    override fun toString(): String =
        "OpenAiTtsRequest(method=$method, url=$url, headers=${maskedHeaders()})"

    private fun maskedHeaders(): Map<String, String> =
        headers.mapValues { (name, value) ->
            if (name.lowercase() in SENSITIVE_HEADERS) SecretRedactor.MASK else value
        }

    companion object {
        /** 敏感头一律掩码（凭据不进日志/toString）。 */
        val SENSITIVE_HEADERS = setOf(
            "authorization", "proxy-authorization", "x-api-key", "api-key", "cookie",
        )
    }
}

object OpenAiTtsRequestBuilder {
    const val PROVIDER_WIRE = "openai"
    const val PATH = "audio/speech"

    /** 供应商官方语速范围 0.25—4.0。 */
    const val MIN_SPEED = 0.25f
    const val MAX_SPEED = 4.0f

    fun build(
        config: OpenAiTtsConfig,
        text: String,
        voiceId: String,
        speed: Float,
        apiKey: String?,
    ): OpenAiTtsRequest {
        require(text.isNotBlank()) { "朗读文本不能为空" }
        val base = requireSafeBaseUrl(config.baseUrl, config.allowHttp)
        val url = joinUrl(base, PATH)
        val voice = voiceId.ifBlank { config.defaultVoice }
        val rate = speed.coerceIn(MIN_SPEED, MAX_SPEED)
        val body = buildString {
            append("{\"model\":\"").append(escapeJson(config.model)).append("\",")
            append("\"voice\":\"").append(escapeJson(voice)).append("\",")
            append("\"input\":\"").append(escapeJson(text)).append("\",")
            append("\"response_format\":\"").append(escapeJson(config.responseFormat)).append("\",")
            append("\"speed\":").append(rate.toString()).append("}")
        }
        val headers = mutableMapOf(
            "Content-Type" to "application/json",
            "Accept" to "audio/mpeg",
        )
        // 鉴权从本地 secret store 注入：只在此处进入请求头，绝不落日志
        if (!apiKey.isNullOrBlank()) {
            headers["Authorization"] = "Bearer $apiKey"
        }
        return OpenAiTtsRequest(method = "POST", url = url, headers = headers, body = body)
    }
}
