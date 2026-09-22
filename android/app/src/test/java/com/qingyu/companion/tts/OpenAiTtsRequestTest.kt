package com.qingyu.companion.tts

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 网络 TTS（OpenAI TTS）请求构造：纯逻辑、凭据不进日志/toString、base URL 加固复用。
 */
class OpenAiTtsRequestTest {

    private val apiKey = "sk-test-secret-key-123"

    @Test
    fun `请求构造-POST到audio-speech且JSON体包含模型音色文本与语速`() {
        val request = OpenAiTtsRequestBuilder.build(
            config = OpenAiTtsConfig(),
            text = "你好，世界",
            voiceId = "nova",
            speed = 1.25f,
            apiKey = apiKey,
        )

        assertEquals("POST", request.method, "网络 TTS 必须走 POST 合成接口")
        assertEquals(
            "https://api.openai.com/v1/audio/speech",
            request.url,
            "供应商协议端点必须是 /v1/audio/speech，端点错了会 404",
        )
        assertEquals("Bearer $apiKey", request.header("Authorization"), "鉴权必须从本地 secret store 注入 Authorization 头")
        assertTrue(request.body.contains("\"model\":\"gpt-4o-mini-tts\""), "请求体缺 model 供应商无法路由")
        assertTrue(request.body.contains("\"voice\":\"nova\""), "请求体缺 voice 会用错音色")
        assertTrue(request.body.contains("\"input\":\"你好，世界\""), "请求体缺 input 会合成空文本")
        assertTrue(request.body.contains("\"response_format\":\"mp3\""), "请求体缺 response_format 会拿到非预期容器")
        assertTrue(request.body.contains("\"speed\":1.25"), "请求体缺 speed 会让语速设置失效")
    }

    @Test
    fun `凭据不出现在toString与describeForLog`() {
        val request = OpenAiTtsRequestBuilder.build(
            config = OpenAiTtsConfig(),
            text = "排障内容",
            voiceId = "alloy",
            speed = 1.0f,
            apiKey = apiKey,
        )

        assertFalse(request.toString().contains(apiKey), "凭据进 toString 等于进日志：toString 必须掩码")
        assertFalse(request.describeForLog().contains(apiKey), "describeForLog 是日志出口，凭据必须掩码")
        assertTrue(
            request.describeForLog().contains(SecretRedactor.MASK),
            "脱敏后应保留掩码占位，方便排障时确认「这里本来有凭据」",
        )
    }

    @Test
    fun `无密钥时省略Authorization头`() {
        val request = OpenAiTtsRequestBuilder.build(
            config = OpenAiTtsConfig(),
            text = "本地网关免鉴权",
            voiceId = "alloy",
            speed = 1.0f,
            apiKey = null,
        )

        assertNull(request.header("Authorization"), "未配置密钥时不得发送空 Authorization 头，免鉴权网关会因此 401")
    }

    @Test
    fun `非法base URL被拒绝-凭据不会发往意外主机`() {
        val failure = assertFailsWith<IllegalArgumentException>("带 userinfo 的 base URL 必须拒绝，防止凭据被夹带转发到第三方主机") {
            OpenAiTtsRequestBuilder.build(
                config = OpenAiTtsConfig(baseUrl = "https://user:pass@evil.example.com/v1"),
                text = "文本",
                voiceId = "alloy",
                speed = 1.0f,
                apiKey = apiKey,
            )
        }
        assertFalse(failure.message.orEmpty().contains(apiKey), "配置错误信息也不得携带密钥")
    }

    @Test
    fun `空文本被拒绝-避免发出空合成请求`() {
        assertFailsWith<IllegalArgumentException>("空文本合成既浪费配额又产生无声缓存，必须拒绝") {
            OpenAiTtsRequestBuilder.build(
                config = OpenAiTtsConfig(),
                text = "   ",
                voiceId = "alloy",
                speed = 1.0f,
                apiKey = apiKey,
            )
        }
    }

    @Test
    fun `语速越界收敛到供应商范围`() {
        val tooFast = OpenAiTtsRequestBuilder.build(
            config = OpenAiTtsConfig(),
            text = "文本",
            voiceId = "alloy",
            speed = 99.0f,
            apiKey = apiKey,
        )
        val tooSlow = OpenAiTtsRequestBuilder.build(
            config = OpenAiTtsConfig(),
            text = "文本",
            voiceId = "alloy",
            speed = 0.01f,
            apiKey = apiKey,
        )

        assertTrue(tooFast.body.contains("\"speed\":4.0"), "超出供应商范围的语速会被 400 拒绝，必须先收敛")
        assertTrue(tooSlow.body.contains("\"speed\":0.25"), "过低语速同样要收敛到供应商下限")
    }
}
