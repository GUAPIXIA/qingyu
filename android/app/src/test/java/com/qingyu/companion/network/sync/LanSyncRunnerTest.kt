package com.qingyu.companion.network.sync

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S7-07：LAN 完整流 openSession→push→prepare→pull→commit（Fake HTTP，不触网）。
 */
class LanSyncRunnerTest {

    private class ScriptedEngine : SyncHttpEngine {
        val calls = mutableListOf<String>()
        var failPullOnce = false

        override fun request(
            method: String,
            url: String,
            headers: Map<String, String>,
            body: String?,
            timeoutMs: Long,
        ): SyncHttpResponse {
            calls += "$method $url"
            return when {
                url.endsWith("/session") && method.equals("POST", true) ->
                    SyncHttpResponse(200, """{"sessionId":"s1"}""")
                url.endsWith("/push") ->
                    SyncHttpResponse(200, """{"itemHash":"h"}""")
                url.endsWith("/prepare") ->
                    SyncHttpResponse(200, """{}""")
                url.endsWith("/pull") -> {
                    if (failPullOnce) {
                        failPullOnce = false
                        SyncHttpResponse(503, """{"error":"busy"}""")
                    } else {
                        SyncHttpResponse(
                            200,
                            """{"envelopes":[{"entityType":"character","entityId":"c1","contentHash":"sha256:${"a".repeat(64)}","version":{"pc":"1"},"deleted":false,"schemaVersion":1,"parentId":null}],"nextCursor":"1","hasMore":false}""",
                        )
                    }
                }
                url.endsWith("/commit") ->
                    SyncHttpResponse(200, """{"receipt":{"receiptId":"r1"}}""")
                else -> SyncHttpResponse(404, "{}")
            }
        }
    }

    private fun env(id: String) = SyncEnvelopeDto(
        entityType = "character",
        entityId = id,
        contentHash = "sha256:" + "a".repeat(64),
        version = mapOf("android-1" to "1"),
        deleted = false,
        payload = mapOf("id" to id),
    )

    private val endpoint = SyncEndpoint("192.168.1.8", 8321, "fp")

    @Test
    fun fullFlowUploadsPullsAndCommits() = runBlocking {
        val engine = ScriptedEngine()
        val transport = LanSyncTransport(engine, maxBatchItems = 10)
        val applied = mutableListOf<SyncEnvelopeDto>()
        val runner = LanSyncRunner(
            transport = transport,
            endpointProvider = { endpoint },
            authorized = { true },
            collectUpload = { listOf(env("u1"), env("u2")) },
            applyDownload = { list ->
                applied += list
                mapOf("android-1" to "2")
            },
        )
        val phases = mutableListOf<String>()
        val r = runner.run { p, s, d -> phases += "$p:$s:$d" }
        assertTrue(r.ok)
        assertEquals(2, r.uploaded)
        assertEquals(1, r.downloaded)
        assertEquals(1, applied.size)
        assertTrue(engine.calls.any { it.endsWith("/push") })
        assertTrue(engine.calls.any { it.endsWith("/pull") })
        assertTrue(engine.calls.any { it.endsWith("/commit") })
        assertTrue(phases.any { it.startsWith("session") })
        assertTrue(phases.any { it.startsWith("done") })
    }

    @Test
    fun unauthorizedDoesNotOpenSession() = runBlocking {
        val engine = ScriptedEngine()
        val runner = LanSyncRunner(
            transport = LanSyncTransport(engine),
            endpointProvider = { endpoint },
            authorized = { false },
            collectUpload = { emptyList() },
            applyDownload = { emptyMap() },
        )
        val r = runner.run()
        assertFalse(r.ok)
        assertTrue(engine.calls.isEmpty())
    }

    @Test
    fun pullRetryableFailureSurfacesRetryable() = runBlocking {
        val engine = ScriptedEngine().apply { failPullOnce = true }
        val runner = LanSyncRunner(
            transport = LanSyncTransport(engine),
            endpointProvider = { endpoint },
            authorized = { true },
            collectUpload = { emptyList() },
            applyDownload = { emptyMap() },
        )
        // pull 503 → retryable fail（LanSyncTransport.pull 单次不重试，由 runner 上抛）
        val r = runner.run()
        assertFalse(r.ok)
        assertEquals(true, r.retryable)
    }
}
