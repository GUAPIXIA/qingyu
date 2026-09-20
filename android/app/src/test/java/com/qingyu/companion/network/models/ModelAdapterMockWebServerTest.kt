package com.qingyu.companion.network.models

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * 阶段 3 S3-05：四类模型适配器的 MockWebServer 验证。
 *
 * 覆盖阶段 3 §3 要求的：成功流、分片边界、非 2xx、限流、取消、超时、畸形 JSON、
 * 空响应、reasoning/thought 过滤。
 */
class ModelAdapterMockWebServerTest {

    private lateinit var server: MockWebServer
    private lateinit var client: ModelClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = ModelClient(
            OkHttpClient.Builder()
                .connectTimeout(2, TimeUnit.SECONDS)
                .readTimeout(2, TimeUnit.SECONDS)
                .writeTimeout(2, TimeUnit.SECONDS)
                .followRedirects(false)
                .build(),
        )
    }

    @After
    fun tearDown() {
        runCatching { server.shutdown() }
    }

    private fun baseUrl(): String = server.url("/").toString().trimEnd('/')

    /**
     * 流式响应：整段 body 以 **1 字节一个 chunk** 写出，
     * 强制 SSE 行跨 socket 分片边界，用于验证跨分片拼接。
     */
    private fun sse(vararg lines: String): MockResponse =
        MockResponse()
            .setResponseCode(200)
            .setHeader("Content-Type", "text/event-stream")
            .setChunkedBody(lines.joinToString(""), 1)

    private fun openAiProfile() = ConnectionProfilePublic(
        id = "p1",
        provider = ModelProvider.OpenAI,
        baseUrl = baseUrl(),
        model = "gpt-test",
        allowHttp = true,
    )

    // ---------------------------------------------------------------- OpenAI

    @Test
    fun `openai stream emits chunks and usage across split boundaries`() = runBlocking {
        server.enqueue(
            sse(
                "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n",
                "data: [DONE]\n\n",
            ),
        )
        val adapter = OpenAiCompatibleAdapter(allowHttp = true)
        val events = withTimeout(10_000) {
            client.stream(
                adapter,
                openAiProfile(),
                ModelChatRequest("gpt-test", listOf(ChatMessageDto("user", "hi"))),
                apiKey = "sk-test",
            ).toList()
        }
        val text = events.filterIsInstance<ModelStreamEvent.Chunk>().joinToString("") { it.value.deltaText }
        assertEquals("你好", text)
        assertTrue(events.filterIsInstance<ModelStreamEvent.Chunk>().any { it.value.finished })
        val finished = events.filterIsInstance<ModelStreamEvent.Chunk>().first { it.value.finished }
        assertEquals("stop", finished.value.finishReason)
        assertEquals(3, finished.value.promptTokens)
        assertEquals(2, finished.value.completionTokens)
        assertTrue(events.any { it is ModelStreamEvent.Completed })

        // 认证头与请求体形状
        val recorded = server.takeRequest()
        assertEquals("Bearer sk-test", recorded.getHeader("Authorization"))
        assertTrue(recorded.path!!.endsWith("/chat/completions"))
        val body = recorded.body.readUtf8()
        assertTrue(body.contains("\"stream\":true"))
        assertTrue(body.contains("gpt-test"))
    }

    @Test
    fun `openai reasoning only chunk is filtered from visible text`() = runBlocking {
        server.enqueue(
            sse(
                "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking...\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"答案\"}}]}\n\n",
                "data: [DONE]\n\n",
            ),
        )
        val events = withTimeout(10_000) {
            client.stream(
                OpenAiCompatibleAdapter(allowHttp = true),
                openAiProfile(),
                ModelChatRequest("m", listOf(ChatMessageDto("user", "q"))),
                null,
            ).toList()
        }
        val text = events.filterIsInstance<ModelStreamEvent.Chunk>().joinToString("") { it.value.deltaText }
        assertEquals("答案", text)
    }

    @Test
    fun `http 429 maps to retryable rate limit error`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(429).setBody("{\"error\":{\"message\":\"rate limited\"}}"),
        )
        val events = withTimeout(10_000) {
            client.stream(
                OpenAiCompatibleAdapter(allowHttp = true),
                openAiProfile(),
                ModelChatRequest("m", listOf(ChatMessageDto("user", "q"))),
                null,
            ).toList()
        }
        val failure = events.filterIsInstance<ModelStreamEvent.Failure>().single()
        assertEquals("HTTP_429", failure.error.code)
        assertTrue(failure.error.retryable)
    }

    @Test
    fun `http 401 maps to non retryable auth error`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(401).setBody("{\"error\":{\"message\":\"bad key\"}}"),
        )
        val result = withTimeout(10_000) {
            client.testConnection(
                OpenAiCompatibleAdapter(allowHttp = true),
                openAiProfile(),
                ModelChatRequest("m", listOf(ChatMessageDto("user", "q")), stream = false),
                apiKey = "wrong",
            )
        }
        assertFalse(result.ok)
        assertEquals("HTTP_401", result.error!!.code)
        assertFalse(result.error!!.retryable)
    }

    @Test
    fun `malformed json line surfaces non retryable failure`() = runBlocking {
        server.enqueue(
            sse(
                "data: {not-json\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n",
                "data: [DONE]\n\n",
            ),
        )
        val events = withTimeout(10_000) {
            client.stream(
                OpenAiCompatibleAdapter(allowHttp = true),
                openAiProfile(),
                ModelChatRequest("m", listOf(ChatMessageDto("user", "q"))),
                null,
            ).toList()
        }
        val failure = events.filterIsInstance<ModelStreamEvent.Failure>().single()
        assertEquals("MALFORMED_JSON", failure.error.code)
        assertFalse(failure.error.retryable)
    }

    @Test
    fun `stream without explicit terminator still completes via eof`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "text/event-stream")
                .setBody("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n"),
        )
        val events = withTimeout(10_000) {
            client.stream(
                OpenAiCompatibleAdapter(allowHttp = true),
                openAiProfile(),
                ModelChatRequest("m", listOf(ChatMessageDto("user", "q"))),
                null,
            ).toList()
        }
        assertTrue(events.none { it is ModelStreamEvent.Failure })
        assertEquals("ok", events.filterIsInstance<ModelStreamEvent.Chunk>().joinToString("") { it.value.deltaText })
        assertTrue(events.any { it is ModelStreamEvent.Completed })
    }

    @Test
    fun `empty non streaming body yields retryable empty response`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(""))
        val result = withTimeout(10_000) {
            client.complete(
                OpenAiCompatibleAdapter(allowHttp = true),
                openAiProfile(),
                ModelChatRequest("m", listOf(ChatMessageDto("user", "q")), stream = false),
                null,
            )
        }
        assertTrue(result is ModelStreamEvent.Failure)
        assertEquals("EMPTY_RESPONSE", (result as ModelStreamEvent.Failure).error.code)
        assertTrue(result.error.retryable)
    }

    @Test
    fun `cancellation stops the stream and reports cancelled`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "text/event-stream")
                .setBodyDelay(5, TimeUnit.SECONDS)
                .setBody("data: {\"choices\":[{\"delta\":{\"content\":\"late\"}}]}\n\n"),
        )
        val (flow, handle) = client.streamWithHandle(
            OpenAiCompatibleAdapter(allowHttp = true),
            openAiProfile(),
            ModelChatRequest("m", listOf(ChatMessageDto("user", "q"))),
            null,
        )
        val collected = java.util.Collections.synchronizedList(mutableListOf<ModelStreamEvent>())
        val scope = CoroutineScope(Dispatchers.IO)
        val job = scope.launch { flow.collect { collected += it } }
        delay(300)
        handle.cancel()
        withTimeout(10_000) { job.join() }
        assertTrue(handle.isCancelled)
        // 取消后不得再产生任何正文内容；调用方经 handle.isCancelled 区分用户取消与错误
        assertTrue(collected.none { it is ModelStreamEvent.Chunk })
    }

    @Test
    fun `read timeout maps to retryable timeout error`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "text/event-stream")
                .setSocketPolicy(SocketPolicy.NO_RESPONSE),
        )
        val events = withTimeout(20_000) {
            client.stream(
                OpenAiCompatibleAdapter(allowHttp = true),
                openAiProfile(),
                ModelChatRequest("m", listOf(ChatMessageDto("user", "q"))),
                null,
            ).toList()
        }
        val failure = events.filterIsInstance<ModelStreamEvent.Failure>().single()
        assertTrue(failure.error.retryable)
        assertTrue(failure.error.code == "TIMEOUT" || failure.error.code == "IO_ERROR")
    }

    // ---------------------------------------------------------------- Anthropic

    @Test
    fun `anthropic builds messages request and parses deltas`() = runBlocking {
        server.enqueue(
            sse(
                "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"He\"}}\n\n",
                "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"llo\"}}\n\n",
                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":4}}\n\n",
                "data: {\"type\":\"message_stop\"}\n\n",
            ),
        )
        val profile = ConnectionProfilePublic("a", ModelProvider.Anthropic, baseUrl(), "claude-test", allowHttp = true)
        val events = withTimeout(10_000) {
            client.stream(
                AnthropicAdapter(allowHttp = true),
                profile,
                ModelChatRequest("claude-test", listOf(ChatMessageDto("user", "hi")), system = "sys"),
                apiKey = "sk-ant",
            ).toList()
        }
        assertEquals("Hello", events.filterIsInstance<ModelStreamEvent.Chunk>().joinToString("") { it.value.deltaText })
        val recorded = server.takeRequest()
        assertEquals("sk-ant", recorded.getHeader("x-api-key"))
        assertEquals("2023-06-01", recorded.getHeader("anthropic-version"))
        assertTrue(recorded.path!!.contains("/v1/messages"))
        val body = recorded.body.readUtf8()
        assertTrue(body.contains("\"system\":\"sys\""))
        // max_tokens 必填
        assertTrue(body.contains("\"max_tokens\""))
    }

    // ---------------------------------------------------------------- Gemini

    @Test
    fun `gemini builds contents request and parses sse`() = runBlocking {
        server.enqueue(
            sse(
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"你\"}]}}]}\n\n",
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"好\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":2,\"candidatesTokenCount\":1}}\n\n",
            ),
        )
        val profile = ConnectionProfilePublic("g", ModelProvider.Gemini, baseUrl(), "gemini-test", allowHttp = true)
        val events = withTimeout(10_000) {
            client.stream(
                GeminiAdapter(allowHttp = true),
                profile,
                ModelChatRequest("gemini-test", listOf(ChatMessageDto("user", "hi")), system = "sys"),
                apiKey = "gk",
            ).toList()
        }
        assertEquals("你好", events.filterIsInstance<ModelStreamEvent.Chunk>().joinToString("") { it.value.deltaText })
        val recorded = server.takeRequest()
        assertEquals("gk", recorded.getHeader("x-goog-api-key"))
        assertTrue(recorded.path!!.contains("streamGenerateContent"))
        val body = recorded.body.readUtf8()
        assertTrue(body.contains("systemInstruction"))
    }

    @Test
    fun `gemini content block reason surfaces as non retryable error`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "text/event-stream")
                .setBody("data: {\"promptFeedback\":{\"blockReason\":\"SAFETY\"}}\n"),
        )
        val profile = ConnectionProfilePublic("g", ModelProvider.Gemini, baseUrl(), "gemini-test", allowHttp = true)
        val events = withTimeout(10_000) {
            client.stream(
                GeminiAdapter(allowHttp = true),
                profile,
                ModelChatRequest("m", listOf(ChatMessageDto("user", "x"))),
                null,
            ).toList()
        }
        val failure = events.filterIsInstance<ModelStreamEvent.Failure>().first()
        assertEquals("CONTENT_BLOCKED", failure.error.code)
        assertFalse(failure.error.retryable)
    }

    // ---------------------------------------------------------------- Ollama

    @Test
    fun `ollama parses ndjson stream and options`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "application/x-ndjson")
                .setBody(
                    "{\"message\":{\"role\":\"assistant\"},\"content\":\"你\",\"done\":false}\n" +
                        "{\"content\":\"好\",\"done\":false}\n" +
                        "{\"content\":\"\",\"done\":true,\"done_reason\":\"stop\",\"prompt_eval_count\":7,\"eval_count\":3}\n",
                ),
        )
        val profile = ConnectionProfilePublic("o", ModelProvider.Ollama, baseUrl(), "llama-test", allowHttp = true)
        val events = withTimeout(10_000) {
            client.stream(
                OllamaAdapter(),
                profile,
                ModelChatRequest("llama-test", listOf(ChatMessageDto("user", "hi")), temperature = 0.7, maxTokens = 64),
                null,
            ).toList()
        }
        assertEquals("你好", events.filterIsInstance<ModelStreamEvent.Chunk>().joinToString("") { it.value.deltaText })
        val finished = events.filterIsInstance<ModelStreamEvent.Chunk>().first { it.value.finished }
        assertEquals("stop", finished.value.finishReason)
        assertEquals(7, finished.value.promptTokens)
        assertEquals(3, finished.value.completionTokens)
        val recorded = server.takeRequest()
        assertTrue(recorded.path!!.endsWith("/api/chat"))
        val body = recorded.body.readUtf8()
        assertTrue(body.contains("\"temperature\":0.7"))
        assertTrue(body.contains("\"num_predict\":64"))
    }

    @Test
    fun `ollama thinking only frame does not end the stream`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setBody(
                    "{\"thinking\":\"pondering\",\"done\":false}\n" +
                        "{\"content\":\"ok\",\"done\":true}\n",
                ),
        )
        val profile = ConnectionProfilePublic("o", ModelProvider.Ollama, baseUrl(), "llama", allowHttp = true)
        val events = withTimeout(10_000) {
            client.stream(
                OllamaAdapter(),
                profile,
                ModelChatRequest("m", listOf(ChatMessageDto("user", "q"))),
                null,
            ).toList()
        }
        assertTrue(events.none { it is ModelStreamEvent.Failure })
        assertEquals("ok", events.filterIsInstance<ModelStreamEvent.Chunk>().joinToString("") { it.value.deltaText })
    }

    // ---------------------------------------------------------------- 安全

    @Test
    fun `http base url requires explicit opt in`() {
        val profile = ConnectionProfilePublic("p", ModelProvider.OpenAI, baseUrl(), "m", allowHttp = false)
        val strict = OpenAiCompatibleAdapter(allowHttp = false)
        val rejected = runCatching {
            strict.buildChatRequest(profile, ModelChatRequest("m", emptyList()), null)
        }.isFailure
        assertTrue("未显式启用时 http 必须被拒绝", rejected)

        val permissive = OpenAiCompatibleAdapter(allowHttp = false)
        val ok = permissive.buildChatRequest(profile.copy(allowHttp = true), ModelChatRequest("m", emptyList()), null)
        assertTrue(ok.url.startsWith("http://"))
    }

    @Test
    fun `api key never appears in built request headers for ollama without key`() {
        val adapter = OllamaAdapter()
        val built = adapter.buildChatRequest(
            ConnectionProfilePublic("o", ModelProvider.Ollama, "http://127.0.0.1:11434", "m", allowHttp = true),
            ModelChatRequest("m", emptyList()),
            null,
        )
        assertFalse(built.headers.keys.any { it.equals("Authorization", ignoreCase = true) })
    }

    // ---------------------------------------------------------------- base URL 规范化/加固

    @Test
    fun `base url rejects userinfo query fragment and path traversal`() {
        val cases = listOf(
            "https://user:pass@api.example.com/v1" to "userinfo",
            "https://api.example.com/v1?key=secret" to "query",
            "https://api.example.com/v1#frag" to "fragment",
            "https://api.example.com/../admin" to "..",
            "ftp://api.example.com/v1" to "scheme",
            "https://" to "host",
            "https://api.example.com:99999/v1" to "port",
            "https://bad_host!/v1" to "hostname",
        )
        for ((url, label) in cases) {
            val rejected = runCatching { requireSafeBaseUrl(url, allowHttp = true) }.isFailure
            assertTrue("应拒绝（$label）：$url", rejected)
        }
    }

    @Test
    fun `base url accepts normalized public lan and ipv6 forms`() {
        assertEquals(
            "https://api.openai.com/v1",
            requireSafeBaseUrl("https://api.openai.com/v1/", allowHttp = false),
        )
        assertEquals(
            "http://192.168.1.10:11434",
            requireSafeBaseUrl("http://192.168.1.10:11434", allowHttp = true),
        )
        assertEquals(
            "http://localhost:11434",
            requireSafeBaseUrl("http://localhost:11434/", allowHttp = true),
        )
        assertEquals(
            "http://[::1]:11434",
            requireSafeBaseUrl("http://[::1]:11434", allowHttp = true),
        )
        assertEquals(
            "https://generativelanguage.googleapis.com",
            requireSafeBaseUrl("  https://generativelanguage.googleapis.com  ", allowHttp = false),
        )
    }

    @Test
    fun `http base url still requires explicit opt in after hardening`() {
        val rejected = runCatching { requireSafeBaseUrl("http://192.168.1.10:11434", allowHttp = false) }.isFailure
        assertTrue(rejected)
    }
}
