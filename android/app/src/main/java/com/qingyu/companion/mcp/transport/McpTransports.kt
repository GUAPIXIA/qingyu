package com.qingyu.companion.mcp.transport

import com.qingyu.companion.mcp.McpDisconnectedException
import com.qingyu.companion.mcp.McpHttpException
import com.qingyu.companion.mcp.McpProtocolException
import com.qingyu.companion.mcp.McpRpcException
import com.qingyu.companion.mcp.McpServerConfig
import com.qingyu.companion.mcp.McpStdioForbiddenException
import com.qingyu.companion.mcp.McpTimeoutException
import com.qingyu.companion.mcp.McpTransportKind
import com.qingyu.companion.mcp.protocol.McpJsonRpc
import com.qingyu.companion.mcp.protocol.McpMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import java.util.concurrent.ConcurrentHashMap

/**
 * JSON-RPC over HTTP 传输基类：请求 id 关联、超时、断线终局。
 *
 * 终局语义（S6-06）：
 * - 超时：单次请求以 McpTimeoutException 结束，从 pending 移除（迟到响应忽略，不重试）；
 * - 断开/断线：pending 全部以 McpDisconnectedException 失败，后续请求快速失败；
 * - 服务端发起的请求统一以 method-not-found 回绝（Android 不声明 MCP 能力），
 *   工具执行不可能由服务端或工具返回文本触发。
 */
abstract class AbstractJsonRpcTransport(
    final override val config: McpServerConfig,
    protected val engine: McpHttpEngine,
    protected val scope: CoroutineScope,
) : McpTransport {

    override var listener: McpTransportListener? = null

    protected var sessionId: String? = null

    @Volatile
    private var connected: Boolean = false

    private var nextId = 0L
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JsonElement?>>()

    override fun isConnected(): Boolean = connected

    protected fun markConnected() {
        connected = true
    }

    /** 传输层发一次 HTTP POST（子类实现）。 */
    protected abstract suspend fun performPost(body: String): McpHttpResponse

    /** 发送通知的 HTTP 语义可能不同（202 无响应体），子类可覆盖。 */
    protected open suspend fun performPostNotification(body: String): McpHttpResponse = performPost(body)

    override suspend fun sendRequest(method: String, params: JsonElement?, timeoutMs: Long): JsonElement? {
        if (!connected) throw McpDisconnectedException("${config.name} 未连接")
        val id = nextId().toString()
        val deferred = CompletableDeferred<JsonElement?>()
        pending[id] = deferred
        try {
            val response = performPost(McpJsonRpc.request(id, method, params))
            ingestHttpResponse(response)
        } catch (err: Exception) {
            pending.remove(id)
            when (err) {
                is McpHttpException, is McpProtocolException, is McpRpcException, is McpTimeoutException -> throw err
                else -> {
                    failAllPending("连接中断: ${err.message}")
                    throw McpDisconnectedException("MCP 连接已断开: ${err.message}")
                }
            }
        }
        return try {
            withTimeout(timeoutMs) { deferred.await() }
        } catch (cancelled: TimeoutCancellationException) {
            pending.remove(id) // 终局：迟到的响应被忽略，不重试
            throw McpTimeoutException("请求超时: $method（${timeoutMs / 1000} 秒）")
        }
    }

    override suspend fun sendNotification(method: String, params: JsonElement?) {
        if (!connected) throw McpDisconnectedException("${config.name} 未连接")
        try {
            performPostNotification(McpJsonRpc.notification(method, params))
        } catch (err: Exception) {
            when (err) {
                is McpHttpException, is McpProtocolException, is McpTimeoutException -> throw err
                else -> {
                    failAllPending("连接中断: ${err.message}")
                    throw McpDisconnectedException("MCP 连接已断开: ${err.message}")
                }
            }
        }
    }

    /**
     * 把 HTTP 响应体作为消息流摄取：
     * - Content-Type: text/event-stream → SSE 分帧后逐事件处理（Streamable HTTP 流式响应）；
     * - 空 body（如 202 Accepted）→ 无消息（响应从 SSE 流到达）；
     * - 其余 → 单条 JSON-RPC 消息。
     */
    protected fun ingestHttpResponse(response: McpHttpResponse) {
        captureSessionId(response)
        val contentType = response.contentType
        when {
            contentType.contains("event-stream", ignoreCase = true) -> {
                val parser = SseFrameParser()
                val events = parser.feed(response.body)
                parser.finish()
                for (event in events) handleMessage(event.data)
            }
            response.body.isBlank() -> Unit
            else -> handleMessage(response.body)
        }
    }

    protected fun captureSessionId(response: McpHttpResponse) {
        response.headers.entries
            .firstOrNull { it.key.equals("Mcp-Session-Id", ignoreCase = true) }
            ?.value
            ?.takeIf { it.isNotBlank() }
            ?.let { sessionId = it }
    }

    /** 处理一条 JSON-RPC 消息（响应完成 pending；通知转发 listener；服务端请求回绝）。 */
    protected fun handleMessage(text: String) {
        when (val message = McpJsonRpc.parse(text)) {
            is McpMessage.Response -> {
                val deferred = pending.remove(message.id) ?: return // 迟到/未知响应：忽略
                if (message.errorMessage != null) {
                    deferred.completeExceptionally(McpRpcException(message.errorCode ?: 0L, message.errorMessage))
                } else {
                    deferred.complete(message.result)
                }
            }
            is McpMessage.Notification -> listener?.onServerNotification(message.method, message.params)
            is McpMessage.ServerRequest -> {
                // Android 不声明任何 MCP 能力：服务端请求不可能触发本地工具执行，直接回绝。
                listener?.onServerRequestRejected(message.method)
                val rejection = McpJsonRpc.methodNotFound(message.id)
                scope.launch { runCatching { performPostNotification(rejection) } }
            }
            is McpMessage.Malformed -> Unit // 与 PC 一致：忽略非 JSON/非法消息
        }
    }

    /** 传输断开（终局）：pending 全部失败，标记未连接。 */
    protected fun markDisconnected(cause: String) {
        if (!connected && pending.isEmpty()) return
        connected = false
        failAllPending(cause)
        listener?.onDisconnected(cause)
    }

    private fun failAllPending(cause: String) {
        val error = McpDisconnectedException(cause)
        for ((_, deferred) in pending) {
            deferred.completeExceptionally(error)
        }
        pending.clear()
    }

    private fun nextId(): Long = synchronized(this) { ++nextId }

    override suspend fun close() {
        connected = false
        failAllPending("连接已关闭")
    }
}

/**
 * Streamable HTTP（远程 MCP，S6-06 主通道）：HTTP POST 承载 JSON-RPC，
 * 响应可以是单条 JSON 也可以是 text/event-stream 流（SSE 分帧）；
 * 另有可选 GET 服务端事件流用于服务端主动消息（如 notifications/tools/list_changed）。
 */
class StreamableHttpTransport(
    config: McpServerConfig,
    engine: McpHttpEngine,
    scope: CoroutineScope,
) : AbstractJsonRpcTransport(config, engine, scope) {

    override val kind: McpTransportKind = McpTransportKind.STREAMABLE_HTTP

    private val serverStream = SseServerStream()

    override suspend fun connect() {
        requireRemoteUrl()
        markConnected()
    }

    /** 打开 GET 服务端事件流（可选能力；断线同样走终局语义）。 */
    fun startServerEventStream() {
        serverStream.open()
    }

    override suspend fun performPost(body: String): McpHttpResponse {
        val response = engine.post(buildRequest(body))
        captureSessionId(response)
        // Streamable HTTP：会话失效（404 + 会话已建立）按断线终局处理
        if (response.status == 404 && sessionId != null) {
            throw McpDisconnectedException("MCP 会话已失效（HTTP 404）")
        }
        if (response.status !in 200..299) {
            throw McpHttpException(response.status, "MCP HTTP ${response.status}")
        }
        return response
    }

    override suspend fun close() {
        serverStream.close()
        super.close()
    }

    private fun buildRequest(body: String): McpHttpRequest {
        val headers = mutableMapOf(
            "Content-Type" to "application/json",
            "Accept" to "application/json, text/event-stream",
        )
        headers.putAll(config.headers) // 认证头仅本地使用，不进 public config / 普通日志
        sessionId?.let { headers["Mcp-Session-Id"] = it }
        return McpHttpRequest(url = requireRemoteUrl(), headers = headers, body = body)
    }

    private fun requireRemoteUrl(): String {
        if (config.transport == McpTransportKind.STDIO) throw McpStdioForbiddenException()
        return config.url ?: throw McpProtocolException("远程 MCP 配置缺少 url")
    }

    private inner class SseServerStream {
        private var source: McpEventSource? = null
        private var job: Job? = null

        fun open() {
            job = scope.launch {
                val headers = mutableMapOf("Accept" to "text/event-stream")
                headers.putAll(config.headers)
                sessionId?.let { headers["Mcp-Session-Id"] = it }
                val opened = try {
                    engine.openEventStream(McpHttpRequest(requireRemoteUrl(), headers, body = ""))
                } catch (err: Exception) {
                    markDisconnected("服务端事件流打开失败: ${err.message}")
                    return@launch
                }
                source = opened
                pump(opened)
            }
        }

        private suspend fun pump(stream: McpEventSource) {
            val parser = SseFrameParser()
            try {
                while (true) {
                    val chunk = stream.readChunk() ?: break
                    for (event in parser.feed(chunk)) handleMessage(event.data)
                }
                parser.finish()
                markDisconnected("服务端事件流结束")
            } catch (err: Exception) {
                markDisconnected("服务端事件流断开: ${err.message}")
            }
        }

        fun close() {
            job?.cancel()
            source?.close()
            source = null
        }
    }
}

/**
 * HTTP+SSE（legacy MCP 传输，PC 的 `sse`）：
 * GET 打开事件流（首个 `event: endpoint` 给出 POST 目标），JSON-RPC 请求经 POST 发出，
 * 响应从 SSE 流回到达。断线（流结束/异常）即终局。
 */
class HttpSseTransport(
    config: McpServerConfig,
    engine: McpHttpEngine,
    scope: CoroutineScope,
) : AbstractJsonRpcTransport(config, engine, scope) {

    override val kind: McpTransportKind = McpTransportKind.SSE

    private val endpoint = CompletableDeferred<String>()
    private var streamJob: Job? = null
    private var source: McpEventSource? = null

    override suspend fun connect() {
        if (config.transport == McpTransportKind.STDIO) throw McpStdioForbiddenException()
        val url = config.url ?: throw McpProtocolException("远程 MCP 配置缺少 url")
        markConnected()
        streamJob = scope.launch {
            val headers = mutableMapOf("Accept" to "text/event-stream")
            headers.putAll(config.headers)
            val opened = try {
                engine.openEventStream(McpHttpRequest(url, headers, body = ""))
            } catch (err: Exception) {
                markDisconnected("SSE 事件流打开失败: ${err.message}")
                return@launch
            }
            source = opened
            val parser = SseFrameParser()
            try {
                while (true) {
                    val chunk = opened.readChunk() ?: break
                    for (event in parser.feed(chunk)) {
                        if (event.event == "endpoint" && !endpoint.isCompleted) {
                            endpoint.complete(resolveEndpoint(url, event.data.trim()))
                        } else {
                            handleMessage(event.data)
                        }
                    }
                }
                parser.finish()
                markDisconnected("SSE 事件流结束")
            } catch (err: Exception) {
                markDisconnected("SSE 事件流断开: ${err.message}")
            }
        }
    }

    override suspend fun performPost(body: String): McpHttpResponse {
        val target = withTimeoutOrNull(ENDPOINT_WAIT_MS) { endpoint.await() }
            ?: throw McpTimeoutException("SSE endpoint 事件未到达（${ENDPOINT_WAIT_MS / 1000} 秒）")
        val headers = mutableMapOf("Content-Type" to "application/json")
        headers.putAll(config.headers)
        sessionId?.let { headers["Mcp-Session-Id"] = it }
        val response = engine.post(McpHttpRequest(target, headers, body))
        captureSessionId(response)
        if (response.status !in 200..299) {
            throw McpHttpException(response.status, "MCP HTTP ${response.status}")
        }
        // legacy SSE：响应从事件流回来；POST body 一般为空（202 Accepted）
        if (response.body.isNotBlank()) ingestHttpResponse(response)
        return response
    }

    override suspend fun close() {
        streamJob?.cancel()
        source?.close()
        source = null
        super.close()
    }

    companion object {
        private const val ENDPOINT_WAIT_MS = 10_000L

        /** 把 endpoint 事件给出的路径解析为可 POST 的绝对地址（相对路径按 SSE URL 的 origin 解析）。 */
        fun resolveEndpoint(sseUrl: String, endpoint: String): String {
            if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) return endpoint
            val schemeEnd = sseUrl.indexOf("://")
            if (schemeEnd < 0) throw McpProtocolException("SSE URL 非法: $sseUrl")
            val authorityEnd = sseUrl.indexOf('/', startIndex = schemeEnd + 3)
            val origin = if (authorityEnd < 0) sseUrl else sseUrl.substring(0, authorityEnd)
            return when {
                endpoint.startsWith("/") -> origin + endpoint
                else -> "$origin/$endpoint"
            }
        }
    }
}
