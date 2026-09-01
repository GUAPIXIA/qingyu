package com.qingyu.companion.network

import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.network.connection.ConnectionMetrics
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.onSubscription
import kotlinx.coroutines.launch
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * F-03：WS 事件丢弃计数与对账请求测试。
 * 用 extraBufferCapacity=0 确定性模拟缓冲溢出。tryEmit 语义（kotlinx-couroutines 实测）：
 * - 零订阅者 → 快速通道直接成功（不丢弃），所以丢弃测试必须先给 events 挂一个订阅者；
 * - 有订阅者且 buffer 容量 0 → tryEmit 必然失败（tryEmit 不做挂起投递）→ 确定性走丢弃路径。
 * 断言：
 * - 每次丢弃 metrics.increment("ws_event_drop") + eventGaps +1；
 * - critical 事件（ai:done/session:updated/task 生命周期等）丢弃 → 对账流收到 sessionId；
 * - chunk 类事件可合并丢失 → 不触发对账。
 * 事件投递测试（TaskEvent 帧解析）使用默认容量客户端（容量 0 时值永远无法进入流）。
 * F-01：task:subscribe 能力门控与帧形态（{event, payload:{sessionIds, cursors}}）、task 帧分发。
 */
class WsClientEventDropTest {

    private lateinit var server: MockWebServerHolder
    private lateinit var client: WsClientImpl
    private lateinit var metrics: ConnectionMetrics

    @Before
    fun setUp() {
        server = MockWebServerHolder()
        metrics = ConnectionMetrics()
        // eventBufferCapacity = 0：存在订阅者时 tryEmit 必然失败 → 确定性触发丢弃路径
        client = WsClientImpl(NetworkModule.json, metrics = metrics, eventBufferCapacity = 0)
    }

    @After
    fun tearDown() {
        client.disconnect()
        server.close()
    }

    private fun connection(capabilities: Set<String> = emptySet()) = ServerConnection(
        deviceId = "test",
        host = server.host,
        port = server.port,
        token = "secret-token",
        name = "PC",
        fingerprint = "fingerprint",
        capabilities = capabilities,
    )

    private fun awaitTrue(timeoutMs: Long = 5_000L, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(10)
        }
        assertTrue("等待条件超时", condition())
    }

    /** 后台订阅，onSubscription 建立确定性握手后才允许建链 */
    private fun collectInBackground(
        latch: CountDownLatch,
        sink: (String) -> Unit,
        flow: SharedFlow<String>,
    ): CoroutineScope {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope.launch {
            flow.onSubscription { latch.countDown() }.collect { sink(it) }
        }
        assertTrue("订阅建立超时", latch.await(5, TimeUnit.SECONDS))
        return scope
    }

    /**
     * 给 events 挂一个永久挂起的订阅者：容量 0 + 有订阅者 ⇒ 后续每次 tryEmit
     * 确定性失败（进入丢弃路径），且值永不进入流。订阅建立前不得建链。
     */
    private fun attachSuspendedEventsCollector(): CoroutineScope {
        val subscribed = CountDownLatch(1)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope.launch {
            client.events.onSubscription { subscribed.countDown() }.collect { /* 容量 0 下不可达 */ }
        }
        assertTrue("订阅建立超时", subscribed.await(5, TimeUnit.SECONDS))
        return scope
    }

    @Test
    fun `事件丢弃计数并触发对账-done 与 chunk 行为区分`() {
        val received = CopyOnWriteArrayList<String>()
        val subscribed = CountDownLatch(1)
        val reconcileScope = collectInBackground(subscribed, { received.add(it as String) }, client.reconciliationRequests)
        val eventsScope = attachSuspendedEventsCollector()
        try {
            server.enqueueUpgrade { webSocket ->
                webSocket.send("""{"event":"ai:chunk","payload":{"requestId":"r1","sessionId":"s1","delta":"增量"}}""")
                webSocket.send(
                    """{"event":"ai:done","payload":{"requestId":"r1","sessionId":"s1","message":{"id":"m1","sessionId":"s1","characterId":"c1","role":"assistant","content":"完整","timestamp":1}}}""",
                )
                webSocket.send("""{"event":"ai:chunk","payload":{"requestId":"r1","sessionId":"s1","delta":"尾"}}""")
            }
            server.start()
            runBlockingCompat { client.connect(connection()) }

            // 三个事件全部丢弃（容量 0 + 存在订阅者 → tryEmit 必失败）：计数 3
            awaitTrue { metrics.counter("ws_event_drop") == 3L }
            // chunk 丢弃不触发对账；只有 done 的 sessionId s1 进入对账流
            awaitTrue { received.singleOrNull() == "s1" }
            assertEquals(3, client.eventGaps.value)
        } finally {
            reconcileScope.coroutineContext[Job]?.cancel()
            eventsScope.coroutineContext[Job]?.cancel()
        }
    }

    @Test
    fun `task 生命周期事件丢弃触发对账-chunk 不触发`() {
        val received = CopyOnWriteArrayList<String>()
        val subscribed = CountDownLatch(1)
        val reconcileScope = collectInBackground(subscribed, { received.add(it as String) }, client.reconciliationRequests)
        val eventsScope = attachSuspendedEventsCollector()
        try {
            server.enqueueUpgrade { webSocket ->
                webSocket.send(
                    """{"event":"task:chunk","payload":{"protocolVersion":2,"eventId":"e1","taskId":"t1","requestId":"r1","sessionId":"s9","sequence":2,"type":"task:chunk","timestamp":1,"payload":{"delta":"片段"}}}""",
                )
                webSocket.send(
                    """{"event":"task:completed","payload":{"protocolVersion":2,"eventId":"e2","taskId":"t1","requestId":"r1","sessionId":"s9","sequence":3,"type":"task:completed","timestamp":2,"payload":{}}}""",
                )
            }
            server.start()
            runBlockingCompat { client.connect(connection()) }

            awaitTrue { metrics.counter("ws_event_drop") == 2L }
            awaitTrue { received.singleOrNull() == "s9" }
        } finally {
            reconcileScope.coroutineContext[Job]?.cancel()
            eventsScope.coroutineContext[Job]?.cancel()
        }
    }

    @Test
    fun `task 帧解析为 TaskEvent 且字段对齐 PC envelope`() {
        // 容量 0 时值永远无法进入流：本测试需要真实投递，用默认容量客户端
        client = WsClientImpl(NetworkModule.json, metrics = metrics)
        val events = CopyOnWriteArrayList<CompanionEvent.TaskEvent>()
        val subscribed = CountDownLatch(1)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope.launch {
            client.events
                .onSubscription { subscribed.countDown() }
                .collect { event -> if (event is CompanionEvent.TaskEvent) events.add(event) }
        }
        assertTrue("订阅建立超时", subscribed.await(5, TimeUnit.SECONDS))
        try {
            server.enqueueUpgrade { webSocket ->
                webSocket.send(
                    """{"event":"task:chunk","payload":{"protocolVersion":2,"eventId":"e1","taskId":"t1","requestId":"r1","sessionId":"s1","sequence":2,"type":"task:chunk","timestamp":10,"payload":{"delta":"你","accumulatedLength":1},"futureField":"ignored"}}""",
                )
            }
            server.start()
            runBlockingCompat { client.connect(connection()) }

            awaitTrue { events.isNotEmpty() }
            val envelope = events.first().envelope
            assertEquals(2, envelope.protocolVersion)
            assertEquals("t1", envelope.taskId)
            assertEquals("r1", envelope.requestId)
            assertEquals("s1", envelope.sessionId)
            assertEquals(2L, envelope.sequence)
            assertEquals("task:chunk", envelope.type)
            assertEquals("你", envelope.chunkDelta)
            assertTrue(envelope.isChunkLike)
        } finally {
            scope.coroutineContext[Job]?.cancel()
        }
    }

    @Test
    fun `task subscribe 能力命中时发送帧且含会话与cursor`() {
        val frames = CopyOnWriteArrayList<String>()
        server.enqueueUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                frames.add(text)
            }
        })
        server.start()
        runBlockingCompat { client.connect(connection(capabilities = setOf("task_events_v2"))) }

        val sent = runBlockingCompat {
            client.subscribeTasks(listOf("s1", "s2"), mapOf("t1" to 3L))
        }

        assertTrue("capability 命中应发送订阅帧", sent)
        awaitTrue { frames.any { it.contains("task:subscribe") } }
        val frame = frames.first { it.contains("task:subscribe") }
        assertTrue(frame.contains("\"sessionIds\":[\"s1\",\"s2\"]"))
        assertTrue(frame.contains("\"cursors\":{\"t1\":3}"))
    }

    @Test
    fun `task subscribe 能力未命中时不发送`() {
        val frames = CopyOnWriteArrayList<String>()
        server.enqueueUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                frames.add(text)
            }
        })
        server.start()
        runBlockingCompat { client.connect(connection(capabilities = emptySet())) }

        val sent = runBlockingCompat { client.subscribeTasks(listOf("s1"), emptyMap()) }

        assertFalse("能力未命中不得发送订阅帧", sent)
        assertTrue(frames.none { it.contains("task:subscribe") })
    }
}

/** MockWebServer + WS 升级的轻量持有（与 WsClientImplTest 同模式） */
private class MockWebServerHolder {
    private val server = okhttp3.mockwebserver.MockWebServer()
    private var listener: WebSocketListener? = null

    fun enqueueUpgrade(onOpen: (WebSocket) -> Unit) {
        listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                onOpen(webSocket)
            }
        }
    }

    fun enqueueUpgrade(l: WebSocketListener) {
        listener = l
    }

    val host: String get() = server.hostName
    val port: Int get() = server.port

    fun start() {
        server.start()
        server.enqueue(okhttp3.mockwebserver.MockResponse().withWebSocketUpgrade(listener!!))
    }

    fun close() {
        server.shutdown()
    }
}

private fun <T> runBlockingCompat(block: suspend kotlinx.coroutines.CoroutineScope.() -> T): T =
    kotlinx.coroutines.runBlocking { block() }
