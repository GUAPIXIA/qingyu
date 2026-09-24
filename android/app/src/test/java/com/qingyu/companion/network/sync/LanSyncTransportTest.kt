package com.qingyu.companion.network.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S7-05：LAN transport 分批、同 batch 重试、暂停与 receipt 恢复。
 */
class LanSyncTransportTest {

    private class FakeEngine(
        private val script: MutableList<Pair<Int, String>> = mutableListOf(),
    ) : SyncHttpEngine {
        val calls = mutableListOf<String>()
        var failTimes = 0
        override fun request(
            method: String,
            url: String,
            headers: Map<String, String>,
            body: String?,
            timeoutMs: Long,
        ): SyncHttpResponse {
            calls += "$method $url"
            if (failTimes > 0) {
                failTimes--
                return SyncHttpResponse(503, """{"error":"sync_dormant"}""")
            }
            val next = if (script.isNotEmpty()) script.removeAt(0) else 200 to "{}"
            return SyncHttpResponse(next.first, next.second)
        }
    }

    private fun env(id: String) = SyncEnvelopeDto(
        entityType = "character",
        entityId = id,
        contentHash = "sha256:" + "a".repeat(64),
        version = mapOf("android-1" to "1"),
        deleted = false,
        payload = mapOf("id" to id, "name" to "n"),
    )

    private val endpoint = SyncEndpoint(host = "192.168.1.8", port = 8321, fingerprint = "fp")

    @Test
    fun splitBatchesRespectsItemLimit() {
        val t = LanSyncTransport(FakeEngine(), maxBatchItems = 2)
        val batches = t.splitBatches(listOf(env("a"), env("b"), env("c")))
        assertEquals(2, batches.size)
        assertEquals(2, batches[0].envelopes.size)
        assertEquals(1, batches[1].envelopes.size)
        assertEquals(0, batches[0].sequence)
        assertEquals(1, batches[1].sequence)
    }

    @Test
    fun pushRetriesSameBatchIdThenSucceeds() {
        val engine = FakeEngine()
        val t = LanSyncTransport(engine)
        engine.failTimes = 1
        val handle = SyncSessionHandle("s1", endpoint)
        val batch = SyncBatch("b-0", 0, listOf(env("c1")))
        val r = t.pushBatch(handle, batch, maxAttempts = 3)
        assertTrue(r is SyncTransportResult.Ok)
        // 第一次 503 + 第一次成功 = 2 次 push
        assertEquals(2, engine.calls.count { it.contains("/push") })
        assertTrue(t.pendingBatches().isEmpty())
    }

    @Test
    fun pauseBlocksPushAndKeepsPending() {
        val engine = FakeEngine()
        val t = LanSyncTransport(engine)
        t.pause()
        val r = t.pushBatch(SyncSessionHandle("s1", endpoint), SyncBatch("b-0", 0, listOf(env("c1"))))
        assertTrue(r is SyncTransportResult.Fail)
        assertEquals("paused", (r as SyncTransportResult.Fail).code)
        assertEquals(1, t.pendingBatches().size)
        assertTrue(engine.calls.isEmpty())
        t.resume()
        val r2 = t.pushBatch(SyncSessionHandle("s1", endpoint), SyncBatch("b-0", 0, listOf(env("c1"))))
        assertTrue(r2 is SyncTransportResult.Ok)
    }

    @Test
    fun commitAndReceiptQuery() {
        val engine = FakeEngine(
            mutableListOf(
                200 to """{"receipt":{"receiptId":"r-1"},"idempotent":false}""",
                200 to """{"receipt":{"receiptId":"r-1"}}""",
            ),
        )
        val t = LanSyncTransport(engine)
        val handle = SyncSessionHandle("s1", endpoint)
        val c = t.commit(handle, "b-0")
        assertTrue(c is SyncTransportResult.Ok)
        assertEquals("r-1", (c as SyncTransportResult.Ok).value)
        val q = t.fetchReceipt(handle, "b-0")
        assertEquals("r-1", (q as SyncTransportResult.Ok).value)
    }

    @Test
    fun openSessionRequiresFingerprint() {
        val t = LanSyncTransport(FakeEngine())
        val r = t.openSession(SyncEndpoint(host = "127.0.0.1", port = 1, fingerprint = " "))
        assertTrue(r is SyncTransportResult.Fail)
        assertEquals("fingerprint_required", (r as SyncTransportResult.Fail).code)
    }

    @Test
    fun baseUrlEncodesIpv6() {
        val t = LanSyncTransport(FakeEngine())
        val url = t.baseUrl(SyncEndpoint(host = "fe80::1", port = 8321, fingerprint = "fp"))
        assertEquals("http://[fe80::1]:8321/sync/v1", url)
    }
}
