package com.qingyu.companion.network

import com.qingyu.companion.model.AiChunkPayload
import com.qingyu.companion.model.AiDonePayload
import com.qingyu.companion.model.AiErrorPayload
import com.qingyu.companion.model.AiUsagePayload
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.model.SessionUpdatedPayload
import com.qingyu.companion.model.WsEnvelope
import com.qingyu.companion.model.WsEvents
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * OkHttp WebSocket 实现。
 * 线程模型：OkHttp 回调线程负责解析帧并 tryEmit 到事件流；
 * 重连调度在独立 [CoroutineScope] 中，指数退避。
 */
class WsClientImpl(
    private val json: Json,
) : WsClient {

    private val _state = MutableStateFlow(WsClient.State.DISCONNECTED)
    override val state: StateFlow<WsClient.State> = _state.asStateFlow()

    private val _events = MutableSharedFlow<CompanionEvent>(
        extraBufferCapacity = 256,
    )
    override val events: SharedFlow<CompanionEvent> = _events.asSharedFlow()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private var connection: ServerConnection? = null
    private var webSocket: WebSocket? = null
    private var client: OkHttpClient? = null

    // M-32 修复：OkHttp 回调线程与协程线程并发读写，加 @Volatile 保证可见性
    // （此前竞态导致间歇性多余重连/旧 socket 误判）
    @Volatile private var stopped = true
    @Volatile private var reconnectAttempts = 0

    override suspend fun connect(connection: ServerConnection) {
        this.connection = connection
        stopped = false
        reconnectAttempts = 0
        openSocket(connection)
    }

    override fun disconnect() {
        stopped = true
        connection = null
        reconnectAttempts = 0
        webSocket?.cancel()
        webSocket = null
        client?.dispatcher?.cancelAll()
        client = null
        _state.value = WsClient.State.DISCONNECTED
    }

    override suspend fun stopGeneration(requestId: String) {
        webSocket?.send("""{"event":"${WsEvents.AI_STOP}","requestId":"$requestId"}""")
    }

    private fun openSocket(target: ServerConnection) {
        if (stopped) return
        _state.value = WsClient.State.CONNECTING
        // 复用会残留旧连接与回调，先清场（先置空 webSocket 再 cancelAll，
        // 避免旧 socket 的 onClosed/onFailure 在窗口期内通过 isCurrent 触发多余重连）
        webSocket = null
        client?.dispatcher?.cancelAll()
        val okClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            // WebSocket 长连接不设读超时，靠 pingInterval 探测存活
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
            .build()
        client = okClient
        val request = Request.Builder()
            .url(NetworkModule.wsUrlOf(target))
            .header("User-Agent", UA)
            .build()
        webSocket = okClient.newWebSocket(request, listener)
    }

    private val listener = object : WebSocketListener() {
        private fun isCurrent(socket: WebSocket): Boolean =
            socket === this@WsClientImpl.webSocket

        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (!isCurrent(webSocket)) return
            reconnectAttempts = 0
            _state.value = WsClient.State.CONNECTED
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (!isCurrent(webSocket)) return
            handleFrame(text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (!isCurrent(webSocket)) return
            _state.value = WsClient.State.DISCONNECTED
            scheduleReconnect()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (!isCurrent(webSocket)) return
            _state.value = WsClient.State.DISCONNECTED
            scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        if (stopped) return
        val target = connection ?: return
        val delayMs = minOf(1_000L shl minOf(reconnectAttempts, 5), 30_000L)
        reconnectAttempts++
        _state.value = WsClient.State.RECONNECTING
        scope.launch {
            delay(delayMs)
            // H-17 修复：延迟到期时校验 target 仍是当前连接（引入代次语义）——
            // 此前只查 stopped，期间用户切换到 PC-B 并连接成功后，A 的延迟协程醒来
            // 会先 cancelAll 杀掉 B 的连接再连回 A，造成 REST/WS 数据源错乱（会话串台）。
            if (!stopped && connection === target) {
                openSocket(target)
            } else {
                reconnectAttempts = 0
            }
        }
    }

    private fun handleFrame(text: String) {
        val envelope = runCatching { json.decodeFromString<WsEnvelope>(text) }.getOrNull() ?: return
        val event = when (envelope.event) {
            WsEvents.AI_CHUNK -> envelope.payload?.let {
                runCatching { json.decodeFromJsonElement<AiChunkPayload>(it) }.getOrNull()
            }?.let { CompanionEvent.Chunk(it.requestId, it.sessionId, it.delta) }

            WsEvents.AI_DONE -> envelope.payload?.let {
                runCatching { json.decodeFromJsonElement<AiDonePayload>(it) }.getOrNull()
            }?.let { CompanionEvent.Done(it.requestId, it.sessionId, it.message) }

            WsEvents.AI_ERROR -> envelope.payload?.let {
                runCatching { json.decodeFromJsonElement<AiErrorPayload>(it) }.getOrNull()
            }?.let { CompanionEvent.Error(it.requestId, it.sessionId, it.message) }

            WsEvents.AI_USAGE -> envelope.payload?.let {
                runCatching { json.decodeFromJsonElement<AiUsagePayload>(it) }.getOrNull()
            }?.let {
                CompanionEvent.Usage(it.requestId, it.promptTokens, it.completionTokens, it.totalTokens)
            }

            WsEvents.SESSION_UPDATED -> envelope.payload?.let {
                runCatching { json.decodeFromJsonElement<SessionUpdatedPayload>(it) }.getOrNull()
            }?.let { CompanionEvent.SessionUpdated(it.sessionId, it.change) }

            WsEvents.CONNECTION_HEARTBEAT -> {
                // P1-1: 收到服务端心跳，立即回复 pong，防 60s pong 超时被服务端误断
                webSocket?.send("""{"event":"${WsEvents.CONNECTION_PONG}"}""")
                null
            }

            else -> null
        }
        event?.let { _events.tryEmit(it) }
    }

    private companion object {
        const val UA = "qingyu-companion-android/0.1"
    }
}
