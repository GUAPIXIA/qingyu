package com.qingyu.companion.mcp

import com.qingyu.companion.mcp.protocol.McpJsonRpc
import com.qingyu.companion.mcp.protocol.McpMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * JSON-RPC 消息编解码测试（与 PC electron/mcp/client.ts 消息形状一致）。
 */
class McpJsonRpcTest {

    @Test
    fun `请求消息形状与 PC 一致`() {
        val text = McpJsonRpc.request("1", "tools/call", kotlinx.serialization.json.buildJsonObject { })
        assertTrue(text.contains("\"jsonrpc\":\"2.0\""), "请求必须声明 jsonrpc 2.0")
        assertTrue(text.contains("\"id\":\"1\""), "请求必须携带 id 用于响应关联")
        assertTrue(text.contains("\"method\":\"tools/call\""), "请求必须携带 method")
    }

    @Test
    fun `响应解析 result 与 error 两个方向`() {
        val ok = McpJsonRpc.parse("""{"jsonrpc":"2.0","id":"1","result":{"tools":[]}}""")
        assertTrue(ok is McpMessage.Response && ok.result != null, "带 result 的消息应解析为响应")
        val err = McpJsonRpc.parse("""{"jsonrpc":"2.0","id":"1","error":{"code":-32601,"message":"method not found"}}""")
        assertTrue(err is McpMessage.Response && err.errorMessage == "method not found", "带 error 的消息应解析为响应错误")
    }

    @Test
    fun `通知与服务端请求被区分`() {
        val notification = McpJsonRpc.parse("""{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}""")
        assertTrue(notification is McpMessage.Notification, "无 id 的 method 消息是通知")
        val serverRequest = McpJsonRpc.parse("""{"jsonrpc":"2.0","id":"9","method":"sampling/createMessage","params":{}}""")
        assertTrue(serverRequest is McpMessage.ServerRequest, "带 id 的 method 消息是服务端请求")
    }

    @Test
    fun `非法消息解析为 Malformed 不抛异常`() {
        val broken = McpJsonRpc.parse("这不是 JSON")
        assertTrue(broken is McpMessage.Malformed, "非法消息不得抛异常击穿调用方，应标记 Malformed")
        val noIdNoMethod = McpJsonRpc.parse("{\"jsonrpc\":\"2.0\"}")
        assertTrue(noIdNoMethod is McpMessage.Malformed, "缺少 id 与 method 的消息是非法消息")
    }

    @Test
    fun `服务端请求回绝消息是 method not found`() {
        val rejection = McpJsonRpc.methodNotFound("9")
        assertTrue(rejection.contains("\"code\":-32601"), "Android 不声明 MCP 能力，服务端请求必须回绝")
    }

    @Test
    fun `id 关联键使用原始内容`() {
        val response = McpJsonRpc.parse("""{"jsonrpc":"2.0","id":"42","result":null}""") as McpMessage.Response
        assertEquals("42", response.id, "响应 id 必须按原始内容关联 pending 请求")
    }
}
