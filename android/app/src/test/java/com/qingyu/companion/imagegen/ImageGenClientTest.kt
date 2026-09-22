package com.qingyu.companion.imagegen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.SocketTimeoutException
import java.util.Base64

/**
 * S6-04：网络执行接口抽象 + 测试替身（断言请求形状与失败分类），
 * 覆盖三端点编排、ComfyUI 轮询/输出过滤/超时、结果校验与 localhost 阻断。
 */
class ImageGenClientTest {

    private class FakeTransport : ImageGenTransport {
        val requests = mutableListOf<ImageGenHttpRequest>()
        private val scripts = ArrayDeque<(ImageGenHttpRequest) -> ImageGenHttpResponse>()

        fun enqueue(response: ImageGenHttpResponse) {
            scripts.add { response }
        }

        fun enqueueMany(count: Int, response: ImageGenHttpResponse) {
            repeat(count) { enqueue(response) }
        }

        fun enqueueThrowing(error: Throwable) {
            scripts.add { throw error }
        }

        override fun execute(request: ImageGenHttpRequest): ImageGenHttpResponse {
            requests.add(request)
            return scripts.removeFirst().invoke(request)
        }
    }

    private class FakeClock : ImageGenClock {
        var now: Long = 0
        override fun nowMs(): Long = now
        override fun sleepMs(ms: Long) {
            now += ms
        }
    }

    private fun pngBytes(): ByteArray =
        byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 3, 1, 4)

    private fun jsonResponse(status: Int, body: String) =
        ImageGenHttpResponse(status, "application/json", body.toByteArray())

    private fun openAi(baseUrl: String = "https://api.example.com/v1") = ImageGenConfig.OpenAi(
        id = "m1", name = "OpenAI", apiKey = "sk-test", baseUrl = baseUrl,
        model = "dall-e-3", size = "1024x1024", quality = "standard",
    )

    private fun sd() = ImageGenConfig.SdWebUi(
        id = "m2", name = "SD", apiKey = "", baseUrl = "http://192.168.1.5:7860", size = "512x512",
    )

    private val comfyWorkflowJson = """
        {
          "6": {"class_type":"CLIPTextEncode","inputs":{"text":"old"}},
          "3": {"class_type":"KSampler","inputs":{"seed":1,"steps":10,"cfg":7,"positive":["6",0],"latent_image":["5",0]}},
          "5": {"class_type":"EmptyLatentImage","inputs":{"width":512,"height":512}},
          "9": {"class_type":"SaveImage","inputs":{"images":["3",0]}}
        }
    """.trimIndent()

    private fun comfy(outputNodeIds: List<String> = listOf("9")) = ImageGenConfig.ComfyUi(
        id = "m3", name = "Comfy", apiKey = "comfy-key", baseUrl = "http://192.168.1.5:8188",
        workflow = comfyWorkflowJson,
        bindings = ComfyWorkflowBindings(outputNodeIds = outputNodeIds),
    )

    @Test
    fun `openai generate end to end with verified images`() {
        val transport = FakeTransport()
        val b64 = Base64.getEncoder().encodeToString(pngBytes())
        transport.enqueue(jsonResponse(200, """{"data":[{"b64_json":"$b64"}]}"""))
        val client = ImageGenClient(transport, FakeClock())

        val outcome = client.generate(openAi(), "a \"cat\"")
        outcome as ImageGenOutcome.Success
        assertEquals("成功必须返回一张已校验图片", 1, outcome.images.size)
        assertTrue("图片必须通过校验并带 sha256", outcome.images[0].sha256Hex.matches(Regex("[0-9a-f]{64}")))

        val request = transport.requests.single()
        assertTrue("请求必须打生成端点", request.url.endsWith("/images/generations"))
        assertEquals("鉴权必须在执行层注入", "Bearer sk-test", request.allHeaders()["Authorization"])
        assertTrue("提示词必须清洗后发送", request.body!!.contains("\"prompt\":\"a cat\""))
    }

    @Test
    fun `sd webui generate end to end`() {
        val transport = FakeTransport()
        val b64 = Base64.getEncoder().encodeToString(pngBytes())
        transport.enqueue(jsonResponse(200, """{"images":["$b64"]}"""))
        val client = ImageGenClient(transport, FakeClock())

        val outcome = client.generate(sd(), "1girl, red dress")
        assertTrue("SD WebUI 生成必须成功", outcome is ImageGenOutcome.Success)
        assertTrue("请求必须打 txt2img 端点", transport.requests.single().url.endsWith("/sdapi/v1/txt2img"))
    }

    @Test
    fun `comfy generate polls history filters outputs and downloads images`() {
        val transport = FakeTransport()
        transport.enqueue(jsonResponse(200, """{"prompt_id":"p-1"}"""))
        transport.enqueue(jsonResponse(200, "{}"))
        transport.enqueue(
            jsonResponse(
                200,
                """{"p-1":{"status":{"completed":true},"outputs":{
                    "9":{"images":[{"filename":"a.png","type":"output"},{"filename":"b.png","type":"output"}]},
                    "10":{"images":[{"filename":"noise.png","type":"output"}]}}}}""",
            ),
        )
        transport.enqueue(ImageGenHttpResponse(200, "image/png", pngBytes()))
        transport.enqueue(ImageGenHttpResponse(200, "image/png", pngBytes()))
        val client = ImageGenClient(transport, FakeClock(), seedProvider = { 42 }, clientIdProvider = { "client-9" })

        val outcome = client.generate(comfy(), "cat")
        outcome as ImageGenOutcome.Success
        assertEquals("只下载选定输出节点的图片", 2, outcome.images.size)
        assertEquals("完整流程共 5 次请求", 5, transport.requests.size)
        val queueBody = transport.requests[0].body!!
        assertTrue("入队请求必须携带运行时工作流", queueBody.contains("\"class_type\":\"KSampler\""))
        assertTrue("入队请求必须带 client_id", queueBody.contains("\"client_id\":\"client-9\""))
        assertTrue("第二步必须轮询历史", transport.requests[1].url.contains("/history/p-1"))
        assertTrue("下载地址必须指向选定图片", transport.requests[3].url.contains("view?filename=a.png"))
        assertFalse("未选定节点的图片不得下载", transport.requests.any { it.url.contains("noise.png") })
    }

    @Test
    fun `comfy selected output without images fails with node list`() {
        val transport = FakeTransport()
        transport.enqueue(jsonResponse(200, """{"prompt_id":"p-1"}"""))
        transport.enqueue(
            jsonResponse(200, """{"p-1":{"status":{"completed":true},"outputs":{"10":{"images":[{"filename":"noise.png"}]}}}}"""),
        )
        val client = ImageGenClient(transport, FakeClock())
        val outcome = client.generate(comfy(outputNodeIds = listOf("9")), "cat")
        outcome as ImageGenOutcome.Failure
        assertEquals("选定输出无图必须拒绝", "SELECTED_OUTPUT_EMPTY", outcome.failure.code)
    }

    @Test
    fun `comfy history timeout classified`() {
        val transport = FakeTransport()
        transport.enqueue(jsonResponse(200, """{"prompt_id":"p-1"}"""))
        transport.enqueueMany(20, jsonResponse(200, "{}"))
        val client = ImageGenClient(transport, FakeClock())
        client.historyDeadlineMs = 2_500
        val outcome = client.generate(comfy(), "cat")
        outcome as ImageGenOutcome.Failure
        assertEquals("轮询超时必须给出超时失败", "COMFY_TIMEOUT", outcome.failure.code)
        assertEquals("超时文案与 PC 一致", "ComfyUI 生图超时（120秒）", outcome.failure.message)
    }

    @Test
    fun `http failures classified through client`() {
        val transport = FakeTransport()
        transport.enqueue(jsonResponse(401, """{"error":"bad"}"""))
        val client = ImageGenClient(transport, FakeClock())
        val outcome = client.generate(openAi(), "cat")
        outcome as ImageGenOutcome.Failure
        assertEquals("401 必须归类为鉴权失败", ImageGenFailureKind.AUTH, outcome.failure.kind)
        assertFalse("鉴权失败不得自动重试", outcome.failure.retryable)
    }

    @Test
    fun `transport exceptions classified for retry policy`() {
        val timeout = FakeTransport()
        timeout.enqueueThrowing(SocketTimeoutException("slow"))
        val timeoutOutcome = ImageGenClient(timeout, FakeClock()).generate(openAi(), "cat")
        timeoutOutcome as ImageGenOutcome.Failure
        assertEquals("读超时必须归类为超时", ImageGenFailureKind.TIMEOUT, timeoutOutcome.failure.kind)
        assertTrue("超时可重试", timeoutOutcome.failure.retryable)

        val refused = FakeTransport()
        refused.enqueueThrowing(java.net.ConnectException("refused"))
        val refusedOutcome = ImageGenClient(refused, FakeClock()).generate(sd(), "cat")
        refusedOutcome as ImageGenOutcome.Failure
        assertEquals("连接拒绝必须归类为连接失败", "CONNECTION_REFUSED", refusedOutcome.failure.code)
    }

    @Test
    fun `localhost config blocked before any request`() {
        val transport = FakeTransport()
        val client = ImageGenClient(transport, FakeClock())
        val outcome = client.generate(openAi(baseUrl = "http://127.0.0.1:7860"), "cat")
        outcome as ImageGenOutcome.Failure
        assertEquals("loopback 端点必须阻断", "LOCALHOST_ENDPOINT", outcome.failure.code)
        assertTrue("提示必须说明手机本机语义", outcome.failure.message.contains("手机"))
        assertTrue("阻断发生在发起请求之前", transport.requests.isEmpty())
    }

    @Test
    fun `non-image download rejected by result verification`() {
        val transport = FakeTransport()
        val b64 = Base64.getEncoder().encodeToString(byteArrayOf(1, 2, 3, 4, 5))
        transport.enqueue(jsonResponse(200, """{"data":[{"b64_json":"$b64"}]}"""))
        val client = ImageGenClient(transport, FakeClock())
        val outcome = client.generate(openAi(), "cat")
        outcome as ImageGenOutcome.Failure
        assertEquals("非图片内容必须被结果校验拒绝", "UNKNOWN_IMAGE_FORMAT", outcome.failure.code)
    }

    @Test
    fun `connection test reuses auth and classifies 401`() {
        val transport = FakeTransport()
        transport.enqueue(jsonResponse(401, ""))
        val client = ImageGenClient(transport, FakeClock())
        val result = client.testConnection(openAi())
        assertEquals("连接测试失败必须保留提示", "API Key 无效（401 Unauthorized）", result.failure!!.message)
        assertEquals(
            "连接测试必须与生成使用同一鉴权构造",
            "Bearer sk-test",
            transport.requests.single().allHeaders()["Authorization"],
        )
    }
}
