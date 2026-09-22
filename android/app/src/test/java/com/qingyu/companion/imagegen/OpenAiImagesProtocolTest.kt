package com.qingyu.companion.imagegen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/**
 * S6-04 端点一：OpenAI Images 请求构造、返回解析、失败分类。
 */
class OpenAiImagesProtocolTest {

    private fun pngBytes(): ByteArray =
        byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4)

    private fun config(model: String = "dall-e-3", size: String = "1024x1024", apiKey: String = "sk-test-key") =
        ImageGenConfig.OpenAi(
            id = "m1", name = "OpenAI 生图", apiKey = apiKey,
            baseUrl = "https://api.example.com/v1", model = model, size = size, quality = "standard",
        )

    private fun jsonResponse(status: Int, body: String) =
        ImageGenHttpResponse(status, "application/json", body.toByteArray())

    @Test
    fun `generate request shape matches pc protocol`() {
        val (request, appliedSize) = OpenAiImagesProtocol.buildGenerateRequest(
            config(), "a cat, masterpiece", ImageGenRequestOptions(size = "1792x1024"),
        )
        assertEquals("请求必须打到 images/generations 端点", "https://api.example.com/v1/images/generations", request.url)
        assertEquals("生成必须是 POST", "POST", request.method)
        assertEquals("请求体必须是 JSON", "application/json", request.headers["Content-Type"])
        assertEquals("尺寸先归一化再发送", "1792x1024", appliedSize)
        val body = request.body!!
        assertTrue("请求体必须携带 model", body.contains("\"model\":\"dall-e-3\""))
        assertTrue("请求体必须携带清洗后的提示词", body.contains("\"prompt\":\"a cat, masterpiece\""))
        assertTrue("请求体固定 n=1", body.contains("\"n\":1"))
        assertTrue("请求体必须要求 b64_json 返回", body.contains("\"response_format\":\"b64_json\""))
        assertTrue("请求体必须携带归一化尺寸", body.contains("\"size\":\"1792x1024\""))
        assertEquals("鉴权必须本地注入 Bearer", "Bearer sk-test-key", request.allHeaders()["Authorization"])
    }

    @Test
    fun `size normalized to dalle legal set keeping orientation`() {
        fun normalized(raw: String, model: String): String =
            OpenAiImagesProtocol.buildGenerateRequest(config(model = model), "p", ImageGenRequestOptions(size = raw)).second

        assertEquals("竖版意图必须映射为 1024x1792", "1024x1792", normalized("512x768", "dall-e-3"))
        assertEquals("竖版封面 3:4 必须映射为 1024x1792", "1024x1792", normalized("768x1024", "dall-e-3"))
        assertEquals("横版意图必须映射为 1792x1024", "1792x1024", normalized("768x512", "dall-e-3"))
        assertEquals("正方形非标尺寸必须映射为 1024x1024", "1024x1024", normalized("384x384", "dall-e-3"))
        assertEquals("合法尺寸必须原样透传", "1792x1024", normalized("1792x1024", "dall-e-3"))
        assertEquals("DALL-E 2 的 512x512 必须透传", "512x512", normalized("512x512", "dall-e-2"))
        assertEquals("DALL-E 2 非正方形必须退回 512x512", "512x512", normalized("512x768", "dall-e-2"))
    }

    @Test
    fun `response parsed into png images`() {
        val b64 = Base64.getEncoder().encodeToString(pngBytes())
        val parsed = OpenAiImagesProtocol.parseGenerateResponse(
            jsonResponse(200, """{"data":[{"b64_json":"$b64"}]}"""),
        )
        parsed as ParsedImages.Success
        assertEquals("成功响应必须解析出一张图", 1, parsed.images.size)
        assertEquals("b64_json 按 PNG 解码", "image/png", parsed.images[0].mimeType)
        assertTrue("图片字节必须与响应一致", parsed.images[0].bytes.contentEquals(pngBytes()))
    }

    @Test
    fun `empty data rejected with pc message`() {
        val parsed = OpenAiImagesProtocol.parseGenerateResponse(jsonResponse(200, """{"data":[]}"""))
        parsed as ParsedImages.Failure
        assertEquals("空结果必须给出 PC 同文案的失败", "OpenAI 返回的图片数据为空", parsed.failure.message)
        assertEquals("空结果不可重试", false, parsed.failure.retryable)
    }

    @Test
    fun `missing b64_json rejected as malformed`() {
        val parsed = OpenAiImagesProtocol.parseGenerateResponse(jsonResponse(200, """{"data":[{"url":"http://x"}]}"""))
        parsed as ParsedImages.Failure
        assertEquals("结果缺 b64_json 必须报格式异常", "OpenAI 返回的图片数据格式异常", parsed.failure.message)
    }

    @Test
    fun `http failures classified for retry policy`() {
        val unauthorized = OpenAiImagesProtocol.parseGenerateResponse(jsonResponse(401, """{"error":"bad key"}"""))
        unauthorized as ParsedImages.Failure
        assertEquals("401 必须归类为鉴权失败", ImageGenFailureKind.AUTH, unauthorized.failure.kind)
        assertFalse("鉴权失败不得自动重试", unauthorized.failure.retryable)

        val limited = OpenAiImagesProtocol.parseGenerateResponse(jsonResponse(429, """{"error":"rate"}"""))
        limited as ParsedImages.Failure
        assertEquals("429 必须归类为限流", ImageGenFailureKind.RATE_LIMIT, limited.failure.kind)
        assertTrue("限流应允许稍后重试", limited.failure.retryable)

        val server = OpenAiImagesProtocol.parseGenerateResponse(jsonResponse(500, "oops"))
        server as ParsedImages.Failure
        assertEquals("5xx 必须归类为服务端错误", ImageGenFailureKind.SERVER, server.failure.kind)
        assertTrue("服务端错误应允许重试", server.failure.retryable)
    }

    @Test
    fun `connection test request carries auth and parses model count`() {
        val request = OpenAiImagesProtocol.buildConnectionTestRequest(config())
        assertEquals("连接测试打 /models", "https://api.example.com/v1/models", request.url)
        assertEquals("连接测试与生成使用同一认证头构造", "Bearer sk-test-key", request.allHeaders()["Authorization"])
        val ok = OpenAiImagesProtocol.parseConnectionTestResponse(jsonResponse(200, """{"data":[{},{}]}"""))
        assertEquals("连接测试成功必须报告可用模型数", "连接成功，可用模型 2 个", ok.message)
        val denied = OpenAiImagesProtocol.parseConnectionTestResponse(jsonResponse(401, ""))
        assertEquals("401 必须给出 API Key 无效提示", "API Key 无效（401 Unauthorized）", denied.failure!!.message)
    }

    @Test
    fun `openai prompt sanitizer keeps natural language`() {
        val cleaned = PromptSanitizer.sanitizeOpenAiPrompt("  \"a \n\n cat\",  中文提示  ")
        assertEquals("清洗只去引号并折叠空白，保留语义", "a cat, 中文提示", cleaned)
    }
}
