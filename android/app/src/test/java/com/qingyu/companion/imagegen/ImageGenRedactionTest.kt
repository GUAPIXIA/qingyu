package com.qingyu.companion.imagegen

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-04 鉴权纪律：API Key 本地注入，绝不进入 toString / 日志字符串。
 */
class ImageGenRedactionTest {

    @Test
    fun `bearer auth never appears in request toString or log string`() {
        val secret = "sk-super-secret-key"
        val request = ImageGenHttpRequest(
            method = "GET",
            url = "https://api.example.com/v1/models",
            headers = mapOf("Accept" to "application/json"),
            authHeaders = bearerAuth(secret),
            timeoutMs = 10_000,
        )
        assertFalse("请求 toString 泄漏 API Key 会把密钥写进日志", request.toString().contains(secret))
        assertFalse("日志视图泄漏 API Key 会把密钥写进日志", request.toLogString().contains(secret))
        assertTrue("脱敏视图应保留头名，便于排查鉴权问题", request.toLogString().contains("Authorization"))
        assertTrue("脱敏视图必须对鉴权值打码", request.toLogString().contains("***"))
    }

    @Test
    fun `comfy dual auth headers never appear in log strings`() {
        val secret = "comfy-cloud-key"
        val request = ImageGenHttpRequest(
            method = "POST",
            url = "https://comfy.example.com/prompt",
            headers = mapOf("Content-Type" to "application/json"),
            body = """{"prompt":{}}""",
            authHeaders = ComfyUiProtocol.comfyAuth(secret),
            timeoutMs = 15_000,
        )
        assertFalse("Bearer 鉴权值不得出现在 toString", request.toString().contains(secret))
        assertFalse("X-API-Key 鉴权值不得出现在日志视图", request.toLogString().contains(secret))
        assertTrue("X-API-Key 头名应保留便于排查", request.toLogString().contains("X-API-Key"))
    }

    @Test
    fun `failure toString omits message content`() {
        val failure = ImageGenFailure(
            kind = ImageGenFailureKind.PROTOCOL,
            code = "PROVIDER_ERROR",
            message = "供应商回显了 secret-token-1234",
            retryable = false,
        )
        assertFalse("失败对象进日志不得携带可能包含秘密的 message 正文", failure.toString().contains("secret-token-1234"))
        assertTrue("失败对象应保留分类与错误码", failure.toString().contains("PROVIDER_ERROR"))
    }

    @Test
    fun `config toString omits api key`() {
        val config = ImageGenConfig.OpenAi(
            id = "m1", name = "OpenAI", apiKey = "sk-leak-check", baseUrl = "https://api.example.com/v1",
        )
        assertFalse("OpenAI 配置 toString 不得包含 API Key", config.toString().contains("sk-leak-check"))
        val comfy = ImageGenConfig.ComfyUi(
            id = "m2", name = "Comfy", apiKey = "comfy-key-leak", baseUrl = "http://192.168.1.5:8188", workflow = "{}",
        )
        assertFalse("ComfyUI 配置 toString 不得包含 API Key", comfy.toString().contains("comfy-key-leak"))
        val sd = ImageGenConfig.SdWebUi(
            id = "m3", name = "SD", apiKey = "sd-key-leak", baseUrl = "http://192.168.1.5:7860",
        )
        assertFalse("SD WebUI 配置 toString 不得包含 API Key", sd.toString().contains("sd-key-leak"))
    }
}
