package com.qingyu.companion.tts

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 网络 TTS 引擎（OpenAI TTS）端到端：请求线格式、鉴权从本地 secret 注入、
 * 响应流式落盘、错误脱敏（凭据不进日志/错误文案）。
 */
class OpenAiTtsEngineTest {

    private lateinit var server: MockWebServer
    private lateinit var tempDir: File

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        tempDir = Files.createTempDirectory("tts-network-test").toFile()
    }

    @After
    fun tearDown() {
        server.shutdown()
        tempDir.deleteRecursively()
    }

    private fun engine(apiKey: String?): OpenAiTtsEngine = OpenAiTtsEngine(
        http = OkHttpClient(),
        secretSource = TtsSecretSource { apiKey },
        config = OpenAiTtsConfig(baseUrl = server.url("/v1").toString(), allowHttp = true),
    )

    private class CollectingCallback : SynthCallback {
        val results = mutableListOf<SynthResult>()
        val latch = CountDownLatch(1)
        override fun onResult(result: SynthResult) {
            results += result
            latch.countDown()
        }
    }

    @Test
    fun `合成请求携带secret注入的鉴权-响应流式落盘`() {
        val secret = "sk-test-secret-key-123"
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "audio/mpeg")
                .setBody(Buffer().write(wavLikeAudio())),
        )
        val target = tempDir.resolve("out.part").absolutePath
        val callback = CollectingCallback()

        engine(secret).synthesize(speakReq(text = "落盘内容", voice = "nova"), target, callback)

        assertTrue(callback.latch.await(5, TimeUnit.SECONDS), "网络合成回调必须返回，否则朗读任务悬挂无期限")
        assertTrue(callback.results.single() is SynthResult.Ok, "合法响应必须合成成功")

        val recorded = assertNotNull(server.takeRequest(5, TimeUnit.SECONDS), "引擎必须发出合成请求")
        assertEquals("/v1/audio/speech", recorded.path, "端点错误会 404")
        assertEquals("POST", recorded.method, "合成必须走 POST")
        assertEquals("Bearer $secret", recorded.getHeader("Authorization"), "鉴权必须来自本地 secret store 注入")
        assertTrue(recorded.body.readUtf8().contains("\"input\":\"落盘内容\""), "请求体必须携带待合成文本")

        val written = File(target)
        assertTrue(written.length() >= AudioIntegrity.MIN_BYTES, "响应必须完整落盘，缺字节会导致半截音频")
    }

    @Test
    fun `HTTP错误映射为TtsError且不泄漏密钥`() {
        val secret = "sk-test-secret-key-123"
        // 供应商常见行为：把密钥回显进错误体——照样不许出现在我们侧的日志/错误文案里
        server.enqueue(
            MockResponse().setResponseCode(401)
                .setBody("{\"error\":{\"message\":\"Incorrect API key provided: $secret\"}}"),
        )
        val target = tempDir.resolve("out.part").absolutePath
        val callback = CollectingCallback()

        engine(secret).synthesize(speakReq(), target, callback)

        assertTrue(callback.latch.await(5, TimeUnit.SECONDS), "错误也必须回调，否则任务悬挂")
        val failure = callback.results.single() as SynthResult.Failure
        assertEquals("HTTP_401", failure.error.code, "HTTP 状态必须映射成可判读的错误码")
        assertFalse(failure.error.message.contains(secret), "供应商回显的密钥必须脱敏，错误文案会进日志")
        assertFalse(failure.error.toString().contains(secret), "TtsError.toString 是日志出口，不得携带密钥")
    }

    @Test
    fun `未配置密钥时省略Authorization头`() {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "audio/mpeg")
                .setBody(Buffer().write(wavLikeAudio())),
        )
        val target = tempDir.resolve("out.part").absolutePath
        val callback = CollectingCallback()

        engine(apiKey = null).synthesize(speakReq(), target, callback)

        assertTrue(callback.latch.await(5, TimeUnit.SECONDS), "回调必须返回")
        val recorded = assertNotNull(server.takeRequest(5, TimeUnit.SECONDS), "引擎必须发出合成请求")
        assertNull(recorded.getHeader("Authorization"), "未配置密钥时不得发送空 Authorization 头")
    }
}
