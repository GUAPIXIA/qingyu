package com.qingyu.companion.network

import com.qingyu.companion.model.AiChunkPayload
import com.qingyu.companion.model.AiDonePayload
import com.qingyu.companion.model.AiErrorPayload
import com.qingyu.companion.model.AiUsagePayload
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.model.ServerInfo
import com.qingyu.companion.model.SessionUpdatedPayload
import com.qingyu.companion.model.SettingsUpdatedPayload
import com.qingyu.companion.model.TaskEventEnvelopeDto
import com.qingyu.companion.model.TaskSubscribePayload
import com.qingyu.companion.model.WsEnvelope
import com.qingyu.companion.model.RelayWsFrame
import com.qingyu.companion.model.RelayBridgeEventPayload
import com.qingyu.companion.model.RelayCommandCompletedPayload
import com.qingyu.companion.model.RelayCommandExpiredPayload
import com.qingyu.companion.model.ConnectionMode
import com.qingyu.companion.model.WsEvents
import com.qingyu.companion.network.connection.ConnectionLease
import com.qingyu.companion.network.connection.ConnectionMetrics
import com.qingyu.companion.network.connection.ReconnectBackoff
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import kotlin.random.Random

/**
 * OkHttp WebSocket 实现。
 * 线程模型：OkHttp 回调线程负责解析帧并 tryEmit 到事件流；
 * 重连调度在独立 [CoroutineScope] 中，指数退避。
 *
 * B-05 连接代次：每次 connect/disconnect 递增 generation，session 以
 * (generation, deviceId) 语义标识——旧 socket 回调、旧重连计时器到达时
 * 发现代次已变即作废，不再使用 `connection === target` 对象引用比较
 * （数据类重新加载后引用不同但语义相同，引用比较会误判）。
 * B-06 网络恢复：onLost 暂停重连循环（避免无网空转），onAvailable 取消退避立即重连。
 * B-04：默认复用 [NetworkStack.webSocketClient] 共享连接池/DNS（可注入覆盖）。
 * 事件缺口：tryEmit 失败（订阅者缓冲溢出）计入 [eventGaps]，供诊断展示。
 */
class WsClientImpl(
    private val json: Json,
    private val clientProvider: () -> OkHttpClient = { NetworkModule.sharedStack.webSocketClient() },
    private val random: Random = Random.Default,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    /** F-03：事件丢弃计数落点（可空 = 纯内存替身/旧测试不接指标） */
    private val metrics: ConnectionMetrics? = null,
    /** 事件缓冲容量（默认 256；测试注入 0 以确定性模拟 tryEmit 失败） */
    private val eventBufferCapacity: Int = 256,
) : WsClient {

    private val _state = MutableStateFlow(WsClient.State.DISCONNECTED)
    override val state: StateFlow<WsClient.State> = _state.asStateFlow()

    private val _events = MutableSharedFlow<CompanionEvent>(
        replay = 0,
        extraBufferCapacity = eventBufferCapacity,
    )
    override val events: SharedFlow<CompanionEvent> = _events.asSharedFlow()

    /** 因缓冲溢出/无订阅丢弃的事件计数（诊断用，不回绕清零）。 */
    private val _eventGaps = MutableStateFlow(0)
    override val eventGaps: StateFlow<Int> = _eventGaps.asStateFlow()

    /** F-03：critical 事件丢弃后的对账请求（sessionId；conflate 语义 = 小缓冲 + DROP_OLDEST 去抖）。 */
    private val _reconciliationRequests = MutableSharedFlow<String>(
        replay = 0,
        extraBufferCapacity = 16,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    override val reconciliationRequests: SharedFlow<String> = _reconciliationRequests.asSharedFlow()

    /** 最近一次 task:subscribe 意图（onOpen 后自动重发；跨重连存活）。 */
    @Volatile private var taskSubscription: TaskSubscribePayload? = null

    /** 当前 WS 会话（B-05：语义 = generation + deviceId + socket 实例）。 */
    private class Session(
        val generation: Long,
        val deviceId: String,
        val connection: ServerConnection,
        var socket: WebSocket? = null,
    )

    // M-32 修复：OkHttp 回调线程与协程线程并发读写，加 @Volatile 保证可见性
    // （此前竞态导致间歇性多余重连/旧 socket 误判）
    @Volatile private var stopped = true
    @Volatile private var session: Session? = null
    @Volatile private var networkPaused = false
    @Volatile private var reconnectAttempts = 0
    private var reconnectJob: Job? = null

    override suspend fun connect(connection: ServerConnection) =
        connectInternal(connection, lease = null)

    override suspend fun connect(connection: ServerConnection, lease: ConnectionLease) =
        connectInternal(connection, lease = lease)

    private fun connectInternal(connection: ServerConnection, lease: ConnectionLease?) {
        // 新会话 = 新代次；显式携带租约时沿用协调器代次（B-05 单一权威源）
        val generation = lease?.generation ?: ((session?.generation ?: 0L) + 1L)
        stopped = false
        networkPaused = false
        reconnectAttempts = 0
        reconnectJob?.cancel()
        // 旧会话 socket 必须先取消（共享 client 后不能 dispatcher.cancelAll，会误杀 REST 在途请求）
        val previous = session
        session = Session(generation, connection.deviceId, connection)
        // F-01：task 订阅绑定 PC——切换设备后旧订阅必须清空（cursor 属于旧 PC）
        if (previous?.deviceId != connection.deviceId) taskSubscription = null
        previous?.socket?.cancel()
        openSocket(session!!)
    }

    override fun disconnect() {
        stopped = true
        networkPaused = false
        reconnectAttempts = 0
        reconnectJob?.cancel()
        reconnectJob = null
        // 会话置空 = 任何在途回调（onFailure/重连定时器）的语义校验必然失败
        val old = session
        session = null
        old?.socket?.cancel()
        _state.value = WsClient.State.DISCONNECTED
    }

    override suspend fun stopGeneration(requestId: String) {
        val current = session ?: return
        val frame = if (current.connection.mode == ConnectionMode.RELAY) {
            """{"v":1,"type":"rpc:cancel","sentAt":${System.currentTimeMillis()},"payload":{"requestId":"$requestId"}}"""
        } else """{"event":"${WsEvents.AI_STOP}","payload":{"requestId":"$requestId"}}"""
        current.socket?.send(frame)
    }

    // ---------- F-01：task v2 订阅 ----------

    override suspend fun subscribeTasks(sessionIds: List<String>, cursors: Map<String, Long>): Boolean {
        val current = session ?: return false
        // 能力门控：未命中 task_events_v2 完全走 v1 ai:* 链路，不发订阅帧
        if (ServerInfo.CAP_TASK_EVENTS_V2 !in current.connection.capabilities) return false
        if (sessionIds.isEmpty()) return false
        val payload = TaskSubscribePayload(sessionIds = sessionIds, cursors = cursors)
        taskSubscription = payload
        return sendTaskSubscribe(payload)
    }

    /** 发送订阅帧；onOpen 后自动重发（重连自愈），socket 未就绪返回 false 由下次 onOpen 兜底。 */
    private fun sendTaskSubscribe(payload: TaskSubscribePayload): Boolean {
        val socket = session?.socket ?: return false
        val frame = """{"event":"${WsEvents.TASK_SUBSCRIBE}","payload":${json.encodeToString(payload)}}"""
        return runCatching { socket.send(frame) }.getOrDefault(false)
    }

    // ---------- B-06 网络恢复联动（coordinator 驱动） ----------

    override fun onNetworkLost() {
        if (stopped) return
        networkPaused = true
        reconnectJob?.cancel()
        reconnectJob = null
        // 杀掉半开 socket：其 onFailure 因 networkPaused 只置 DISCONNECTED 不再空转退避
        session?.socket?.cancel()
        _state.value = WsClient.State.DISCONNECTED
    }

    override fun onNetworkAvailable() {
        if (stopped || !networkPaused) return
        networkPaused = false
        reconnectAttempts = 0
        val target = session ?: return
        reconnectJob = scope.launch { openSocket(target) }
    }

    private fun openSocket(target: Session) {
        if (stopped || target !== session) return
        _state.value = WsClient.State.CONNECTING
        // 复用会残留旧连接与回调，先清场（先置空 socket 再 cancelAll，
        // 避免旧 socket 的 onClosed/onFailure 在窗口期内通过 isCurrent 触发多余重连）
        val previous = target.socket
        target.socket = null
        val okClient = clientProvider()
        val request = Request.Builder()
            .url(NetworkModule.wsUrlOf(target.connection))
            .header("Authorization", "Bearer ${target.connection.token}")
            .header("User-Agent", UA)
            .build()
        val socket = okClient.newWebSocket(request, listener(target))
        // newWebSocket 期间可能已被 disconnect/切换：语义检查后作废本次 socket
        if (stopped || session !== target) {
            socket.cancel()
            return
        }
        target.socket = socket
        previous?.cancel()
    }

    /** 每个 session 独立 listener 实例，捕获自身会话做代次/语义校验。 */
    private fun listener(target: Session) = object : WebSocketListener() {
        private fun isCurrent(socket: WebSocket): Boolean {
            val current = session ?: return false
            // B-05：代次 + deviceId 语义判断（而非 connection 对象引用）+ socket 实例归属
            return current === target &&
                current.generation == target.generation &&
                current.deviceId == target.deviceId &&
                socket === current.socket
        }

        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (!isCurrent(webSocket)) return
            reconnectAttempts = 0
            networkPaused = false
            _state.value = WsClient.State.CONNECTED
            // F-01：重连成功后自动重发 task:subscribe（订阅意图跨重连存活）
            taskSubscription?.let { sendTaskSubscribe(it) }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (!isCurrent(webSocket)) return
            handleFrame(webSocket, text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (!isCurrent(webSocket)) return
            _state.value = WsClient.State.DISCONNECTED
            scheduleReconnect(target)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (!isCurrent(webSocket)) return
            _state.value = WsClient.State.DISCONNECTED
            scheduleReconnect(target)
        }
    }

    private fun scheduleReconnect(target: Session) {
        if (stopped || networkPaused) return
        // 语义判断：仍是当前会话同代次设备才续排重连（替代旧 connection === target）
        val current = session ?: return
        if (current !== target || current.generation != target.generation ||
            current.deviceId != target.deviceId
        ) {
            reconnectAttempts = 0
            return
        }
        reconnectAttempts += 1
        // B-06 统一退避序列：0/1/2/4/8/15/30s 封顶 + jitter±20%（首连失败立即重试一次）
        val delayMs = ReconnectBackoff.delayMs(reconnectAttempts, random)
        _state.value = WsClient.State.RECONNECTING
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(delayMs)
            val still = session
            if (!stopped && !networkPaused &&
                still != null && still.generation == target.generation &&
                still.deviceId == target.deviceId
            ) {
                openSocket(still)
            } else {
                reconnectAttempts = 0
            }
        }
    }

    private fun handleFrame(socket: WebSocket, text: String) {
        val relay = session?.connection?.mode == ConnectionMode.RELAY
        val envelope = if (relay) {
            val frame = runCatching { json.decodeFromString<RelayWsFrame>(text) }.getOrNull() ?: return
            if (frame.v != 1) { socket.close(4406, "upgrade required"); return }
            if (frame.type == "connection:ping") {
                socket.send("""{"v":1,"type":"connection:pong","sentAt":${System.currentTimeMillis()}}""")
                return
            }
            if (frame.type != "bridge:event") return
            val event = frame.payload?.let { runCatching { json.decodeFromJsonElement<RelayBridgeEventPayload>(it) }.getOrNull() } ?: return
            WsEnvelope(event.event, event.data)
        } else runCatching { json.decodeFromString<WsEnvelope>(text) }.getOrNull() ?: return
        // F-01：task v2 事件帧先行分流（载荷为 TaskEventEnvelope；PC 不发 task:done/task:error，
        // 终态为 task:completed/failed/cancelled/interrupted）
        val event: CompanionEvent? = if (isTaskEventFrame(envelope.event)) {
            envelope.payload?.let {
                runCatching { json.decodeFromJsonElement<TaskEventEnvelopeDto>(it) }.getOrNull()
            }?.let { CompanionEvent.TaskEvent(it) }
        } else {
            parseEvent(socket, envelope)
        }
        if (event != null && !_events.tryEmit(event)) {
            onEventDropped(event)
        }
    }

    private fun parseEvent(socket: WebSocket, envelope: WsEnvelope): CompanionEvent? = when (envelope.event) {
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
            }?.let { CompanionEvent.SessionUpdated(it.sessionId, it.change, it.revision) }

            // F-01 v1 兼容 TODO：PC 侧 session:updated 当前仅 { sessionId, change }，
            // 不带 revision/变更时间，无法在此做 revision 跳变检测触发补拉；
            // 待 PC 补充 revision 后，与本地缓存 revision 对比、跳变即触发 refreshSession。

            // C-04 设置同步 v2：PC 广播 settings:updated（revision 去重由消费方负责）
            WsEvents.SETTINGS_UPDATED -> envelope.payload?.let {
                runCatching { json.decodeFromJsonElement<SettingsUpdatedPayload>(it) }.getOrNull()
            }?.let {
                CompanionEvent.SettingsUpdated(
                    revision = it.revision,
                    changedFields = it.changedFields,
                    sourceDeviceId = it.sourceDeviceId,
                )
            }

            WsEvents.RELAY_COMMAND_COMPLETED -> envelope.payload?.let {
                runCatching { json.decodeFromJsonElement<RelayCommandCompletedPayload>(it) }.getOrNull()
            }?.let { CompanionEvent.RelayCommandCompleted(it.commandId, it.resultStatus, it.resultBody) }

            WsEvents.RELAY_COMMAND_EXPIRED -> envelope.payload?.let {
                runCatching { json.decodeFromJsonElement<RelayCommandExpiredPayload>(it) }.getOrNull()
            }?.let { CompanionEvent.RelayCommandExpired(it.commandId) }

            WsEvents.CONNECTION_HEARTBEAT -> {
                // P1-1: 收到服务端心跳，立即回复 pong，防 60s pong 超时被服务端误断
                socket.send("""{"event":"${WsEvents.CONNECTION_PONG}"}""")
                null
            }

            else -> null
        }

    private fun isTaskEventFrame(event: String): Boolean =
        event.startsWith(WsEvents.TASK_EVENT_PREFIX) && event != WsEvents.TASK_SUBSCRIBE

    /**
     * F-03：事件丢弃处理。
     * - 全量：缺口计数 + metrics.increment("ws_event_drop")（诊断可见，不落敏感数据）；
     * - critical 事件（done/error/session 变更/task 生命周期，chunk/usage 除外）：
     *   同步发出对账请求（sessionId），由 AppContainer 接线到 ChatRepository.refreshSession
     *   做 REST 重拉。chunk 可合并丢失（UI 端以 REST 刷新为准），不触发对账。
     */
    private fun onEventDropped(event: CompanionEvent) {
        _eventGaps.value += 1
        metrics?.increment(METRIC_EVENT_DROP)
        val sessionId = reconciliationTarget(event) ?: return
        _reconciliationRequests.tryEmit(sessionId)
    }

    /** critical 事件的对账目标（null = 可合并丢失，不需要对账）。 */
    private fun reconciliationTarget(event: CompanionEvent): String? = when (event) {
        is CompanionEvent.Chunk -> null
        is CompanionEvent.Usage -> null
        is CompanionEvent.SettingsUpdated -> null
        is CompanionEvent.RelayCommandCompleted -> event.message?.sessionId
        is CompanionEvent.RelayCommandExpired -> null
        is CompanionEvent.Done -> event.sessionId
        is CompanionEvent.Error -> event.sessionId
        is CompanionEvent.SessionUpdated -> event.sessionId
        is CompanionEvent.TaskEvent ->
            if (event.envelope.isChunkLike) null else event.envelope.sessionId
    }

    private companion object {
        const val UA = "qingyu-companion-android/0.1"

        /** F-03：WS 事件丢弃计数键（纳入 ConnectionMetrics 诊断快照 counters 输出） */
        const val METRIC_EVENT_DROP = "ws_event_drop"
    }
}
