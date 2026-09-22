package com.qingyu.companion.mcp

import com.qingyu.companion.mcp.transport.HttpSseTransport
import com.qingyu.companion.mcp.transport.McpHttpEngine
import com.qingyu.companion.mcp.transport.McpTransportFactory
import com.qingyu.companion.mcp.transport.McpTransportListener
import com.qingyu.companion.mcp.transport.StreamableHttpTransport
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * 远程传输测试（S6-06：Streamable HTTP / SSE 与 PC 同语义；超时与断线终局；网络用测试替身）。
 */
class McpTransportTest {

    private fun remoteConfig(kind: McpTransportKind = McpTransportKind.STREAMABLE_HTTP) = McpServerConfig(
        id = "srv-1",
        name = "远程 MCP",
        transport = kind,
        url = "https://example.com/mcp",
        headers = mapOf("Authorization" to "Bearer local-secret-token"),
    )

    private fun response(id: String, resultJson: String) =
        """{"jsonrpc":"2.0","id":"$id","result":$resultJson}"""

    // ---------- Streamable HTTP ----------

    @Test
    fun `streamable http 请求响应按 id 关联`() = runTest {
        val engine = FakeHttpEngine()
        engine.postHandler = { request ->
            val id = Regex("\"id\":\"(\\d+)\"").find(request.body)!!.groupValues[1]
            com.qingyu.companion.mcp.transport.McpHttpResponse(
                status = 200,
                headers = mapOf("Content-Type" to "application/json"),
                body = response(id, """{"ok":true}"""),
            )
        }
        val transport = StreamableHttpTransport(remoteConfig(), engine, backgroundScope)
        transport.connect()
        val result = transport.sendRequest("tools/call", null, 60_000)
        assertTrue(result is JsonObject && (result["ok"] as JsonPrimitive).content == "true", "响应必须按 id 关联到请求并原样返回 result")
    }

    @Test
    fun `streamable http 的 SSE 流式响应逐帧解析`() = runTest {
        val engine = FakeHttpEngine()
        var call = 0
        engine.postHandler = { request ->
            call++
            if (call == 1) {
                com.qingyu.companion.mcp.transport.McpHttpResponse(200, mapOf("Content-Type" to "application/json"), response("1", """{"handshake":true}"""))
            } else {
                // 流式响应：一个通知帧 + 一个响应帧，且分帧文本被拆在两个 chunk 语义里（单次 body 也要按 SSE 规则解析）
                com.qingyu.companion.mcp.transport.McpHttpResponse(
                    200,
                    mapOf("Content-Type" to "text/event-stream"),
                    "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n" +
                        "data: ${response("2", """{"tools":[]}""")}\n\n",
                )
            }
        }
        val notifications = mutableListOf<String>()
        val transport = StreamableHttpTransport(remoteConfig(), engine, backgroundScope)
        transport.listener = object : McpTransportListener {
            override fun onServerNotification(method: String, params: kotlinx.serialization.json.JsonElement?) {
                notifications += method
            }
        }
        transport.connect()
        transport.sendRequest("initialize", null, 10_000)
        val result = transport.sendRequest("tools/list", null, 10_000)
        assertTrue(result is JsonObject && result.containsKey("tools"), "SSE 流式响应中的目标帧必须解析为 result")
        assertEquals(listOf("notifications/tools/list_changed"), notifications, "同流中的通知帧必须照常派发")
    }

    @Test
    fun `认证头只在本地请求携带且会话 id 被续用`() = runTest {
        val engine = FakeHttpEngine()
        engine.postHandler = { request ->
            val id = Regex("\"id\":\"(\\d+)\"").find(request.body)!!.groupValues[1]
            com.qingyu.companion.mcp.transport.McpHttpResponse(
                200,
                mapOf("Content-Type" to "application/json", "Mcp-Session-Id" to "sess-1"),
                response(id, "{}"),
            )
        }
        val transport = StreamableHttpTransport(remoteConfig(), engine, backgroundScope)
        transport.connect()
        transport.sendRequest("initialize", null, 10_000)
        transport.sendRequest("tools/list", null, 10_000)
        assertTrue(engine.posts[0].headers["Authorization"] == "Bearer local-secret-token", "本地认证头必须随请求下发，否则远程 MCP 无法通过鉴权")
        assertEquals("sess-1", engine.posts[1].headers["Mcp-Session-Id"], "会话 id 必须在后续请求续用")
    }

    @Test
    fun `HTTP 错误与超时分别终局`() = runTest {
        val engine = FakeHttpEngine()
        engine.postHandler = { com.qingyu.companion.mcp.transport.McpHttpResponse(500) }
        val transport = StreamableHttpTransport(remoteConfig(), engine, backgroundScope)
        transport.connect()
        assertFailsWith<com.qingyu.companion.mcp.McpHttpException>("HTTP 5xx 必须以明确错误终局") {
            transport.sendRequest("tools/call", null, 1_000)
        }

        // 202 空响应 → 永远没有响应体：必须按超时终局，且不留后台等待
        engine.postHandler = { com.qingyu.companion.mcp.transport.McpHttpResponse(202) }
        assertFailsWith<com.qingyu.companion.mcp.McpTimeoutException>("请求超时必须终局失败，不允许永久挂起") {
            transport.sendRequest("tools/call", null, 1_000)
        }
    }

    @Test
    fun `迟到的超时响应被忽略不影响后续请求`() = runTest {
        val engine = FakeHttpEngine()
        var call = 0
        engine.postHandler = { request ->
            call++
            val id = Regex("\"id\":\"(\\d+)\"").find(request.body)!!.groupValues[1]
            when (call) {
                1 -> com.qingyu.companion.mcp.transport.McpHttpResponse(202) // 第一次请求无响应 → 超时
                else -> com.qingyu.companion.mcp.transport.McpHttpResponse(
                    200,
                    mapOf("Content-Type" to "text/event-stream"),
                    // 同一流里带回旧 id（迟到）与新 id 的响应帧
                    "data: ${response("1", """{"late":true}""")}\n\ndata: ${response(id, """{"fresh":true}""")}\n\n",
                )
            }
        }
        val transport = StreamableHttpTransport(remoteConfig(), engine, backgroundScope)
        transport.connect()
        assertFailsWith<com.qingyu.companion.mcp.McpTimeoutException>("第一次请求必须超时终局") {
            transport.sendRequest("tools/call", null, 1_000)
        }
        val result = transport.sendRequest("tools/list", null, 1_000)
        assertTrue(result is JsonObject && result.containsKey("fresh"), "迟到的旧响应不得污染新请求的结果")
    }

    @Test
    fun `服务端事件流断线让 in-flight 请求终局失败`() = runTest {
        val engine = FakeHttpEngine()
        val source = FakeEventSource()
        engine.streamHandler = { source }
        engine.postHandler = { com.qingyu.companion.mcp.transport.McpHttpResponse(202) }
        val transport = StreamableHttpTransport(remoteConfig(), engine, backgroundScope)
        transport.connect()
        transport.startServerEventStream()
        runCurrent()

        val inFlight = async {
            runCatching { transport.sendRequest("tools/call", null, 60_000) }
        }
        runCurrent() // 请求已发出（202 无响应体），挂起等待响应

        source.fail(java.io.IOException("连接被重置"))
        runCurrent()

        val outcome = inFlight.await()
        assertTrue(outcome.exceptionOrNull() is com.qingyu.companion.mcp.McpDisconnectedException, "事件流断线后 in-flight 请求必须以断线终局")
        assertTrue(!transport.isConnected(), "断线后传输必须标记为未连接，后续请求快速失败")
    }

    @Test
    fun `会话失效 404 按断线终局`() = runTest {
        val engine = FakeHttpEngine()
        var call = 0
        engine.postHandler = { request ->
            call++
            val id = Regex("\"id\":\"(\\d+)\"").find(request.body)!!.groupValues[1]
            when (call) {
                1 -> com.qingyu.companion.mcp.transport.McpHttpResponse(
                    200,
                    mapOf("Content-Type" to "application/json", "Mcp-Session-Id" to "sess-1"),
                    response(id, "{}"),
                )
                else -> com.qingyu.companion.mcp.transport.McpHttpResponse(404)
            }
        }
        val transport = StreamableHttpTransport(remoteConfig(), engine, backgroundScope)
        transport.connect()
        transport.sendRequest("initialize", null, 10_000)
        assertFailsWith<com.qingyu.companion.mcp.McpDisconnectedException>("会话失效必须按断线终局，不能把 404 当普通响应") {
            transport.sendRequest("tools/list", null, 10_000)
        }
    }

    // ---------- HTTP+SSE ----------

    @Test
    fun `http sse 传输经事件流取回响应`() = runTest {
        val engine = FakeHttpEngine()
        val source = FakeEventSource()
        engine.streamHandler = { source }
        engine.postHandler = { request ->
            assertTrue(request.url.startsWith("https://example.com/messages"), "POST 必须发往 endpoint 事件给出的地址，实际=${request.url}")
            com.qingyu.companion.mcp.transport.McpHttpResponse(202)
        }
        val transport = HttpSseTransport(remoteConfig(McpTransportKind.SSE), engine, backgroundScope)
        transport.connect()
        runCurrent()
        source.emit("event: endpoint\ndata: /messages?session=abc\n\n")
        runCurrent()

        val inFlight = async { runCatching { transport.sendRequest("tools/call", null, 60_000) } }
        runCurrent()
        // 响应分两块到达（跨块分帧）
        source.emit("data: {\"jsonrpc\":\"2.0\",\"id\":\"1\",")
        source.emit("\"result\":{\"via\":\"sse\"}}\n\n")
        runCurrent()

        val outcome = inFlight.await().getOrThrow()
        assertTrue(outcome is JsonObject && (outcome["via"] as JsonPrimitive).content == "sse", "SSE 流上的响应必须按 id 关联给请求")
    }

    @Test
    fun `http sse 断线让 pending 请求全部终局失败`() = runTest {
        val engine = FakeHttpEngine()
        val source = FakeEventSource()
        engine.streamHandler = { source }
        engine.postHandler = { com.qingyu.companion.mcp.transport.McpHttpResponse(202) }
        val transport = HttpSseTransport(remoteConfig(McpTransportKind.SSE), engine, backgroundScope)
        transport.connect()
        runCurrent()
        source.emit("event: endpoint\ndata: /messages\n\n")
        runCurrent()

        val inFlight = async { runCatching { transport.sendRequest("tools/call", null, 60_000) } }
        runCurrent()
        source.endStream()
        runCurrent()

        val outcome = inFlight.await()
        assertTrue(outcome.exceptionOrNull() is com.qingyu.companion.mcp.McpDisconnectedException, "SSE 流结束必须让 pending 请求全部断线终局")
    }

    @Test
    fun `endpoint 相对路径按 SSE 地址 origin 解析`() {
        assertEquals(
            "https://example.com/messages?x=1",
            HttpSseTransport.resolveEndpoint("https://example.com/sse", "/messages?x=1"),
            "相对 endpoint 必须解析成绝对地址，否则 POST 发错地方",
        )
        assertEquals(
            "https://other.example.com/post",
            HttpSseTransport.resolveEndpoint("https://example.com/sse", "https://other.example.com/post"),
            "绝对 endpoint 必须原样使用",
        )
    }

    // ---------- 工厂与 stdio 禁令 ----------

    @Test
    fun `工厂拒绝创建 stdio 传输且只创建远程传输`() = runTest {
        val engine = FakeHttpEngine()
        assertFailsWith<com.qingyu.companion.mcp.McpStdioForbiddenException>("stdio 必须被拒绝创建，Android 不启动本地进程") {
            McpTransportFactory.create(
                McpServerConfig(id = "s", name = "本地", transport = McpTransportKind.STDIO, command = "tool.exe"),
                engine,
                backgroundScope,
            )
        }
        val streamable = McpTransportFactory.create(remoteConfig(McpTransportKind.STREAMABLE_HTTP), engine, backgroundScope)
        assertEquals(McpTransportKind.STREAMABLE_HTTP, streamable.kind, "Streamable HTTP 必须可创建")
        val sse = McpTransportFactory.create(remoteConfig(McpTransportKind.SSE), engine, backgroundScope)
        assertEquals(McpTransportKind.SSE, sse.kind, "HTTP+SSE 必须可创建")
    }

    @Test
    fun `stdio 配置即使被直接塞进远程传输也被拒绝`() = runTest {
        val stdioConfig = McpServerConfig(id = "s", name = "本地", transport = McpTransportKind.STDIO, command = "tool.exe")
        val transport = StreamableHttpTransport(stdioConfig, FakeHttpEngine(), backgroundScope)
        assertFailsWith<com.qingyu.companion.mcp.McpStdioForbiddenException>("纵深防御：stdio 配置在任何传输入口都必须被拒绝") {
            transport.connect()
        }
    }
}
