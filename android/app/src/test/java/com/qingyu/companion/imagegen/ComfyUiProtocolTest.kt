package com.qingyu.companion.imagegen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-04 端点三：ComfyUI 请求构造（/prompt、/history、/view、/object_info）、
 * 返回解析与失败分类。
 */
class ComfyUiProtocolTest {

    private fun config(apiKey: String = "comfy-key", bindings: ComfyWorkflowBindings? = null) =
        ImageGenConfig.ComfyUi(
            id = "m3", name = "ComfyUI", apiKey = apiKey,
            baseUrl = "http://192.168.1.5:8188", workflow = "{}", bindings = bindings,
        )

    private fun jsonResponse(status: Int, body: String) =
        ImageGenHttpResponse(status, "application/json", body.toByteArray())

    private fun tinyWorkflow(): ComfyWorkflow = linkedMapOf(
        "1" to ComfyNode("CLIPTextEncode", linkedMapOf("text" to "a cat", "clip" to listOf("2", RawNumber("1")))),
        "2" to ComfyNode("CheckpointLoaderSimple", linkedMapOf("ckpt_name" to "sd.safetensors")),
    )

    @Test
    fun `queue request shape matches pc protocol`() {
        val request = ComfyUiProtocol.buildQueueRequest(config(), tinyWorkflow(), "client-1")
        assertEquals("入队打 /prompt 端点", "http://192.168.1.5:8188/prompt", request.url)
        assertEquals("入队必须是 POST", "POST", request.method)
        val body = request.body!!
        assertTrue("请求体必须包含 API 格式工作流", body.contains("\"class_type\":\"CLIPTextEncode\""))
        assertTrue("请求体必须携带 client_id", body.contains("\"client_id\":\"client-1\""))
        assertEquals("Bearer 鉴权必须注入", "Bearer comfy-key", request.allHeaders()["Authorization"])
        assertEquals("X-API-Key 必须同时注入（Comfy Cloud）", "comfy-key", request.allHeaders()["X-API-Key"])
    }

    @Test
    fun `auth headers omitted when api key blank`() {
        val request = ComfyUiProtocol.buildQueueRequest(config(apiKey = "  "), tinyWorkflow(), "c")
        assertTrue("无 key 时不得发送空鉴权头", request.authHeaders.isEmpty())
        assertTrue("无 key 时不得出现 Authorization 头", !request.allHeaders().containsKey("Authorization"))
    }

    @Test
    fun `queue response parsed to prompt id`() {
        val queued = ComfyUiProtocol.parseQueueResponse(jsonResponse(200, """{"prompt_id":"p-1"}"""))
        assertEquals("入队成功必须返回 prompt_id", "p-1", (queued as ComfyUiProtocol.QueueState.Queued).promptId)
    }

    @Test
    fun `queue response without prompt id rejected with detail`() {
        val failed = ComfyUiProtocol.parseQueueResponse(
            jsonResponse(200, """{"error":{"message":"invalid workflow"}}"""),
        )
        failed as ComfyUiProtocol.QueueState.Failed
        assertEquals(
            "缺 prompt_id 必须报错并带上游详情",
            "ComfyUI 未返回 prompt_id: invalid workflow",
            failed.failure.message,
        )
    }

    @Test
    fun `queue http failure classified`() {
        val failed = ComfyUiProtocol.parseQueueResponse(jsonResponse(500, "boom"))
        failed as ComfyUiProtocol.QueueState.Failed
        assertTrue("入队失败文案必须带状态码", failed.failure.message.startsWith("ComfyUI 入队失败 500"))
        assertEquals("5xx 必须可重试", ImageGenFailureKind.SERVER, failed.failure.kind)
    }

    @Test
    fun `history parsing covers pending completed and error`() {
        assertEquals(
            "未出现的条目必须继续轮询",
            ComfyUiProtocol.HistoryState.Pending,
            ComfyUiProtocol.parseHistoryResponse(jsonResponse(200, "{}"), "p-1"),
        )
        assertEquals(
            "执行失败必须报节点/模型检查提示",
            "ComfyUI 工作流执行失败，请检查节点和模型配置",
            (ComfyUiProtocol.parseHistoryResponse(
                jsonResponse(200, """{"p-1":{"status":{"status_str":"error"}}}"""),
                "p-1",
            ) as ComfyUiProtocol.HistoryState.Failed).failure.message,
        )
        val done = ComfyUiProtocol.parseHistoryResponse(
            jsonResponse(200, """{"p-1":{"status":{"completed":true},"outputs":{"9":{"images":[{"filename":"a.png","subfolder":"","type":"output"}]}}}}"""),
            "p-1",
        ) as ComfyUiProtocol.HistoryState.Completed
        assertEquals("完成后必须收集图片引用", 1, done.images.size)
        assertEquals("文件名必须保留", "a.png", done.images[0].filename)

        val noImage = ComfyUiProtocol.parseHistoryResponse(
            jsonResponse(200, """{"p-1":{"status":{"completed":true},"outputs":{}}}"""),
            "p-1",
        ) as ComfyUiProtocol.HistoryState.Failed
        assertEquals(
            "完成但无图片输出必须报明确错误",
            "ComfyUI 工作流已完成，但没有图片输出（SaveImage / PreviewImage / SaveImageAdvanced）",
            noImage.failure.message,
        )
    }

    @Test
    fun `selected output node ids filter other outputs`() {
        val parsed = ComfyUiProtocol.parseHistoryResponse(
            jsonResponse(
                200,
                """{"p-1":{"status":{"completed":true},"outputs":{
                    "9":{"images":[{"filename":"wanted.png","type":"output"}]},
                    "10":{"images":[{"filename":"noise.png","type":"output"}]}}}""",
            ),
            "p-1",
            selectedOutputNodeIds = listOf("9"),
        ) as ComfyUiProtocol.HistoryState.Completed
        assertEquals("只收集用户选定输出节点的图片", 1, parsed.images.size)
        assertEquals("未选定节点的图片必须忽略", "wanted.png", parsed.images[0].filename)

        val empty = ComfyUiProtocol.parseHistoryResponse(
            jsonResponse(200, """{"p-1":{"status":{"completed":true},"outputs":{"10":{"images":[{"filename":"noise.png"}]}}}}"""),
            "p-1",
            selectedOutputNodeIds = listOf("9"),
        ) as ComfyUiProtocol.HistoryState.Failed
        assertEquals(
            "选定输出节点没有产出必须报错并列出节点",
            "ComfyUI 选定的输出节点（9）未产生图片，请在工作流配置中重新选择",
            empty.failure.message,
        )
    }

    @Test
    fun `view request carries filename query and auth`() {
        val request = ComfyUiProtocol.buildViewRequest(
            config(),
            ComfyUiProtocol.ComfyOutputImage(filename = "a b.png", subfolder = "sub/dir", type = "output"),
        )
        assertEquals(
            "下载地址必须带 filename/subfolder/type 查询",
            "http://192.168.1.5:8188/view?filename=a+b.png&subfolder=sub%2Fdir&type=output",
            request.url,
        )
        assertEquals("下载同样注入鉴权", "Bearer comfy-key", request.allHeaders()["Authorization"])
    }

    @Test
    fun `view response mapped to image bytes with mime`() {
        val bytes = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 5)
        val parsed = ComfyUiProtocol.parseViewImage(
            ImageGenHttpResponse(200, "image/png; charset=binary", bytes),
        ) as ParsedImages.Success
        assertEquals("MIME 必须取响应 content-type", "image/png", parsed.images[0].mimeType)
        assertTrue("字节必须原样保留", parsed.images[0].bytes.contentEquals(bytes))

        val failed = ComfyUiProtocol.parseViewImage(ImageGenHttpResponse(404, null, ByteArray(0)))
        assertEquals(
            "下载失败必须报状态码",
            "ComfyUI 图片下载失败 404",
            (failed as ParsedImages.Failure).failure.message,
        )
    }

    @Test
    fun `object info and connection test requests target documented endpoints`() {
        val info = ComfyUiProtocol.buildObjectInfoRequest("http://192.168.1.5:8188/", "k")
        assertEquals("object_info 必须去尾斜杠拼接", "http://192.168.1.5:8188/object_info", info.url)
        val test = ComfyUiProtocol.buildConnectionTestRequest(config())
        assertEquals("连接测试打 /system_stats", "http://192.168.1.5:8188/system_stats", test.url)
        val ok = ComfyUiProtocol.parseConnectionTestResponse(jsonResponse(200, "{}"))
        assertEquals("连接成功文案与 PC 一致", "连接成功，ComfyUI 服务可用", ok.message)
    }

    @Test
    fun `object info failure is non blocking result`() {
        val failed = ComfyUiProtocol.parseObjectInfoResponse(jsonResponse(500, "x"))
        assertEquals("object_info 失败不抛错，只返回失败结果", false, failed.success)
        val ok = ComfyUiProtocol.parseObjectInfoResponse(
            jsonResponse(200, """{"KSampler":{"input":{"steps":["INT",{"min":1}]}}}}"""),
        )
        assertEquals("object_info 成功必须解析节点定义", true, ok.success)
        assertTrue("节点定义必须可索引", ok.objectInfo!!.containsKey("KSampler"))
    }
}
