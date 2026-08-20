package com.qingyu.companion.network

import com.qingyu.companion.model.ServerConnection
import org.junit.Assert.assertEquals
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
}
