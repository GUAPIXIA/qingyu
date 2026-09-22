package com.qingyu.companion.mcp.transport

import com.qingyu.companion.mcp.McpServerConfig
import com.qingyu.companion.mcp.McpTransportKind
import kotlinx.serialization.json.JsonElement

/**
 * MCP 传输抽象（S6-06：远程 Streamable HTTP / SSE；网络用接口抽象 + 测试替身）。
 *
 * 生产实现把 [McpHttpEngine] 接到 OkHttp（参考 network/ 的客户端风格）；
 * 单元测试用内存替身驱动，包括 SSE 分帧与断线。
 */

data class McpHttpRequest(
    val url: String,
    val headers: Map<String, String>,
    val body: String,
)

data class McpHttpResponse(
    val status: Int,
    val headers: Map<String, String> = emptyMap(),
    val body: String = "",
) {
    val contentType: String
        get() = headers.entries.firstOrNull { it.key.equals("Content-Type", ignoreCase = true) }?.value.orEmpty()
}

/** SSE 事件流读取端。[readChunk] 返回 null 表示流正常结束；断线以异常抛出。 */
interface McpEventSource {
    suspend fun readChunk(): String?
    fun close()
}

/** HTTP 引擎抽象：只做字节/文本传输，不做业务。 */
interface McpHttpEngine {
    suspend fun post(request: McpHttpRequest): McpHttpResponse
    suspend fun openEventStream(request: McpHttpRequest): McpEventSource
}

/** 服务端事件回调。 */
interface McpTransportListener {
    /** 服务端通知（如 notifications/tools/list_changed）。 */
    fun onServerNotification(method: String, params: JsonElement?) {}

    /** 服务端发起的请求：Android 不声明能力，传输层统一回绝（method not found）。 */
    fun onServerRequestRejected(method: String) {}

    /** 连接断开（终局事件：pending 请求全部失败）。 */
    fun onDisconnected(cause: String) {}
}

/**
 * JSON-RPC 传输。超时/断线都以**终局**异常结束单次调用，不留后台重试（S6-06）。
 */
interface McpTransport {
    val kind: McpTransportKind
    val config: McpServerConfig
    var listener: McpTransportListener?

    /** 建立连接（Streamable HTTP 为会话初始化；SSE 为事件流建立）。 */
    suspend fun connect()

    /** 发送请求并等待 result；超时抛 McpTimeoutException，断线抛 McpDisconnectedException。 */
    suspend fun sendRequest(method: String, params: JsonElement?, timeoutMs: Long): JsonElement?

    suspend fun sendNotification(method: String, params: JsonElement?)

    fun isConnected(): Boolean

    suspend fun close()
}
