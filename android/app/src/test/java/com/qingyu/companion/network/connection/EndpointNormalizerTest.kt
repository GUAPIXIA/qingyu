package com.qingyu.companion.network.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A-04 端点规范化：实施文档 §5 测试表全部 10 行 + 输入清洗用例。
 */
class EndpointNormalizerTest {

    // ---------- 文档测试表 ----------

    @Test
    fun `doc table - ipv4 private ranges are local cleartext`() {
        assertEquals(TransportSecurity.LOCAL_CLEARTEXT, EndpointNormalizer.securityFor("192.168.1.5"))
        assertEquals(TransportSecurity.LOCAL_CLEARTEXT, EndpointNormalizer.securityFor("10.0.0.8"))
        assertEquals(TransportSecurity.LOCAL_CLEARTEXT, EndpointNormalizer.securityFor("100.100.1.2")) // 100.64/10 Tailscale
        assertEquals(TransportSecurity.LOCAL_CLEARTEXT, EndpointNormalizer.securityFor("172.20.1.5")) // 172.16/12
        assertEquals(TransportSecurity.LOCAL_CLEARTEXT, EndpointNormalizer.securityFor("127.0.0.1")) // 127/8
        assertEquals(TransportSecurity.LOCAL_CLEARTEXT, EndpointNormalizer.securityFor("localhost"))
    }

    @Test
    fun `doc table - mdns local hostname is local cleartext`() {
        assertEquals(TransportSecurity.LOCAL_CLEARTEXT, EndpointNormalizer.securityFor("qingyu-pc.local"))
    }

    @Test
    fun `doc table - ipv6 ula is local cleartext and bracketed in url`() {
        val endpoint = EndpointNormalizer.normalize("fd00::1234", 8321)
        assertEquals(TransportSecurity.LOCAL_CLEARTEXT, endpoint.security)
        assertEquals("http://[fd00::1234]:8321/", endpoint.toHttpUrl())
        assertEquals("ws://[fd00::1234]:8321/ws", endpoint.toWsUrl())
    }

    @Test
    fun `doc table - ipv6 link-local keeps zone id and percent-encodes it in url`() {
        val endpoint = EndpointNormalizer.normalize("fe80::1%wlan0", 8321)
        assertEquals(TransportSecurity.LOCAL_CLEARTEXT, endpoint.security)
        assertEquals("fe80::1%wlan0", endpoint.host)
        assertEquals("http://[fe80::1%25wlan0]:8321/", endpoint.toHttpUrl())
        assertEquals("ws://[fe80::1%25wlan0]:8321/ws", endpoint.toWsUrl())
    }

    @Test
    fun `doc table - ipv6 loopback is local`() {
        assertEquals(TransportSecurity.LOCAL_CLEARTEXT, EndpointNormalizer.securityFor("::1"))
        assertEquals(
            "http://[::1]:80/",
            EndpointNormalizer.normalize("::1", 80).toHttpUrl(),
        )
    }

    @Test
    fun `doc table - public domain and public ip default to tls system`() {
        assertEquals(TransportSecurity.TLS_SYSTEM, EndpointNormalizer.securityFor("example.com"))
        assertEquals(TransportSecurity.TLS_SYSTEM, EndpointNormalizer.securityFor("8.8.8.8"))
        // ULA 全段（fc00::/7 = fc00..fdff 首 hextet）
        assertEquals(TransportSecurity.LOCAL_CLEARTEXT, EndpointNormalizer.securityFor("fc00::1"))
        assertEquals(TransportSecurity.LOCAL_CLEARTEXT, EndpointNormalizer.securityFor("fd12:3456::78"))
        // 边界：不在放行网段
        assertFalse(EndpointNormalizer.isLocalHost("172.15.0.1"))
        assertFalse(EndpointNormalizer.isLocalHost("100.63.255.1"))
        assertFalse(EndpointNormalizer.isLocalHost("100.128.0.1"))
        assertEquals(TransportSecurity.TLS_SYSTEM, EndpointNormalizer.securityFor("fe00::")) // fe80::/10 之外
        assertEquals(TransportSecurity.TLS_SYSTEM, EndpointNormalizer.securityFor("2001:4860::8888"))
    }

    @Test
    fun `doc table - public host cannot be constructed as local cleartext`() {
        assertThrows(IllegalArgumentException::class.java) {
            ConnectionEndpoint("example.com", 8321, TransportSecurity.LOCAL_CLEARTEXT)
        }
        assertThrows(IllegalArgumentException::class.java) {
            ConnectionEndpoint("8.8.8.8", 443, TransportSecurity.LOCAL_CLEARTEXT)
        }
        // 公网 → 本地明文的"洗白"路径也必须被阻断（scheme 伪装在构造期被拒）
        assertThrows(IllegalArgumentException::class.java) {
            ConnectionEndpoint("http://8.8.8.8", 8321, TransportSecurity.LOCAL_CLEARTEXT)
        }
    }

    // ---------- 输入清洗 ----------

    @Test
    fun `sanitize strips scheme path trailing slash and whitespace`() {
        val cleaned = EndpointNormalizer.sanitize("  http://192.168.1.5:8321/path/ ")
        assertEquals("192.168.1.5", cleaned?.host)
        assertEquals(8321, cleaned?.port)

        assertEquals("bridge.example.com", EndpointNormalizer.sanitize("https://bridge.example.com/api/v1/status")?.host)
        assertEquals("qingyu-pc.local", EndpointNormalizer.sanitize("http://QINGYU-PC.local/")?.host)
        assertEquals("10.0.0.8", EndpointNormalizer.sanitize("10.0.0.8 ")?.host)
        assertNull(EndpointNormalizer.sanitize("   "))
        assertNull(EndpointNormalizer.sanitize("http://"))
        assertNull(EndpointNormalizer.sanitize("/just/a/path"))
    }

    @Test
    fun `normalize accepts dirty url-ish input and infers port from it`() {
        val endpoint = EndpointNormalizer.normalize("http://192.168.1.5:8321/path/")
        assertEquals("192.168.1.5", endpoint.host)
        assertEquals(8321, endpoint.port)
        assertEquals(TransportSecurity.LOCAL_CLEARTEXT, endpoint.security)
        assertEquals("http://192.168.1.5:8321/", endpoint.toHttpUrl())
    }

    @Test
    fun `explicit port wins over port embedded in input`() {
        val endpoint = EndpointNormalizer.normalize("https://pc.example.com:9999/x", 8321)
        assertEquals(8321, endpoint.port)
        assertEquals("https://pc.example.com:8321/", endpoint.toHttpUrl())
    }

    @Test
    fun `normalize handles bracketed ipv6 with port and percent zone`() {
        val cleaned = EndpointNormalizer.sanitize("http://[fe80::1%25wlan0]:8321/path")
        assertEquals("fe80::1%wlan0", cleaned?.host)
        assertEquals(8321, cleaned?.port)
    }

    @Test
    fun `normalize without any port fails`() {
        assertThrows(IllegalArgumentException::class.java) {
            EndpointNormalizer.normalize("192.168.1.5")
        }
    }

    // ---------- 其他构造校验 ----------

    @Test
    fun `tls pinned requires certificate pin`() {
        assertThrows(IllegalArgumentException::class.java) {
            ConnectionEndpoint("bridge.example.com", 443, TransportSecurity.TLS_PINNED)
        }
        val pinned = ConnectionEndpoint("bridge.example.com", 443, TransportSecurity.TLS_PINNED, certificatePin = "sha256/abc")
        assertEquals("https://bridge.example.com:443/", pinned.toHttpUrl())
    }

    @Test
    fun `invalid ports rejected`() {
        assertThrows(IllegalArgumentException::class.java) {
            ConnectionEndpoint("10.0.0.8", 0, TransportSecurity.LOCAL_CLEARTEXT)
        }
        assertThrows(IllegalArgumentException::class.java) {
            ConnectionEndpoint("10.0.0.8", 70000, TransportSecurity.LOCAL_CLEARTEXT)
        }
    }

    @Test
    fun `ipv4 octet parsing is strict`() {
        assertTrue(EndpointNormalizer.isLocalHost("192.168.1.5"))
        assertFalse(EndpointNormalizer.isLocalHost("192.168.256.5"))
        assertFalse(EndpointNormalizer.isLocalHost("192.168.1"))
        assertFalse(EndpointNormalizer.isLocalHost("010.0.0.8")) // 前导零歧义写法不放行
        assertFalse(EndpointNormalizer.isLocalHost("192.168.001.5"))
        assertFalse(EndpointNormalizer.isLocalHost("example.local.evil.com"))
    }
}
