package com.qingyu.companion.network

import com.qingyu.companion.model.ServerConnection
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class WsClientImplTest {
    private lateinit var server: MockWebServer
    private lateinit var client: WsClientImpl

    @Before
    fun setUp() {
        server = MockWebServer()
        client = WsClientImpl(NetworkModule.json)
    }

    @After
    fun tearDown() {
        client.disconnect()
        server.shutdown()
    }

    @Test
    fun `websocket authenticates by header and replies to application heartbeat`() {
        val opened = CountDownLatch(1)
        val pong = CountDownLatch(1)
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    opened.countDown()
                    webSocket.send("""{"event":"connection:heartbeat"}""")
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (text == """{"event":"connection:pong"}""") pong.countDown()
                }
            }),
        )
        server.start()
        val target = ServerConnection(
            deviceId = "test",
            host = server.hostName,
            port = server.port,
            token = "secret-token",
            name = "PC",
            fingerprint = "fingerprint",
        )

        kotlinx.coroutines.runBlocking { client.connect(target) }

        assertTrue("WebSocket should open", opened.await(3, TimeUnit.SECONDS))
        assertTrue("Android should reply to the bridge heartbeat", pong.await(3, TimeUnit.SECONDS))
        assertEquals("Bearer secret-token", server.takeRequest().getHeader("Authorization"))
    }
}
