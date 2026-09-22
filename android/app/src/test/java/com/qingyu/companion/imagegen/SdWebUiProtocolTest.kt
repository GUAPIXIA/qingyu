package com.qingyu.companion.imagegen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.text.Normalizer
import java.util.Base64

/**
 * S6-04 端点二：SD WebUI (Automatic1111) 请求构造、返回解析、失败分类。
 */
class SdWebUiProtocolTest {

    private fun pngBytes(): ByteArray =
        byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 9, 8, 7)

    private fun config(steps: Int? = null, cfgScale: Double? = null, sampler: String? = null) =
        ImageGenConfig.SdWebUi(
            id = "m2", name = "SD WebUI", apiKey = "sd-key",
            baseUrl = "http://192.168.1.5:7860", size = "512x512",
            negativePrompt = "blurry", steps = steps, cfgScale = cfgScale, sampler = sampler,
        )

    private fun jsonResponse(status: Int, body: String) =
        ImageGenHttpResponse(status, "application/json", body.toByteArray())

    @Test
    fun `generate request body matches pc protocol`() {
        val request = SdWebUiProtocol.buildGenerateRequest(
            config(steps = 30), "1girl, red dress",
            ImageGenRequestOptions(negativePrompt = "lowres", size = "768x512"),
        )
        assertEquals("请求必须打到 txt2img 端点", "http://192.168.1.5:7860/sdapi/v1/txt2img", request.url)
        assertEquals("生成必须是 POST", "POST", request.method)
        val body = request.body!!
        assertTrue("提示词按 SD 语法清洗后发送", body.contains("\"prompt\":\"1girl, red dress\""))
        assertTrue("请求级负面提示词优先于配置", body.contains("\"negative_prompt\":\"lowres\""))
        assertTrue("steps 走配置值", body.contains("\"steps\":30"))
        assertTrue("cfg_scale 缺省为 7", body.contains("\"cfg_scale\":7"))
        assertTrue("尺寸按 768x512 展开", body.contains("\"width\":768") && body.contains("\"height\":512"))
        assertTrue("采样器缺省 Euler a", body.contains("\"sampler_name\":\"Euler a\""))
        assertTrue("batch_size 固定 1", body.contains("\"batch_size\":1"))
    }

    @Test
    fun `request-level negative falls back to config and empty default`() {
        val fromConfig = SdWebUiProtocol.buildGenerateRequest(config(), "p", ImageGenRequestOptions()).body!!
        assertTrue("未指定时用配置负面提示词", fromConfig.contains("\"negative_prompt\":\"blurry\""))
        val blank = SdWebUiProtocol.buildGenerateRequest(
            config().copy(negativePrompt = null), "p", ImageGenRequestOptions(negativePrompt = ""),
        ).body!!
        assertTrue("显式空字符串必须清空负面提示词", blank.contains("\"negative_prompt\":\"\""))
    }

    @Test
    fun `sd webui requests carry no auth header per pc parity`() {
        val request = SdWebUiProtocol.buildGenerateRequest(config(), "p", ImageGenRequestOptions())
        assertNull(
            "PC 当前 SD WebUI 端点不发送鉴权头（apiKey 字段存在但未使用），Android 必须保持同形请求",
            request.allHeaders()["Authorization"],
        )
        assertTrue("请求形状本身必须脱敏安全", !request.toString().contains("sd-key"))
    }

    @Test
    fun `response parsed into png images`() {
        val b64 = Base64.getEncoder().encodeToString(pngBytes())
        val parsed = SdWebUiProtocol.parseGenerateResponse(jsonResponse(200, """{"images":["$b64"]}"""))
        parsed as ParsedImages.Success
        assertEquals("成功响应必须解析出一张图", 1, parsed.images.size)
        assertTrue("base64 必须解码为原始字节", parsed.images[0].bytes.contentEquals(pngBytes()))
    }

    @Test
    fun `empty images rejected with pc message`() {
        val parsed = SdWebUiProtocol.parseGenerateResponse(jsonResponse(200, """{"images":[]}"""))
        parsed as ParsedImages.Failure
        assertEquals("空图片列表必须报 PC 同文案", "SD WebUI 返回的图片数据为空", parsed.failure.message)
    }

    @Test
    fun `undecodable base64 rejected as protocol failure`() {
        val parsed = SdWebUiProtocol.parseGenerateResponse(jsonResponse(200, """{"images":["@@@not-base64@@@"]}"""))
        parsed as ParsedImages.Failure
        assertEquals("坏 base64 必须归类为协议失败", ImageGenFailureKind.PROTOCOL, parsed.failure.kind)
    }

    @Test
    fun `http failures classified`() {
        val server = SdWebUiProtocol.parseGenerateResponse(jsonResponse(503, "busy"))
        server as ParsedImages.Failure
        assertEquals("5xx 必须可重试", ImageGenFailureKind.SERVER, server.failure.kind)
        assertTrue("服务端失败应允许重试", server.failure.retryable)
    }

    @Test
    fun `connection test reports current model`() {
        val request = SdWebUiProtocol.buildConnectionTestRequest(config())
        assertEquals("连接测试轮询 options 端点", "http://192.168.1.5:7860/sdapi/v1/options", request.url)
        val ok = SdWebUiProtocol.parseConnectionTestResponse(
            jsonResponse(200, """{"sd_model_checkpoint":"sd15.safetensors"}"""),
        )
        assertEquals("连接测试必须报告当前模型", "连接成功，当前模型: sd15.safetensors", ok.message)
    }

    @Test
    fun `sd prompt sanitizer keeps tag grammar`() {
        val raw = "\"1girl\",\n red dress, café@#$"
        val cleaned = PromptSanitizer.sanitizeSdPrompt(raw)
        assertFalse("引号不得保留", cleaned.contains("\""))
        assertTrue("换行必须转成逗号分隔", cleaned.contains("red dress"))
        assertTrue("NFC 规范化必须保住拉丁扩展字符", cleaned.contains("café"))
        assertFalse("非 SD 语法字符必须剥离", cleaned.contains("@"))
        assertEquals("逗号片段去空后重新连接", "1girl, red dress, café", cleaned)
    }

    @Test
    fun `nfc normalization avoids stripping accented letters`() {
        val decomposed = Normalizer.normalize("cafe\u0301", Normalizer.Form.NFD)
        val cleaned = PromptSanitizer.sanitizeSdPrompt(decomposed)
        assertEquals("NFD 输入必须在 NFC 下保住重音字母", "café", cleaned)
    }
}
