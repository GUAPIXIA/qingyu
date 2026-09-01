package com.qingyu.companion.network

import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.network.connection.ConnectionEndpoint
import com.qingyu.companion.network.connection.TransportSecurity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkModuleTest {
    private fun connection(host: String) = ServerConnection("test", host, 8321, "secret", "dev", "fp")

    @Test
    fun `lan connections use header-authenticated http and ws urls without token`() {
        val target = connection("192.168.10.3")
        assertEquals("http://192.168.10.3:8321/", NetworkModule.baseUrlOf(target))
        assertEquals("ws://192.168.10.3:8321/ws", NetworkModule.wsUrlOf(target))
    }

    @Test
    fun `public connections require https and wss`() {
        val target = connection("bridge.example.com")
        assertEquals("https://bridge.example.com:8321/", NetworkModule.baseUrlOf(target))
        assertEquals("wss://bridge.example.com:8321/ws", NetworkModule.wsUrlOf(target))
    }

    @Test
    fun `ipv6 loopback endpoint wraps address in brackets`() {
        val target = connection("::1")
        assertEquals("http://[::1]:8321/", NetworkModule.baseUrlOf(target))
        assertEquals("ws://[::1]:8321/ws", NetworkModule.wsUrlOf(target))
    }

    @Test
    fun `ipv6 link-local with zone id encodes percent in url`() {
        val target = connection("fe80::1%wlan0")
        assertEquals("http://[fe80::1%25wlan0]:8321/", NetworkModule.baseUrlOf(target))
        assertEquals("ws://[fe80::1%25wlan0]:8321/ws", NetworkModule.wsUrlOf(target))
    }

    @Test
    fun `dirty host input is sanitized before url generation`() {
        // 历史脏数据：host 字段被写入完整 URL 也不应拼出非法 baseUrl
        val target = connection("http://192.168.1.5:8321/path/")
        assertEquals("http://192.168.1.5:8321/", NetworkModule.baseUrlOf(target))
        val public = connection("https://Bridge.Example.com./api")
        assertEquals("https://bridge.example.com:8321/", NetworkModule.baseUrlOf(public))
    }

    @Test
    fun `endpoint of public host is TLS_SYSTEM and secure`() {
        val endpoint = NetworkModule.endpointOf(connection("8.8.8.8"))
        assertEquals(TransportSecurity.TLS_SYSTEM, endpoint.security)
        assertTrue(NetworkModule.isSecureConnection(connection("8.8.8.8")))
        assertTrue(!NetworkModule.isSecureConnection(connection("10.0.0.8")))
    }

    @Test
    fun `endpoint serializes with kotlinx json round trip`() {
        val endpoint = NetworkModule.endpointOf(connection("fd00::1234"))
        val text = NetworkModule.json.encodeToString(ConnectionEndpoint.serializer(), endpoint)
        val restored = NetworkModule.json.decodeFromString(ConnectionEndpoint.serializer(), text)
        assertEquals(endpoint, restored)
        assertEquals("http://[fd00::1234]:8321/", restored.toHttpUrl())
    }

    @Test
    fun `deprecated isPrivateHost delegates to endpoint policy`() {
        @Suppress("DEPRECATION")
        assertTrue(NetworkModule.isPrivateHost("192.168.1.5"))
        @Suppress("DEPRECATION")
        assertTrue(!NetworkModule.isPrivateHost("8.8.8.8"))
    }
}
