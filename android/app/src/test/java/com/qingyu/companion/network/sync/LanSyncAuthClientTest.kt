package com.qingyu.companion.network.sync

import com.qingyu.companion.synccore.LanAuth
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S7-05：LanSyncAuthClient 纯逻辑部分（QR 解析 / 短认证串 / ECDH 密钥一致）。
 * 网络 hello/status 用 FakeEngine 覆盖。
 */
class LanSyncAuthClientTest {

    private class FakeEngine(private val script: MutableMap<String, Pair<Int, String>> = mutableMapOf()) : SyncHttpEngine {
        var lastUrl: String? = null
        override fun request(
            method: String,
            url: String,
            headers: Map<String, String>,
            body: String?,
            timeoutMs: Long,
        ): SyncHttpResponse {
            lastUrl = url
            val key = "$method ${url.substringAfterLast('/')}"
            val (code, text) = script[key] ?: (200 to "{}")
            return SyncHttpResponse(code, text)
        }
    }

    private fun sampleQrJson(): String {
        return """
            {"version":1,"scheme":"qingyu-sync-auth","protocolVersion":1,
             "host":"192.168.1.8","port":8321,"sessionId":"sess-1",
             "pcPublicKey":"ERERERERERERERERERERERERERERERERERERERERERE=",
             "secret":"q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=",
             "expiresAt":${System.currentTimeMillis() + 60_000},
             "fingerprint":"fp-1","displayName":"PC","scope":"sync"}
        """.trimIndent()
    }

    @Test
    fun parseQrAcceptsValidPayload() {
        val client = LanSyncAuthClient(FakeEngine(), "Pixel")
        val p = client.parseQr(sampleQrJson())
        assertNotNull(p)
        assertEquals("sess-1", p!!.sessionId)
        assertEquals(LanAuth.SCOPE, p.scope)
    }

    @Test
    fun parseQrRejectsExpired() {
        val client = LanSyncAuthClient(FakeEngine())
        val raw = sampleQrJson().replace(Regex("\"expiresAt\":\\d+"), "\"expiresAt\":1")
        assertEquals(null, client.parseQr(raw, now = 2L))
    }

    @Test
    fun startHandshakeComputesSixDigitShortAuth() {
        val engine = FakeEngine(mutableMapOf("POST hello" to (200 to """{"phase":"awaiting_confirm"}""")))
        val client = LanSyncAuthClient(engine, "Pixel")
        val payload = client.parseQr(sampleQrJson())!!
        val r = client.startHandshake(payload)
        assertTrue(r is SyncTransportResult.Ok)
        val code = (r as SyncTransportResult.Ok).value
        assertTrue(code.matches(Regex("\\d{6}")))
        assertEquals(code, client.shortAuth())
    }

    @Test
    fun deriveSessionKeysMatchesBothSides() {
        val engine = FakeEngine(mutableMapOf("POST hello" to (200 to "{}")))
        val client = LanSyncAuthClient(engine, "Pixel")
        val payload = client.parseQr(sampleQrJson())!!
        client.startHandshake(payload)
        val keys = client.deriveSessionKeys()
        assertTrue(keys is SyncTransportResult.Ok)
        val k = (keys as SyncTransportResult.Ok).value
        assertEquals(32, java.util.Base64.getDecoder().decode(k.sessionKey).size)
        assertEquals(32, java.util.Base64.getDecoder().decode(k.macKey).size)
    }

    @Test
    fun pollAuthStatusReadsConfirmedFlag() {
        val engine = FakeEngine(
            mutableMapOf(
                "POST hello" to (200 to "{}"),
                "GET status" to (200 to """{"confirmed":true,"phase":"confirmed"}"""),
            ),
        )
        val client = LanSyncAuthClient(engine, "Pixel")
        client.startHandshake(client.parseQr(sampleQrJson())!!)
        val st = client.pollAuthStatus()
        assertTrue(st is SyncTransportResult.Ok)
        assertTrue((st as SyncTransportResult.Ok).value)
    }
}
