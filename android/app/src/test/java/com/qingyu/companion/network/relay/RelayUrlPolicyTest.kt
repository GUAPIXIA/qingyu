package com.qingyu.companion.network.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class RelayUrlPolicyTest {
    @Test fun mapsOnlyToFixedRelayEndpoints() {
        assertEquals("https://relay.example.com/relay/v1/bridge/", RelayUrlPolicy.bridgeBaseUrl("https://relay.example.com"))
        assertEquals("wss://relay.example.com/relay/v1/ws/android", RelayUrlPolicy.androidWsUrl("https://relay.example.com/other/"))
    }
    @Test fun rejectsUnsafeUrls() {
        listOf("http://relay.example.com", "https://user:pass@relay.example.com", "https://relay.example.com?q=1", "https://relay.example.com/#x").forEach {
            assertThrows(IllegalArgumentException::class.java) { RelayUrlPolicy.normalizeBaseUrl(it) }
        }
    }
}
