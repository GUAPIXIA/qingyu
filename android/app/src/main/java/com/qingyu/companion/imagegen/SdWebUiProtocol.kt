package com.qingyu.companion.imagegen

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.Base64

/**
 * SD WebUI (Automatic1111) 端点协议（PC `sdWebuiGenerate` / `testImageGenConnection` 等价）。
 *
 * 请求：`POST {base}/sdapi/v1/txt2img`；响应 `images[]` 为纯 base64（无 data: 前缀）。
 *
 * 鉴权：PC 当前对 SD WebUI 端点**不发送鉴权头**（配置虽有 apiKey 字段但 PC 未使用，
 * A1111 原生 `--api-auth` 为 Basic 形态）。为保持请求协议与 PC 逐字段一致，
 * Android 同样不注入；远程带鉴权的反代场景列入报告遗留。
 */
object SdWebUiProtocol {

    const val GENERATE_TIMEOUT_MS: Long = 120_000
    const val TEST_TIMEOUT_MS: Long = 10_000

    /** 构造 txt2img 请求（步骤/CFG/采样器等字段与 PC 默认值一致）。 */
    fun buildGenerateRequest(
        config: ImageGenConfig.SdWebUi,
        prompt: String,
        options: ImageGenRequestOptions,
    ): ImageGenHttpRequest {
        val baseUrl = requireBaseUrl(config.baseUrl)
        val sizeText = options.size ?: config.size.ifBlank { "512x512" }
        val (width, height) = ImageGenSizes.parseSize(sizeText)
        val negative = options.negativePrompt ?: config.negativePrompt ?: ""
        val body = buildString {
            append('{')
            append("\"prompt\":\"").append(escapeJson(prompt)).append("\",")
            append("\"negative_prompt\":\"").append(escapeJson(negative)).append("\",")
            append("\"steps\":").append(config.steps ?: 20).append(',')
            append("\"cfg_scale\":").append(config.cfgScale ?: 7).append(',')
            append("\"width\":").append(width).append(',')
            append("\"height\":").append(height).append(',')
            append("\"sampler_name\":\"").append(escapeJson(config.sampler?.ifBlank { null } ?: "Euler a")).append("\",")
            append("\"batch_size\":1")
            append('}')
        }
        return ImageGenHttpRequest(
            method = "POST",
            url = "$baseUrl/sdapi/v1/txt2img",
            headers = mapOf("Content-Type" to "application/json"),
            body = body,
            authHeaders = emptyMap(),
            timeoutMs = GENERATE_TIMEOUT_MS,
        )
    }

    /** 解析响应：`images[]`（纯 base64）→ PNG 图片。 */
    fun parseGenerateResponse(response: ImageGenHttpResponse): ParsedImages {
        if (response.statusCode !in 200..299) {
            val snippet = response.text().take(200)
            return ParsedImages.Failure(
                classifyHttpStatus("SDWEBUI", response.statusCode, "SD WebUI API 错误 ${response.statusCode}: $snippet"),
            )
        }
        val root = try {
            parseJsonElement(response.text())
        } catch (err: Exception) {
            return ParsedImages.Failure(
                ImageGenFailure(ImageGenFailureKind.PROTOCOL, "MALFORMED_JSON", "SD WebUI 返回的图片数据为空", false),
            )
        }
        val images = (root as? JsonObject)?.get("images") as? JsonArray
        if (images == null || images.isEmpty()) {
            return ParsedImages.Failure(
                ImageGenFailure(ImageGenFailureKind.EMPTY_RESULT, "EMPTY_RESULT", "SD WebUI 返回的图片数据为空", false),
            )
        }
        val decoded = mutableListOf<PlainImage>()
        for (item in images) {
            val text = (item as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?: return ParsedImages.Failure(
                    ImageGenFailure(ImageGenFailureKind.PROTOCOL, "MALFORMED_RESULT", "SD WebUI 返回的图片数据格式异常", false),
                )
            val bytes = try {
                Base64.getDecoder().decode(text)
            } catch (err: IllegalArgumentException) {
                return ParsedImages.Failure(
                    ImageGenFailure(ImageGenFailureKind.PROTOCOL, "MALFORMED_BASE64", "SD WebUI 返回的图片数据无法解码", false),
                )
            }
            decoded.add(PlainImage("image/png", bytes))
        }
        return ParsedImages.Success(decoded)
    }

    /** 连接测试：`GET /sdapi/v1/options` 读取当前模型。 */
    fun buildConnectionTestRequest(config: ImageGenConfig.SdWebUi): ImageGenHttpRequest {
        val baseUrl = requireBaseUrl(config.baseUrl)
        return ImageGenHttpRequest(
            method = "GET",
            url = "$baseUrl/sdapi/v1/options",
            headers = mapOf("Content-Type" to "application/json"),
            timeoutMs = TEST_TIMEOUT_MS,
        )
    }

    fun parseConnectionTestResponse(response: ImageGenHttpResponse): ImageGenConnectionTestResult {
        if (response.statusCode !in 200..299) {
            val snippet = response.text().take(100)
            return ImageGenConnectionTestResult(
                success = false,
                failure = classifyHttpStatus("SDWEBUI", response.statusCode, "HTTP ${response.statusCode}: $snippet"),
            )
        }
        val root = try {
            parseJsonElement(response.text())
        } catch (err: Exception) {
            return ImageGenConnectionTestResult(
                success = false,
                failure = ImageGenFailure(ImageGenFailureKind.PROTOCOL, "MALFORMED_JSON", "/sdapi/v1/options 返回格式异常", false),
            )
        }
        val obj = root as? JsonObject
        val model = (obj?.get("sd_model_checkpoint") as? JsonPrimitive)?.content
            ?: (obj?.get("sd_model_hash") as? JsonPrimitive)?.content
            ?: "未知"
        return ImageGenConnectionTestResult(success = true, message = "连接成功，当前模型: $model")
    }
}
