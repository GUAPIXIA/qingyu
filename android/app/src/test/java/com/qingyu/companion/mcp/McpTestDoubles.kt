package com.qingyu.companion.mcp

import com.qingyu.companion.mcp.client.McpClientApi
import com.qingyu.companion.mcp.transport.McpEventSource
import com.qingyu.companion.mcp.transport.McpHttpEngine
import com.qingyu.companion.mcp.transport.McpHttpRequest
import com.qingyu.companion.mcp.transport.McpHttpResponse
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * 测试替身（纯 JVM）：HTTP 引擎、SSE 事件流、客户端、工具宿主、记录型日志器。
 * 网络全部走接口抽象（S6-06 工程纪律）。
 */

class FakeHttpEngine : McpHttpEngine {
    val posts = mutableListOf<McpHttpRequest>()
    val streams = mutableListOf<McpHttpRequest>()
    var postHandler: suspend (McpHttpRequest) -> McpHttpResponse = { McpHttpResponse(status = 200) }
    var streamHandler: suspend (McpHttpRequest) -> McpEventSource = { FakeEventSource() }

    override suspend fun post(request: McpHttpRequest): McpHttpResponse {
        posts += request
        return postHandler(request)
    }

    override suspend fun openEventStream(request: McpHttpRequest): McpEventSource {
        streams += request
        return streamHandler(request)
    }
}

/**
 * SSE 事件流替身：[emit] 喂原始分帧文本，[endStreams] 正常结束，
 * [fail] 模拟断线（readChunk 抛出）。
 */
class FakeEventSource : McpEventSource {
    private val chunks = Channel<String>(capacity = Channel.UNLIMITED)

    suspend fun emit(text: String) {
        chunks.send(text)
    }

    fun endStream() {
        chunks.close()
    }

    fun fail(error: Exception) {
        chunks.close(error)
    }

    override suspend fun readChunk(): String? {
        val result = chunks.receiveCatching()
        result.exceptionOrNull()?.let { throw it } // fail() 注入的断线错误必须真的抛出
        return result.getOrNull()
    }

    override fun close() {
        chunks.close()
    }
}

class RecordingLogger : McpLogger {
    val events = mutableListOf<McpLogEvent>()
    val lines: List<String> get() = events.map { it.render() }
    override fun log(event: McpLogEvent) {
        events += event
    }
}

class FakeToolHost(
    var configs: Map<String, McpServerConfig> = emptyMap(),
    var tools: Map<Pair<String, String>, McpTool> = emptyMap(),
    var callHandler: suspend (String, String, JsonObject, Long) -> McpToolResult = { _, _, _, _ ->
        McpToolResult(content = emptyList())
    },
) : McpToolHost {
    val calls = mutableListOf<Triple<String, String, JsonObject>>()

    override fun serverConfig(serverId: String): McpServerConfig? = configs[serverId]
    override fun findTool(serverId: String, toolName: String): McpTool? = tools[serverId to toolName]

    override suspend fun callTool(serverId: String, toolName: String, args: JsonObject, timeoutMs: Long): McpToolResult {
        calls += Triple(serverId, toolName, args)
        return callHandler(serverId, toolName, args, timeoutMs)
    }
}

class FakeMcpClient(
    // @JvmField：直暴露字段不生成 getTools() 访问器——否则与下面的覆写 getTools() JVM 签名冲突
    @JvmField var tools: List<McpTool> = emptyList(),
    var onCall: suspend (String, JsonObject, Long) -> McpToolResult = { _, _, _ -> McpToolResult(emptyList()) },
) : McpClientApi {
    var connected = false
        private set
    var connectCount = 0
        private set
    val calls = mutableListOf<Pair<String, JsonObject>>()

    override suspend fun connect(): List<McpTool> {
        connectCount++
        connected = true
        return tools
    }

    override fun getTools(): List<McpTool> = tools

    override suspend fun callTool(toolName: String, args: JsonObject, timeoutMs: Long): McpToolResult {
        calls += toolName to args
        return onCall(toolName, args, timeoutMs)
    }

    override suspend fun disconnect() {
        connected = false
    }

    override fun isConnected(): Boolean = connected
}

/** 脚本化传输替身（客户端单测用）。 */
class FakeTransport : com.qingyu.companion.mcp.transport.McpTransport {
    override val kind = McpTransportKind.STREAMABLE_HTTP
    override val config = McpServerConfig(
        id = "srv-fake",
        name = "测试服务器",
        transport = McpTransportKind.STREAMABLE_HTTP,
        url = "https://example.com/mcp",
    )
    override var listener: com.qingyu.companion.mcp.transport.McpTransportListener? = null

    var connected = false
    val requests = mutableListOf<Pair<String, JsonElement?>>()
    val notifications = mutableListOf<String>()
    var handler: suspend (String, JsonElement?, Long) -> JsonElement? = { _, _, _ -> null }
    var errorToThrow: Exception? = null

    override suspend fun connect() {
        connected = true
    }

    override suspend fun sendRequest(method: String, params: JsonElement?, timeoutMs: Long): JsonElement? {
        requests += method to params
        errorToThrow?.let { err ->
            errorToThrow = null
            throw err
        }
        return handler(method, params, timeoutMs)
    }

    override suspend fun sendNotification(method: String, params: JsonElement?) {
        notifications += method
    }

    override fun isConnected(): Boolean = connected

    override suspend fun close() {
        connected = false
    }

    fun dropConnection(cause: String = "测试断线") {
        connected = false
        listener?.onDisconnected(cause)
    }
}
