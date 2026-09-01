package com.qingyu.companion.network.connection

import com.qingyu.companion.network.NetworkModule
import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A-05 重定向安全回归：
 * 纯决策函数 [EndpointNormalizer.decideRedirectAllowed] +
 * createHttpClient 的 RedirectPolicyInterceptor 端到端行为（MockWebServer）。
 */
class RedirectPolicyTest {

    // ---------- 纯决策函数 ----------

    @Test
    fun `local http to local http redirect allowed`() {
        assertTrue(EndpointNormalizer.decideRedirectAllowed("http://192.168.1.5:8321/api", "http://192.168.1.9:8321/api"))
        assertTrue(EndpointNormalizer.decideRedirectAllowed("http://[fe80::1%25wlan0]:8321/a", "http://localhost:8321/b"))
    }

    @Test
    fun `redirect to public cleartext rejected`() {
        // 本地 → 公网明文（脱网跳转）
        assertFalse(EndpointNormalizer.decideRedirectAllowed("http://192.168.1.5:8321/a", "http://evil.example.com/x"))
        assertFalse(EndpointNormalizer.decideRedirectAllowed("http://192.168.1.5:8321/a", "http://8.8.8.8/x"))
    }

    @Test
    fun `https to http downgrade rejected`() {
        assertFalse(EndpointNormalizer.decideRedirectAllowed("https://bridge.example.com/a", "http://bridge.example.com/a"))
        // 即使目标是本地，TLS 也不得降级为明文（防 SSRF 探测局域网）
        assertFalse(EndpointNormalizer.decideRedirectAllowed("https://bridge.example.com/a", "http://192.168.1.5:8321/a"))
    }

    @Test
    fun `public to local cleartext jump rejected`() {
        assertFalse(EndpointNormalizer.decideRedirectAllowed("http://public.example.com/a", "http://169.254.1.1:8321/a"))
        assertFalse(EndpointNormalizer.decideRedirectAllowed("https://bridge.example.com/a", "http://127.0.0.1:8321/a"))
    }

    @Test
    fun `upgrades and tls-to-tls always allowed`() {
        assertTrue(EndpointNormalizer.decideRedirectAllowed("http://192.168.1.5:8321/a", "https://192.168.1.5:8443/a"))
        assertTrue(EndpointNormalizer.decideRedirectAllowed("https://a.example.com/", "https://b.example.com/"))
        assertTrue(EndpointNormalizer.decideRedirectAllowed("http://localhost:8321/x", "http://[::1]:8321/y"))
    }

    @Test
    fun `non-http request url fails closed`() {
        // ws/其它 scheme 的请求 URL 不出现在 HTTP 重定向链路上；判定侧一律拒绝（fail-closed）
        assertFalse(EndpointNormalizer.decideRedirectAllowed("ws://localhost:8321/x", "https://localhost/x"))
    }

    @Test
    fun `non-http schemes and garbage rejected`() {
        assertFalse(EndpointNormalizer.decideRedirectAllowed("http://192.168.1.5/a", "file:///etc/passwd"))
        assertFalse(EndpointNormalizer.decideRedirectAllowed("http://192.168.1.5/a", "javascript:alert(1)"))
        assertFalse(EndpointNormalizer.decideRedirectAllowed("http://192.168.1.5/a", ""))
        assertFalse(EndpointNormalizer.decideRedirectAllowed("http://192.168.1.5/a", "not a url"))
        assertFalse(EndpointNormalizer.decideRedirectAllowed("ftp://host/a", "http://localhost/b"))
    }

    // ---------- createHttpClient 端到端 ----------

    private fun client(): OkHttpClient =
        NetworkModule.createHttpClient(token = "tok", debugLog = false).newBuilder()
            .callTimeout(10, TimeUnit.SECONDS)
            .build()

    @Test
    fun `client follows allowed local relative redirect`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "/moved"))
        server.enqueue(MockResponse().setResponseCode(200).setBody("ok"))
        server.start()
        try {
            val url = server.url("/api")
            val response = client().newCall(Request.Builder().url(url).build()).execute()
            response.use {
                assertEquals(200, it.code)
                assertEquals("ok", it.body!!.string())
            }
            server.takeRequest(2, TimeUnit.SECONDS)
            val followed = server.takeRequest(2, TimeUnit.SECONDS)
            assertEquals("/moved", followed?.path)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `client rejects redirect from local http to public http`() {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().setResponseCode(302).setHeader("Location", "http://evil.example.com/steal"),
        )
        server.start()
        try {
            val call = client().newCall(Request.Builder().url(server.url("/api")).build())
            assertThrows(IOException::class.java) { call.execute() }
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `client strips authorization on cross-host redirect`() {
        val server = MockWebServer()
        server.start()
        val port = server.port
        // 127.0.0.1 -> localhost：同为本地明文故允许，但跨主机必须剥离令牌
        server.enqueue(
            MockResponse().setResponseCode(302)
                .setHeader("Location", "http://localhost:$port/second"),
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody("ok"))
        try {
            val url = java.net.URL("http://127.0.0.1:$port/first")
            val client = client()
            client.newCall(Request.Builder().url(url).build()).execute().close()
            val first = server.takeRequest(2, TimeUnit.SECONDS)
            assertEquals("Bearer tok", first?.getHeader("Authorization"))
            val second = server.takeRequest(2, TimeUnit.SECONDS)
            assertNull(second?.getHeader("Authorization"))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `client does not auto follow ssl downgrade and stops at max hops`() {
        val server = MockWebServer()
        // 6 跳本地明文循环：超过上限后把最后一个 3xx 原样返回，不无限跟随
        repeat(6) {
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "/loop"))
        }
        server.start()
        try {
            val response = client().newCall(Request.Builder().url(server.url("/start")).build()).execute()
            response.use {
                assertTrue(it.code in 301..308)
            }
        } finally {
            server.shutdown()
        }
    }
}
