package com.qingyu.companion.mcp

import com.qingyu.companion.mcp.client.McpClient
import com.qingyu.companion.mcp.client.McpClientInfo
import com.qingyu.companion.mcp.schema.ToolSchemaNode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * MCP 客户端测试（与 PC electron/mcp/client.ts 对齐：握手、工具清单/参数 schema、超时与断线终局）。
 */
class McpClientTest {

    private fun toolsListResult(): JsonObject = Json.parseToJsonElement(
        """{"tools":[{"name":"search","description":"搜索","inputSchema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}]}""",
    ) as JsonObject

    private fun initializeResult(): JsonObject = Json.parseToJsonElement(
        """{"protocolVersion":"2024-11-05","capabilities":{}}""",
    ) as JsonObject

    @Test
    fun `连接握手顺序与 PC 一致并加载工具清单`() = runTest {
        val transport = FakeTransport()
        val client = McpClient(serverId = "srv-1", transport = transport, scope = this, clientInfo = McpClientInfo("轻Tavern", "android"))
        transport.handler = { method, _, _ ->
            when (method) {
                "initialize" -> initializeResult()
                "tools/list" -> toolsListResult()
                else -> null
            }
        }

        val tools = client.connect()

        assertEquals(
            listOf("initialize", "tools/list"),
            transport.requests.map { it.first },
            "握手必须先 initialize 再 tools/list，顺序与 PC 相同",
        )
        assertEquals(
            listOf("notifications/initialized"),
            transport.notifications,
            "握手后必须发送 notifications/initialized（PC 相同语义）",
        )
        assertEquals(1, tools.size, "工具清单必须加载成功")
        val tool = tools[0]
        assertEquals("srv-1", tool.serverId, "工具必须归属正确的 server")
        assertEquals("search", tool.name, "工具名解析错误")
        assertTrue(tool.inputSchema is ToolSchemaNode.ObjectNode, "参数 schema 必须解析为 object 节点，供参数校验使用")
        assertTrue(client.isConnected(), "握手完成后客户端必须处于已连接状态")
    }

    @Test
    fun `协议版本不符报协议错误`() = runTest {
        val transport = FakeTransport()
        val client = McpClient("srv-1", transport, this)
        transport.handler = { _, _, _ ->
            Json.parseToJsonElement("""{"protocolVersion":"1999-01-01"}""") as JsonObject
        }
        assertFailsWith<McpProtocolException>("协议版本不符必须报错而不是静默继续，否则语义漂移不可控") {
            client.connect()
        }
    }

    @Test
    fun `callTool 携带 name 与 arguments 并解析结果`() = runTest {
        val transport = FakeTransport()
        val client = McpClient("srv-1", transport, this)
        transport.handler = { method, _, _ ->
            when (method) {
                "initialize" -> initializeResult()
                "tools/list" -> toolsListResult()
                "tools/call" -> Json.parseToJsonElement(
                    """{"content":[{"type":"text","text":"结果 A"},{"type":"image","data":"aGk=","mimeType":"image/png"}],"isError":false}""",
                ) as JsonObject
                else -> null
            }
        }
        client.connect()
        val result = client.callTool("search", buildJsonObject { put("query", "轻语") })

        val callParams = transport.requests.last().second as JsonObject
        assertEquals("search", (callParams["name"] as kotlinx.serialization.json.JsonPrimitive).content, "tools/call 必须携带工具名")
        assertTrue(callParams.containsKey("arguments"), "tools/call 必须携带 arguments")
        assertEquals("结果 A", result.textContent(), "text 块必须被抽取")
        assertEquals(false, result.isError, "isError=false 必须如实解析")
    }

    @Test
    fun `JSON-RPC error 以 McpRpcException 终局`() = runTest {
        val transport = FakeTransport()
        val client = McpClient("srv-1", transport, this)
        transport.handler = { method, _, _ ->
            when (method) {
                "initialize" -> initializeResult()
                "tools/list" -> toolsListResult()
                else -> null
            }
        }
        client.connect()
        transport.handler = { _, _, _ -> null }
        transport.errorToThrow = McpRpcException(-32602, "invalid params")
        assertFailsWith<McpRpcException>("服务端 error 必须以明确异常终局") {
            client.callTool("search", buildJsonObject { put("query", "x") })
        }
    }

    @Test
    fun `超时与断线都是终局失败`() = runTest {
        val transport = FakeTransport()
        val client = McpClient("srv-1", transport, this)
        transport.handler = { method, _, _ ->
            when (method) {
                "initialize" -> initializeResult()
                "tools/list" -> toolsListResult()
                else -> null
            }
        }
        client.connect()

        transport.errorToThrow = McpTimeoutException("请求超时: tools/call（60 秒）")
        assertFailsWith<McpTimeoutException>("超时必须以终局异常结束") {
            client.callTool("search", buildJsonObject { put("query", "x") })
        }

        transport.errorToThrow = McpDisconnectedException("MCP 连接已断开")
        assertFailsWith<McpDisconnectedException>("断线必须以终局异常结束，且不得自动重试") {
            client.callTool("search", buildJsonObject { put("query", "x") })
        }
    }

    @Test
    fun `断线回调置位且后续调用快速失败`() = runTest {
        val transport = FakeTransport()
        val client = McpClient("srv-1", transport, this)
        var disconnectCause: String? = null
        client.onDisconnected = { cause -> disconnectCause = cause }
        transport.handler = { method, _, _ ->
            when (method) {
                "initialize" -> initializeResult()
                "tools/list" -> toolsListResult()
                else -> null
            }
        }
        client.connect()
        transport.dropConnection("网络断开")

        assertEquals("网络断开", disconnectCause, "断线事件必须传达给上层（终局可见）")
        assertTrue(!client.isConnected(), "断线后客户端必须处于未连接状态")
        assertFailsWith<McpProtocolException>("断线后调用必须快速失败，不允许半死状态") {
            client.callTool("search", buildJsonObject { put("query", "x") })
        }
    }

    @Test
    fun `tools list changed 通知触发工具清单刷新`() = runTest {
        val transport = FakeTransport()
        val client = McpClient("srv-1", transport, this)
        var changed = false
        client.onToolsChanged = { changed = true }
        var listRound = 0
        transport.handler = { method, _, _ ->
            when (method) {
                "initialize" -> initializeResult()
                "tools/list" -> {
                    listRound++
                    if (listRound == 1) toolsListResult()
                    else Json.parseToJsonElement("""{"tools":[]}""") as JsonObject
                }
                else -> null
            }
        }
        client.connect()
        transport.listener?.onServerNotification("notifications/tools/list_changed", null)
        testScheduler.runCurrent()

        assertTrue(changed, "工具清单变化通知必须触发刷新回调")
        assertTrue(client.getTools().isEmpty(), "刷新后工具清单必须反映服务端最新状态")
    }

    @Test
    fun `工具清单非法结构报协议错误`() = runTest {
        val transport = FakeTransport()
        val client = McpClient("srv-1", transport, this)
        transport.handler = { method, _, _ ->
            when (method) {
                "initialize" -> initializeResult()
                "tools/list" -> Json.parseToJsonElement("""{"tools":[{"description":"缺名字"}]}""") as JsonObject
                else -> null
            }
        }
        assertFailsWith<McpProtocolException>("缺 name 的工具条目必须报协议错误，不能带病进入工具清单") {
            client.connect()
        }
    }
}
