package com.qingyu.companion.imagegen

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.Base64

/**
 * OpenAI Images 端点协议（PC `openaiGenerate` / `testImageGenConnection` 等价）。
 *
 * 请求：`POST {base}/images/generations`，`Authorization: Bearer <apiKey>`（本地注入，不进日志）；
 * 响应：`data[].b64_json` → PNG 图片。
 */
object OpenAiImagesProtocol {

    const val GENERATE_TIMEOUT_MS: Long = 120_000
    const val TEST_TIMEOUT_MS: Long = 10_000

    /** 构造生成请求（尺寸先按模型合法集合归一化，保留竖/横取向）。 */
    fun buildGenerateRequest(
        config: ImageGenConfig.OpenAi,
        prompt: String,
        options: ImageGenRequestOptions,
    ): Pair<ImageGenHttpRequest, String> {
        val baseUrl = requireBaseUrl(config.baseUrl)
        val model = config.model.ifBlank { "dall-e-3" }
        val requestedSize = options.size ?: config.size.ifBlank { "1024x1024" }
        val size = ImageGenSizes.normalizeOpenAiSize(requestedSize, model)
        val body = buildString {
            append('{')
            append("\"model\":\"").append(escapeJson(model)).append("\",")
            append("\"prompt\":\"").append(escapeJson(prompt)).append("\",")
            append("\"n\":1,")
            append("\"size\":\"").append(escapeJson(size)).append("\",")
            append("\"quality\":\"").append(escapeJson(options.quality ?: config.quality.ifBlank { "standard" })).append("\",")
            append("\"response_format\":\"b64_json\"")
            append('}')
        }
        val request = ImageGenHttpRequest(
            method = "POST",
            url = "$baseUrl/images/generations",
            headers = mapOf("Content-Type" to "application/json"),
            body = body,
            authHeaders = bearerAuth(config.apiKey),
            timeoutMs = GENERATE_TIMEOUT_MS,
        )
        return request to size
    }

    /** 解析生成响应：`b64_json` → 图片字节。 */
    fun parseGenerateResponse(response: ImageGenHttpResponse): ParsedImages {
        if (response.statusCode !in 200..299) {
            val snippet = response.text().take(200)
            return ParsedImages.Failure(
                classifyHttpStatus("OPENAI", response.statusCode, "OpenAI API 错误 ${response.statusCode}: $snippet"),
            )
        }
        val root = try {
            parseJsonElement(response.text())
        } catch (err: Exception) {
            return ParsedImages.Failure(
                ImageGenFailure(
                    ImageGenFailureKind.PROTOCOL, "MALFORMED_JSON",
                    "OpenAI 返回的图片数据格式异常", false,
                ),
            )
        }
        val data = (root as? JsonObject)?.get("data") as? JsonArray
        if (data == null || data.isEmpty()) {
            return ParsedImages.Failure(
                ImageGenFailure(ImageGenFailureKind.EMPTY_RESULT, "EMPTY_RESULT", "OpenAI 返回的图片数据为空", false),
            )
        }
        val images = mutableListOf<PlainImage>()
        for (item in data) {
            val b64 = (item as? JsonObject)?.get("b64_json") as? JsonPrimitive
            val text = b64?.takeIf { it.isString }?.content ?: continue
            val bytes = try {
                Base64.getDecoder().decode(text)
            } catch (err: IllegalArgumentException) {
                return ParsedImages.Failure(
                    ImageGenFailure(
                        ImageGenFailureKind.PROTOCOL, "MALFORMED_BASE64",
                        "OpenAI 返回的图片数据格式异常", false,
                    ),
                )
            }
            images.add(PlainImage("image/png", bytes))
        }
        if (images.isEmpty()) {
            return ParsedImages.Failure(
                ImageGenFailure(ImageGenFailureKind.PROTOCOL, "MALFORMED_RESULT", "OpenAI 返回的图片数据格式异常", false),
            )
        }
        return ParsedImages.Success(images)
    }

    /** 连接测试：`GET /models` 验证 API key（PC 文案与分类一致）。 */
    fun buildConnectionTestRequest(config: ImageGenConfig.OpenAi): ImageGenHttpRequest {
        val baseUrl = requireBaseUrl(config.baseUrl)
        return ImageGenHttpRequest(
            method = "GET",
            url = "$baseUrl/models",
            authHeaders = bearerAuth(config.apiKey),
            timeoutMs = TEST_TIMEOUT_MS,
        )
    }

    fun parseConnectionTestResponse(response: ImageGenHttpResponse): ImageGenConnectionTestResult {
        if (response.statusCode !in 200..299) {
            return if (response.statusCode == 401) {
                ImageGenConnectionTestResult(
                    success = false,
                    failure = ImageGenFailure(
                        ImageGenFailureKind.AUTH, "HTTP_401", "API Key 无效（401 Unauthorized）", false, 401,
                    ),
                )
            } else {
                val snippet = response.text().take(100)
                ImageGenConnectionTestResult(
                    success = false,
                    failure = classifyHttpStatus("OPENAI", response.statusCode, "HTTP ${response.statusCode}: $snippet"),
                )
            }
        }
        val root = try {
            parseJsonElement(response.text())
        } catch (err: Exception) {
            return ImageGenConnectionTestResult(
                success = false,
                failure = ImageGenFailure(ImageGenFailureKind.PROTOCOL, "MALFORMED_JSON", "/models 返回格式异常", false),
            )
        }
        val count = ((root as? JsonObject)?.get("data") as? JsonArray)?.size ?: 0
        return ImageGenConnectionTestResult(success = true, message = "连接成功，可用模型 $count 个")
    }
}

/** 鉴权头（本地注入）；未配置 apiKey 时不带（本地兼容网关常无需鉴权）。 */
internal fun bearerAuth(apiKey: String): Map<String, String> {
    val key = apiKey.trim()
    return if (key.isEmpty()) emptyMap() else mapOf("Authorization" to "Bearer $key")
}

/** 端点 base URL 统一校验（非 http(s)/元数据等安全边界在构造期即拒绝）。 */
internal fun requireBaseUrl(raw: String): String = when (val decision = ImageGenUrlPolicy.checkBaseUrl(raw)) {
    is ImageGenUrlPolicy.UrlDecision.Allowed -> decision.normalizedUrl
    is ImageGenUrlPolicy.UrlDecision.Blocked ->
        throw ImageGenConfigException("生图端点地址不合法：${decision.reason}")
}

/** 三类端点共用的解析结果。 */
sealed class ParsedImages {
    data class Success(val images: List<PlainImage>) : ParsedImages()
    data class Failure(val failure: ImageGenFailure) : ParsedImages()
}
